import { afterEach, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { a2 } from '../src/server/a2.ts'
import type { GrantInput } from '../src/api/routes.ts'
import { PERMISSIONS } from '../src/server/access.ts'
import { caller, deploymentToken, OIDC_ISS, oidcToken, personToken, PROJECT_ID, testAuth, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

const ALL = [...PERMISSIONS]
const own = (environment: string) => deploymentToken('board', PROJECT_ID, environment)

/** A board that keeps `grants`, set before any test request. */
async function granting(...grants: GrantInput[]) {
  const board = testBoard()
  // Without g2's every project on the team, so only these grants let one in.
  await board.revokeGrant('g2')
  for (const grant of grants) await board.createGrant(grant)
  return board
}

afterEach(() => vi.restoreAllMocks())

describe("the board's own project", () => {
  afterEach(() => vi.unstubAllEnvs())
  /** A board running in `environment`, as Vercel tells it; none outside Vercel. */
  /** A board in `environment`, without g2: its own deployments get in by the board's defaults alone. */
  const runningIn = async (environment: string | null, options: Parameters<typeof testBoard>[0] = {}) => {
    vi.stubEnv('VERCEL_TARGET_ENV', '')
    vi.stubEnv('VERCEL_ENV', environment ?? '')
    const board = testBoard(options)
    await board.revokeGrant('g2')
    return board
  }
  const refusal = (here: string, environment: string) => ({
    message: `this token can't use this board: it runs in ${here}, and its ${environment} deployments need a grant`,
    hint: `Grant them: vb grants create --project ${PROJECT_ID} --environment ${environment}`,
  })

  it('gives its people and its production everything on a production board', async () => {
    const { fetch } = await runningIn('production')
    expect((await caller(fetch, await personToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.can).toEqual({ '*': ALL })
  })

  it('refuses its previews and custom environments on a production board unless a grant lets them in', async () => {
    const { fetch } = await runningIn('production')
    for (const environment of ['preview', 'staging']) {
      const denied = await caller(fetch, await own(environment))('GET', '/me')
      expect(denied).toMatchObject({ status: 403, body: { error: refusal('production', environment) } })
    }
  })

  it('lets a preview board call itself, and refuses its production', async () => {
    const { fetch } = await runningIn('preview')
    expect((await caller(fetch, await own('preview'))('GET', '/me')).body.can).toEqual({ '*': ALL })
    const denied = await caller(fetch, await own('production'))('GET', '/me')
    expect(denied).toMatchObject({ status: 403, body: { error: refusal('preview', 'production') } })
  })

  it('knows a custom environment by its target, not as a preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('VERCEL_TARGET_ENV', 'staging')
    const board = testBoard()
    await board.revokeGrant('g2')
    const { fetch } = board
    expect((await caller(fetch, await own('staging'))('GET', '/me')).body.can).toEqual({ '*': ALL })
    const denied = await caller(fetch, await own('preview'))('GET', '/me')
    expect(denied).toMatchObject({ status: 403, body: { error: refusal('staging', 'preview') } })
  })

  it('lets only its people in outside Vercel', async () => {
    const { fetch } = await runningIn(null)
    expect((await caller(fetch, await personToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
    const denied = await caller(fetch, await own('production'))('GET', '/me')
    expect(denied).toMatchObject({ status: 403, body: { error: refusal('no Vercel environment', 'production') } })
  })

  it('lets in its other environments by a grant', async () => {
    const board = await runningIn('production')
    await board.createGrant({ principals: [{ kind: 'project', project: PROJECT_ID, environments: ['preview'] }], can: { 'dev/': ['read'] } })
    const { fetch } = board
    const preview = caller(fetch, await own('preview'))
    const me = await preview('GET', '/me')
    expect(me.body).toMatchObject({ principal: `vercel:project:${PROJECT_ID}:preview`, can: { 'dev/': ['read'] } })
    const posted = await preview('POST', '/messages', { channel: 'dev', text: 'from a branch' })
    expect(posted).toMatchObject({ status: 403, body: { error: { message: "this token can't post in dev" } } })
    // Production keeps its default, since the grant names previews only.
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.can).toEqual({ '*': ALL })
  })

  it('never narrows its people, or its own deployments where it runs, by a grant', async () => {
    const board = await runningIn('preview')
    // Its claims match the board's previews and its people's development tokens alike.
    await board.createGrant({ principals: [{ kind: 'project', project: PROJECT_ID, environments: ['preview', 'development'] }], can: { 'dev/': ['read', 'post'] } })
    expect((await caller(board.fetch, await own('preview'))('GET', '/me')).body.can).toEqual({ '*': ALL })
    // A person is a person, whatever the grants say.
    expect((await caller(board.fetch, await personToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
  })
})

describe('what a grant lets in', () => {
  const marketing = { principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { 'feedback/': ['post'] } } satisfies GrantInput

  it('lets another project post in its own channels and nowhere else', async () => {
    const { fetch } = await granting(marketing)
    const front = caller(fetch, await deploymentToken())
    expect((await front('POST', '/messages', { channel: 'feedback/front', text: 'checkout is slow' })).status).toBe(201)
    const elsewhere = await front('POST', '/messages', { channel: 'dev', text: 'hi' })
    expect(elsewhere).toMatchObject({ status: 403, body: { error: { message: "this token can't post in dev" } } })
    expect((await front('GET', '/me')).body.can).toEqual({ 'feedback/': ['post'] })
  })

  it('checks a new thread’s sync targets in its channel', async () => {
    const { fetch } = await granting(marketing)
    const denied = await caller(fetch, await deploymentToken())('POST', '/messages', { channel: 'feedback', text: 'hi', sync: ['slack:#x'] })
    expect(denied).toMatchObject({ status: 403, body: { error: { message: "this token can't sync in feedback" } } })
  })

  it('says which grant would let in a token none matches', async () => {
    const { fetch } = await granting(
      { principals: [{ kind: 'github', repository: 'other/repo' }], can: { '*': 'all' } },
      { principals: [{ kind: 'project', project: 'prj_docs', environments: ['production'] }], can: { '*': 'all' } },
    )
    expect(await caller(fetch, await workflowToken())('GET', '/me')).toMatchObject({
      status: 403,
      body: { error: { message: "this token can't use this board: no grant lets in acme/web", hint: 'Grant it: vb grants create --github acme/web' } },
    })
    expect(await caller(fetch, await deploymentToken())('GET', '/me')).toMatchObject({
      status: 403,
      body: {
        error: {
          message: "this token can't use this board: no grant lets in project prj_marketing in production",
          hint: 'Grant it: vb grants create --project prj_marketing --environment production',
        },
      },
    })
  })

  it('covers both of the CI guide’s samples with its grant', async () => {
    // docs/03-guides/03-ci.md: the repo's grant, its failure report, and its wait.
    const { fetch } = await granting({ principals: [{ kind: 'github', repository: 'acme/www', event: 'push' }], can: { 'errors-www': ['post', 'label'], deploys: ['read', 'post'] } })
    const ci = caller(fetch, await workflowToken({ repository: 'acme/www' }))
    expect((await ci('POST', '/messages', { channel: 'errors-www', text: 'deploy failed on abc', labels: { source: 'ci' }, id: 'deploy-abc' })).status).toBe(201)
    const id = (await ci('POST', '/messages', { channel: 'deploys', text: 'Ready to promote?' })).body.message.id
    expect((await ci('GET', `/messages?re=${id}&after=${id}`)).status).toBe(200)
  })
})

describe('a grant for another OIDC issuer', () => {
  const gitlab = (can: GrantInput['can'] = { 'ci/': ['read', 'post'] }) => granting({ principals: [{ kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }], can })

  it('trusts a pinned issuer’s tokens whose claims match exactly', async () => {
    const me = await caller((await gitlab()).fetch, await oidcToken())('GET', '/me')
    expect(me.body).toMatchObject({
      principal: 'oidc:gitlab.test:project_path:acme/api:ref_type:branch:ref:main',
      kind: 'workflow',
      can: { 'ci/': ['read', 'post'] },
    })
  })

  it('refuses tokens whose claims differ', async () => {
    const other = await caller((await gitlab()).fetch, await oidcToken({ project_path: 'acme/api-fork' }))('GET', '/me')
    expect(other).toMatchObject({ status: 403, body: { error: { message: "this token can't use this board: no grant lets in its claims" } } })
    const nested = await caller((await gitlab()).fetch, await oidcToken({ project_path: ['acme/api'] }))('GET', '/me')
    expect(nested.status).toBe(403)
  })

  it('needs a sub to name the principal', async () => {
    const me = await caller((await gitlab()).fetch, await oidcToken({ sub: undefined }))('GET', '/me')
    expect(me).toMatchObject({ status: 401, body: { error: { message: `token from ${OIDC_ISS} without sub` } } })
  })

  it('trusts no issuer that no grant names, and never fetches its keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // The test keys for OIDC_ISS are configured, but no grant names it.
    const unlisted = await caller(testBoard().fetch, await oidcToken())('GET', '/me')
    expect(unlisted).toMatchObject({ status: 401, body: { error: { message: `untrusted issuer: ${OIDC_ISS}` } } })
    const elsewhere = await caller((await gitlab()).fetch, await oidcToken({}, 'https://evil.test'))('GET', '/me')
    expect(elsewhere).toMatchObject({ status: 401, body: { error: { message: 'untrusted issuer: https://evil.test' } } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names a principal so no issuer’s sub can pass for another issuer’s', async () => {
    // Before, both were oidc:gitlab.test:8443:deploy.
    const withPort = `${OIDC_ISS}:8443`
    const board = testBoard({ auth: { ...testAuth, oidc: { ...testAuth.oidc, [withPort]: testAuth.oidc[OIDC_ISS]! } } })
    for (const issuer of [OIDC_ISS, withPort]) await board.createGrant({ principals: [{ kind: 'oidc', issuer, claims: { project_path: 'acme/api' } }], can: { '*': 'all' } })
    const { fetch } = board
    const principal = async (sub: string, issuer?: string) =>
      (await caller(fetch, await oidcToken({ sub }, issuer))('GET', '/me')).body.principal
    expect(await principal('8443:deploy')).toBe('oidc:gitlab.test:8443:deploy')
    expect(await principal('deploy', withPort)).toBe('oidc:gitlab.test%3A8443:deploy')
  })

  it('keeps each grant to its own issuer', async () => {
    const selfHosted = 'https://ci.selfhosted.test'
    const board = testBoard({ auth: { ...testAuth, oidc: { ...testAuth.oidc, [selfHosted]: testAuth.oidc[OIDC_ISS]! } } })
    await board.createGrant({ principals: [{ kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }], can: { '*': 'all' } })
    await board.createGrant({ principals: [{ kind: 'oidc', issuer: selfHosted, claims: { team: 'x' } }], can: { 'ci/': ['post'] } })
    const { fetch } = board
    // A token from the self-hosted issuer that claims gitlab.com's project gets nothing of its grant.
    const forged = await caller(fetch, await oidcToken({ project_path: 'acme/api' }, selfHosted))('GET', '/me')
    expect(forged).toMatchObject({ status: 403, body: { error: { message: "this token can't use this board: no grant lets in its claims" } } })
    expect((await caller(fetch, await oidcToken({ team: 'x' }, selfHosted))('GET', '/me')).body.can).toEqual({ 'ci/': ['post'] })
    expect((await caller(fetch, await oidcToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
  })
})

describe('x-board-scope', () => {
  it('narrows what the token can do', async () => {
    const { fetch } = testBoard()
    const pi = caller(fetch, await personToken(), { 'x-board-scope': 'dev/=read,post,react,label;ci/=read' })
    expect((await pi('GET', '/me')).body.can).toEqual({ 'ci/': ['read'], 'dev/': ['read', 'post', 'react', 'label'] })
    expect((await pi('POST', '/messages', { channel: 'dev/pi', text: 'on it' })).status).toBe(201)
    const ci = await pi('POST', '/messages', { channel: 'ci', text: 'not mine' })
    expect(ci).toMatchObject({ status: 403, body: { error: { message: "this token can't post in ci" } } })
  })

  it('never widens it', async () => {
    const { fetch } = await granting({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': ['post'] } })
    const widened = caller(fetch, await workflowToken(), { 'x-board-scope': '*=all' })
    expect((await widened('GET', '/me')).body.can).toEqual({ '*': ['post'] })
  })

  it('refuses a scope longer than a schedule can keep, on every route', async () => {
    const queue = fakeQueue()
    const { fetch } = testBoard({ scheduler: queue.scheduler })
    const scopeOf = (length: number) => 'dev/=all'.padEnd(length, ';')
    const longest = caller(fetch, await personToken(), { 'x-board-scope': scopeOf(4000) })
    expect((await longest('POST', '/messages', { channel: 'dev', text: 'now' })).status).toBe(201)
    expect((await longest('POST', '/schedules', { channel: 'dev', text: 'later', in: '1h' })).status).toBe(201)
    const tooLong = caller(fetch, await personToken(), { 'x-board-scope': scopeOf(4001) })
    for (const [method, path, body] of [
      ['POST', '/messages', { channel: 'dev', text: 'now' }],
      ['POST', '/schedules', { channel: 'dev', text: 'later', in: '1h' }],
    ] as const)
      expect(await tooLong(method, path, body), path).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_scope', message: 'x-board-scope is longer than 4000 characters' } },
      })
  })

  it('refuses a scope it can’t read', async () => {
    const { fetch } = testBoard()
    for (const scope of ['dev/', 'dev/*=read', 'dev/=write', ''])
      expect((await caller(fetch, await personToken(), { 'x-board-scope': scope })('GET', '/me')).body.error, scope).toMatchObject({ code: 'invalid_scope' })
  })
})
