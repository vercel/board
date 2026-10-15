import { afterEach, describe, expect, it, vi } from 'vitest'
import { githubActions, oidc, vercelProject } from '../src/server/index.ts'
import { PERMISSIONS } from '../src/server/access.ts'
import { caller, deploymentToken, OIDC_ISS, oidcToken, personToken, PROJECT_ID, testBoard, workflowToken } from './harness.ts'

const ALL = [...PERMISSIONS]
const own = (environment: string) => deploymentToken('board', PROJECT_ID, environment)

afterEach(() => vi.restoreAllMocks())

describe("the board's own project", () => {
  it('gives its people and its production everything', async () => {
    const { fetch } = testBoard()
    expect((await caller(fetch, await personToken())('GET', '/me')).body.access).toEqual({ '*': ALL })
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.access).toEqual({ '*': ALL })
  })

  it('gives its previews and custom environments nothing unless access lists them', async () => {
    for (const environment of ['preview', 'staging']) {
      const denied = await caller(testBoard().fetch, await own(environment))('GET', '/me')
      expect(denied.status).toBe(403)
      expect(denied.body.error.message).toBe(
        `this project's ${environment} deployments aren't in access: add vercelProject({ project: 'self', environments: ['${environment}'], can })`,
      )
    }
  })

  it("lists them with project: 'self'", async () => {
    const { fetch } = testBoard({ access: [vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } })] })
    const preview = caller(fetch, await own('preview'))
    const me = await preview('GET', '/me')
    expect(me.body).toMatchObject({ principal: `vercel:project:${PROJECT_ID}:preview`, access: { 'dev/': ['read'] } })
    const posted = await preview('POST', '/messages', { channel: 'dev', text: 'from a branch' })
    expect(posted).toMatchObject({ status: 403, body: { error: { message: "this token can't post in dev" } } })
    // Production keeps its default, since the rule names previews only.
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.access).toEqual({ '*': ALL })
  })

  it('narrows its production when a rule matches it', async () => {
    const { fetch } = testBoard({ access: [vercelProject({ project: 'self', environments: ['production'], can: { 'dev/': ['read', 'post'] } })] })
    expect((await caller(fetch, await own('production'))('GET', '/me')).body.access).toEqual({ 'dev/': ['read', 'post'] })
    // A person is a person, whatever the rules say.
    expect((await caller(fetch, await personToken())('GET', '/me')).body.access).toEqual({ '*': ALL })
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
    expect((await front('GET', '/me')).body.access).toEqual({ 'feedback/': ['post'] })
  })

  it('checks a new thread’s sync targets in its channel', async () => {
    const { fetch } = testBoard({ access: [vercelProject({ project: 'prj_marketing', can: { 'feedback/': ['post'] } })] })
    const denied = await caller(fetch, await deploymentToken())('POST', '/messages', { channel: 'feedback', text: 'hi', sync: ['slack:#x'] })
    expect(denied).toMatchObject({ status: 403, body: { error: { message: "this token can't sync in feedback" } } })
  })

  it('needs manage in every channel for the board’s bookkeeping', async () => {
    const { fetch } = testBoard({ access: [githubActions({ repository: 'basehub-ai/www', can: { '*': 'all', 'security/': [] } })] })
    const denied = await caller(fetch, await workflowToken())('GET', '/stuck')
    expect(denied).toMatchObject({ status: 403, body: { error: { message: 'reading stuck events needs manage on every channel' } } })
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
      access: { 'ci/': ['read', 'post'] },
    })
  })

  it('refuses tokens whose claims differ', async () => {
    const other = await caller(gitlab().fetch, await oidcToken({ project_path: 'acme/api-fork' }))('GET', '/me')
    expect(other).toMatchObject({ status: 403, body: { error: { message: `this token from ${OIDC_ISS} isn't in access` } } })
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
})

describe('x-board-scope', () => {
  it('narrows what the token can do', async () => {
    const { fetch } = testBoard()
    const pi = caller(fetch, await personToken(), { 'x-board-scope': 'dev/=read,post,react,label;ci/=read' })
    expect((await pi('GET', '/me')).body.access).toEqual({ 'ci/': ['read'], 'dev/': ['read', 'post', 'react', 'label'] })
    expect((await pi('POST', '/messages', { channel: 'dev/pi', text: 'on it' })).status).toBe(201)
    const ci = await pi('POST', '/messages', { channel: 'ci', text: 'not mine' })
    expect(ci).toMatchObject({ status: 403, body: { error: { message: "this token can't post in ci" } } })
    expect((await pi('GET', '/stuck')).status).toBe(403)
  })

  it('never widens it', async () => {
    const { fetch } = testBoard({ access: [githubActions({ repository: 'basehub-ai/www', can: ['post'] })] })
    const widened = caller(fetch, await workflowToken(), { 'x-board-scope': '*=all' })
    expect((await widened('GET', '/me')).body.access).toEqual({ '*': ['post'] })
  })

  it('refuses a scope it can’t read', async () => {
    const { fetch } = testBoard()
    for (const scope of ['dev/', 'dev/*=read', 'dev/=write', ''])
      expect((await caller(fetch, await personToken(), { 'x-board-scope': scope })('GET', '/me')).body.error, scope).toMatchObject({ code: 'invalid_scope' })
  })
})
