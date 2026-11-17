import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { oidcTokens, type CallerRequest, type HostPrincipal } from '../src/access/index.ts'
// The engine itself, as a2() starts it: these tests are about what it does.
import { mount as board, type MountOptions } from './harness.ts'
import { fakeQueue } from './queue.ts'
import { BOARD_URL, caller, deploymentToken, PROJECT_ID, personToken, testAuth, testBoard } from './harness.ts'

/** A host's credentials: opaque platform tokens it verifies itself, each naming a team. */
const PLATFORM: Record<string, { team: string; principal: HostPrincipal }> = {
  pt_ada: { team: 'team_a', principal: { id: 'vercel:user:u_ada', kind: 'person', handle: 'user-ada' } },
  pt_bob: { team: 'team_b', principal: { id: 'vercel:user:u_bob', kind: 'person', handle: 'user-bob' } },
  pt_carol: { team: 'team_a', principal: { id: 'vercel:user:u_carol', kind: 'person', handle: 'user-carol' } },
  // A host that names its people as a local board does: they're people, never its owner.
  pt_mallory: { team: 'team_a', principal: { id: 'local:user:mallory', kind: 'person', handle: 'mallory' } },
  pt_deploy: { team: 'team_a', principal: { id: 'vercel:project:prj_app:production', kind: 'deployment', handle: 'app' } },
  pt_guest: { team: 'team_a', principal: { id: 'support:customer:99', kind: 'external', handle: 'customer-99' } },
}

/** What a grant names a host's deployment by: the project and environment its ID says. */
const APP = { principals: [{ kind: 'project' as const, project: 'prj_app', environments: ['production'] }] }

/** Who a request is, as a host's own credentials say: only on its own team's board. */
const authenticate = (team: string) => (request: CallerRequest) => {
  const token = request.credential ?? ''
  const found = PLATFORM[token]
  if (!found || found.team !== team) return Response.json({ error: { code: 'not_found', message: 'no board here' } }, { status: 404 })
  return found.principal
}

/** One board per team, like a host would build them, each answering only for its own team. */
function hosted(team: string, options: Partial<MountOptions> = {}) {
  return board({
    store: memory(),
    url: BOARD_URL,
    // The host's own project: its tokens must get nothing unless `authenticate` names them.
    authenticate: authenticate(team),
    ...options,
  })
}

describe("a host's authenticate", () => {
  it("puts a host's people through the grants like anyone: a lock shuts them out, a grant on them lets them in", async () => {
    const tenant = board({ store: memory(), url: BOARD_URL, authenticate: authenticate('team_a') })
    const ada = caller(tenant.fetch, 'pt_ada')
    const carol = caller(tenant.fetch, 'pt_carol')
    // g1 lets both in, as every person: Ada lets Carol into security/, then closes it to everyone, herself included.
    expect((await ada('POST', '/channels', { path: 'security' })).status).toBe(201)
    expect((await ada('POST', '/grants', { principals: [{ kind: 'user', userId: 'u_carol' }], can: { 'security/': 'all' } })).status).toBe(200)
    expect((await ada('POST', '/grants', { principals: [{ kind: 'everyone' }], can: { 'security/': [] }, lockMeOut: true })).status).toBe(200)
    expect((await carol('POST', '/messages', { channel: 'security', text: 'in' })).status).toBe(201)
    expect((await ada('POST', '/messages', { channel: 'security', text: 'out' })).status).toBe(403)
    expect((await ada('GET', '/me')).body.can).toMatchObject({ '*': ['read', 'post', 'react', 'label', 'sync', 'manage'], 'security/': [] })
    // One the host names local:user: is a person like Ada: it can't lift the lock for itself.
    const mallory = caller(tenant.fetch, 'pt_mallory')
    expect((await mallory('POST', '/grants', { principals: [{ kind: 'user', userId: 'mallory' }], can: { 'security/': 'all' } })).status).toBe(403)
    expect((await mallory('POST', '/messages', { channel: 'security', text: 'in?' })).status).toBe(403)
  })

  it("trusts nothing built in: the host project's own person and deployment tokens get no access", async () => {
    const tenant = hosted('team_a')
    for (const token of [await personToken(), await deploymentToken('board', PROJECT_ID)]) {
      const call = caller(tenant.fetch, token)
      expect((await call('GET', '/messages')).status).toBe(404)
      expect((await call('POST', '/messages', { channel: 'dev', text: 'hi' })).status).toBe(404)
    }
  })

  it("accepts who it names, with no audience check, and keeps its handle over the one the CLI sends", async () => {
    const ada = caller(hosted('team_a').fetch, 'pt_ada', { 'x-board-profile': 'pi' })
    const me = await ada('GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ principal: 'vercel:user:u_ada', actor: 'vercel:user:u_ada+pi', handle: 'user-ada/pi', expiresAt: null })
  })

  it('carries its principal through reads, writes, tails and SSE', async () => {
    const tenant = hosted('team_a')
    const ada = caller(tenant.fetch, 'pt_ada', {})
    const posted = await ada('POST', '/messages', { channel: 'dev', text: 'one' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by.principal).toBe('vercel:user:u_ada')
    expect((await ada('POST', `/messages/${posted.body.message.id}/labels`, { set: { kind: 'bug' } })).status).toBe(200)

    expect((await ada('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)).toEqual(['one'])
    expect((await ada('GET', `/messages/${posted.body.message.id}`)).body.message.labels).toEqual({ kind: 'bug' })
    const tail = await ada('GET', '/events?after=0&channel=dev')
    expect(tail.body.events.map((e: { type: string }) => e.type)).toContain('message.posted')

    const controller = new AbortController()
    const response = await tenant.fetch(
      new Request(`${BOARD_URL}/events?after=0`, {
        headers: { authorization: 'Bearer pt_ada', accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    )
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('"text":"one"')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(text).toContain('"text":"one"')
    controller.abort()
  })

  it('gives a deployment it names what a grant gives its ID, per channel', async () => {
    const tenant = hosted('team_a')
    await caller(tenant.fetch, 'pt_ada')('POST', '/messages', { channel: 'dev', text: 'one' })
    await tenant.createGrant({ ...APP, can: { 'feedback/': ['post'] } })
    // Write-only, in one subtree: it posts feedback and reads nothing.
    const deploy = caller(tenant.fetch, 'pt_deploy')
    expect((await deploy('POST', '/messages', { channel: 'feedback/app', text: 'from the app' })).status).toBe(201)
    expect((await deploy('POST', '/messages', { channel: 'dev', text: 'elsewhere' })).status).toBe(403)
    expect((await deploy('GET', '/messages')).body.messages).toEqual([])
  })

  it("keeps two tenants' boards apart", async () => {
    const a = hosted('team_a')
    const b = hosted('team_b')
    await caller(a.fetch, 'pt_ada')('POST', '/messages', { channel: 'dev', text: 'team a only' })
    const bob = caller(b.fetch, 'pt_bob')
    expect((await bob('GET', '/messages')).body.messages).toEqual([])
    // Ada's credentials don't open team b's board.
    expect((await caller(b.fetch, 'pt_ada')('GET', '/messages')).status).toBe(404)
  })

  it('rejects with the Response it throws, and fails on a principal that breaks the ID scheme', async () => {
    const thrown = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => {
        throw new Response('{"error":"nope"}', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
      },
    })
    const rejected = await thrown.fetch(new Request(`${BOARD_URL}/messages`))
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get('www-authenticate')).toBe('Bearer')

    const malformed = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => ({ id: 'ada+pi', kind: 'person', handle: 'ada' }),
    })
    expect((await caller(malformed.fetch, 'x')('GET', '/messages')).status).toBe(500)
    // `]` would end an exact mention, `@[<actor id>]`, so nobody could mention it.
    const unmentionable = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => ({ id: 'vercel:user:a]b', kind: 'person', handle: 'ada' }),
    })
    expect((await caller(unmentionable.fetch, 'x')('GET', '/messages')).status).toBe(500)

    const expired = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada', expiresAt: new Date(0) }),
    })
    expect((await caller(expired.fetch, 'x')('GET', '/messages')).status).toBe(401)
  })

  it("recognizes a page's own session from its headers, with no token", async () => {
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      // A same-site page's `fetch` sends its cookie: the host knows whose session it is.
      authenticate: (request) =>
        request.headers.get('cookie') === 'session=ada'
          ? { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }
          : Response.json({ error: { code: 'unauthorized', message: 'sign in' } }, { status: 401 }),
    })
    const page = (cookie: string) => tenant.fetch(new Request(`${BOARD_URL}/me`, { headers: { cookie, 'x-board-profile': 'page' } }))
    expect(await (await page('session=ada')).json()).toMatchObject({ actor: 'vercel:user:u_ada+page', principal: 'vercel:user:u_ada' })
    expect((await page('session=eve')).status).toBe(401)
  })

  it("gives its people everything, and anyone else it names nothing until a grant does", async () => {
    const tenant = hosted('team_a')
    // A person the host vouches for is a person: everything, as the board's own people.
    expect((await caller(tenant.fetch, 'pt_ada')('GET', '/me')).body.can).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] })
    // A deployment it names gets what a grant gives its ID: none here, and it hears which would.
    expect((await caller(tenant.fetch, 'pt_deploy')('GET', '/me')).body.error).toEqual({
      code: 'forbidden',
      message: "this token can't use this board: no grant lets in project prj_app in production",
      hint: 'Grant it: vb grants create --project prj_app --environment production',
    })
    // `external` gets everything only as a platform user sync writes as: one the host names, nothing.
    expect((await caller(tenant.fetch, 'pt_guest')('GET', '/me')).body).toMatchObject({ error: { code: 'forbidden', message: "this token can't use this board" } })
  })

  it("composes with vb's tokens: a session cookie, or a bearer token, and nothing is a 401", async () => {
    const tokens = oidcTokens(testAuth)
    // The host's session: null when the request carries none, so the next verifier gets it.
    const staff = (request: CallerRequest) =>
      request.headers.get('cookie') === 'session=ada' ? ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } as const) : null
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: async (request) => (await staff(request)) ?? (await tokens(request)),
    })
    const me = async (headers: Record<string, string>) => {
      const response = await tenant.fetch(new Request(`${BOARD_URL}/me`, { headers }))
      return { status: response.status, body: await response.json() }
    }
    expect(await me({ cookie: 'session=ada' })).toMatchObject({ status: 200, body: { principal: 'vercel:user:u_ada' } })
    expect(await me({ authorization: `Bearer ${await personToken()}` })).toMatchObject({ status: 200, body: { principal: 'vercel:user:u_julian' } })
    // A token that fails is refused, not passed over.
    expect(await me({ authorization: `Bearer ${await personToken('u_julian', 'https://elsewhere.test/api/board')}` })).toMatchObject({
      status: 401,
      body: { error: { code: 'unauthorized', message: expect.stringMatching(/^invalid token: /) } },
    })
    expect(await me({})).toMatchObject({ status: 401, body: { error: { code: 'unauthorized', message: 'missing bearer token' } } })
  })
})

/** An app's own site: its session cookie names staff and customers, people in its own ID scheme, and `vb`'s tokens still work. */
function supportBoard() {
  const tokens = oidcTokens(testAuth)
  const session = (request: CallerRequest): HostPrincipal | null => {
    const cookie = request.headers.get('cookie') ?? ''
    if (cookie === 'session=staff-ada') return { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }
    const customer = /^session=customer-(\d+)$/.exec(cookie)?.[1]
    return customer ? { id: `support:customer:${customer}`, kind: 'person', handle: `customer-${customer}` } : null
  }
  return board({
    store: memory(),
    url: BOARD_URL,
    authenticate: async (request) => session(request) ?? (await tokens(request)),
  })
}

const asCookie = (tenant: { fetch(request: Request): Promise<Response> }, cookie: string) => async (method: string, path: string, body?: unknown) => {
  const response = await tenant.fetch(
    new Request(`${BOARD_URL}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  )
  return { status: response.status, body: await response.json() }
}

/** What a grant names the sync's deployment by. */
const SYNC = { principals: [{ kind: 'project' as const, project: 'prj_sync', environments: ['production'] }], can: { '*': 'all' as const } }

describe("a host's own ID scheme", () => {
  it("keeps a sync from writing as a host's principal, or as the watchers it registered, whatever platform it names", async () => {
    const tenant = supportBoard()
    await tenant.createGrant(SYNC)
    const customer = asCookie(tenant, 'session=customer-99')
    const staff = asCookie(tenant, 'session=staff-ada')
    expect((await customer('POST', '/watchers', { watch: { inbox: { tail: 'support/' } } })).status).toBe(200)
    expect((await customer('POST', '/messages', { channel: 'support/billing', text: 'my invoice is wrong' })).status).toBe(201)
    expect((await staff('POST', '/messages', { channel: 'support/billing', text: 'on it' })).status).toBe(201)
    // A sync that says its platform is `support`, or `vercel`'s like, speaks for neither.
    const sync = caller(tenant.fetch, await deploymentToken('sync', 'prj_sync'))
    expect((await sync('POST', '/watchers', { watch: {}, sync: [{ key: 'support', platform: 'support' }] })).status).toBe(200)
    const as = (id: string) => sync('POST', '/sync/imports', { op: 'post', author: { id, handle: 'x', name: 'X', avatar: null, isBot: false }, from: 'support', channel: 'support/billing', text: `as ${id}` })
    // Its watcher's own writes don't wake it, so an import as it would hide what it says from it.
    for (const id of ['support:customer:99+inbox', 'support:customer:99']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error?.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
    }
    expect((await as('support:user:7')).status).toBe(200)
  })

  it("keeps a sync from writing as a host's principal that wrote, or its profiles, though it registered nothing", async () => {
    const tenant = supportBoard()
    await tenant.createGrant(SYNC)
    // Two of the host's principals write, one as a profile of its own, and neither registers anything.
    const write = (cookie: string, headers: Record<string, string> = {}) =>
      tenant.fetch(new Request(`${BOARD_URL}/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ channel: 'support/billing', text: 'refund please' }) }))
    expect((await write('session=customer-42')).status).toBe(201)
    expect((await write('session=customer-43', { 'x-board-profile': 'helper' })).status).toBe(201)
    const sync = caller(tenant.fetch, await deploymentToken('sync', 'prj_sync'))
    expect((await sync('POST', '/watchers', { watch: {}, sync: [{ key: 'support', platform: 'support' }] })).status).toBe(200)
    const as = (id: string) => sync('POST', '/sync/imports', { op: 'post', author: { id, handle: 'x', name: 'X', avatar: null, isBot: false }, from: 'support', channel: 'support/billing', text: `as ${id}` })
    for (const id of ['support:customer:42', 'support:customer:43+helper']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error?.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
    }
    // One the board has never seen is what the access page says to keep out of a sync's reach: an ID scheme no sync registers.
    expect((await as('support:customer:44')).status).toBe(200)
  })

  it("keeps the defaults: a person, and the board's own deployments where it runs, get everything, and its previews need a grant", async () => {
    vi.stubEnv('VERCEL_TARGET_ENV', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    try {
      const tenant = supportBoard()
      // Without g2's every project on the team, its previews included.
      await tenant.revokeGrant('g2')
      const everything = { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] }
      expect((await asCookie(tenant, 'session=staff-ada')('GET', '/me')).body).toMatchObject({ principal: 'vercel:user:u_ada', can: everything })
      expect((await caller(tenant.fetch, await personToken())('GET', '/me')).body.can).toEqual(everything)
      expect((await caller(tenant.fetch, await deploymentToken('board', PROJECT_ID))('GET', '/me')).body.can).toEqual(everything)
      // Its previews run any branch's code: they aren't a default.
      expect((await caller(tenant.fetch, await deploymentToken('board', PROJECT_ID, 'preview'))('GET', '/me')).body.error).toEqual({
        code: 'forbidden',
        message: "this token can't use this board: it runs in production, and its preview deployments need a grant",
        hint: `Grant them: vb grants create --project ${PROJECT_ID} --environment preview`,
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("schedules from a host's principal", () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  const HOUR = 3_600_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  /** A person the host signs in until `session.until`: there's no request to ask again when a schedule sends. */
  async function setup(until: number) {
    const session = { until }
    const queue = fakeQueue()
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada', expiresAt: new Date(session.until) }),
    })
    const ada = caller(tenant.fetch, 'pt_ada')
    const advance = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      vi.setSystemTime(Date.now() + ms)
      await queue.fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return { ada, advance, session }
  }

  it("send while the host's principal is live", async () => {
    const { ada, advance } = await setup(T0 + 24 * HOUR)
    const { body } = await ada('POST', '/schedules', { channel: 'dev/standup', text: 'standup', in: '1h' })
    await advance(HOUR)
    expect((await ada('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ id: body.schedule.id, state: 'done', sent: 1 }])
    expect((await ada('GET', '/messages?channel=dev/standup')).body.messages).toMatchObject([{ text: 'standup' }])
  })

  it('are revoked once that principal has expired, even for a person', async () => {
    const { ada, advance, session } = await setup(T0 + 2 * HOUR)
    await ada('POST', '/schedules', { channel: 'dev/standup', text: 'standup', in: '3h' })
    await advance(3 * HOUR)
    // The host signs Ada in again, so she can see what happened.
    session.until = Date.now() + HOUR
    expect((await ada('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'canceled', sent: 0, canceled: { reason: 'revoked' } }])
    expect((await ada('GET', '/messages?channel=dev/standup')).body.messages).toEqual([])
  })

  it("ask the board's grants again at each send, and are revoked once they give nothing", async () => {
    const queue = fakeQueue()
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: (request) => (request.headers.get('cookie') === 'session=app' ? { id: 'vercel:project:prj_app:production', kind: 'deployment', handle: 'app' } : null),
    })
    const support = { ...APP, can: { 'support/': ['read' as const, 'post' as const] } }
    const { grant } = await tenant.createGrant(support)
    const app = asCookie(tenant, 'session=app')
    const advance = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      vi.setSystemTime(Date.now() + ms)
      await queue.fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const created = await app('POST', '/schedules', { channel: 'support', text: 'still waiting', every: '1h' })
    expect(created.status).toBe(201)
    await advance(HOUR)
    expect((await app('GET', '/messages?channel=support')).body.messages).toMatchObject([{ text: 'still waiting' }])
    // The grant is revoked: the next send asks, and gets nothing.
    await tenant.revokeGrant(grant.id)
    await advance(HOUR)
    await tenant.createGrant(support)
    expect((await app('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ id: created.body.schedule.id, sent: 1, state: 'canceled', canceled: { reason: 'revoked' } }])
    expect((await app('GET', '/messages?channel=support')).body.messages).toHaveLength(1)
  })
})

describe("a board that switches its verifier", () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  const HOUR = 3_600_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it("revokes a host's principals' schedules once its verifier is the built-in one alone", async () => {
    const store = memory()
    const queue = fakeQueue()
    const before = board({
      store,
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }),
    })
    expect((await caller(before.fetch, 'pt_ada')('POST', '/schedules', { channel: 'dev', text: 'from the host', in: '1h' })).status).toBe(201)

    const after = testBoard({ store, scheduler: queue.scheduler })
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const julian = caller(after.fetch, await personToken())
    expect((await julian('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'canceled', canceled: { reason: 'revoked' } }])
    expect((await julian('GET', '/messages?channel=dev')).body.messages).toEqual([])
  })

  it("keeps sending the board's own code's schedules behind a host's verifier", async () => {
    const queue = fakeQueue()
    const hostedBoard = board({
      store: memory(),
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }),
    })
    await hostedBoard.as('digest').schedule('dev', { text: 'daily digest', in: '1h' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await caller(hostedBoard.fetch, 'pt_ada')('GET', '/messages?channel=dev')).body.messages).toMatchObject([{ text: 'daily digest' }])
  })
})
