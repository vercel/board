import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import type { GrantInput } from '../src/api/routes.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

type Fetch = (request: Request) => Promise<Response>

/** A board with a scheduler that lets in v0's production deployments and acme/web's runs everywhere, as their own grants. */
async function ownPrincipals() {
  const team = testBoard({ scheduler: fakeQueue().scheduler })
  await team.createGrant({ principals: [{ kind: 'project', project: 'prj_v0', environments: ['production'] }], can: { '*': 'all' } })
  await team.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } })
  return team
}

/** A board with a scheduler that grants v0's deployments in `environment` what `can` says, before any test request. */
async function grantingV0(environment = 'production', can: GrantInput['can'] = { '*': 'all' }) {
  const board = testBoard({ scheduler: fakeQueue().scheduler })
  await board.createGrant({ principals: [{ kind: 'project', project: 'prj_v0', environments: [environment] }], can })
  return board
}

/** A handle on the board behind `fetch`, as `vb conformance` checks it. */
const clientOf = async (fetch: Fetch) => clientAs(fetch, () => personToken())

/** A handle on the board behind `fetch`, with the token `token` gives. */
const clientAs = async (fetch: Fetch, token: () => Promise<string>) =>
  board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

/** A handle on the board behind `fetch`, with a board token's secret, as `vb conformance` opens one. */
const withToken = (fetch: Fetch) => (secret: string) =>
  board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), async () => secret) }) }).as(null)

/** The grants checks a board without team roles skips, and why: a run names no viewer, and grants don't cross teams yet. */
const NO_ROLES = ['caps a person by their team role, so a viewer reads but neither posts nor manages', 'name a viewer in principals to check it: a board without team roles caps no one']
const NO_APPS = ['names an app by its slug or client ID, keeps it by client ID, and every app as a group', 'name an app in principals to check it: a local board has no apps']
const CROSS_TEAM = ['lets a project on another team in, in its environments', "grants across teams aren't specified yet: what a project on another team needs, and what all-projects means for one, comes later"]
/** And one no run can check: shut out by a lock, it couldn't lift the lock after. */
const LOCKED_OUT = ['lets a member grant on a pattern after a lock under it', "a run can't be shut out by a lock and lift it afterwards: the board's own tests check it"]
const skipped = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.filter((check) => check.status !== 'passed').map((check) => [check.name, check.detail])

/** The tokens check that calls the board with a token's secret. */
const tokenUse = (report: Awaited<ReturnType<typeof conformance>>) =>
  report.checks.find((check) => check.group === 'tokens' && check.name.startsWith('lets a token do what its can says'))

/** A board in front of `fetch` that rewrites what it answers, or what it's asked. */
function broken(fetch: Fetch, change: { request?: (url: URL) => void; body?: (text: string) => string }): Fetch {
  return async (request) => {
    const url = new URL(request.url)
    change.request?.(url)
    const response = await fetch(new Request(url, request))
    if (!change.body || !response.headers.get('content-type')?.includes('application/json')) return response
    return new Response(change.body(await response.text()), { status: response.status, headers: response.headers })
  }
}

/** A board in front of `fetch` from before `path`: a registration drops it, as its schema did. */
function withoutPath(fetch: Fetch): Fetch {
  return async (request) => {
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/watchers')) return fetch(request)
    const { path: _path, ...body } = await request.json()
    return fetch(new Request(request, { body: JSON.stringify(body) }))
  }
}

/**
 * A board in front of `fetch` that wakes by path, as the team board does: it refuses a path from a
 * person, and keeps one (and a preview's branch) as a URL on a host that never resolves, which it
 * shows as the path.
 */
function wakingByPath(fetch: Fetch): Fetch {
  const host = 'https://path.invalid'
  return async (request) => {
    const url = new URL(request.url)
    let forwarded = request
    if (request.method === 'POST' && url.pathname.endsWith('/watchers')) {
      const { path, branch, ...body } = await request.json()
      const claims = JSON.parse(Buffer.from(request.headers.get('authorization')!.split('.')[1]!, 'base64url').toString())
      if (path && claims.user_id) return Response.json({ error: { code: 'not_a_project', message: "a path is on the caller's own project" } }, { status: 403 })
      const at = `${host}${path}${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`
      forwarded = new Request(request, { body: JSON.stringify(path ? { ...body, url: at } : body) })
    }
    const response = await fetch(forwarded)
    if (!response.headers.get('content-type')?.includes('application/json')) return response
    let text = (await response.text()).replace(
      /"url":"https:\/\/path\.invalid([^"?]*)(?:\?branch=([^"]*))?"/g,
      (_, path: string, branch?: string) => `"url":null,"path":${JSON.stringify(path)}${branch ? `,"branch":${JSON.stringify(decodeURIComponent(branch))}` : ''}`,
    )
    if (request.method === 'GET' && url.pathname.replace(/\/$/, '') === new URL(BOARD_URL).pathname) text = text.replace(/^\{/, '{"wake_by_path":true,')
    return new Response(text, { status: response.status, headers: response.headers })
  }
}

/** The watcher and sync checks' statuses, in order. */
const watcherStatuses = (report: Awaited<ReturnType<typeof conformance>>) =>
  report.checks.filter((check) => check.group === 'watchers' || check.group === 'sync').map((check) => check.status)

describe('the conformance kit', () => {
  it('passes a board on a2(), checking the whole protocol, and deletes what it posted', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const client = await clientOf(board.fetch)
    const report = await conformance(client, { withToken: withToken(board.fetch) })
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
    expect(skipped(report)).toEqual([NO_ROLES, NO_APPS, LOCKED_OUT, CROSS_TEAM])
    expect(tokenUse(report)?.status).toBe('passed')
    expect(report).toMatchObject({ ok: true, url: BOARD_URL })
    // Every grant it made is gone, the ones that closed a pattern to everyone included.
    expect((await client.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
    expect([...new Set(report.checks.map((check) => check.group))]).toEqual(['core', 'schedules', 'grants', 'tokens', 'attachments', 'watchers', 'sync'])
    const { messages } = await client.messages({ channel: 'conformance', limit: 500 })
    expect(messages.filter((message) => !message.deleted)).toEqual([])
  })

  it("passes through a board's own handle, in-process", async () => {
    const team = testBoard({ scheduler: fakeQueue().scheduler })
    const report = await conformance(team, { withToken: withToken(team.fetch) })
    // The board's own code needs no grant to keep it in what it closes.
    expect(skipped(report)).toEqual([NO_ROLES, NO_APPS, LOCKED_OUT, CROSS_TEAM])
    expect((await team.me()).actor).toBe('board:client')
  })

  it("fails a board whose tokens do more than their can says, and skips the check where it can't call the board with one", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    // A board that takes a token for whoever minted it, unnarrowed.
    const person = await personToken()
    const unnarrowed: Fetch = (request) => {
      if (!request.headers.get('authorization')?.startsWith('Bearer board_')) return board.fetch(request)
      const headers = new Headers(request.headers)
      headers.set('authorization', `Bearer ${person}`)
      return board.fetch(new Request(request, { headers }))
    }
    const report = await conformance(await clientOf(board.fetch), { withToken: withToken(unnarrowed) })
    expect(tokenUse(report)).toMatchObject({ status: 'failed', detail: 'what a token that may only read says it may do: expected {"conformance":["read"]}, got {"*":["read","post","react","label","sync","manage"]}' })
    expect(tokenUse(await conformance(await clientOf(board.fetch)))).toMatchObject({ status: 'skipped', detail: "this run can't call the board with a token's secret" })
  })

  it("leaves a token's registration as it was: one with watchers or a sync is skipped, and an empty one keeps its URL", async () => {
    const board = await grantingV0()
    const v0 = caller(board.fetch, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production'))
    const registered = async () => (await v0('GET', '/watchers')).body.watchers.map(({ hash: _hash, ...rest }: { hash: string }) => rest)
    for (const registration of [
      // A project's board on http() that syncs Slack and has no watchers of its own.
      { url: 'https://v0.test/api/board', watch: {}, sync: [{ key: 'slack', platform: 'slack' }] },
      { url: 'https://v0.test/api/board', watch: { fix: { tail: 'feedback', when: 'matches' } }, sync: [] },
    ]) {
      expect((await v0('POST', '/watchers', registration)).status).toBe(200)
      const before = await registered()
      const report = await conformance(asV0)
      // What registers is skipped; noSync and an account lookup register nothing.
      expect(watcherStatuses(report)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'passed'])
      expect(await registered()).toEqual(before)
    }
    // One with nothing in it is checked, and keeps where it's woken.
    const empty = { owner: 'vercel:project:prj_v0:production', url: 'https://v0.test/api/board', watch: {}, sync: [] }
    expect((await v0('POST', '/watchers', { url: empty.url, watch: {} })).status).toBe(200)
    const report = await conformance(asV0)
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
    expect(await registered()).toEqual([empty])
  })

  it('replaces nothing on a board from before `path`, which reads one as a registration with nothing in it', async () => {
    const older = withoutPath((await grantingV0()).fetch)
    const v0 = caller(older, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(older, () => deploymentToken('v0', 'prj_v0', 'production'))
    const watching = { url: 'https://v0.test/api/board', watch: { fix: { tail: 'feedback', when: 'matches' } }, sync: [] }
    expect((await v0('POST', '/watchers', watching)).status).toBe(200)
    expect(watcherStatuses(await conformance(asV0))).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'passed'])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([watching])
    // An empty one fails the check, since the board took the path, and keeps where it's woken.
    expect((await v0('POST', '/watchers', { url: watching.url, watch: {} })).status).toBe(200)
    const report = await conformance(asV0)
    expect(report.checks.filter((check) => check.status === 'failed')).toMatchObject([
      { name: 'wakes by path only where its discovery says so, and only a Vercel project', detail: 'a path, on a board that wakes only urls: expected 501 no_wake_by_path, and it succeeded' },
    ])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([{ url: watching.url, watch: {} }])
  })

  it("passes a board that wakes by path, which a project registers on and gets back, and refuses anyone else's", async () => {
    const byPath = wakingByPath((await grantingV0()).fetch)
    const v0 = caller(byPath, await deploymentToken('v0', 'prj_v0', 'production'))
    expect((await v0('POST', '/watchers', { path: '/api/board', watch: {} })).status).toBe(200)
    const report = await conformance(await clientAs(byPath, () => deploymentToken('v0', 'prj_v0', 'production')))
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, path: '/api/board', watch: {} }])
    // A person's token names no project to wake.
    const person = await conformance(await clientOf(wakingByPath(testBoard({ scheduler: fakeQueue().scheduler }).fetch)))
    expect(watcherStatuses(person)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
  })

  it("checks a preview's path with its branch, and gives the branch back", async () => {
    const byPath = wakingByPath((await grantingV0('preview')).fetch)
    const preview = caller(byPath, await deploymentToken('v0', 'prj_v0', 'preview'))
    expect((await preview('POST', '/watchers', { path: '/api/board', branch: 'jb/watchers', watch: {} })).status).toBe(200)
    const report = await conformance(await clientAs(byPath, () => deploymentToken('v0', 'prj_v0', 'preview')))
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
    expect((await preview('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, path: '/api/board', branch: 'jb/watchers', watch: {} }])
  })

  it('reports schedules and files as not kept here on a board without a scheduler or a blob store', async () => {
    // A board on a2() with only its store answers 501 for each, and the kit reads that.
    const bare = testBoard({ blob: undefined })
    const report = await conformance(await clientOf(bare.fetch), { withToken: withToken(bare.fetch) })
    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => check.status !== 'passed').map((check) => [check.group, check.status, check.detail])).toEqual([
      ['schedules', 'skipped', "not kept here: this board has no scheduler, so it can't send later"],
      ['schedules', 'skipped', "not kept here: this board has no scheduler, so it can't send later"],
      ['grants', 'skipped', NO_ROLES[1]],
      ['grants', 'skipped', NO_APPS[1]],
      ['grants', 'skipped', LOCKED_OUT[1]],
      ['grants', 'skipped', CROSS_TEAM[1]],
      ['attachments', 'skipped', 'not kept here: this board keeps no files'],
    ])
  })

  it('leaves the grants as it found them as a project, which a grant keeps in what it closes, and as a run no grant could keep in, which skips closing', async () => {
    const team = await ownPrincipals()
    const grantIds = async () => (await team.grants()).map((grant) => grant.id)
    const before = await grantIds()
    const asProject = await conformance(await clientAs(team.fetch, () => deploymentToken('v0', 'prj_v0', 'production')))
    expect(asProject.checks.filter((check) => check.group === 'grants' && check.status === 'failed')).toEqual([])
    expect(await grantIds()).toEqual(before)
    const asRun = await conformance(await clientAs(team.fetch, () => workflowToken()))
    expect(asRun.checks.filter((check) => check.detail?.startsWith('closing a pattern to everyone')).map((check) => check.name)).toEqual([
      'lets the most specific pattern decide, then the closest principal there, and adds up ties',
      'lets everyone narrow what something else lets in, and lets no one in itself',
    ])
    expect(await grantIds()).toEqual(before)
  })

  it('makes every grant inside conformance/grants/, and no channel but the one it posts in', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const patterns: string[] = []
    // Every grant write it sends, by itself or by a token it minted, refused or not.
    const recording = (fetch: Fetch): Fetch => async (request) => {
      if (/\/grants(\/[^/]+)?$/.test(new URL(request.url).pathname) && ['POST', 'PATCH'].includes(request.method)) patterns.push(...Object.keys((await request.clone().json()).can ?? {}))
      return fetch(request)
    }
    const report = await conformance(await clientOf(recording(board.fetch)), { withToken: withToken(recording(board.fetch)) })
    expect(report.ok).toBe(true)
    expect(patterns.length).toBeGreaterThan(20)
    expect(patterns.filter((pattern) => !pattern.startsWith('conformance/grants/'))).toEqual([])
    expect((await board.channels()).map((channel) => channel.path)).toEqual(['conformance'])
  })

  it('refuses principals that are its own before it writes anything, which the checks would change under it', async () => {
    const team = await ownPrincipals()
    const before = (await team.grants()).map((grant) => grant.id)
    const asProject = await clientAs(team.fetch, () => deploymentToken('v0', 'prj_v0', 'production'))
    await expect(conformance(asProject, { principals: { project: 'prj_v0' } })).rejects.toThrow("principals.project is this run's own project, prj_v0")
    expect((await team.messages({ channel: 'conformance', limit: 10 })).messages).toEqual([])
    expect((await team.grants()).map((grant) => grant.id)).toEqual(before)
    const asRun = await clientAs(team.fetch, () => workflowToken())
    await expect(conformance(asRun, { principals: { repository: 'acme/web' } })).rejects.toThrow("principals.repository is this run's own repository, acme/web")
  })

  it("fails a board that lets a token grant past its can, and still revokes what that board made", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    // A board that takes a token for whoever minted it, unnarrowed.
    const person = await personToken()
    const unnarrowed: Fetch = (request) => {
      if (!request.headers.get('authorization')?.startsWith('Bearer board_')) return board.fetch(request)
      const headers = new Headers(request.headers)
      headers.set('authorization', `Bearer ${person}`)
      return board.fetch(new Request(request, { headers }))
    }
    const report = await conformance(await clientOf(board.fetch), { withToken: withToken(unnarrowed) })
    const find = (start: string) => report.checks.find((check) => check.name.startsWith(start))
    expect(find('lets no token grant past its own can')).toMatchObject({ status: 'failed', detail: 'a grant on conformance/grants/ from a token kept out of conformance/grants/secret/: expected 403, and it made the grant' })
    expect(find('lets no token let anyone in')).toMatchObject({ status: 'failed', detail: 'a grant from a token kept out of conformance/grants/open/, which everyone reads: expected 403, and it made the grant' })
    expect((await board.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it("fails a check whose grants it can't revoke, and one whose token the board answers otherwise than minting none", async () => {
    const stuck = testBoard({ scheduler: fakeQueue().scheduler })
    const revokes = (status: number): Fetch => async (request) =>
      request.method === 'POST' && /\/grants\/[^/]+\/revoke$/.test(new URL(request.url).pathname) ? Response.json({ error: { code: 'error', message: 'down' } }, { status }) : stuck.fetch(request)
    const report = await conformance(await clientOf(revokes(500)), { withToken: withToken(stuck.fetch) })
    expect(report.checks.find((check) => check.name === 'grants a principal, lists it, and revokes it')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/couldn't revoke what it made: g\d+ \(/) })
    const plain = testBoard({ scheduler: fakeQueue().scheduler })
    const mints = (status: number): Fetch => async (request) =>
      request.method === 'POST' && new URL(request.url).pathname.endsWith('/tokens') ? Response.json({ error: { code: 'error', message: 'down' } }, { status }) : plain.fetch(request)
    const manage = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name.startsWith('takes manage at each pattern'))
    expect(manage(await conformance(await clientOf(mints(500)), { withToken: withToken(plain.fetch) }))).toMatchObject({ status: 'failed' })
    for (const status of [403, 404, 501])
      expect([status, manage(await conformance(await clientOf(mints(status)), { withToken: withToken(plain.fetch) }))]).toMatchObject([status, { status: 'skipped', detail: 'this board mints no tokens to check with: down' }])
  }, 30_000)

  it('fails a board that lets a grant on * decide a subtree everyone is closed out of, or adds up grants across levels', async () => {
    const decides = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name.startsWith('lets the most specific pattern decide'))
    // A board whose explain says the least specific pattern decided.
    const loose = testBoard({ scheduler: fakeQueue().scheduler })
    const star = broken(loose.fetch, { body: (text) => text.replace('"pattern":"conformance/grants/closed/"', '"pattern":"*"') })
    expect(decides(await conformance(await clientOf(star)))).toMatchObject({ status: 'failed', detail: 'the pattern that decides conformance/grants/closed/thread: expected "conformance/grants/closed/", got "*"' })
    // One that says what everyone gives where a closer grant decides.
    const flat = testBoard({ scheduler: fakeQueue().scheduler })
    const everyone = broken(flat.fetch, { body: (text) => text.replace('"level":"principal"', '"level":"everyone"') })
    expect(decides(await conformance(await clientOf(everyone)))).toMatchObject({ status: 'failed', detail: expect.stringContaining('the level that decides conformance/grants/') })
  })

  it('fails a board that lets everyone in on its own', async () => {
    const find = (report: Awaited<ReturnType<typeof conformance>>, start: string) => report.checks.find((check) => check.name.startsWith(start))
    // A board whose explain gives what everyone's grant says to a principal nothing else lets in.
    const open = testBoard({ scheduler: fakeQueue().scheduler })
    const admits = broken(open.fetch, { body: (text) => (text.includes('"pattern":null') ? text.replace('"can":[]', '"can":["read"]') : text) })
    expect(find(await conformance(await clientOf(admits)), 'lets everyone narrow')).toMatchObject({ status: 'failed', detail: `what everyone's grant gives them: expected [], got ["read"]` })
  })

  it("fails a board whose inbox acks nothing, or queues a platform's retry as a new event", async () => {
    const inboxCheck = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name.startsWith("queues a platform thread's events"))
    // An ack that answers ok and changes nothing: the thread's next event never comes.
    const acking = testBoard({ scheduler: fakeQueue().scheduler })
    const noAck: Fetch = async (request) =>
      request.method === 'POST' && /\/inbox\/[^/]+\/[^/]+\/ack$/.test(new URL(request.url).pathname) ? Response.json({ ok: true }) : acking.fetch(request)
    expect(inboxCheck(await conformance(await clientOf(noAck)))).toMatchObject({ status: 'failed', detail: 'the events leased from the platform thread, for message 2: expected 1, got 0' })
    // Each push under a new ID, so the platform's retry is queued again.
    const queueing = testBoard({ scheduler: fakeQueue().scheduler })
    const renamed: Fetch = async (request) => {
      if (request.method !== 'POST' || !/\/inbox\/[^/]+$/.test(new URL(request.url).pathname)) return queueing.fetch(request)
      const body = (await request.json()) as { events: { id: string }[] }
      const events = body.events.map((event) => ({ ...event, id: `${event.id}-${crypto.randomUUID()}` }))
      return queueing.fetch(new Request(request, { body: JSON.stringify({ ...body, events }) }))
    }
    expect(inboxCheck(await conformance(await clientOf(renamed)))).toMatchObject({ status: 'failed', detail: 'the events leased once both are acked: expected 0, got 1' })
  })

  it('skips the @sync check for a token that syncs elsewhere, but not where the kit posts', async () => {
    const can = { conformance: ['read', 'post', 'react', 'label'], 'elsewhere/': ['sync'] } as const
    const board = await grantingV0('production', can)
    const report = await conformance(await clientAs(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production')))
    expect(report.checks.find((check) => check.name === 'hands a sync each message change as a match of its @sync watcher')).toMatchObject({
      status: 'skipped',
      detail: "this token can't sync in conformance",
    })
  })

  it('fails a board that answers only part of the protocol any other way', async () => {
    // Schedules that are missing, not refused, and files the board takes but loses.
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const partial = broken(board.fetch, { request: (url) => url.pathname.endsWith('/schedules') && (url.pathname = url.pathname.replace(/schedules$/, 'nowhere')) })
    const report = await conformance(await clientOf(partial))
    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.group, check.name])).toEqual([
      ['schedules', 'schedules a reply, lists it, and cancels it'],
      ['schedules', 'keeps noSync on a schedule, so its sends stay off every platform'],
    ])
  })

  it('fails a board that shows its IDs as numbers', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const numeric = broken(board.fetch, { body: (text) => text.replace(/"(id|re)":"(\d+)"/g, '"$1":$2') })
    const report = await conformance(await clientOf(numeric))
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'posts a message, and reads it back by its ID')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining("a message's id should be a string of 1 to 128 characters, got 2"),
    })
  })

  it("fails a board whose reads ignore where they're asked to start", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const ignoring = broken(board.fetch, { request: (url) => url.pathname.endsWith('/messages') && url.searchParams.delete('after') })
    const report = await conformance(await clientOf(ignoring))
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.name, check.detail])).toEqual([
      ['reads a channel after a cursor or a message ID, oldest first', 'reading after a message should leave it out'],
    ])
  })

  it("reports a board whose discovery doesn't say where it is", async () => {
    const board = testBoard()
    const nameless = broken(board.fetch, { body: (text) => (text.includes('"audience"') ? text.replace(/"audience":"[^"]*",?/, '') : text) })
    const report = await conformance(await clientOf(nameless))
    expect(report).toMatchObject({
      ok: false,
      checks: [{ name: 'says in its discovery where it is', status: 'failed', detail: expect.stringContaining('discovery should have url, audience, and sync') }],
    })
  })
})
