import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board, type Watcher, type WatcherContext } from '../src/server/index.ts'
import type { CallerRequest, Can } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, OIDC_ISS, oidcToken, personToken, PROJECT_ID, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'
import { LEASE_MS, SWEEP_MS, wakeBackoff } from '../src/server/registered.ts'
import { canonicalWatchers } from '../src/server/watchers-hash.ts'
import { slack } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { fakePlatform } from './sync-fixtures.ts'

/** Where v0's board is mounted: a board on the team's board, over http(). */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'
// Another team's project, so only the rules let it in: g2 lets in every project on the board's team.
const v0Token = () => deploymentToken('v0', 'prj_v0', 'production')

// The board's own Vercel OIDC token, as @vercel/oidc mints it on Vercel: only the tests that say
// they run on Vercel give it one.
const mint = vi.hoisted(() => vi.fn(async (_options: { audience: string }): Promise<string> => Promise.reject(new Error('not on Vercel'))))
vi.mock('@vercel/oidc', async (original) => ({ ...(await original<typeof import('@vercel/oidc')>()), getVercelOidcToken: mint }))

/** Lets a project's production deployments do what `can` says on `on`: again, it changes what they may. */
const grant = async (on: ReturnType<typeof testBoard>, projectId: string, can: Can) => {
  const written = (typeof can === 'object' && !Array.isArray(can) ? can : { '*': can }) as never
  const grants = await on.grants()
  const named = grants.find((one) => one.principals.length === 1 && one.principals[0]!.kind === 'project' && one.principals[0]!.projectId === projectId)
  if (named) return on.updateGrant(named.id, { can: written })
  // Without g2's every project on the team, it may do only what its grant says.
  if (grants.some((one) => one.id === 'g2')) await on.revokeGrant('g2')
  return on.createGrant({ principals: [{ kind: 'project', project: projectId, environments: ['production'] }], can: written })
}

/**
 * The team's board on a2(), and v0's board on http() using it, calling each other in-process:
 * the team's board wakes v0's at `<V0_URL>/wake`, and v0's pulls and writes back over HTTP. v0 may
 * do what `can` says there, until a test changes it, and marketing everything.
 */
async function team(watch: Record<string, Watcher> = {}, can: Can = 'all') {
  const queue = fakeQueue()
  const woken: string[] = []
  /** Each wake-up's headers, as the board sent them. */
  const wakes: Record<string, string>[] = []
  /** The status v0's board answered each wake-up with. */
  const answered: number[] = []
  let down = false
  let project: ReturnType<typeof v0Board>
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    if (request.url.startsWith(V0_URL)) return project.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const remote = testBoard({
    scheduler: queue.scheduler,
    transport: {
      post: (url, init) => {
        woken.push(url)
        wakes.push(init.headers)
        if (down) return Promise.resolve(new Response('deploying', { status: 503 }))
        return route(url, { method: 'POST', headers: init.headers, body: init.body }).then((response) => {
          answered.push(response.status)
          return response
        })
      },
    },
  })
  const v0Board = (next: Record<string, Watcher>) => {
    const backend = http(BOARD_URL, { fetch: bearer(route, v0Token) })
    // The backend's own registration, as `POST /watchers` does.
    return Object.assign(board({ backend, url: V0_URL, watch: next }), { registerWatchers: backend.registerWatchers })
  }
  await grant(remote, 'prj_v0', can)
  await grant(remote, 'prj_marketing', 'all')
  project = v0Board(watch)
  return {
    remote,
    /** What v0 may do on the team's board from now on. */
    allow: (next: Can) => grant(remote, 'prj_v0', next),
    queue,
    woken,
    wakes,
    answered,
    get project() {
      return project
    },
    deploy: (next: Record<string, Watcher>) => (project = v0Board(next)),
    /** While it's down, v0's board answers wake-ups with a 503. */
    set down(value: boolean) {
      down = value
    },
    /** Fires every timer now: leases run out, and waits after an error end. */
    fireTimers: async () => {
      for (const timer of queue.timers) timer.dueAt = 0
      await queue.fire()
    },
    /** With `Date` faked: moves the clock to the next sweep and fires what's due then, and says how long that was. */
    sweep: async () => {
      const before = Date.now()
      const at = Math.min(...queue.timers.filter(isSweep).map((task) => task.dueAt))
      vi.setSystemTime(at)
      await queue.fire()
      return at - before
    },
  }
}

/** A watcher that records each event it runs on, and runs `then` after. */
function recorder(tail: string, then?: Watcher['run']) {
  const seen: WatcherContext['event'][] = []
  return { seen, watcher: { tail, run: async (context: WatcherContext) => (seen.push(context.event), then?.(context)) } satisfies Watcher }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>) => caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

/** A sweep's timer, as opposed to an error's wait. */
const isSweep = (task: { events: readonly { payload: unknown }[] }) => (task.events[0]?.payload as { sweep?: number }).sweep !== undefined

describe('watchers on http()', () => {
  it("run on what the same tail prints, woken with nothing in the wake-up, writing as the deployment's profile", async () => {
    const fix = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted' && event.message?.re === null) await board.reply(event.message.id, 'on it')
    })
    const t = await team({ fix: fix.watcher })
    await t.project.registerWatchers()
    const julian = await julianOn(t.remote.fetch)
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })).body.message
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root.id}`)
      expect(body.replies.map((reply: { text: string; by: { actor: string } }) => [reply.text, reply.by.actor])).toEqual([['on it', `${V0}+fix`]])
    })
    expect(fix.seen.map((event) => [event.type, event.message?.text])).toEqual([['message.posted', 'export is broken']])
    expect(t.woken[0]).toBe(`${V0_URL}/wake`)
  })

  it('wake their board once for a burst of matches, since it pulls until nothing is left', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const fix = recorder('feedback', () => held)
    const t = await team({ fix: fix.watcher })
    await t.project.registerWatchers()
    const julian = await julianOn(t.remote.fetch)
    for (const n of [1, 2, 3, 4, 5]) await julian('POST', '/messages', { channel: 'feedback', text: `report ${n}` })
    // The first wake-up is still running when the rest match.
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).filter((event: { type: string }) => event.type === 'watch.matched')).toHaveLength(5))
    release()
    await vi.waitFor(() => expect(fix.seen).toHaveLength(5))
    // Every match has been to the waker since: a drain here returns while the first wake-up's holds its claim.
    const server = t.remote.servers.at(-1)!
    await vi.waitFor(async () => {
      const cursors = await t.remote.store.log.cursors(`${server.contract.name}\u001fwatch:@${V0}`)
      expect(cursors.filter((cursor) => cursor.head !== null || cursor.claimHolder !== null)).toEqual([])
    })
    expect(t.woken).toEqual([`${V0_URL}/wake`])
  })

  it("try a wake-up that didn't get there again, from a sweep a minute or so on", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const fix = recorder('feedback')
      const t = await team({ fix: fix.watcher })
      await t.project.registerWatchers()
      t.down = true
      const julian = await julianOn(t.remote.fetch)
      await julian('POST', '/messages', { channel: 'feedback', text: 'while it deploys' })
      await vi.waitFor(() => expect(t.queue.timers.filter(isSweep)).toHaveLength(1))
      expect(fix.seen).toEqual([])
      t.down = false
      // A sweep is on the minute at least a second after the back-off.
      expect(await t.sweep()).toBeLessThanOrEqual(wakeBackoff(1) + SWEEP_MS + 1000)
      await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['while it deploys']))
      expect(t.woken).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never runs on what its registrant can't read", async () => {
    const fix = recorder('--all')
    const t = await team({ fix: fix.watcher }, { feedback: ['read', 'post'] })
    await t.project.registerWatchers()
    const julian = await julianOn(t.remote.fetch)
    await julian('POST', '/messages', { channel: 'security', text: 'hunter2' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['export is broken']))
  })

  it("doesn't wake for its own writes", async () => {
    const echo = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted') await board.post('feedback', 'echo')
    })
    const t = await team({ echo: echo.watcher })
    await t.project.registerWatchers()
    await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'hello' })
    await vi.waitFor(() => expect(echo.seen).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(echo.seen.map((event) => event.message?.text)).toEqual(['hello'])
  })

  it('registers again when a wake-up shows the remote holds an older registration', async () => {
    const t = await team({ fix: recorder('feedback').watcher })
    await t.project.registerWatchers()
    const next = recorder('feedback --label kind=bug')
    t.deploy({ fix: next.watcher })
    // The old registration still matches, and the wake-up's hash shows it's stale.
    await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(async () => {
      const { body } = await caller(t.remote.fetch, await v0Token())('GET', '/watchers')
      expect(body.watchers[0].watch).toEqual({ fix: { tail: 'feedback --label kind=bug' } })
    })
  })

  it('answers a wake-up after 2 seconds while a slow watcher runs, and runs it to the end', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const fix = recorder('feedback', () => held)
    const t = await team({ fix: fix.watcher })
    await t.project.registerWatchers()
    const julian = await julianOn(t.remote.fetch)
    await julian('POST', '/messages', { channel: 'feedback', text: 'slow report' })
    await vi.waitFor(() => expect(t.answered).toEqual([202]), { timeout: 4000 })
    expect(fix.seen).toHaveLength(1)
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    const acked = async () => (await queue.history()).filter((event: { type: string }) => event.type === 'watch.acked')
    await expect(acked()).resolves.toHaveLength(0)
    release()
    await vi.waitFor(async () => expect(await acked()).toHaveLength(1))
  }, 10_000)

  it('ignores what a forged wake-up says: it only pulls its own', async () => {
    const t = await team({ fix: recorder('feedback').watcher })
    await t.project.registerWatchers()
    const forged = await t.project.fetch(new Request(`${V0_URL}/wake`, { method: 'POST', body: '{"run":"everything"}' }))
    expect(await forged.json()).toEqual({ ran: 0 })
  })

  it("pulls on its own when it can't be woken", async () => {
    const fix = recorder('feedback')
    const t = await team()
    const backend = http(BOARD_URL, { fetch: bearer((input, init) => t.remote.fetch(new Request(input, init)), v0Token) })
    const local = board({ backend, url: 'http://localhost:3000/api/board', watch: { fix: fix.watcher } })
    try {
      // Nothing happens until it's first used: here, a call from the project's own code.
      expect((await caller(t.remote.fetch, await v0Token())('GET', '/watchers')).body.watchers).toEqual([])
      await local.as('deploys').me()
      await vi.waitFor(async () => {
        const { body } = await caller(t.remote.fetch, await v0Token())('GET', '/watchers')
        expect(body.watchers).toEqual([expect.objectContaining({ owner: V0, url: null })])
      })
      await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
      await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['export is broken']))
    } finally {
      backend.close()
    }
  })
})

/** What the board logged about waking boards, one line each. */
const wakeLogs = (errors: { mock: { calls: unknown[][] } }) =>
  errors.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes("couldn't wake"))

/** v0's queue on the team's board, and how many of its wake-ups in a row didn't get there, as recorded. */
function v0Queue(t: Awaited<ReturnType<typeof team>>) {
  const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
  const history = async () => (await queue.history()) as { type: string; payload: { failures?: number; by?: string } }[]
  return {
    history,
    /** The `watch.unreachable` events so far. */
    unreachable: async () => (await history()).filter((event) => event.type === 'watch.unreachable'),
    /** What each `watch.reachable` so far says ended the wait. */
    reached: async () => (await history()).flatMap((event) => (event.type === 'watch.reachable' ? [event.payload.by] : [])),
  }
}

describe("a board whose wake-ups don't get there", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is woken less often while they fail, a minute doubling to an hour, and the log says so twice', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((failures) => wakeBackoff(failures) / SWEEP_MS)).toEqual([1, 2, 4, 8, 16, 32, 60, 60])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = await team({ fix: recorder('feedback').watcher })
    await t.project.registerWatchers()
    t.down = true
    const julian = await julianOn(t.remote.fetch)
    const queue = v0Queue(t)
    await julian('POST', '/messages', { channel: 'feedback', text: 'first' })
    await vi.waitFor(async () => expect(await queue.unreachable()).toHaveLength(1))
    // A match while it waits only queues: the sweep wakes it for both.
    await julian('POST', '/messages', { channel: 'feedback', text: 'second' })
    await vi.waitFor(async () => expect((await queue.history()).filter((event) => event.type === 'watch.matched')).toHaveLength(2))
    await t.remote.servers.at(-1)!.drain(`watch:@${V0}`)
    expect(t.woken).toHaveLength(1)
    // Each try waits out its back-off, then the sweep on the minute after it.
    for (let failures = 1; failures <= 7; failures++) {
      const waited = await t.sweep()
      expect(waited).toBeGreaterThan(wakeBackoff(failures))
      expect(waited).toBeLessThanOrEqual(wakeBackoff(failures) + SWEEP_MS + 1000)
      await vi.waitFor(async () => expect(await queue.unreachable()).toHaveLength(failures + 1))
    }
    expect(t.woken).toHaveLength(8)
    expect((await queue.unreachable()).map((event) => event.payload.failures)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(wakeLogs(errors)).toEqual([
      `[board] couldn't wake ${V0_URL}: 503`,
      `[board] couldn't wake ${V0_URL} again (503): trying less often, up to once an hour, until it answers, pulls, or registers`,
    ])
  })

  it('starts over once one gets there', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fix = recorder('feedback')
    const t = await team({ fix: fix.watcher })
    await t.project.registerWatchers()
    t.down = true
    const julian = await julianOn(t.remote.fetch)
    const queue = v0Queue(t)
    await julian('POST', '/messages', { channel: 'feedback', text: 'while it deploys' })
    await vi.waitFor(async () => expect(await queue.unreachable()).toHaveLength(1))
    await t.sweep()
    await vi.waitFor(async () => expect(await queue.unreachable()).toHaveLength(2))
    t.down = false
    await t.sweep()
    await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['while it deploys']))
    await vi.waitFor(async () => expect(await queue.reached()).toContain('wake'))
    // The next that doesn't get there is a first failure: a minute's wait, and said again.
    t.down = true
    await julian('POST', '/messages', { channel: 'feedback', text: 'down again' })
    await vi.waitFor(async () => expect(await queue.unreachable()).toHaveLength(3))
    expect((await queue.unreachable()).at(-1)!.payload.failures).toBe(1)
    expect(wakeLogs(errors)).toHaveLength(3)
    expect(wakeLogs(errors).at(-1)).toBe(`[board] couldn't wake ${V0_URL}: 503`)
  })

  it.each(['pulls', 'registers'] as const)('is woken for its next match right away once its board %s', async (how) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fix = recorder('feedback')
    const t = await team({ fix: fix.watcher })
    await t.project.registerWatchers()
    t.down = true
    const julian = await julianOn(t.remote.fetch)
    const queue = v0Queue(t)
    await julian('POST', '/messages', { channel: 'feedback', text: 'while it deploys' })
    await vi.waitFor(async () => expect(await queue.unreachable()).toHaveLength(1))
    t.down = false
    // The clock hasn't moved: without this, the next match would wait for the sweep.
    if (how === 'pulls') expect((await caller(t.remote.fetch, await v0Token())('GET', '/watchers/matches')).body.matches).toHaveLength(1)
    else {
      t.deploy({ fix: fix.watcher })
      await t.project.registerWatchers()
    }
    expect(await queue.reached()).toEqual([how === 'pulls' ? 'pull' : 'registration'])
    await julian('POST', '/messages', { channel: 'feedback', text: 'next' })
    await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toContain('next'))
    expect(t.woken).toHaveLength(2)
  })
})

/** This project's own bypass secret, as Vercel's system variable holds it. */
const SECRET = 'this-projects-bypass-secret'

describe('a wake-up through Deployment Protection', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', SECRET)
    // The board's deployment could mint a token, if anything asked it to.
    mint.mockReset().mockImplementation(async ({ audience }) => deploymentToken('board', PROJECT_ID, 'preview', { audience }))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each(['1', ''])('carries no credential for any registrant, on Vercel (%j) or off, and never the bypass secret', async (vercel) => {
    vi.stubEnv('VERCEL', vercel)
    /** Each registrant's wake-up headers, by the host it registered. */
    const sent: Record<string, Record<string, string>> = {}
    const transport = {
      post: async (url: string, init: { headers: Record<string, string> }) => {
        sent[new URL(url).host] = init.headers
        return new Response(null, { status: 204 })
      },
    }
    const remote = testBoard({ scheduler: fakeQueue().scheduler, transport })
    await remote.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } })
    await remote.createGrant({ principals: [{ kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }], can: { '*': 'all' } })
    await grant(remote, 'prj_v0', 'all')
    const hosted = testBoard({
      scheduler: fakeQueue().scheduler,
      transport,
      authenticate: (request: CallerRequest) => (request.credential === 'pt_app' ? { id: 'vercel:project:prj_app:production', kind: 'deployment', handle: 'app' } : null),
    })
    await grant(hosted, 'prj_app', 'all')
    const register = (host: string) => ({ url: `https://${host}/api/board`, watch: { fix: { tail: 'feedback' } } })
    const registrants = [
      [remote, await workflowToken(), 'workflow.test'],
      [remote, await oidcToken(), 'gitlab.test'],
      [remote, await personToken(), 'person.test'],
      [remote, await v0Token(), 'v0.test'],
      [hosted, 'pt_app', 'host.test'],
    ] as const
    for (const [on, token, host] of registrants) expect((await caller(on.fetch, token)('POST', '/watchers', register(host))).status).toBe(200)
    await caller(remote.fetch, await personToken('u_ada'))('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await caller(hosted.fetch, 'pt_app')('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(() => expect(Object.keys(sent)).toHaveLength(5))
    // A Vercel project's included: the project lets /wake through its own protection.
    for (const headers of Object.values(sent)) expect(Object.keys(headers).sort()).toEqual(['content-type', 'x-board-watchers'])
    expect(JSON.stringify(sent)).not.toContain(SECRET)
    expect(mint).not.toHaveBeenCalled()
  })
})

/** The queue as v0 sees it through the API, registered without a URL so nothing wakes it. */
async function queued(tail = 'feedback') {
  const t = await team()
  const v0 = caller(t.remote.fetch, await v0Token())
  expect((await v0('POST', '/watchers', { watch: { fix: { tail } } })).status).toBe(200)
  const julian = await julianOn(t.remote.fetch)
  const pull = async (headers: Record<string, string> = {}) =>
    (await caller(t.remote.fetch, await v0Token(), headers)('GET', '/watchers/matches')).body.matches as { id: string; lease: string; attempt: number; event: { message: { text: string } } }[]
  const ack = (match: { id: string; lease: string }, body: Record<string, unknown> = {}) => v0('POST', `/watchers/matches/${match.id}/ack`, { lease: match.lease, ...body })
  return { t, v0, julian, pull, ack }
}

describe('pulling matches', () => {
  it("hands out a thread's matches one at a time, in order", async () => {
    const { julian, pull, ack } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'first' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'second' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'another thread' })
    let matches: Awaited<ReturnType<typeof pull>> = []
    await vi.waitFor(async () => {
      matches = [...matches, ...(await pull())]
      expect(matches.map((match) => match.event.message.text).sort()).toEqual(['another thread', 'first'])
    })
    // The thread's second waits for its first.
    expect(await pull()).toEqual([])
    const first = matches.find((match) => match.event.message.text === 'first')!
    expect((await ack(first)).status).toBe(200)
    expect((await pull()).map((match) => match.event.message.text)).toEqual(['second'])
  })

  it('leases a match to one pull at a time', async () => {
    const { julian, pull } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'once' })
    await vi.waitFor(async () => {
      const both = await Promise.all([pull(), pull()])
      expect(both.flat()).toHaveLength(1)
    })
  })

  it('tries an error again after a wait, gives up after 5 tries, and the thread goes on', async () => {
    const { t, julian, pull, ack } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'flaky' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'after it' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(match!.attempt).toBe(attempt)
      expect((await ack(match!, { error: 'boom' })).status).toBe(200)
      if (attempt === 4) break
      // It waits out its delay before anyone can pull it again.
      expect(await pull()).toEqual([])
      await t.fireTimers()
      match = (await pull())[0]
      expect(match?.event.message.text).toBe('flaky')
    }
    expect((await pull()).map((next) => next.event.message.text)).toEqual(['after it'])
    const history = await t.remote.servers.at(-1)!.session(`watch:@${V0}`).history()
    expect(history.filter((event: { type: string }) => event.type === 'watch.failed')).toHaveLength(1)
  })

  it('pulls a match again once its lease runs out, and ignores the old lease', async () => {
    const { t, julian, pull, ack } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'slow' })
    let first: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((first = (await pull())[0])).toBeDefined())
    expect(await pull()).toEqual([])
    // Its puller never acks, and five minutes go by.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + LEASE_MS + 1000)
      await t.fireTimers()
      const again = (await pull())[0]!
      expect([again.id, again.attempt]).toEqual([first!.id, 1])
      expect(await ack(first!)).toEqual({ status: 409, body: { error: { code: 'stale_lease', message: 'that lease ran out, and the match was pulled again' } } })
      expect((await ack(again)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sets one sweep a minute for its leases, however many it pulls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T12:00:10.000Z'))
    try {
      const { t, julian, pull } = await queued()
      for (const n of [1, 2, 3]) {
        await julian('POST', '/messages', { channel: 'feedback', text: `report ${n}` })
        await vi.waitFor(async () => expect(await pull()).toHaveLength(1))
      }
      // Three pulls, leases until 12:05:10, one sweep on the minute after.
      expect(t.queue.timers.filter(isSweep).map((task) => new Date(task.dueAt).toISOString())).toEqual(['2026-10-20T12:06:00.000Z'])
    } finally {
      vi.useRealTimers()
    }
  })

  it("sets each registrant's sweep, when two pull in the same minute", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T12:00:10.000Z'))
    try {
      const { t, julian, pull } = await queued()
      // Both queues record a sweep on the same minute, under the same derived ID: an ID is its session's.
      const marketing = caller(t.remote.fetch, await deploymentToken())
      expect((await marketing('POST', '/watchers', { watch: { fix: { tail: 'feedback' } } })).status).toBe(200)
      await julian('POST', '/messages', { channel: 'feedback', text: 'for both' })
      await vi.waitFor(async () => expect(await pull()).toHaveLength(1))
      const theirs = await marketing('GET', '/watchers/matches')
      expect(theirs.status).toBe(200)
      expect(theirs.body.matches.map((match: { event: { message: { text: string } } }) => match.event.message.text)).toEqual(['for both'])
      const server = t.remote.servers.at(-1)!
      const armed = async (owner: string) => (await server.session(`watch:@${owner}`).history()).filter((event: { type: string }) => event.type === 'watch.armed')
      const [ours, other] = [await armed(V0), await armed('vercel:project:prj_marketing:production')]
      expect([ours.length, other.length]).toEqual([1, 1])
      expect(ours[0]!.id).toBe(other[0]!.id)
      expect(t.queue.timers.filter(isSweep)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a match its registrant can't read anymore", async () => {
    const { t, julian, pull } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'meant for v0' })
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.matched'))
    // The team's grant took feedback away since: the match is skipped, not handed out.
    await t.allow({ other: ['read'] })
    expect(await pull()).toEqual([])
    expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.skipped')
    await t.allow('all')
    expect(await pull()).toEqual([])
  })

  it('refuses a caller narrowed with x-board-scope, which leaves its registration and matches as they were', async () => {
    const { t, v0, julian, pull, ack } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'meant for v0' })
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.matched'))
    const narrowed = caller(t.remote.fetch, await v0Token(), { 'x-board-scope': 'other=read' })
    const refusal = { status: 403, body: { error: { code: 'forbidden', message: "this token is narrowed with x-board-scope: registering and running watchers is its project's job" } } }
    // Its pull would have dropped the match it can't read, and its register replaced v0's whole registration.
    expect(await narrowed('GET', '/watchers/matches')).toEqual(refusal)
    expect(await narrowed('POST', '/watchers', { watch: {} })).toEqual(refusal)
    expect((await queue.history()).map((event: { type: string }) => event.type)).not.toContain('watch.skipped')
    expect((await v0('GET', '/watchers')).body.watchers.map((found: { watch: object }) => Object.keys(found.watch))).toEqual([['fix']])
    const [match] = await pull()
    expect(match!.event.message.text).toBe('meant for v0')
    expect(await narrowed('POST', `/watchers/matches/${match!.id}/ack`, { lease: match!.lease })).toEqual(refusal)
    expect((await ack(match!)).status).toBe(200)
  })

  it('shows what a match links to only as its puller may read it now', async () => {
    // A Slack message in feedback links to one in security, which v0 could read when it matched.
    const s = fakePlatform('slack')
    const remote = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'feedback', C2: 'security' })) } })
    await grant(remote, 'prj_v0', 'all')
    await grant(remote, 'prj_sync', 'all')
    const webhook = (body: unknown) =>
      remote.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const v0 = caller(remote.fetch, await v0Token())
    expect((await v0('POST', '/watchers', { watch: { fix: { tail: 'feedback' } } })).status).toBe(200)
    const secret = '1791322095.443859'
    await webhook({ type: 'message', threadId: `slack:C2:${secret}`, id: secret, text: 'the key is hunter2', user: 'U_ADA', name: 'Ada' })
    const permalink = `https://acme.slack.com/archives/C2/p${secret.replace('.', '')}`
    // Linked with its snapshot from feedback: the board's own sync no longer makes one across
    // channels, but a sync elsewhere can import one, as a log can hold one from before.
    await vi.waitFor(async () => expect((await (await julianOn(remote.fetch))('GET', '/messages?channel=security')).body.messages).toHaveLength(1))
    const [linked] = (await (await julianOn(remote.fetch))('GET', '/messages?channel=security')).body.messages
    const sync = caller(remote.fetch, await deploymentToken('sync', 'prj_sync', 'production'))
    expect((await sync('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    const snapshot = { author: 'Ada', text: 'the key is hunter2', createdAt: null, files: [] }
    const author = { id: 'slack:user:U_JB', handle: 'jb', name: 'JB', avatar: null, isBot: false }
    const links = [{ url: permalink, message: linked.id, snapshot, unavailable: null }]
    expect((await sync('POST', '/sync/imports', { op: 'post', author, from: 'helpdesk', channel: 'feedback', text: `see ${permalink}`, links })).status).toBe(200)
    const queue = remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.matched'))
    // Down to feedback since, it still gets the match, but nothing of the message in security.
    await grant(remote, 'prj_v0', { feedback: ['read'] })
    const [match] = (await v0('GET', '/watchers/matches')).body.matches
    expect(match.event.message.text).toContain(permalink)
    // In the message it matched, and in its event's own payload.
    expect(match.event.message.links).toEqual([{ url: permalink, message: null, snapshot: null, unavailable: 'not_readable' }])
    expect(match.event.payload.links).toEqual([{ url: permalink, message: null, snapshot: null, unavailable: 'not_readable' }])
    expect(JSON.stringify(match)).not.toContain('hunter2')
  })

  it('needs a registration, and acks only its own', async () => {
    const { t, julian, pull } = await queued()
    const marketing = caller(t.remote.fetch, await deploymentToken())
    expect((await marketing('GET', '/watchers/matches')).body.error.code).toBe('no_registration')
    await julian('POST', '/messages', { channel: 'feedback', text: 'for v0' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    expect((await marketing('POST', `/watchers/matches/${match!.id}/ack`, { lease: match!.lease })).status).toBe(404)
  })
})

describe('registering', () => {
  it("is checked the way a board's own watchers are", async () => {
    const t = await team()
    const v0 = caller(t.remote.fetch, await v0Token())
    const register = (watch: unknown, url?: string) => v0('POST', '/watchers', { watch, ...(url ? { url } : {}) })
    expect(await register({ fix: { tail: 'feedback --after 3' } })).toEqual({
      status: 400,
      body: { error: { code: 'bad_watcher', message: "watch fix: --after isn't a filter" } },
    })
    expect((await register({ review_pi: { tail: 'prs' } })).body.error.message).toBe(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    expect((await register({}, 'http://v0.test/board')).body.error.message).toContain('wake-ups go over https')
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`w${n}`, { tail: 'feedback' }]))
    expect((await register(many)).body.error.message).toContain('at most 32 watchers')
    expect((await register({ fix: { tail: 'feedback' } }, V0_URL)).status).toBe(200)
  })

  it('needs a token that reads somewhere, and lists registrations to whoever may see them', async () => {
    const t = await team({}, { feedback: ['post'] })
    const v0 = caller(t.remote.fetch, await v0Token())
    expect((await v0('POST', '/watchers', { watch: {} })).status).toBe(403)
    const marketing = caller(t.remote.fetch, await deploymentToken())
    await marketing('POST', '/watchers', { watch: { fix: { tail: 'feedback' } } })
    expect((await v0('GET', '/watchers')).body.watchers).toEqual([])
    expect((await (await julianOn(t.remote.fetch))('GET', '/watchers')).body.watchers.map((found: { owner: string }) => found.owner)).toEqual([
      'vercel:project:prj_marketing:production',
    ])
  })

  it('hashes watchers and sync entries in code-unit order, the same in every locale', () => {
    const spec = { tail: 'feedback' }
    const entry = (key: string) => ({ key, platform: 'slack' })
    // A locale's collation puts `a` before `B`; code units put `B` (U+0042) before `a` (U+0061).
    const canonical = canonicalWatchers({ a: spec, B: spec }, [entry('a'), entry('B')])
    expect(JSON.parse(canonical)).toEqual([
      ['B', 'feedback'],
      ['a', 'feedback'],
      ['sync', [['B', 'slack'], ['a', 'slack']]],
    ])
    expect(canonicalWatchers({ B: spec, a: spec }, [entry('B'), entry('a')])).toBe(canonical)
  })
})

describe('registering by path', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("is the board's to offer: one on a2() can't find a project's deployments, so it says so", async () => {
    const remote = testBoard()
    await grant(remote, 'prj_v0', 'all')
    const v0 = caller(remote.fetch, await v0Token())
    expect(await v0('POST', '/watchers', { path: '/api/board', watch: { fix: { tail: 'feedback' } } })).toMatchObject({
      status: 501,
      body: { error: { code: 'no_wake_by_path' } },
    })
  })

  it('takes a url or a path, not both, and a branch only with a path, and says which', async () => {
    const remote = testBoard()
    await grant(remote, 'prj_v0', 'all')
    const v0 = caller(remote.fetch, await v0Token())
    const refused = (message: string) => ({ status: 400, body: { error: { code: 'invalid_request', message } } })
    expect(await v0('POST', '/watchers', { url: V0_URL, path: '/api/board', watch: {} })).toMatchObject(refused('path: register a url or a path, not both'))
    expect(await v0('POST', '/watchers', { url: V0_URL, branch: 'jb/watchers', watch: {} })).toMatchObject(refused('branch: a branch goes with a path'))
    // A url registration that's wrong elsewhere is told what's wrong there, not only that it matched neither.
    const watch = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`w${i}`, { tail: 'feedback' }]))
    expect(await v0('POST', '/watchers', { url: V0_URL, watch })).toMatchObject(refused('watch: a board registers at most 32 watchers'))
  })

  it('types a registration as a url or a path, never both', () => {
    const handle = board({ backend: http(BOARD_URL) })
    const watch = {}
    // Never sent: the calls only have to typecheck, or not.
    const typed = () => {
      handle.register({ url: V0_URL, watch })
      handle.register({ path: '/api/board', branch: 'jb/watchers', watch })
      // @ts-expect-error a url and a path are two registrations
      handle.register({ url: V0_URL, path: '/api/board', watch })
      // @ts-expect-error a branch goes with a path
      handle.register({ url: V0_URL, branch: 'jb/watchers', watch })
    }
    expect(typed).toBeTypeOf('function')
  })

  const production = { VERCEL: '1', VERCEL_ENV: 'production' }
  it.each([
    ['production, on a board that wakes by path', production, true, { path: '/api/board' }],
    ['a preview of a branch, which it names', { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'jb/watchers' }, true, { path: '/api/board', branch: 'jb/watchers' }],
    ['a preview of no branch, as `vercel deploy` makes', { VERCEL: '1', VERCEL_ENV: 'preview' }, true, { url: V0_URL }],
    ['a custom environment', { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', VERCEL_GIT_COMMIT_REF: 'staging' }, true, { url: V0_URL }],
    ['development', { VERCEL: '1', VERCEL_ENV: 'development' }, true, { url: V0_URL }],
    ['off Vercel', {}, true, { url: V0_URL }],
    ["on a board that doesn't wake by path", production, false, { url: V0_URL }],
  ])('registers %s with %j', async (_case, env: Record<string, string>, byPath, where) => {
    for (const name of ['VERCEL', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'VERCEL_GIT_COMMIT_REF']) vi.stubEnv(name, env[name] ?? '')
    /** The team's board, as v0's board sees it: its discovery, and the registration it was sent. */
    const sent: unknown[] = []
    const remote = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && (path === '/api/board' || path === '/api/board/'))
        return Response.json({ version: '0', url: BOARD_URL, audience: BOARD_URL, team_id: null, project_id: null, sync: [], ...(byPath ? { wake_by_path: true } : {}) })
      if (request.method === 'POST' && path === '/api/board/watchers') {
        sent.push(await request.json())
        return Response.json({ owner: V0, url: null, watch: {}, sync: [], hash: 'h' })
      }
      return new Response('no such route', { status: 404 })
    }
    const backend = http(BOARD_URL, { fetch: bearer(remote, v0Token) })
    board({ backend, url: V0_URL, watch: { fix: { tail: 'feedback', run: async () => {} } } })
    await backend.registerWatchers()
    expect(sent).toEqual([{ ...where, watch: { fix: { tail: 'feedback' } } }])
  })
})
