import { afterEach, describe, expect, it, vi } from 'vitest'
import { githubActions, oidc, vercelProject } from '../src/server/index.ts'
import { PERMISSIONS } from '../src/server/access.ts'
import { caller, deploymentToken, OIDC_ISS, oidcToken, personToken, PROJECT_ID, testAuth, testBoard, workflowToken } from './harness.ts'

const ALL = [...PERMISSIONS]
const own = (environment: string) => deploymentToken('board', PROJECT_ID, environment)

afterEach(() => vi.restoreAllMocks())

describe("the board's own project", () => {
  afterEach(() => vi.unstubAllEnvs())
  /** A board running in `environment`, as Vercel tells it; none outside Vercel. */
  const runningIn = (environment: string | null, options: Parameters<typeof testBoard>[0] = {}) => {
    vi.stubEnv('VERCEL_TARGET_ENV', '')
    vi.stubEnv('VERCEL_ENV', environment ?? '')
    return testBoard(options)
  }
  const refusal = (here: string, environment: string) =>
    `this token can't use this board: it runs in ${here}, so its ${environment} deployments need vercelProject({ project: 'self', environments: ['${environment}'], can })`

  it('gives its people and its production everything on a production board', async () => {
    const { fetch } = runningIn('production')
    expect((await caller(fetch, await personToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.can).toEqual({ '*': ALL })
  })

  it('refuses its previews and custom environments on a production board unless access lists them', async () => {
    const { fetch } = runningIn('production')
    for (const environment of ['preview', 'staging']) {
      const denied = await caller(fetch, await own(environment))('GET', '/me')
      expect(denied).toMatchObject({ status: 403, body: { error: { message: refusal('production', environment) } } })
    }
  })

  it('lets a preview board call itself, and refuses its production', async () => {
    const { fetch } = runningIn('preview')
    expect((await caller(fetch, await own('preview'))('GET', '/me')).body.can).toEqual({ '*': ALL })
    const denied = await caller(fetch, await own('production'))('GET', '/me')
    expect(denied).toMatchObject({ status: 403, body: { error: { message: refusal('preview', 'production') } } })
  })

  it('knows a custom environment by its target, not as a preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('VERCEL_TARGET_ENV', 'staging')
    const { fetch } = testBoard()
    expect((await caller(fetch, await own('staging'))('GET', '/me')).body.can).toEqual({ '*': ALL })
    const denied = await caller(fetch, await own('preview'))('GET', '/me')
    expect(denied).toMatchObject({ status: 403, body: { error: { message: refusal('staging', 'preview') } } })
  })

  it('lets only its people in outside Vercel', async () => {
    const { fetch } = runningIn(null)
    expect((await caller(fetch, await personToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
    const denied = await caller(fetch, await own('production'))('GET', '/me')
    expect(denied).toMatchObject({ status: 403, body: { error: { message: refusal('no Vercel environment', 'production') } } })
  })

  it("lists other environments with project: 'self'", async () => {
    const { fetch } = runningIn('production', {
      access: [vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } })],
    })
    const preview = caller(fetch, await own('preview'))
    const me = await preview('GET', '/me')
    expect(me.body).toMatchObject({ principal: `vercel:project:${PROJECT_ID}:preview`, can: { 'dev/': ['read'] } })
    const posted = await preview('POST', '/messages', { channel: 'dev', text: 'from a branch' })
    expect(posted).toMatchObject({ status: 403, body: { error: { message: "this token can't post in dev" } } })
    // Production keeps its default, since the rule names previews only.
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.can).toEqual({ '*': ALL })
  })

  it('narrows its own environment when a rule matches it', async () => {
    const { fetch } = runningIn('preview', {
      access: [vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read', 'post'] } })],
    })
    expect((await caller(fetch, await own('preview'))('GET', '/me')).body.can).toEqual({ 'dev/': ['read', 'post'] })
    // A person is a person, whatever the rules say.
    expect((await caller(fetch, await personToken())('GET', '/me')).body.can).toEqual({ '*': ALL })
  })

  it("refuses a team on 'self'", () => {
    expect(() => vercelProject({ project: 'self', team: 'team_x', can: 'all' })).toThrow("drop team")
  })
})

describe('access rules', () => {
  it('lets another project post in its own channels and nowhere else', async () => {
    const { fetch } = testBoard({ access: [vercelProject({ project: 'prj_marketing', can: { 'feedback/': ['post'] } })] })
    const front = caller(fetch, await deploymentToken())
    expect((await front('POST', '/messages', { channel: 'feedback/front', text: 'checkout is slow' })).status).toBe(201)
    const elsewhere = await front('POST', '/messages', { channel: 'dev', text: 'hi' })
    expect(elsewhere).toMatchObject({ status: 403, body: { error: { message: "this token can't post in dev" } } })
    expect((await front('GET', '/me')).body.can).toEqual({ 'feedback/': ['post'] })
  })

  it('checks a new thread’s sync targets in its channel', async () => {
    const { fetch } = testBoard({ access: [vercelProject({ project: 'prj_marketing', can: { 'feedback/': ['post'] } })] })
    const denied = await caller(fetch, await deploymentToken())('POST', '/messages', { channel: 'feedback', text: 'hi', sync: ['slack:#x'] })
    expect(denied).toMatchObject({ status: 403, body: { error: { message: "this token can't sync in feedback" } } })
  })

  it('says which rule would let in a token none matches', async () => {
    const { fetch } = testBoard({ access: [githubActions({ repository: 'other/repo', can: 'all' }), vercelProject({ project: 'docs', can: 'all' })] })
    expect((await caller(fetch, await workflowToken())('GET', '/me')).body.error.message).toBe(
      "this token can't use this board: add githubActions({ repository: 'basehub-ai/www', can }) to access",
    )
    expect((await caller(fetch, await deploymentToken())('GET', '/me')).body.error.message).toBe(
      "this token can't use this board: add vercelProject({ project: 'marketing', can }) to access",
    )
  })

  it('covers both of the CI guide’s samples with its rule', async () => {
    // docs/03-guides/03-ci.md: the deploy workflow's rule, its failure report, and its wait.
    const { fetch } = testBoard({
      access: [githubActions({ repository: 'basehub-ai/www', workflow: '.github/workflows/deploy.yml', can: { 'errors-www': ['post', 'label'], deploys: ['read', 'post'] } })],
    })
    const ci = caller(fetch, await workflowToken())
    expect((await ci('POST', '/messages', { channel: 'errors-www', text: 'deploy failed on abc', labels: { source: 'ci' }, id: 'deploy-abc' })).status).toBe(201)
    const id = (await ci('POST', '/messages', { channel: 'deploys', text: 'Ready to promote?' })).body.message.id
    expect((await ci('GET', `/messages?re=${id}&after=${id}`)).status).toBe(200)
  })

  it('needs manage in every channel for the board’s bookkeeping', async () => {
    const { fetch } = testBoard({ access: [githubActions({ repository: 'basehub-ai/www', can: { '*': 'all', 'security/': [] } })] })
    const denied = await caller(fetch, await workflowToken())('GET', '/stuck')
    expect(denied).toMatchObject({ status: 403, body: { error: { message: "this token can't read stuck events: it needs manage in every channel" } } })
  })
})

describe('oidc()', () => {
  const gitlab = (can: Parameters<typeof oidc>[0]['can'] = { 'ci/': ['read', 'post'] }) =>
    testBoard({ access: [oidc({ issuer: OIDC_ISS, claims: { project_path: 'acme/api' }, can })] })

  it('trusts a pinned issuer’s tokens whose claims match exactly', async () => {
    const me = await caller(gitlab().fetch, await oidcToken())('GET', '/me')
    expect(me.body).toMatchObject({
      principal: 'oidc:gitlab.test:project_path:acme/api:ref_type:branch:ref:main',
      kind: 'workflow',
      can: { 'ci/': ['read', 'post'] },
    })
  })

  it('refuses tokens whose claims differ', async () => {
    const other = await caller(gitlab().fetch, await oidcToken({ project_path: 'acme/api-fork' }))('GET', '/me')
    expect(other).toMatchObject({ status: 403, body: { error: { message: `this token can't use this board: add oidc({ issuer: '${OIDC_ISS}', claims, can }) to access` } } })
    const nested = await caller(gitlab().fetch, await oidcToken({ project_path: ['acme/api'] }))('GET', '/me')
    expect(nested.status).toBe(403)
  })

  it('needs a sub to name the principal', async () => {
    const me = await caller(gitlab().fetch, await oidcToken({ sub: undefined }))('GET', '/me')
    expect(me).toMatchObject({ status: 401, body: { error: { message: `token from ${OIDC_ISS} without sub` } } })
  })

  it('trusts no issuer that access doesn’t name, and never fetches its keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // The test keys for OIDC_ISS are configured, but no rule names it.
    const unlisted = await caller(testBoard().fetch, await oidcToken())('GET', '/me')
    expect(unlisted).toMatchObject({ status: 401, body: { error: { message: `untrusted issuer: ${OIDC_ISS}` } } })
    const elsewhere = await caller(gitlab().fetch, await oidcToken({}, 'https://evil.test'))('GET', '/me')
    expect(elsewhere).toMatchObject({ status: 401, body: { error: { message: 'untrusted issuer: https://evil.test' } } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a rule that would match everyone, or another helper’s issuer', () => {
    expect(() => oidc({ issuer: OIDC_ISS, claims: {}, can: 'all' })).toThrow('name at least one claim')
    expect(() => oidc({ issuer: 'http://gitlab.test', claims: { a: 'b' }, can: 'all' })).toThrow('https URL')
    expect(() => oidc({ issuer: 'https://oidc.vercel.com/acme', claims: { a: 'b' }, can: 'all' })).toThrow('use vercelProject()')
    expect(() => oidc({ issuer: 'https://token.actions.githubusercontent.com', claims: { a: 'b' }, can: 'all' })).toThrow('use githubActions()')
    expect(() => oidc({ issuer: OIDC_ISS, claims: { a: 'b' }, can: { 'ci/*': ['post'] } })).toThrow('write ci/ for ci and its subtree')
  })

  it('refuses a claim with no value, as an unset environment variable gives', () => {
    for (const value of [process.env.VBOARD_TEST_UNSET, '', [], [undefined], ['acme/api', '']])
      expect(() => oidc({ issuer: OIDC_ISS, claims: { project_path: value as string }, can: 'all' }), JSON.stringify(value)).toThrow(
        `oidc: claim project_path has no value to match for ${OIDC_ISS}`,
      )
    expect(oidc({ issuer: OIDC_ISS, claims: { project_path: ['acme/api', 'acme/web'] }, can: 'all' }).matches({ project_path: 'acme/web' }, { teamId: null, projectId: null })).toBe(true)
  })

  it('keeps each rule to its own issuer', async () => {
    const selfHosted = 'https://ci.selfhosted.test'
    const { fetch } = testBoard({
      auth: { ...testAuth, oidc: { ...testAuth.oidc, [selfHosted]: testAuth.oidc[OIDC_ISS]! } },
      access: [
        oidc({ issuer: OIDC_ISS, claims: { project_path: 'acme/api' }, can: 'all' }),
        oidc({ issuer: selfHosted, claims: { team: 'x' }, can: { 'ci/': ['post'] } }),
      ],
    })
    // A token from the self-hosted issuer that claims gitlab.com's project gets nothing of its rule.
    const forged = await caller(fetch, await oidcToken({ project_path: 'acme/api' }, selfHosted))('GET', '/me')
    expect(forged).toMatchObject({ status: 403, body: { error: { message: `this token can't use this board: add oidc({ issuer: '${selfHosted}', claims, can }) to access` } } })
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
    expect((await pi('GET', '/stuck')).status).toBe(403)
  })

  it('never widens it', async () => {
    const { fetch } = testBoard({ access: [githubActions({ repository: 'basehub-ai/www', can: ['post'] })] })
    const widened = caller(fetch, await workflowToken(), { 'x-board-scope': '*=all' })
    expect((await widened('GET', '/me')).body.can).toEqual({ '*': ['post'] })
  })

  it('refuses a scope it can’t read', async () => {
    const { fetch } = testBoard()
    for (const scope of ['dev/', 'dev/*=read', 'dev/=write', ''])
      expect((await caller(fetch, await personToken(), { 'x-board-scope': scope })('GET', '/me')).body.error, scope).toMatchObject({ code: 'invalid_scope' })
  })
})
