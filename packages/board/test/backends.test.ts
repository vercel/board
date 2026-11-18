import { describe, expect, it, vi } from 'vitest'
import { connect } from '../src/client/node.ts'
import { board, HttpError, type Backend, type Caller } from '../src/server/index.ts'
import { oidcTokens } from '../src/access/index.ts'
import { local } from '../src/backend-local/index.ts'
import { http } from '../src/backend-http/index.ts'
import { board as projectBoard, bearer, BOARD_URL, caller, deploymentToken, OIDC_ISS, oidcToken, personToken, signedInHome, testAuth, testBoard } from './harness.ts'

/** Where v0's board is mounted: a board on the team's board, over http(). */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'

/** The team's board, granting v0's and marketing's production, and v0's board using it over http(), calling each other in-process. */
async function team(options: Parameters<typeof http>[1] = {}) {
  const remote = testBoard()
  for (const project of ['prj_v0', 'prj_marketing']) await remote.createGrant({ principals: [{ kind: 'project', project: project, environments: ['production'] }], can: { '*': 'all' } })
  const seen: Request[] = []
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    seen.push(request.clone())
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const project = board({
    backend: http(BOARD_URL, { fetch: bearer(route, () => deploymentToken('v0', 'prj_v0', 'production')), ...options }),
    url: V0_URL,
  })
  return { remote, project, seen }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>, audience?: string) =>
  caller(fetch, await personToken('u_julian', audience), {})

/** Julian, signed in to each board as `vercel login` leaves it, for a client in this process. */
async function signedIn(audiences: string[]) {
  vi.stubEnv('XDG_CONFIG_HOME', await signedInHome(audiences))
  vi.stubEnv('BOARD_TOKEN', '')
  vi.stubEnv('VERCEL', '')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '')
}

describe('board() and its backend', () => {
  it("leaves a write's handles to the team's board, and answers what it said of them", async () => {
    const { remote, project, seen } = await team()
    // Julian has written on the team's board: a Vercel login's handle is its user ID.
    await (await julianOn(remote.fetch))('POST', '/messages', { channel: 'dev', text: 'hi' })
    const before = seen.length
    const posted = await project.post('dev', 'over to @u_julian and @nobody')
    expect(posted.text).toBe('over to @[vercel:user:u_julian] and @nobody')
    expect(posted.mentions).toEqual([
      { written: '@u_julian', actor: { id: 'vercel:user:u_julian', handle: 'u_julian', name: 'u_julian' }, candidates: [] },
      { written: '@nobody', actor: null, candidates: [] },
    ])
    // It read no actors of its own to do it: the team's board knows who it sees.
    expect(seen.slice(before).map((request) => `${request.method} ${new URL(request.url).pathname}`).filter((sent) => sent.includes('/actors'))).toEqual([])
  })

  it("takes a URL, which TypeScript can't check", () => {
    expect(() => http('board.example.com')).toThrow("http: board.example.com isn't a URL")
  })

  it('keeps the board in this process with local(), one board to a backend', async () => {
    const backend = local({ memory: true })
    const here = board({ backend, url: BOARD_URL })
    const discovery = await (await here.fetch(new Request(BOARD_URL))).json()
    expect(discovery).toMatchObject({ url: BOARD_URL })
    expect(discovery.capabilities).toBeUndefined()
    expect(() => board({ backend, url: BOARD_URL })).toThrow('local: this backend already serves a board')
  })

  it('serves the protocol on a backend of your own, calling each method with the caller it verified and its parsed input', async () => {
    const calls: { method: string; caller: Caller; input: unknown }[] = []
    const record = (method: string) => async (caller: Caller, input: unknown) => {
      calls.push({ method, caller, input })
      return { messages: [], cursor: '0' }
    }
    const mine = {
      routes: [{ method: 'GET', path: '/health', handle: async () => Response.json({ ok: true }) }],
      keeps: true,
      bind: () => {},
      threads: record('threads'),
      async post(caller: Caller, input: { channel?: string; text: string }) {
        calls.push({ method: 'post', caller, input })
        if (input.channel === 'missing') throw new HttpError(404, 'message_not_found', 'message not found: #nope')
        return { message: { id: 'm1', channel: input.channel, text: input.text } }
      },
    } as unknown as Backend
    const { fetch } = projectBoard({ backend: mine, authenticate: oidcTokens(testAuth), url: BOARD_URL })
    const token = await personToken()
    const julian = caller(fetch, token, { 'x-board-profile': 'claude', 'x-board-can': 'dev/=read' })

    expect(await julian('GET', '/threads?channel=dev&label=state=open|draft&limit=5')).toEqual({ status: 200, body: { messages: [], cursor: '0' } })
    expect(await julian('POST', '/messages', { channel: 'dev', text: 'hello' })).toMatchObject({ status: 201, body: { message: { id: 'm1' } } })
    expect(calls.map(({ method, input }) => [method, input])).toEqual([
      ['threads', { channel: 'dev', label: [['state', ['open', 'draft']]], limit: 5 }],
      ['post', { channel: 'dev', text: 'hello' }],
    ])
    // Who the request is, as board() verified it: its principal, with what it may do, narrowed by its scope.
    expect(calls[0]!.caller).toMatchObject({
      identity: {
        principal: { id: 'vercel:user:u_julian', kind: 'person', scope: 'dev/=read' },
        author: { actor: 'vercel:user:u_julian+claude', principal: 'vercel:user:u_julian', profile: 'claude' },
        actor: { id: 'vercel:user:u_julian+claude', kind: 'agent', handle: 'u_julian/claude', name: 'claude' },
      },
      origin: { via: { kind: 'api' } },
    })
    const { caller: first } = calls[0]!
    expect('identity' in first && first.identity.principal.access.summary()).toEqual({ 'dev/': ['read'] })

    // What it throws, it answers; what doesn't validate never reaches it.
    expect(await julian('POST', '/messages', { channel: 'missing', text: 'hi' })).toEqual({
      status: 404,
      body: { error: { code: 'message_not_found', message: 'message not found: #nope' } },
    })
    expect((await julian('POST', '/messages', { channel: 'Not A Channel', text: 'hi' })).status).toBe(400)
    expect(calls).toHaveLength(3)

    // A route it doesn't own, protocol or not, isn't there; its own routes are.
    expect((await julian('GET', '/channels')).status).toBe(404)
    expect((await julian('POST', '/wake', {})).status).toBe(404)
    expect(await (await fetch(new Request(`${BOARD_URL}/health`))).json()).toEqual({ ok: true })
    // A request board() can't verify never reaches it, and neither does a claim that doesn't parse.
    expect((await fetch(new Request(`${BOARD_URL}/threads`, { headers: { cookie: 'session=abc' } }))).status).toBe(401)
    expect((await caller(fetch, token, { 'x-board-profile': 'not a profile' })('GET', '/threads')).status).toBe(400)
    expect(calls).toHaveLength(3)

    // Your own code is `{ self }`: the backend decides who that is.
    const own = board({ backend: { ...mine, bind: () => {} } as Backend, url: BOARD_URL })
    await own.threads()
    expect(calls.at(-1)!.caller).toEqual({ self: null, origin: { via: { kind: 'client', name: null } } })
    await own.as('deploys').threads()
    expect(calls.at(-1)!.caller).toEqual({ self: 'deploys', profile: 'deploys', origin: { via: { kind: 'client', name: 'deploys' } } })
  })

  it("hands a backend of your own the board's team and name once, when it binds, and refuses what isn't one", () => {
    const bound: { team: string | null; name: string | null }[] = []
    const mine = () => ({ routes: [], keeps: true, bind: ({ team, name }: { team: string | null; name: string | null }) => void bound.push({ team, name }) }) as unknown as Backend
    board({ backend: mine(), team: 'acme', name: 'security', url: BOARD_URL })
    board({ backend: mine(), team: 'team_acme', url: BOARD_URL })
    board({ backend: mine(), url: BOARD_URL })
    expect(bound).toEqual([{ team: 'acme', name: 'security' }, { team: 'team_acme', name: null }, { team: null, name: null }])
    for (const name of ['', 'acme/security', '/security', 'x'.repeat(65)])
      expect(() => board({ backend: mine(), name, url: BOARD_URL }), name).toThrow("isn't a board's name")
    for (const team of ['', 'acme/web', 'two words']) expect(() => board({ backend: mine(), team, url: BOARD_URL }), team).toThrow("isn't a team")
    expect(bound).toHaveLength(3)
  })

  it('takes a backend made from another, with one method changed', async () => {
    const kept = local({ memory: true })
    const backend: Backend = {
      ...kept,
      async delete() {
        throw new HttpError(403, 'forbidden', 'messages on this board stay')
      },
    }
    const { fetch } = projectBoard({ backend, authenticate: oidcTokens(testAuth), url: BOARD_URL })
    const julian = await julianOn(fetch)
    const id = (await julian('POST', '/messages', { channel: 'dev', text: 'kept' })).body.message.id
    expect(await julian('POST', `/messages/${id}/delete`, {})).toEqual({ status: 403, body: { error: { code: 'forbidden', message: 'messages on this board stay' } } })
    expect((await julian('GET', `/messages/${id}`)).body.message.text).toBe('kept')
  })
})

describe('a board on http()', () => {
  it('answers nothing itself, and its handle reads the board it uses', async () => {
    const { project } = await team()
    const nothing = { error: { code: 'not_found', message: `${V0_URL} answers nothing itself` } }
    // No discovery to send anyone elsewhere: a repo links the team's board itself.
    const discovery = await project.fetch(new Request(V0_URL))
    expect([discovery.status, await discovery.json()]).toEqual([404, nothing])
    expect(await (await julianOn(project.fetch, V0_URL))('GET', '/threads')).toEqual({ status: 404, body: nothing })
    // Its own handle asks the board it uses.
    expect(await project.discovery()).toMatchObject({ url: BOARD_URL, audience: BOARD_URL })
  })

  it('reaches the board it uses with the credentials `vb` finds, minting one for that board', async () => {
    const { remote } = await team()
    await signedIn([BOARD_URL])
    const seen: string[] = []
    const route = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(`${request.method} ${request.url}`)
      return remote.fetch(request)
    }
    const here = board({ backend: http(BOARD_URL, { fetch: connect(BOARD_URL, { fetch: route as typeof fetch }).fetch }) }).as(null)
    expect((await here.me()).principal).toBe('vercel:user:u_julian')
    expect((await here.post('dev', 'from a script')).text).toBe('from a script')
    // Discovery first, for the project to mint for, then the calls, each with the token it minted.
    expect(seen).toEqual([`GET ${BOARD_URL}`, `GET ${BOARD_URL}/me`, `POST ${BOARD_URL}/messages`])
    vi.unstubAllEnvs()
  })

  it("writes from your own code as its deployment, idempotent by the post's id", async () => {
    const { remote, project } = await team()
    const deploys = project.as('deploys')
    await deploys.post('deploys', { text: 'a1b2c3 is live', id: 'd1' })
    await deploys.post('deploys', { text: 'a1b2c3 is live', id: 'd1' })
    await project.as('deploys').post('deploys', { text: 'd4e5f6 is live', id: 'd2' })
    expect((await deploys.posted('d2')).text).toBe('d4e5f6 is live')
    await expect(project.as('deploy_bot').post('deploys', 'x')).rejects.toThrow('start with a letter and use up to 32 letters, numbers, and hyphens')

    const { body } = await (await julianOn(remote.fetch))('GET', '/messages?channel=deploys')
    expect(body.messages.map((message: { text: string; by: { actor: string } }) => [message.text, message.by.actor])).toEqual([
      ['a1b2c3 is live', `${V0}+deploys`],
      ['d4e5f6 is live', `${V0}+deploys`],
    ])
  })

  it("makes a task on the board it uses once for its id, as its deployment, and works it from there", async () => {
    const { remote, project } = await team()
    const deploys = project.as('deploys')
    const first = await deploys.tasks.create('work', { text: 'roll out a1b2c3', id: 'rollout-1', labels: { step: 'deploy' } })
    const again = await project.as('deploys').tasks.create('work', { text: 'roll out a1b2c3', id: 'rollout-1', labels: { step: 'deploy' } })
    expect(again.task.id).toBe(first.task.id)
    // The board it uses keeps the task: this one forwards each call, as the token's holder.
    const claim = await deploys.tasks.claim({ channel: 'work/', label: { step: 'deploy' } })
    expect(claim).toMatchObject({ task: { id: first.task.id }, epoch: 1 })
    expect((await claim!.complete('live')).task).toMatchObject({ state: 'completed', result: 'live' })
    const { body } = await (await julianOn(remote.fetch))('GET', '/tasks?state=all')
    expect(body.tasks.map((t: { message: { text: string; task: { owner: string; state: string }; by: { actor: string } } }) => [t.message.text, t.message.by.actor, t.message.task.owner, t.message.task.state])).toEqual([
      ['roll out a1b2c3', `${V0}+deploys`, V0, 'completed'],
    ])
    expect((await project.tasks.list({ state: 'all' })).tasks.map((t) => t.message.id)).toEqual([first.task.id])
  })

  it('makes several tasks on the board it uses in one write, once for its id, as its deployment', async () => {
    const { remote, project } = await team()
    const deploys = project.as('deploys')
    const plan = [{ key: 'build', text: 'build a1b2c3' }, { text: 'roll out a1b2c3', needs: [{ key: 'build' }], labels: { step: 'deploy' } }]
    const first = await deploys.tasks.createMany('work', plan, { id: 'rollout-1' })
    const again = await project.as('deploys').tasks.createMany('work', plan, { id: 'rollout-1' })
    expect(again.map((root) => root.id)).toEqual(first.map((root) => root.id))
    // The board it uses keeps them: its own handle's id reaches it as this deployment's key, which it takes.
    const { body } = await (await julianOn(remote.fetch))('GET', '/tasks?state=all')
    expect(body.tasks.map((t: { message: { text: string; task: { owner: string; state: string; needs: string[] }; by: { actor: string } } }) => [t.message.text, t.message.by.actor, t.message.task.owner, t.message.task.state, t.message.task.needs])).toEqual([
      ['build a1b2c3', `${V0}+deploys`, V0, 'ready', []],
      ['roll out a1b2c3', `${V0}+deploys`, V0, 'waiting', [first[0]!.id]],
    ])
  })

  it("keeps a handle's post IDs its own, so no one can take one first", async () => {
    const { remote, project } = await team()
    const marketing = caller(remote.fetch, await deploymentToken('marketing', 'prj_marketing', 'production'))
    const taken = await marketing('POST', '/messages', { channel: 'deploys', text: 'mine now', id: `key:${V0}:0123456789abcdef0123456789abcdef` })
    expect(taken).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: `id: key:… IDs derive from a client's key, and this token's are key:vercel:project:prj_marketing:production:…`,
        },
      },
    })
    const own = 'key:vercel:project:prj_marketing:production:0123456789abcdef0123456789abcdef'
    expect((await marketing('POST', '/messages', { channel: 'deploys', text: 'fine', id: own })).status).toBe(201)
    // v0's own post still lands, its ID under its own principal.
    expect((await project.as('deploys').post('deploys', { text: 'a1b2c3 is live', id: 'd1' })).id).toEqual(expect.any(String))
    // Even one it names as someone else's key.
    expect((await project.post('deploys', { text: 'still mine', id: own })).text).toBe('still mine')
  })

  it("keeps a principal's keyed IDs from one whose ID is a colon-prefix of it", async () => {
    // OIDC subjects carry colons, so one principal's ID can be the start of another's.
    const remote = testBoard()
    await remote.createGrant({ principals: [{ kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }], can: { '*': 'all' } })
    const acme = caller(remote.fetch, await oidcToken({ sub: 'acme' }))
    expect((await acme('GET', '/me')).body.principal).toBe('oidc:gitlab.test:acme')
    const theirs = 'key:oidc:gitlab.test:acme:ci:0123456789abcdef0123456789abcdef'
    expect(await acme('POST', '/messages', { channel: 'deploys', text: 'mine now', id: theirs })).toMatchObject({
      status: 400,
      body: { error: { message: "id: key:… IDs derive from a client's key, and this token's are key:oidc:gitlab.test:acme:…" } },
    })
    const ci = caller(remote.fetch, await oidcToken({ sub: 'acme:ci' }))
    expect((await ci('POST', '/messages', { channel: 'deploys', text: 'mine', id: theirs })).status).toBe(201)
  })

  it('checks its watchers the way a local board does, and their IDs as profiles', () => {
    expect(() => board({ backend: http(BOARD_URL), url: V0_URL, watch: { review_pi: { tail: 'prs', run: () => {} } } })).toThrow(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    expect(() => board({ backend: http(BOARD_URL), url: V0_URL, watch: { fix: { tail: 'prs --after 3', run: () => {} } } })).toThrow(
      "watch fix: --after isn't a filter",
    )
  })
})
