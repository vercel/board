import { describe, expect, it } from 'vitest'
import { checkGrantChange, compileAccess, type Can, type GrantShape } from '../src/access/index.ts'

// What a board and Vercel's API both run on a grant write. A caller is what `GET /me` says it may
// do (`caller`), and what it may do by its own limits, its role, grants, and token, without
// everyone's grants (`own`).
const g1: GrantShape = { principals: [{ kind: 'all-users' }], can: { '*': 'all' } }
const run = [{ kind: 'github' }]
const everyone = (can: GrantShape['can']): GrantShape => ({ principals: [{ kind: 'everyone' }], can })
const as = (caller: Can, own: Can = caller) => ({ caller: compileAccess(caller), own: compileAccess(own) })
const grant = (can: GrantShape['can']): GrantShape => ({ principals: run, can })

describe('checkGrantChange', () => {
  it("refuses a grant that reaches where the caller can't manage, by its token or its own grants", () => {
    const changed = grant({ '*': 'all' })
    // (a) A token with nothing in secret/.
    expect(checkGrantChange({ ...as({ '*': 'all', 'secret/': [] }), after: [g1, changed], changed })).toEqual({ reason: 'reach', pattern: 'secret/', permission: 'manage' })
    // (b) A person a grant on them keeps out of security/.
    expect(checkGrantChange({ ...as({ '*': 'all', 'security/': [] }), after: [g1, changed], changed })).toEqual({ reason: 'reach', pattern: 'security/', permission: 'manage' })
  })

  it("refuses a token's own limit even where everyone is shut out, since the lock may be lifted", () => {
    // (e) Lift everyone's lock on secret/ later, and the run would read it while the token still can't.
    const changed = grant({ '*': 'all' })
    const token = as({ '*': 'all', 'secret/': [] })
    expect(checkGrantChange({ ...token, after: [g1, everyone({ 'secret/': [] }), changed], changed })).toEqual({ reason: 'reach', pattern: 'secret/', permission: 'manage' })
  })

  it('lets a member grant on * past a channel closed to everyone, and nothing in it', () => {
    const lock = everyone({ 'security/': [] })
    const alice = { principals: [{ kind: 'user' }], can: { 'security/': 'all' } } as const
    // Bob is shut out of security/ by everyone's lock alone.
    const bob = as({ '*': 'all', 'security/': [] }, { '*': 'all' })
    const wide = grant({ '*': 'all' })
    // (c)
    expect(checkGrantChange({ ...bob, after: [g1, lock, alice, wide], changed: wide })).toBeNull()
    // (d) His run's grant on security/ would meet the lock there and win, being closer.
    for (const pattern of ['security/', 'security/incidents']) {
      const changed = grant({ [pattern]: ['read'] })
      expect(checkGrantChange({ ...bob, after: [g1, lock, alice, changed], changed })).toEqual({ reason: 'reach', pattern, permission: 'manage' })
    }
  })

  it("counts a lock at the grant's own patterns, though not under them", () => {
    const changed = grant({ 'secret/sub/': 'all' })
    const bob = as({ '*': 'all', 'secret/': [] }, { '*': 'all' })
    expect(checkGrantChange({ ...bob, after: [g1, everyone({ 'secret/': [] }), changed], changed })).toEqual({ reason: 'reach', pattern: 'secret/sub/', permission: 'manage' })
  })

  it('lets no one in, however narrow the grant, where everyone gets more than the caller has', () => {
    const changed = grant({ 'dev/': ['post'] })
    // A token kept out of secret/, which everyone reads: the run it lets in would read it.
    const reads = everyone({ 'secret/': ['read'] })
    expect(checkGrantChange({ ...as({ '*': 'all', 'secret/': [] }), after: [g1, reads, changed], changed })).toEqual({ reason: 'admission', pattern: 'secret/', permission: 'read' })
    // A person kept out of security/incidents, under security/, which everyone reads.
    const carol = as({ '*': 'all', 'security/': ['read'], 'security/incidents': [] }, { '*': 'all', 'security/incidents': [] })
    expect(checkGrantChange({ ...carol, after: [g1, everyone({ 'security/': ['read'] }), changed], changed })).toEqual({ reason: 'admission', pattern: 'security/incidents', permission: 'read' })
    // Where everyone gets nothing, there's nothing to let anyone in to.
    const bob = as({ '*': 'all', 'secret/': [] }, { '*': 'all' })
    expect(checkGrantChange({ ...bob, after: [g1, everyone({ 'secret/': [] }), changed], changed })).toBeNull()
  })

  it('judges a revoke or a removal by reach alone, since it widens whoever the grant named and lets no one in', () => {
    // A token kept out of secret/ lifts nothing that held anyone back there.
    const shut: GrantShape = { principals: [{ kind: 'project' }], can: { '*': [] } }
    expect(checkGrantChange({ ...as({ '*': 'all', 'secret/': [] }), after: [g1], revoked: shut })).toEqual({ reason: 'reach', pattern: 'secret/', permission: 'manage' })
    // A member shut out of security/ by everyone's lock alone lifts a grant on *, but not the lock.
    const lock = everyone({ 'security/': [] })
    const bob = as({ '*': 'all', 'security/': [] }, { '*': 'all' })
    expect(checkGrantChange({ ...bob, after: [g1, lock], revoked: grant({ '*': ['read'] }) })).toBeNull()
    expect(checkGrantChange({ ...bob, after: [g1], revoked: lock })).toEqual({ reason: 'reach', pattern: 'security/', permission: 'manage' })
    // Narrower than everyone somewhere, a caller still revokes where it reaches: no one new gets in.
    const carol = as({ '*': 'all', 'security/': ['read'], 'security/incidents': [] }, { '*': 'all', 'security/incidents': [] })
    expect(checkGrantChange({ ...carol, after: [g1, everyone({ 'security/': ['read'] })], revoked: grant({ 'dev/': ['post'] }) })).toBeNull()
  })

  it('lets an owner no token narrows make any grant', () => {
    const changed = grant({ '*': 'all' })
    expect(checkGrantChange({ ...as({}), owner: true, after: [g1, everyone({ 'secret/': ['read'] }), changed], changed })).toBeNull()
  })
})
