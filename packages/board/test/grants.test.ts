import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'experimental-a2/server'
import { ACCESS_SESSION, accessContract } from '../src/contract/contract.ts'
import { memory } from '../src/store/memory.ts'
import { caller, deploymentToken, localUserToken, oidcToken, OIDC_ISS, personToken, testBoard, testKeys, workflowToken } from './harness.ts'

/**
 * A board, its owner (its local user, as `vb serve` mints a token for it), a person on the team,
 * and callers with other tokens: the owner and the person set grants, the others try the board.
 */
async function setUp(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  const owner = caller(board.fetch, await localUserToken())
  const person = caller(board.fetch, await personToken())
  return {
    board,
    owner,
    person,
    as: async (token: string | Promise<string>) => caller(board.fetch, await token),
    /** A caller narrowed with `x-board-can`, as a proxy holding its credential sends it. */
    narrowed: async (token: string | Promise<string>, can: string) => caller(board.fetch, await token, { 'x-board-can': can }),
  }
}

const ALL = ['read', 'post', 'react', 'label', 'sync', 'manage']
const everyone = { kind: 'everyone' } as const
const user = (userId: string) => ({ kind: 'user', userId }) as const

describe('grants', () => {
  it('starts with every person doing everything, every project on the team reading, posting, reacting, labeling, and syncing, and every app all but syncing', async () => {
    const { person, as } = await setUp()
    expect((await person('GET', '/grants')).body.grants).toEqual([
      { id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' }, capped: false, by: null, at: null },
      { id: 'g2', principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, capped: false, by: null, at: null },
      { id: 'g3', principals: [{ kind: 'all-apps' }], can: { '*': ['read', 'post', 'react', 'label'] }, capped: false, by: null, at: null },
    ])
    expect((await (await as(personToken('u_ada')))('GET', '/me')).body.can).toEqual({ '*': ALL })
    // Any project on the board's team, its previews included; none on another team.
    expect((await (await as(deploymentToken('web', 'prj_web', 'preview')))('GET', '/me')).body.can).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync'] })
    expect((await (await as(deploymentToken('web', 'prj_partner', 'production', { teamId: 'team_partner' })))('GET', '/me')).status).toBe(403)
  })

  it('lets in a workflow a grant names, as its can says, and keeps it out once revoked', async () => {
    const { person, as } = await setUp()
    const workflow = await as(workflowToken())
    expect((await workflow('GET', '/me')).status).toBe(403)
    const set = await person('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['read', 'post'] } })
    expect(set.status).toBe(200)
    expect(set.body.grant).toMatchObject({ principals: [{ kind: 'github', repository: 'acme/web', repositoryId: null }], can: { 'ci/': ['read', 'post'] }, by: 'vercel:user:u_julian' })
    expect((await workflow('POST', '/messages', { channel: 'ci', text: 'green' })).status).toBe(201)
    expect((await workflow('POST', '/messages', { channel: 'dev', text: 'not here' })).status).toBe(403)
    expect((await person('POST', `/grants/${set.body.grant.id}/revoke`, {})).body).toEqual({ revoked: true })
    expect((await workflow('POST', '/messages', { channel: 'ci', text: 'again' })).status).toBe(403)
  })

  it('grants on any channel path, the longest and its subtree included, and refuses a pattern no path could match', async () => {
    const { person, as } = await setUp()
    const workflow = await as(workflowToken())
    const longest = `ci/${'a'.repeat(2045)}`
    const set = await person('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { [longest]: ['read', 'post'], [`${longest}/`]: ['read'] } })
    expect(set.status).toBe(200)
    expect((await workflow('POST', '/messages', { channel: longest, text: 'green' })).status).toBe(201)
    const tooLong = await person('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { [`${longest}a/`]: ['read'] } })
    expect([tooLong.status, tooLong.body.error.code]).toEqual([400, 'invalid_request'])
  })

  it('decides a channel by its most specific pattern first, then by the closest principal', async () => {
    const { owner, as } = await setUp()
    await owner('POST', '/grants', { principals: [everyone], can: { 'security/': [] } })
    await owner('POST', '/grants', { principals: [user('u_alice')], can: { 'security/': 'all' } })
    // A grant naming Bob on * doesn't reach security/: the more specific pattern decides first.
    await owner('POST', '/grants', { principals: [user('u_bob')], can: { '*': 'all' } })
    const alice = await as(personToken('u_alice'))
    const bob = await as(personToken('u_bob'))
    expect((await alice('POST', '/messages', { channel: 'security/incidents', text: 'paged' })).status).toBe(201)
    expect((await bob('GET', '/me')).body.can).toEqual({ '*': ALL, 'security/': [] })
    expect((await bob('POST', '/messages', { channel: 'security/incidents', text: 'paged' })).status).toBe(403)
    expect((await bob('POST', '/messages', { channel: 'dev', text: 'hi' })).status).toBe(201)
  })

  it('adds up grants tied at the closest principal, past what a group gives at the same pattern', async () => {
    const { person, as } = await setUp()
    await person('POST', '/grants', { principals: [user('u_ada')], can: { 'dev/': ['read'] } })
    await person('POST', '/grants', { principals: [user('u_ada')], can: { 'dev/': ['post'] } })
    await person('POST', '/grants', { principals: [{ kind: 'all-users' }], can: { 'dev/': 'all' } })
    expect((await (await as(personToken('u_ada')))('GET', '/me')).body.can).toEqual({ '*': ALL, 'dev/': ['read', 'post'] })
    // Grace is named only by the group, which decides for her there.
    expect((await (await as(personToken('u_grace')))('GET', '/me')).body.can).toEqual({ '*': ALL })
  })

  it('lets no one in through everyone alone, and narrows whoever else is let in', async () => {
    const { owner, as } = await setUp()
    await owner('POST', '/grants', { principals: [everyone], can: { '*': 'all', 'ci/': [] } })
    expect((await (await as(workflowToken()))('GET', '/me')).status).toBe(403)
    // A project on the team is let in by g2, and everyone's ci/ is more specific than g2's *.
    expect((await (await as(deploymentToken('web', 'prj_web', 'production')))('GET', '/me')).body.can).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync'], 'ci/': [] })
  })

  it('lets a member grant on * once a channel is closed to everyone, which the grant then leaves closed', async () => {
    const { owner, as } = await setUp()
    await owner('POST', '/grants', { principals: [everyone], can: { 'security/': [] } })
    await owner('POST', '/grants', { principals: [user('u_alice')], can: { 'security/': 'all' } })
    const bob = await as(personToken('u_bob'))
    const run = { kind: 'github', repository: 'acme/web' }
    const made = await bob('POST', '/grants', { principals: [run], can: { '*': 'all' } })
    expect(made.status).toBe(200)
    expect((await bob('PATCH', `/grants/${made.body.grant.id}`, { can: { '*': ['read', 'post'] } })).status).toBe(200)
    // The run it lets in gets nothing in security/: everyone's grant there is more specific than *.
    const me = (await (await as(workflowToken({ repository: 'acme/web', repository_id: '99' })))('GET', '/me')).body
    expect(me.can).toEqual({ '*': ['read', 'post'], 'security/': [] })
    // Nothing on security/ or under it, which Bob doesn't manage.
    for (const can of [{ 'security/': ['read'] }, { 'security/incidents': ['read'] }, { '*': 'all', 'security/': 'all' }])
      expect([JSON.stringify(can), (await bob('POST', '/grants', { principals: [run], can })).status]).toEqual([JSON.stringify(can), 403])
  })

  it("lets no one grant past a grant that narrows them, theirs or everyone's", async () => {
    const { owner, as } = await setUp()
    const run = { kind: 'github', repository: 'acme/web' }
    // Bob's own grant closes security/ to him: a grant on * for his run would open it.
    await owner('POST', '/grants', { principals: [user('u_bob')], can: { 'security/': [] } })
    const bob = await as(personToken('u_bob'))
    expect((await bob('POST', '/grants', { principals: [run], can: { '*': 'all' } })).status).toBe(403)
    // Carol's closes security/incidents to her, where everyone reads: anyone she lets in would read it.
    await owner('POST', '/grants', { principals: [everyone], can: { 'security/': ['read'] } })
    await owner('POST', '/grants', { principals: [user('u_carol')], can: { 'security/incidents': [] } })
    const carol = await as(personToken('u_carol'))
    expect((await carol('POST', '/grants', { principals: [run], can: { 'dev/': ['post'] } })).status).toBe(403)
  })

  it('judges a grant on the grants it lands on, so a change that narrows its maker in between counts', async () => {
    // Just before Bob's grant first lands, the owner closes security/ to him: his write finds the log moved on, and looks again.
    const base = memory()
    let between: (() => Promise<unknown>) | null = null
    const log = new Proxy(base.log, {
      get(target, key) {
        if (key !== 'append') {
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (...args: Parameters<typeof base.log.append>) => {
          const hook = between
          if (hook && /grant\.created.*u_bob/.test(JSON.stringify(args[1]))) {
            between = null
            await hook()
          }
          return target.append(...args)
        }
      },
    })
    const { owner, as } = await setUp({ store: { ...base, log, close: () => base.close() } })
    const bob = await as(personToken('u_bob'))
    between = () => owner('POST', '/grants', { principals: [user('u_bob')], can: { 'security/': [] } })
    const made = await bob('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } })
    expect(between).toBeNull()
    expect([made.status, made.body.error?.message]).toEqual([403, "this grant reaches security/, where you can't manage grants"])
  })

  it("revokes, or removes from, a grant only where the caller's own limits reach, since lifting it widens whoever it named", async () => {
    const { owner, as, narrowed } = await setUp()
    // A project the grant keeps out of everything: revoking it gives the project g2 back, secret/ included.
    const shut = await owner('POST', '/grants', { principals: [{ kind: 'project', project: 'prj_x', environments: ['production'] }, { kind: 'project', project: 'prj_y', environments: ['production'] }], can: { '*': [] } })
    const scoped = await narrowed(personToken(), '*=all;secret/=')
    const revoked = await scoped('POST', `/grants/${shut.body.grant.id}/revoke`, {})
    // It may list grants, so it's told where.
    expect([revoked.status, revoked.body.error.message]).toEqual([403, `this token can't revoke ${shut.body.grant.id}: it reaches secret/, where you can't manage grants`])
    expect((await scoped('PATCH', `/grants/${shut.body.grant.id}`, { remove: [{ kind: 'project', project: 'prj_x' }] })).status).toBe(403)
    // A member lifts a grant on * once a channel is closed to everyone, since the lock binds whoever it named too.
    await owner('POST', '/grants', { principals: [everyone], can: { 'security/': [] } })
    const wide = await owner('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }, { kind: 'github', repository: 'acme/api' }], can: { '*': ['read'] } })
    const bob = await as(personToken('u_bob'))
    expect((await bob('PATCH', `/grants/${wide.body.grant.id}`, { remove: [{ kind: 'github', repository: 'acme/api' }] })).status).toBe(200)
    expect((await bob('POST', `/grants/${wide.body.grant.id}/revoke`, {})).body).toEqual({ revoked: true })
    // But not the lock itself, where he's shut out.
    const lock = (await owner('GET', '/grants')).body.grants.find((grant: { principals: { kind: string }[] }) => grant.principals[0]?.kind === 'everyone')
    expect((await bob('POST', `/grants/${lock.id}/revoke`, {})).status).toBe(403)
  })

  it('lets no caller narrowed with x-board-can reach past it by granting someone else', async () => {
    const { owner, narrowed } = await setUp()
    // Manage at *, but nothing in security/: a grant on * for a run it controls would be all of security/ too.
    const scoped = await narrowed(personToken(), '*=all;security/=')
    const run = { kind: 'github', repository: 'acme/web' }
    expect((await scoped('POST', '/grants', { principals: [run], can: { '*': 'all' } })).status).toBe(403)
    expect((await scoped('POST', '/grants', { principals: [run], can: { 'dev/': 'all' } })).status).toBe(200)
    // Not even once security/ is closed to everyone: whoever lifts the lock would open it to the run, and not to the caller.
    await owner('POST', '/grants', { principals: [everyone], can: { 'security/': [] } })
    const locked = await scoped('POST', '/grants', { principals: [run], can: { '*': 'all' } })
    expect([locked.status, locked.body.error.message]).toEqual([403, "this grant reaches security/, where you can't manage grants"])
  })

  it('lets no narrowed caller let in a principal it controls where everyone gets more than it has', async () => {
    const { owner, as, narrowed } = await setUp()
    await owner('POST', '/grants', { principals: [everyone], can: { 'secret/': ['read'] } })
    const scoped = await narrowed(personToken(), '*=all;secret/=')
    // Nothing narrower is under dev/, but the run it lets in would read secret/ through everyone's grant.
    expect((await scoped('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'dev/': ['post'] } })).status).toBe(403)
    expect((await (await as(workflowToken({ repository: 'acme/web', repository_id: '99' })))('GET', '/me')).status).toBe(403)
  })

  it("lets the board's local user, its owner, change any grant, though a closed channel still takes a grant to read", async () => {
    const { owner, person, narrowed } = await setUp()
    const lock = await person('POST', '/grants', { principals: [everyone], can: { 'security/': [] }, lockMeOut: true })
    // A person on the team is no owner: once security/ is closed to them, they open it to no one, and can't undo it.
    expect((await person('POST', '/grants', { principals: [user('u_julian')], can: { 'security/': 'all' } })).status).toBe(403)
    expect((await person('POST', `/grants/${lock.body.grant.id}/revoke`, {})).status).toBe(403)
    expect((await owner('POST', '/messages', { channel: 'security', text: 'locked out' })).status).toBe(403)
    // With g1 gone, the local user manages nothing, and is still the owner.
    expect((await owner('POST', '/grants/g1/revoke', {})).body).toEqual({ revoked: true })
    expect((await owner('GET', '/me')).body.can).toEqual({})
    expect((await owner('POST', '/grants', { principals: [user('julian')], can: { 'security/': 'all' } })).status).toBe(200)
    expect((await owner('POST', '/messages', { channel: 'security', text: 'let in' })).status).toBe(201)
    // Narrowed with x-board-can, the owner goes no further than it says.
    const reader = await narrowed(localUserToken(), 'security/=read')
    expect((await reader('POST', '/grants', { principals: [everyone], can: { 'security/': ['read'] } })).status).toBe(403)
    expect((await reader('GET', '/grants')).status).toBe(403)
  })

  it("refuses a grant its maker couldn't take back, until it says lockMeOut", async () => {
    const { owner, person } = await setUp()
    // Read-only for everyone, the person who makes it included: they may, and then no one but an owner changes it.
    const lock = { principals: [everyone], can: { 'factory/': ['read'], 'factory/memory/': [] } }
    const refused = await person('POST', '/grants', lock)
    expect([refused.status, refused.body.error.code]).toEqual([409, 'grant_lockout'])
    // It names a pattern they'd lose, which they wrote themselves.
    expect(refused.body.error.message).toContain('factory/')
    expect((await person('GET', '/grants')).body.grants.map((grant: { id: string }) => grant.id)).toEqual(['g1', 'g2', 'g3'])
    expect((await person('POST', '/grants/batch', { grants: [lock] })).status).toBe(409)
    // Told to, the board makes it, and it holds against its maker.
    const made = await person('POST', '/grants', { ...lock, lockMeOut: true })
    expect(made.status).toBe(200)
    expect((await person('GET', '/me')).body.can).toMatchObject({ 'factory/': ['read'], 'factory/memory/': [] })
    expect((await person('POST', `/grants/${made.body.grant.id}/revoke`, {})).status).toBe(403)
    expect((await person('POST', `/grants/${made.body.grant.id}/revoke`, { lockMeOut: true })).status).toBe(403)
    // An owner is never locked out, so nothing asks one to say so.
    expect((await owner('POST', `/grants/${made.body.grant.id}/revoke`, {})).body).toEqual({ revoked: true })
    expect((await owner('POST', '/grants', lock)).status).toBe(200)
  })

  it('makes a lock with the grant that keeps its maker in, in one write and in either order, or after it', async () => {
    const { person } = await setUp()
    const lock = { principals: [everyone], can: { 'factory/': ['read'], 'factory/memory/': [] } }
    const keeps = { principals: [user('u_julian')], can: { 'factory/': 'all', 'factory/memory/': 'all' } }
    // The lock first: made one at a time, the grant after it would be refused.
    const both = await person('POST', '/grants/batch', { grants: [lock, keeps] })
    expect(both.status).toBe(200)
    expect(both.body.grants).toMatchObject([
      { id: 'g4', principals: [everyone], can: lock.can, by: 'vercel:user:u_julian' },
      { id: 'g5', principals: [{ kind: 'user', userId: 'u_julian' }], can: keeps.can },
    ])
    expect((await person('GET', '/me')).body.can).toEqual({ '*': ALL })
    // So it's theirs to lift: the lock, and then the grant that kept them in.
    expect((await person('POST', '/grants/g4/revoke', {})).body).toEqual({ revoked: true })
    expect((await person('POST', '/grants/g5/revoke', {})).body).toEqual({ revoked: true })
    // One at a time, the grant that keeps them in goes first.
    expect((await person('POST', '/grants', keeps)).status).toBe(200)
    expect((await person('POST', '/grants', lock)).status).toBe(200)
  })

  it("refuses a lock whose maker is kept in at only some of its patterns, naming one it'd lose", async () => {
    const { person } = await setUp()
    const lock = { principals: [everyone], can: { 'factory/': ['read'], 'factory/memory/': [] } }
    // factory/memory/ is more specific than factory/, so a grant on factory/ alone leaves it closed to them.
    const refused = await person('POST', '/grants/batch', { grants: [{ principals: [user('u_julian')], can: { 'factory/': 'all' } }, lock] })
    expect([refused.status, refused.body.error.code]).toEqual([409, 'grant_lockout'])
    expect(refused.body.error.message).toContain('factory/memory/')
    expect((await person('GET', '/grants')).body.grants).toHaveLength(3)
  })

  it('makes all of a batch or none of it, each grant judged as one made alone is', async () => {
    const { owner, person, as } = await setUp()
    await owner('POST', '/grants', { principals: [everyone], can: { 'security/': [] } })
    const run = { kind: 'github', repository: 'acme/web' }
    const bob = await as(personToken('u_bob'))
    // The second is on security/, where Bob manages nothing: neither is made.
    const refused = await bob('POST', '/grants/batch', { grants: [{ principals: [run], can: { 'ci/': ['post'] } }, { principals: [run], can: { 'security/': ['read'] } }] })
    expect(refused.status).toBe(403)
    expect((await owner('GET', '/grants')).body.grants).toHaveLength(4)
    // Two issuers that name the same principals can't sit side by side, in one grant or across a batch's.
    const twice = await person('POST', '/grants/batch', {
      grants: [
        { principals: [{ kind: 'oidc', issuer: 'https://ci.example.com/a', claims: { sub: 'x' } }], can: { 'ci/': ['post'] } },
        { principals: [{ kind: 'oidc', issuer: 'https://ci.example.com/a/', claims: { sub: 'y' } }], can: { 'ci/': ['post'] } },
      ],
    })
    expect([twice.status, twice.body.error.code]).toEqual([400, 'invalid_grant'])
    expect((await person('POST', '/grants/batch', { grants: [] })).status).toBe(400)
    expect((await person('POST', '/grants/batch', { grants: Array.from({ length: 17 }, () => ({ principals: [run], can: { 'ci/': ['post'] } })) })).status).toBe(400)
    expect((await person('POST', '/grants/batch', { grants: [{ principals: [run], can: { 'ci/': ['post'] }, lockMeOut: true }] })).status).toBe(400)
    expect((await owner('GET', '/grants')).body.grants).toHaveLength(4)
  })

  it('calls revoking or narrowing the grant that keeps its caller in a lockout too', async () => {
    const { owner, person, narrowed } = await setUp()
    await person('POST', '/grants/batch', { grants: [{ principals: [everyone], can: { 'factory/': ['read'] } }, { principals: [user('u_julian'), user('u_ada')], can: { 'factory/': 'all' } }] })
    const revoked = await person('POST', '/grants/g5/revoke', {})
    expect([revoked.status, revoked.body.error.code]).toEqual([409, 'grant_lockout'])
    // They may list the grants, so they're told where.
    expect(revoked.body.error.message).toContain('factory/')
    for (const change of [{ can: { 'factory/': ['read', 'post'] } }, { remove: [user('u_julian')] }]) {
      const updated = await person('PATCH', '/grants/g5', change)
      expect([JSON.stringify(change), updated.status, updated.body.error?.code]).toEqual([JSON.stringify(change), 409, 'grant_lockout'])
    }
    // Refused, it changed nothing.
    expect((await person('GET', '/grants')).body.grants.find((grant: { id: string }) => grant.id === 'g5')).toMatchObject({ principals: [{ userId: 'u_julian' }, { userId: 'u_ada' }], can: { 'factory/': 'all' } })
    // Someone else out of it costs them nothing.
    expect((await person('PATCH', '/grants/g5', { remove: [user('u_ada')] })).status).toBe(200)
    // A caller that can't list the grants isn't told where a stored one reaches.
    const scoped = await narrowed(personToken(), 'factory/=all')
    const hidden = await scoped('POST', '/grants/g5/revoke', {})
    expect([hidden.status, hidden.body.error.code, JSON.stringify(hidden.body).includes('factory')]).toEqual([409, 'grant_lockout', false])
    // Told to, it's done, and then only the owner changes anything there.
    expect((await person('PATCH', '/grants/g5', { remove: [user('u_julian')], add: [user('u_ada')], lockMeOut: true })).status).toBe(200)
    expect((await person('POST', '/grants/g4/revoke', { lockMeOut: true })).status).toBe(403)
    expect((await owner('POST', '/grants/g5/revoke', {})).body).toEqual({ revoked: true })
    // A revoke told to go ahead is done too, and leaves them out.
    await person('POST', '/grants/batch', { grants: [{ principals: [everyone], can: { 'attic/': [] } }, { principals: [user('u_julian')], can: { 'attic/': 'all' } }] })
    expect((await person('POST', '/grants/g7/revoke', {})).status).toBe(409)
    expect((await person('POST', '/grants/g7/revoke', { lockMeOut: true })).body).toEqual({ revoked: true })
    expect((await person('GET', '/me')).body.can).toMatchObject({ 'attic/': [] })
  })

  it("names no stored grant's channels to a caller that can't list the grants", async () => {
    const { owner, as } = await setUp()
    const secret = await owner('POST', '/grants', { principals: [everyone], can: { 'security/incidents/': [] } })
    await owner('POST', '/grants', { principals: [{ kind: 'project', project: 'prj_ops', environments: ['production'] }], can: { 'ci/': 'all' } })
    const ops = await as(deploymentToken('ops', 'prj_ops', 'production'))
    for (const [method, path, body] of [
      ['PATCH', `/grants/${secret.body.grant.id}`, { can: { 'ci/': ['read'] } }],
      ['POST', `/grants/${secret.body.grant.id}/revoke`, {}],
    ] as const) {
      const refused = await ops(method, path, body)
      expect([refused.status, JSON.stringify(refused.body).includes('security')]).toEqual([403, false])
    }
  })

  it("tells a caller who can't change a grant nothing of whom it names, or whether it's there", async () => {
    const { owner, narrowed } = await setUp()
    const { body } = await owner('POST', '/grants', { principals: [{ kind: 'user', userId: 'u_alice' }], can: { 'security/': 'all' } })
    const poster = await narrowed(personToken(), '*=read,post')
    // Guesses at who it names, right or wrong, the last one or not, are all the same refusal.
    for (const remove of [[{ kind: 'user', userId: 'u_alice' }], [{ kind: 'user', userId: 'u_bob' }]])
      expect([JSON.stringify(remove), (await poster('PATCH', `/grants/${body.grant.id}`, { remove })).status]).toEqual([JSON.stringify(remove), 403])
    expect((await poster('PATCH', '/grants/g99', { remove: [{ kind: 'user', userId: 'u_bob' }] })).status).toBe(403)
    expect((await owner('PATCH', '/grants/g99', { can: { '*': ['read'] } })).status).toBe(404)
  })

  it("answers a caller that can't list grants the same for a grant it can't reach as for one that isn't there, since grant IDs count up", async () => {
    const { owner, narrowed } = await setUp()
    const { body } = await owner('POST', '/grants', { principals: [user('u_alice')], can: { 'security/': 'all' } })
    const dev = await narrowed(personToken(), '*=read,post;dev/=all')
    const probe = async () => [await dev('POST', `/grants/${body.grant.id}/revoke`, {}), await dev('PATCH', `/grants/${body.grant.id}`, { can: { 'dev/': ['read'] } })]
    const there = await probe()
    expect(there.map((answer) => [answer.status, answer.body.error.code])).toEqual([
      [403, 'forbidden'],
      [403, 'forbidden'],
    ])
    expect((await owner('POST', `/grants/${body.grant.id}/revoke`, {})).body).toEqual({ revoked: true })
    expect(await probe()).toEqual(there)
    // Whoever may list them is told it's gone.
    expect((await owner('POST', `/grants/${body.grant.id}/revoke`, {})).body).toEqual({ revoked: false })
    expect((await owner('PATCH', `/grants/${body.grant.id}`, { can: { 'dev/': ['read'] } })).body.error.code).toBe('grant_not_found')
  })

  it('keeps both of two adds to one grant that land at once', async () => {
    const { person } = await setUp()
    const { body } = await person('POST', '/grants', { principals: [user('u_ada')], can: { 'dev/': ['read'] } })
    const id = body.grant.id
    const answers = await Promise.all(['u_bob', 'u_carol', 'u_dan'].map((added) => person('PATCH', `/grants/${id}`, { add: [user(added)] })))
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
    const kept = (await person('GET', '/grants')).body.grants.find((grant: { id: string }) => grant.id === id)
    expect(kept.principals.map((principal: { userId: string }) => principal.userId).sort()).toEqual(['u_ada', 'u_bob', 'u_carol', 'u_dan'])
  })

  it('makes a new grant for the same principals, and keeps can as written', async () => {
    const { person } = await setUp()
    const grant = { principals: [{ kind: 'project', project: 'prj_front', environments: ['production', 'preview', 'production'] }], can: { '*': ['label', 'read'], 'feedback/': [] } }
    const first = await person('POST', '/grants', grant)
    const again = await person('POST', '/grants', grant)
    expect([first.body.grant.id, again.body.grant.id]).toEqual(['g4', 'g5'])
    expect(first.body.grant).toMatchObject({
      principals: [{ kind: 'project', projectId: 'prj_front', name: null, environments: ['production', 'preview'] }],
      can: { '*': ['read', 'label'], 'feedback/': [] },
    })
    expect((await person('GET', '/grants')).body.grants.map((listed: { id: string }) => listed.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])
  })

  it('updates a grant by its ID: adds principals, removes them by who they are, and replaces its can', async () => {
    const { person } = await setUp()
    const made = await person('POST', '/grants', { principals: [{ kind: 'project', project: 'prj_front', environments: ['preview'] }], can: { 'dev/': ['post'] } })
    const id = made.body.grant.id
    const added = await person('PATCH', `/grants/${id}`, {
      add: [user('u_ada'), { kind: 'github', repository: 'acme/web', workflow: 'ci.yml' }, { kind: 'all-projects', environments: ['preview'] }],
      can: { 'dev/': ['read', 'post'] },
    })
    expect(added.body.grant).toMatchObject({
      id,
      principals: [
        { kind: 'project', projectId: 'prj_front' },
        { kind: 'user', userId: 'u_ada' },
        { kind: 'github', repository: 'acme/web', workflow: '.github/workflows/ci.yml' },
        { kind: 'all-projects', environments: ['preview'] },
      ],
      can: { 'dev/': ['read', 'post'] },
    })
    // Adding a project it names already adds its environments to it.
    const joined = await person('PATCH', `/grants/${id}`, { add: [{ kind: 'project', project: 'prj_front', environments: ['production'] }, { kind: 'all-projects', environments: ['development'] }] })
    expect(joined.body.grant.principals).toMatchObject([
      { kind: 'project', projectId: 'prj_front', environments: ['production', 'preview'] },
      { kind: 'user' },
      { kind: 'github' },
      { kind: 'all-projects', environments: ['preview', 'development'] },
    ])
    // A project, and every project, is removed by who it is, whatever its environments.
    const removed = await person('PATCH', `/grants/${id}`, { remove: [{ kind: 'project', project: 'prj_front' }, { kind: 'github', repository: 'acme/web' }, { kind: 'all-projects' }] })
    expect(removed.body.grant.principals).toEqual([{ kind: 'user', userId: 'u_ada', email: null }])
    const refused = async (path: string, body: unknown) => {
      const { status, body: answer } = await person('PATCH', path, body)
      return [status, answer.error?.code]
    }
    expect(await refused(`/grants/${id}`, { remove: [{ kind: 'project', project: 'prj_front' }] })).toEqual([400, 'not_in_grant'])
    expect(await refused(`/grants/${id}`, { remove: [user('u_ada')] })).toEqual([400, 'grant_empty'])
    expect(await refused('/grants/g99', { can: { '*': ['read'] } })).toEqual([404, 'grant_not_found'])
    expect(await refused(`/grants/${id}`, {})).toEqual([400, 'invalid_request'])
    expect(await refused(`/grants/${id}`, { add: [{ kind: 'all-projects' }] })).toEqual([400, 'invalid_grant'])
  })

  it('keeps an app by its client ID, and lists it', async () => {
    const { owner } = await setUp()
    const made = await owner('POST', '/grants', { principals: [{ kind: 'app', app: 'cl_ship' }], can: { 'ship/': ['post'] } })
    expect([made.status, made.body.grant?.principals]).toEqual([200, [{ kind: 'app', clientId: 'cl_ship', name: null }]])
    expect((await owner('GET', '/grants')).body.grants.map((grant: { id: string }) => grant.id)).toEqual(['g1', 'g2', 'g3', made.body.grant.id])
  })

  it('matches a GitHub run by its workflow, branch, and event', async () => {
    const { person, as } = await setUp()
    await person('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web', workflow: 'deploy.yml', branch: 'main', event: 'push' }], can: { 'ci/': ['post'] } })
    const posts = async (claims: Record<string, unknown>) => (await (await as(workflowToken(claims)))('POST', '/messages', { channel: 'ci', text: 'run' })).status
    expect(await posts({})).toBe(201)
    expect(await posts({ workflow_ref: 'acme/web/.github/workflows/other.yml@refs/heads/main' })).toBe(403)
    expect(await posts({ ref: 'refs/heads/feature' })).toBe(403)
    expect(await posts({ event_name: 'pull_request' })).toBe(403)
  })

  it('trusts an issuer once a grant names it, and only for tokens with its claims', async () => {
    const { person, as } = await setUp()
    const gitlab = await as(oidcToken())
    expect((await gitlab('GET', '/me')).status).toBe(401)
    await person('POST', '/grants', { principals: [{ kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }], can: { 'ci/': ['post'] } })
    expect((await gitlab('POST', '/messages', { channel: 'ci', text: 'from gitlab' })).status).toBe(201)
    const another = await as(oidcToken({ project_path: 'acme/other', sub: 'project_path:acme/other' }))
    expect((await another('POST', '/messages', { channel: 'ci', text: 'not granted' })).status).toBe(403)
  })

  it("keeps a workflow whose sub has a + apart from another's profile of that name", async () => {
    const { person, as, board } = await setUp()
    await person('POST', '/grants', { principals: [{ kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }], can: { 'ci/': ['read', 'post'] } })
    const lookalike = await as(oidcToken({ sub: 'build+pi' }))
    const build = caller(board.fetch, await oidcToken({ sub: 'build' }), { 'x-board-profile': 'pi' })
    const who = async (call: typeof lookalike) => (await call('POST', '/messages', { channel: 'ci', text: 'hi' })).body.message.by.actor as string
    expect([await who(build), await who(lookalike)]).toEqual(['oidc:gitlab.test:build+pi', 'oidc:gitlab.test:build%2Bpi'])
    // A sub without one names its principal as it always did.
    expect(await who(await as(oidcToken()))).toBe('oidc:gitlab.test:project_path:acme/api:ref_type:branch:ref:main')
  })

  it("finds a grant's issuer's keys by OIDC discovery, never by a redirect or on the board's own network", async () => {
    const ISS = 'https://idp.acme.dev'
    const DISCOVERY = `${ISS}/.well-known/openid-configuration`
    const { person, as } = await setUp()
    await person('POST', '/grants', { principals: [{ kind: 'oidc', issuer: ISS, claims: { project_path: 'acme/api' } }], can: { 'ci/': ['read'] } })
    const me = async () => (await (await as(oidcToken({}, ISS)))('GET', '/me')).status
    // The network as fetch sees it: a redirect is followed unless the request says otherwise.
    const asked: string[] = []
    let routes: Record<string, () => Response> = {}
    const network = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input)
      asked.push(url)
      const response = routes[url]?.() ?? new Response('not found', { status: 404 })
      const location = response.headers.get('location')
      if (location && response.status >= 300 && response.status < 400) {
        const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
        if (mode === 'error') throw new TypeError('redirected')
        if (mode === 'follow') return network(new URL(location, url).href, init)
      }
      return response
    }
    vi.stubGlobal('fetch', network)
    try {
      const refused = {
        'a redirect to the metadata service': [{ [DISCOVERY]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }) }, 'http://169.254.169.254/latest/meta-data/'],
        'keys on its own network': [{ [DISCOVERY]: () => Response.json({ issuer: ISS, jwks_uri: 'https://keys.internal/jwks' }) }, 'https://keys.internal/jwks'],
        'keys over plain http': [{ [DISCOVERY]: () => Response.json({ issuer: ISS, jwks_uri: 'http://idp.acme.dev/jwks' }) }, 'http://idp.acme.dev/jwks'],
        'a document for another issuer': [{ [DISCOVERY]: () => Response.json({ issuer: 'https://evil.example', jwks_uri: `${ISS}/jwks` }) }, `${ISS}/jwks`],
      } as const
      for (const [why, [served, never]] of Object.entries(refused)) {
        routes = served
        expect([why, await me()]).toEqual([why, 401])
        expect([why, asked.includes(never)]).toEqual([why, false])
      }
      // Its own document, naming it and its keys, is how it's let in.
      routes = { [DISCOVERY]: () => Response.json({ issuer: ISS, jwks_uri: `${ISS}/jwks` }), [`${ISS}/jwks`]: () => Response.json(testKeys) }
      expect(await me()).toBe(200)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("fetches an issuer's discovery once for tokens that arrive together, and again after it failed", async () => {
    const ISS = 'https://idp-once.acme.dev'
    const DISCOVERY = `${ISS}/.well-known/openid-configuration`
    const { person, as } = await setUp()
    await person('POST', '/grants', { principals: [{ kind: 'oidc', issuer: ISS, claims: { project_path: 'acme/api' } }], can: { 'ci/': ['read'] } })
    const call = await as(oidcToken({}, ISS))
    let discoveries = 0
    let up = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === DISCOVERY) {
        discoveries++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return up ? Response.json({ issuer: ISS, jwks_uri: `${ISS}/jwks` }) : new Response('down', { status: 503 })
      }
      return url === `${ISS}/jwks` ? Response.json(testKeys) : new Response('not found', { status: 404 })
    })
    try {
      const together = await Promise.all(Array.from({ length: 5 }, async () => (await call('GET', '/me')).status))
      expect([together, discoveries]).toEqual([[401, 401, 401, 401, 401], 1])
      up = true
      expect((await call('GET', '/me')).status).toBe(200)
      expect(discoveries).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("refuses names it can't look up, and principals that name more than they say", async () => {
    const { person } = await setUp()
    const refused = async (principal: unknown, can: unknown = { '*': ['read'] }) => {
      const { status, body } = await person('POST', '/grants', { principals: [principal], can })
      return [status, body.error?.code]
    }
    const invalid = [400, 'invalid_grant']
    // A board that verifies tokens itself has no directory to look names up in.
    expect(await refused({ kind: 'user', email: 'ada@acme.com' })).toEqual(invalid)
    expect(await refused({ kind: 'project', project: 'front', environments: ['production'] })).toEqual(invalid)
    // Every project is in production, preview, and development; a custom environment is one project's.
    expect(await refused({ kind: 'project', project: 'prj_front' })).toEqual(invalid)
    expect(await refused({ kind: 'all-projects', environments: ['env_staging'] })).toEqual(invalid)
    expect(await refused({ kind: 'github', repository: 'acme' })).toEqual(invalid)
    // A key it doesn't know is refused, never dropped: without workflow, this would let in every run.
    expect(await refused({ kind: 'github', repository: 'acme/web', workflows: 'deploy.yml' })).toEqual([400, 'invalid_request'])
    expect((await person('PATCH', '/grants/g2', { add: [everyone], cann: { '*': ['read'] } })).status).toBe(400)
    // An issuer signs tokens for everyone it serves, and its keys are fetched from it, so never from the board's own network.
    expect(await refused({ kind: 'oidc', issuer: OIDC_ISS, claims: {} })).toEqual(invalid)
    expect(await refused({ kind: 'oidc', issuer: 'https://169.254.169.254', claims: { sub: 'x' } })).toEqual(invalid)
    expect(await refused({ kind: 'oidc', issuer: 'https://ci.internal/oidc', claims: { sub: 'x' } })).toEqual(invalid)
    expect(await refused({ kind: 'oidc', issuer: 'http://gitlab.com', claims: { sub: 'x' } })).toEqual(invalid)
    expect(await refused({ kind: 'oidc', issuer: 'https://oidc.vercel.com/acme', claims: { project_id: 'prj_front' } })).toEqual(invalid)
    expect(await refused({ kind: 'oidc', issuer: 'https://token.actions.githubusercontent.com', claims: { repository: 'acme/web' } })).toEqual(invalid)
    expect(await refused(everyone, { 'ci/*': ['post'] })).toEqual(invalid)
    expect(await refused(everyone, {})).toEqual(invalid)
    expect((await person('POST', '/grants', { principals: [], can: { '*': ['read'] } })).status).toBe(400)
    expect((await person('GET', '/grants')).body.grants.map((grant: { id: string }) => grant.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('refuses an issuer that names the same principals as one a grant trusts', async () => {
    const board = testBoard()
    const person = caller(board.fetch, await personToken())
    const gitlab = (issuer: string) => ({ principals: [{ kind: 'oidc', issuer, claims: { project_path: 'acme/api' } }], can: { 'ci/': ['post'] } })
    expect((await person('POST', '/grants', gitlab(OIDC_ISS))).status).toBe(200)
    const { status, body } = await person('POST', '/grants', gitlab(`${OIDC_ISS}/`))
    expect([status, body.error.code]).toEqual([400, 'invalid_grant'])
  })

  it('refuses two issuers that name the same principals within one grant, or added to it', async () => {
    const { person } = await setUp()
    const gitlab = (issuer: string) => ({ kind: 'oidc', issuer, claims: { project_path: 'acme/api' } })
    const both = await person('POST', '/grants', { principals: [gitlab(OIDC_ISS), gitlab(`${OIDC_ISS}/`)], can: { 'ci/': ['post'] } })
    expect([both.status, both.body.error.code]).toEqual([400, 'invalid_grant'])
    const one = await person('POST', '/grants', { principals: [gitlab(OIDC_ISS)], can: { 'ci/': ['post'] } })
    const added = await person('PATCH', `/grants/${one.body.grant.id}`, { add: [gitlab(`${OIDC_ISS}/`)] })
    expect([added.status, added.body.error.code]).toEqual([400, 'invalid_grant'])
  })

  it('takes manage everywhere to name an oidc issuer, whose keys the board then fetches', async () => {
    const { owner, as } = await setUp()
    await owner('POST', '/grants', { principals: [{ kind: 'project', project: 'prj_ops', environments: ['production'] }], can: { 'ci/': 'all' } })
    const ops = await as(deploymentToken('ops', 'prj_ops', 'production'))
    const gitlab = { kind: 'oidc', issuer: OIDC_ISS, claims: { project_path: 'acme/api' } }
    expect((await ops('POST', '/grants', { principals: [gitlab], can: { 'ci/': ['post'] } })).status).toBe(403)
    const run = await ops('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['post'] } })
    expect(run.status).toBe(200)
    expect((await ops('PATCH', `/grants/${run.body.grant.id}`, { add: [gitlab] })).status).toBe(403)
  })

  it("trusts no stored grant's issuer that names another's principals or is on the board's own network, and nothing else breaks", async () => {
    const { board, person, as } = await setUp()
    // Grants a board refuses now, as one could hold from before it did.
    const log = createServer({ contract: accessContract, store: board.store.log }).session(ACCESS_SESSION)
    for (const issuer of [OIDC_ISS, `${OIDC_ISS}/`, 'https://169.254.169.254'])
      await log.append({ type: 'grant.created', payload: { principals: [{ kind: 'oidc', issuer, claims: { project_path: 'acme/api' } }], can: { 'ci/': ['post'] }, by: 'local:user:julian' } })
    const asked: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      asked.push(input instanceof Request ? input.url : String(input))
      return new Response('not found', { status: 404 })
    })
    try {
      // The first of the two issuers is trusted, and verifies as it would alone.
      expect((await (await as(oidcToken()))('POST', '/messages', { channel: 'ci', text: 'from gitlab' })).status).toBe(201)
      expect((await (await as(oidcToken({}, `${OIDC_ISS}/`)))('GET', '/me')).status).toBe(401)
      expect((await (await as(oidcToken({}, 'https://169.254.169.254')))('GET', '/me')).status).toBe(401)
      expect(asked).toEqual([])
      expect((await person('POST', '/messages', { channel: 'dev', text: 'still in' })).status).toBe(201)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('explain', () => {
  it('says which pattern, level, and grants decide a channel for a principal, and what they give', async () => {
    const { owner } = await setUp()
    const lock = (await owner('POST', '/grants', { principals: [everyone], can: { 'security/': [] } })).body.grant
    const team = (await owner('POST', '/grants', { principals: [user('u_alice'), user('u_bob')], can: { 'security/': 'all' } })).body.grant
    const explain = async (query: string) => (await owner('GET', `/grants/explain?${query}`)).body
    expect(await explain('channel=security/incidents&user=u_bob')).toEqual({ channel: 'security/incidents', pattern: 'security/', over: ['*'], level: 'principal', grants: [team], capped: null, can: ALL })
    expect(await explain('channel=security/incidents&user=u_carol')).toEqual({ channel: 'security/incidents', pattern: 'security/', over: ['*'], level: 'everyone', grants: [lock], capped: null, can: [] })
    expect(await explain('channel=dev&user=u_carol')).toMatchObject({ pattern: '*', over: [], level: 'group', grants: [{ id: 'g1' }], can: ALL })
    // A project on the board's team, in the environment it names.
    expect(await explain('channel=dev&project=prj_web&environment=preview')).toMatchObject({ pattern: '*', level: 'group', grants: [{ id: 'g2' }], can: ['read', 'post', 'react', 'label', 'sync'] })
  })

  it('explains the caller when it names no one, and nothing for whom nothing lets in', async () => {
    const { person, as, narrowed } = await setUp()
    await person('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['post'] } })
    const explain = async (query: string) => (await person('GET', `/grants/explain?${query}`)).body
    expect(await explain('channel=ci&github=acme/other')).toEqual({ channel: 'ci', pattern: null, over: [], level: null, grants: [], capped: null, can: [] })
    // A local board has no apps: nothing lets one in, even one a grant names.
    await person('POST', '/grants', { principals: [{ kind: 'app', app: 'cl_ship' }], can: { 'ci/': ['post'] } })
    expect(await explain('channel=ci&app=cl_ship')).toEqual({ channel: 'ci', pattern: null, over: [], level: null, grants: [], capped: null, can: [] })
    expect((await person('GET', '/grants/explain?channel=ci&app=cl_ship&user=u_bob')).status).toBe(400)
    // A run asks about itself: what decides, without the grants, which it may not list.
    const run = await as(workflowToken({ repository: 'acme/web', repository_id: '99' }))
    expect((await run('GET', '/grants/explain?channel=ci')).body).toEqual({ channel: 'ci', pattern: 'ci/', over: [], level: 'principal', grants: [], capped: null, can: ['post'] })
    expect((await explain('channel=ci&github=acme/web')).grants).toHaveLength(1)
    // A run on a branch a grant names is on main unless the query says otherwise.
    await person('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/api', workflow: 'ci.yml', branch: 'main' }], can: { 'ci/': ['read'] } })
    expect((await explain('channel=ci&github=acme/api&workflow=ci.yml')).can).toEqual(['read'])
    expect((await explain('channel=ci&github=acme/api&workflow=ci.yml&branch=dev')).can).toEqual([])
    expect((await run('GET', '/grants/explain?channel=ci&user=u_julian')).status).toBe(403)
    expect((await run('GET', '/grants/explain?channel=ci&app=cl_ship')).status).toBe(403)
    // A caller narrowed with x-board-can says what it may do, narrowed.
    const reader = await narrowed(personToken(), 'ci/=read')
    expect((await reader('GET', '/grants/explain?channel=ci')).body).toMatchObject({ pattern: '*', level: 'group', can: ['read'] })
  })

  it("refuses a name it can't look up, and a query that names two principals", async () => {
    const { person } = await setUp()
    const status = async (query: string) => (await person('GET', `/grants/explain?${query}`)).status
    expect(await status('channel=dev&user=ada@acme.com')).toBe(400)
    expect(await status('channel=dev&project=web')).toBe(400)
    expect(await status('channel=dev&user=u_ada&project=prj_web')).toBe(400)
    expect(await status('channel=dev&environment=preview')).toBe(400)
    expect(await status('channel=Not%20A%20Channel')).toBe(400)
  })
})

