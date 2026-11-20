import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { credentialSource, vercel as nodeVercel } from '../src/backend-vercel/index.ts'
import { handFetch, handLogin, handToken } from '../src/client/node.ts'
import { as, fakeMessageboard } from './messageboard.ts'

const API = 'http://localhost'
const AUDIENCE = 'https://api.vercel.com/v1/messageboard'

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A JWT as GitHub or Vercel signs one, unsigned: what a client reads of it is its claims. */
const jwt = (claims: object) => `${part({ alg: 'none' })}.${part({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })}.`

/** A GitHub Actions run's token, and a deployment's, as Vercel's API takes them. */
const RUN = jwt({ repository: 'acme/web', repository_id: '700001', ref: 'refs/heads/main' })
const DEPLOYMENT = jwt({ owner_id: 'team_test' })

let job = 0

/**
 * A GitHub Actions job that may ask for an OIDC token (`permissions: id-token: write`), each with a
 * request token of its own, and Vercel's API: every audience the job asks GitHub for, and the
 * credential each request to the API carries. GitHub answers with `answer`.
 */
function inActions(api: ReturnType<typeof fakeMessageboard>, answer: () => Response = () => Response.json({ value: RUN })) {
  const request = `actions-request-token-${++job}`
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://actions.example/token?api-version=2.0')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', request)
  const asked: { audience: string | null; authorization: string | null }[] = []
  const sent: (string | null)[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (url.origin === 'https://actions.example') {
      asked.push({ audience: url.searchParams.get('audience'), authorization: headers.get('authorization') })
      return answer()
    }
    sent.push(headers.get('authorization'))
    return api.fetch(input, init)
  })
  return { asked, sent, request }
}

describe("a GitHub Actions job on Vercel's board", () => {
  let cwd: string
  let away: string
  beforeEach(async () => {
    for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|ACTIONS_ID_TOKEN|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
    // Nowhere a Vercel project is linked, so nothing but what the test sets names a team.
    cwd = process.cwd()
    away = await mkdtemp(join(tmpdir(), 'board-actions-'))
    process.chdir(away)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    handToken(null)
    handLogin(null)
    handFetch(null)
    process.chdir(cwd)
    await rm(away, { recursive: true, force: true })
  })

  it("sends the job's own OIDC token, made out to Vercel's API, as itself, and asks GitHub once while it's good", async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001' } })
    const { asked, sent, request } = inActions(api)
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    // A login the Vercel CLI left in the environment is below it, and so is the host's fetch for that login.
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_ada')
    const host = vi.fn(as(api, 'user:u_ada'))
    handFetch(host)
    const team = board({ backend: nodeVercel() })
    const posted = await team.post('ci', 'deploy failed on a1b2c3d')
    expect(await team.me()).toMatchObject({ principal: 'github:repo:700001', kind: 'workflow', handle: 'acme/web' })
    expect(credentialSource()).toBe('GitHub Actions OIDC')
    expect((await team.thread(posted.id)).message.by).toEqual({ actor: 'github:repo:700001', principal: 'github:repo:700001', profile: null })
    expect(asked).toEqual([{ audience: AUDIENCE, authorization: `bearer ${request}` }])
    expect(new Set(sent)).toEqual(new Set([`Bearer ${RUN}`]))
    expect(host).not.toHaveBeenCalled()
  })

  it('sends it only when nothing ahead of it applies: an app\'s login, the deployment\'s token, or BOARD_TOKEN', async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001', [DEPLOYMENT]: 'project:prj_pong:production', k7Qe2mXa9vLp: 'user:u_bo' } })
    const { asked } = inActions(api)
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const principal = async () => (await board({ backend: nodeVercel() }).me()).principal

    vi.stubEnv('BOARD_TOKEN', 'k7Qe2mXa9vLp')
    expect([await principal(), credentialSource()]).toEqual(['vercel:user:u_bo', 'BOARD_TOKEN'])
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_OIDC_TOKEN', DEPLOYMENT)
    expect([await principal(), credentialSource()]).toEqual(['vercel:project:prj_pong:production', 'Vercel OIDC'])
    // The app that runs board's CLI says who it runs as, wherever it runs.
    handToken('user:u_jb')
    expect([await principal(), credentialSource()]).toEqual(['vercel:user:u_jb', 'the token you passed'])
    handToken(null)
    handLogin(async () => 'user:u_ada')
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VERCEL_OIDC_TOKEN', '')
    vi.stubEnv('BOARD_TOKEN', '')
    expect([await principal(), credentialSource()]).toEqual(['vercel:user:u_ada', 'the Vercel CLI'])
    expect(asked).toEqual([])
    handLogin(null)
    expect([await principal(), credentialSource()]).toEqual(['github:repo:700001', 'GitHub Actions OIDC'])
  })

  it("isn't a job that may ask for a token without both of GitHub's variables, and goes as your login", async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001' } })
    const { asked } = inActions(api)
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_ada')
    for (const missing of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
      const kept = process.env[missing]
      vi.stubEnv(missing, '')
      expect([(await board({ backend: nodeVercel() }).me()).principal, credentialSource()]).toEqual(['vercel:user:u_ada', 'the Vercel CLI'])
      vi.stubEnv(missing, kept!)
    }
    expect(asked).toEqual([])
  })

  it('says how to name the team when nothing does, since its token names none, and asks the API nothing', async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001' } })
    const { sent } = inActions(api)
    await expect(board({ backend: nodeVercel() }).post('ci', 'deploy failed')).rejects.toMatchObject({
      status: 400,
      code: 'missing_team',
      origin: 'handle',
      message: "A GitHub Actions token names no Vercel team, so there's no team's board to use.",
      hint: 'Pass --scope <team ID>, or set VERCEL_ORG_ID.',
    })
    expect(sent).toEqual([])
    // A team named in code, or in the environment, is the board's.
    expect((await board({ team: 'team_test', backend: nodeVercel() }).me()).principal).toBe('github:repo:700001')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    expect((await board({ backend: nodeVercel() }).me()).principal).toBe('github:repo:700001')
  })

  it('holds only the requests it sends the token with to a team: a board({ fetch }) with credentials of its own uses their default team', async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001' } })
    const { asked } = inActions(api)
    const own = vi.fn(as(api, 'user:u_ada'))
    await expect(board({ backend: nodeVercel({ fetch: own }) }).me()).resolves.toMatchObject({ principal: 'vercel:user:u_ada' })
    expect(own).toHaveBeenCalled()
    expect(asked).toEqual([])
  })

  it("never sends the job's token anywhere but Vercel's API, and never asks GitHub for one to send there", async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001' } })
    const { asked, sent } = inActions(api)
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    await expect(board({ backend: nodeVercel({ api: 'https://api.example.com' }) }).post('ci', 'deploy failed')).rejects.toMatchObject({
      status: 400,
      code: 'wrong_audience',
      origin: 'handle',
    })
    expect(asked).toEqual([])
    expect(sent).toEqual([])
  })

  it("says why GitHub gave no token, as the handle's own error, not that Vercel's API didn't answer", async () => {
    const api = fakeMessageboard({ tokens: { [RUN]: 'github:repo:700001' } })
    const { sent } = inActions(api, () => Response.json({ message: 'Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable' }, { status: 403 }))
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    await expect(board({ backend: nodeVercel() }).post('ci', 'deploy failed')).rejects.toMatchObject({
      code: 'no_token',
      origin: 'handle',
      message: 'GitHub Actions refused an OIDC token (403).',
      hint: 'Give the job `permissions: id-token: write`.',
    })
    expect(sent).toEqual([])
  })
})

describe("workflows Vercel's API names", () => {
  const SUBJECT = 'project_path:acme/api:ref_type:branch:ref:main'
  const callers = {
    run: { principal: 'github:repo:700001', kind: 'workflow', handle: 'acme/web' },
    issuer: { principal: `oidc:gitlab.com:${SUBJECT}`, kind: 'workflow', handle: SUBJECT },
  } as const
  const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal: string) => board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal) }) })

  it('shows a GitHub Actions run by its repository and another issuer\'s caller by its subject, as what they wrote and as themselves', async () => {
    const api = fakeMessageboard()
    for (const { principal, kind, handle } of Object.values(callers)) {
      const caller = handleOn(api, principal)
      const posted = await caller.post('ci', `from ${handle}`)
      expect(await caller.me()).toMatchObject({ principal, actor: principal, kind, handle })
      // Read back by a person: the author is the workflow, by the ID the API gave it.
      const { message: read } = await handleOn(api, 'user:u_jb').thread(posted.id)
      expect(read).toMatchObject({ by: { actor: principal, principal, profile: null }, author: { kind, handle } })
    }
    expect((await handleOn(api, 'user:u_jb').channel('ci').messages()).messages.map((message) => [message.by.actor, message.author?.handle])).toEqual([
      [callers.run.principal, 'acme/web'],
      [callers.issuer.principal, SUBJECT],
    ])
  })

  it('shows an agent of a workflow by its profile, through the workflow', async () => {
    const api = fakeMessageboard()
    for (const { principal, handle } of Object.values(callers)) {
      const posted = await handleOn(api, principal).as('ci').post('ci', 'from its agent')
      expect((await handleOn(api, 'user:u_jb').thread(posted.id)).message).toMatchObject({ by: { actor: `${principal}+ci`, principal, profile: 'ci' }, author: { kind: 'agent', handle: 'ci', via: { name: handle, environment: null } } })
    }
  })

  it("tells a run no grant lets in that it needs one, and makes no board for it", async () => {
    const api = fakeMessageboard({ boardId: null })
    await expect(handleOn(api, callers.run.principal).post('ci', 'deploy failed')).rejects.toMatchObject({
      status: 403,
      code: 'board_not_granted',
      origin: 'handle',
      message: "this workflow has no access to the team's board (acme/web).",
      hint: "Grant it: vb grants create --github acme/web --can '*=read,post,react,label'",
    })
    expect(api.requests).not.toContain('POST /boards/default')
  })

  it("quotes a board's name in the grant it suggests, so the command can't run what the name holds", async () => {
    const name = "ops'; rm -rf ~ #"
    const api = fakeMessageboard({ boards: [{ name }] })
    await expect(board({ name, backend: vercel({ team: 'team_test', api: API, fetch: as(api, callers.run.principal) }) }).post('ci', 'deploy failed')).rejects.toMatchObject({
      code: 'board_not_granted',
      hint: `Grant it: vb grants create --github acme/web --name 'ops'\\''; rm -rf ~ #' --can '*=read,post,react,label'`,
    })
  })
})
