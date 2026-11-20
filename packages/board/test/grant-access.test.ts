import { describe, expect, it } from 'vitest'
import { checkGrantChange, explainGrants, grantAccess, subPrefix, type DecidingGrant, type GrantFacts, type GrantShape } from '../src/access/index.ts'

// The grant decision as Vercel's API makes it with board's code: plain data in, accesses out.

const ALL = ['read', 'post', 'react', 'label', 'sync', 'manage']
const g1: DecidingGrant = { principals: [{ kind: 'all-users' }], can: { '*': 'all' } }
const g2: DecidingGrant = { principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] } }
const g3: DecidingGrant = { principals: [{ kind: 'all-apps' }], can: { '*': ['read', 'post', 'react', 'label'] } }
const lock: DecidingGrant = { principals: [{ kind: 'everyone' }], can: { 'security/': [] } }
const bob = { caller: { kind: 'user', userId: 'u_bob' }, member: true } as const
const summaries = (facts: GrantFacts) => {
  const decided = grantAccess(facts)
  return decided && { caller: decided.caller.summary(), own: decided.own.summary() }
}

describe('grantAccess', () => {
  it("lets in a person on the team, by every grant that names them, and gives what's closest where it's most specific", () => {
    const alice: DecidingGrant = { principals: [{ kind: 'user', userId: 'u_alice' }, { kind: 'user', userId: 'u_bob' }], can: { 'security/': 'all' } }
    expect(summaries({ ...bob, grants: [g1, lock] })).toEqual({ caller: { '*': ALL, 'security/': [] }, own: { '*': ALL } })
    expect(summaries({ ...bob, grants: [g1, lock, alice] })).toEqual({ caller: { '*': ALL }, own: { '*': ALL } })
    // Ties at the closest level add up; a farther one there doesn't.
    const reads: DecidingGrant = { principals: [{ kind: 'user', userId: 'u_bob' }], can: { 'dev/': ['read'] } }
    const posts: DecidingGrant = { principals: [{ kind: 'user', userId: 'u_bob' }], can: { 'dev/': ['post'] } }
    expect(summaries({ ...bob, grants: [g1, reads, posts, { principals: [{ kind: 'everyone' }], can: { 'dev/': ['label'] } }] })?.caller).toEqual({ '*': ALL, 'dev/': ['read', 'post'] })
    // Off the team, nothing lets a user in, and everyone's grant lets in no one.
    expect(grantAccess({ caller: { kind: 'user', userId: 'u_mallory' }, member: false, grants: [g1, { principals: [{ kind: 'everyone' }], can: { '*': ['read'] } }] })).toBeNull()
  })

  it("keeps a project to the team its grant knows, and matches one that names no team by its ID", () => {
    const named: DecidingGrant = { principals: [{ kind: 'project', projectId: 'prj_web', environments: ['production'], teamId: 'team_acme' }], can: { '*': ['read'] } }
    const web = (teamId?: string): GrantFacts => ({ caller: { kind: 'project', projectId: 'prj_web', environment: 'production', ...(teamId ? { teamId } : {}) }, grants: [named] })
    expect(summaries(web('team_acme'))?.caller).toEqual({ '*': ['read'] })
    // Moved to another team, whose ID its tokens now carry: the grant is no longer its.
    expect(grantAccess(web('team_other'))).toBeNull()
    // A caller that names no team, as a host's deployment, is its ID.
    expect(summaries(web())?.caller).toEqual({ '*': ['read'] })
    // A grant that knows no team, as a local board's outside a linked project, is the ID on any team.
    const anywhere: DecidingGrant = { principals: [{ kind: 'project', projectId: 'prj_web', environments: ['production'] }], can: { '*': ['read'] } }
    expect(summaries({ ...web('team_other'), grants: [anywhere] })?.caller).toEqual({ '*': ['read'] })
  })

  it('matches a workflow by the whole of its workflow_ref, so another file whose name starts the same gets nothing', () => {
    const ci: DecidingGrant = { principals: [{ kind: 'github', repository: 'acme/web', workflow: '.github/workflows/ci.yml' }], can: { 'ci/': ['post'] } }
    const run = (workflowRef: string) => grantAccess({ caller: { kind: 'github', repository: 'acme/web', workflowRef, ref: 'refs/heads/main' }, grants: [ci] })
    expect(run('acme/web/.github/workflows/ci.yml@refs/heads/main')?.caller.summary()).toEqual({ 'ci/': ['post'] })
    expect(run('acme/web/.github/workflows/ci.yml@evil.yml@refs/heads/main')).toBeNull()
  })

  it('caps what it gives, then narrows it by a token', () => {
    expect(summaries({ ...bob, grants: [g1], cap: ['read'] })).toEqual({ caller: { '*': ['read'] }, own: { '*': ['read'] } })
    expect(summaries({ ...bob, grants: [g1], can: { 'dev/': ['read', 'post'] } })?.caller).toEqual({ 'dev/': ['read', 'post'] })
  })

  it("lets in a project, a run, an issuer's token, and an app, each as its principal or its group names it", () => {
    const web = { caller: { kind: 'project', projectId: 'prj_web', environment: 'preview' }, teamProject: true } as const
    expect(summaries({ ...web, grants: [g1, g2] })?.caller).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync'] })
    expect(grantAccess({ ...web, teamProject: false, grants: [g1, g2] })).toBeNull()
    const run = { caller: { kind: 'github', repository: 'acme/web', repositoryId: '7', workflowRef: 'acme/web/.github/workflows/ci.yml@refs/heads/main', ref: 'refs/heads/main', event: 'push' } } as const
    const ci: DecidingGrant = { principals: [{ kind: 'github', repository: 'acme/web', repositoryId: '7', workflow: '.github/workflows/ci.yml', branch: 'main' }], can: { 'ci/': ['post'] } }
    expect(summaries({ ...run, grants: [ci] })?.caller).toEqual({ 'ci/': ['post'] })
    expect(grantAccess({ caller: { ...run.caller, ref: 'refs/heads/dev' }, grants: [ci] })).toBeNull()
    const gitlab: DecidingGrant = { principals: [{ kind: 'oidc', issuer: 'https://gitlab.com', claims: { sub: 'project_path:acme/api:*', project_id: ['42', '43'] } }], can: { 'ci/': ['post'] } }
    expect(grantAccess({ caller: { kind: 'oidc', issuer: 'https://gitlab.com', claims: { sub: 'project_path:acme/api:ref_type:branch:ref:main', project_id: 43 } }, grants: [gitlab] })).not.toBeNull()
    const app = { caller: { kind: 'app', clientId: 'cl_ship' }, teamApp: true } as const
    expect(summaries({ ...app, grants: [g3] })?.caller).toEqual({ '*': ['read', 'post', 'react', 'label'] })
    expect(summaries({ ...app, grants: [g3, { principals: [{ kind: 'app', clientId: 'cl_ship' }], can: { 'ship/': 'all' } }] })?.caller).toEqual({ '*': ['read', 'post', 'react', 'label'], 'ship/': ALL })
    expect(grantAccess({ ...app, teamApp: false, grants: [g3] })).toBeNull()
  })

  it("matches an issuer's sub by how it starts where it ends in :* or /*, and every other value exactly", () => {
    const issuer = 'https://gitlab.com'
    const gitlab: DecidingGrant = { principals: [{ kind: 'oidc', issuer, claims: { sub: ['project_path:acme/api:*', 'org/1/project/2/user/*', 'deploy'], ref: 'release/*' } }], can: { 'ci/': ['post'] } }
    const lets = (sub: string, ref = 'release/*') => grantAccess({ caller: { kind: 'oidc', issuer, claims: { sub, ref } }, grants: [gitlab] }) !== null
    expect(['project_path:acme/api:ref_type:branch:ref:main', 'org/1/project/2/user/3', 'deploy'].map((sub) => lets(sub))).toEqual([true, true, true])
    expect(['project_path:acme/api-evil:ref_type:branch:ref:main', 'project_path:acme/api', 'org/1/project/20/user/3', 'deploy:prod'].map((sub) => lets(sub))).toEqual([false, false, false, false])
    // Only a sub is a pattern.
    expect(lets('deploy', 'release/1')).toBe(false)
    // A grant stored before the board refused other *s matches them as they're written.
    const stored: DecidingGrant = { principals: [{ kind: 'oidc', issuer, claims: { sub: ['acme*', '*'] } }], can: { 'ci/': ['post'] } }
    const storedLets = (sub: string) => grantAccess({ caller: { kind: 'oidc', issuer, claims: { sub } }, grants: [stored] }) !== null
    expect(['acme-evil', 'anyone', 'acme*', '*'].map(storedLets)).toEqual([false, false, true, true])
  })

  it('lets an app capped by its scope, or narrowed where everyone reads, let no one in', () => {
    const app = { caller: { kind: 'app', clientId: 'cl_ship' }, teamApp: true } as const
    const manages: DecidingGrant = { principals: [{ kind: 'app', clientId: 'cl_ship' }], can: { '*': 'all' } }
    const reads: DecidingGrant = { principals: [{ kind: 'everyone' }], can: { 'open/': ['read'] } }
    const changed: GrantShape = { principals: [{ kind: 'github' }], can: { 'dev/': ['post'] } }
    const after: GrantShape[] = [g3, manages, reads, changed]
    // Its scope lets it read and post, never manage.
    const capped = grantAccess({ ...app, grants: [g3, manages, reads], cap: ['read', 'post', 'react', 'label', 'sync'] })!
    expect(checkGrantChange({ ...capped, after, changed })).toEqual({ reason: 'reach', pattern: 'dev/', permission: 'manage' })
    // Narrowed out of open/, which everyone reads: anyone it lets in would read it.
    const narrowed = grantAccess({ ...app, grants: [g3, manages, reads], can: { '*': 'all', 'open/': [] } })!
    expect(checkGrantChange({ ...narrowed, after, changed })).toEqual({ reason: 'admission', pattern: 'open/', permission: 'read' })
    expect(checkGrantChange({ ...grantAccess({ ...app, grants: [g3, manages, reads] })!, after, changed })).toBeNull()
  })
})

describe('subPrefix', () => {
  it('takes a * only at the end, right after a : or a /', () => {
    const subs = ['project_path:acme/api:*', 'org/1/user/*', 'project_path:acme/api', 'acme*', '*', ':*', '/*', 'org:*:project:x', 'a:*:*', '']
    expect(subs.map(subPrefix)).toEqual(['project_path:acme/api:', 'org/1/user/', null, null, null, null, null, null, null, null])
  })
})

describe('explainGrants', () => {
  it('says which pattern, level, and grants decide a channel, and what they give after the cap and the token', () => {
    const opens: DecidingGrant = { principals: [{ kind: 'user', userId: 'u_bob' }], can: { 'security/': 'all' } }
    expect(explainGrants({ ...bob, grants: [g1, lock, opens] }, 'security/incidents')).toEqual({ pattern: 'security/', over: ['*'], level: 'principal', grants: [opens], capped: false, permissions: ALL })
    expect(explainGrants({ ...bob, grants: [g1, lock] }, 'security/incidents')).toMatchObject({ pattern: 'security/', level: 'everyone', grants: [lock], permissions: [] })
    // A viewer's cap takes what g1 gives down to it, and a token narrows what's left.
    expect(explainGrants({ ...bob, grants: [g1], cap: ['read', 'react'] }, 'dev')).toMatchObject({ pattern: '*', level: 'group', grants: [g1], capped: true, permissions: ['read', 'react'] })
    expect(explainGrants({ ...bob, grants: [g1], can: { 'dev/': ['read'] } }, 'dev/x')).toMatchObject({ capped: false, permissions: ['read'] })
    // Nothing lets a user off the team in, so not even everyone's grant decides for them.
    const none = { pattern: null, over: [], level: null, grants: [], capped: false, permissions: [] }
    expect(explainGrants({ caller: { kind: 'user', userId: 'u_mallory' }, member: false, grants: [g1, lock] }, 'security/incidents')).toEqual(none)
  })
})
