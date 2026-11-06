import { describe, expect, it } from 'vitest'
import type { AccessEvent } from '../src/contract/contract.ts'
import { foldAccess, startingAccess, type AccessState } from '../src/server/trust.ts'

const DAY = 24 * 3600_000
const T0 = Date.parse('2026-11-02T12:00:00.000Z')
const minter = { id: 'vercel:user:u_julian', kind: 'person' as const, handle: 'julian', scope: '*=read' }

/** The access session's events, as A2 hands them to the fold: each with its index and time. */
function history() {
  let index = 0
  const state: AccessState = startingAccess()
  const at = (time: number, type: AccessEvent['type'], payload: unknown) =>
    foldAccess(state, { type, payload, index: ++index, createdAt: new Date(time) } as unknown as AccessEvent)
  const mint = (time: number, expiresAt: number, parent: number | null = null) => {
    at(time, 'token.minted', { hash: index.toString(16).padStart(64, '0'), name: 'x', minter, profile: null, avatar: null, session: null, handle: 'julian', personName: null, expiresAt, parent, by: minter.id })
    return index
  }
  return { state, at, mint }
}

describe("the access session's fold", () => {
  it('folds the grants of a log from before grants named principals into nothing, so they reach none made since', () => {
    const { state, at } = history()
    at(T0, 'grant.set', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' }, by: minter.id })
    // Grant 1 was that one; g1 now is the board's own, every person.
    at(T0 + 1, 'grant.revoked', { id: 1, by: minter.id })
    at(T0 + 2, 'grant.created', { principals: [{ kind: 'everyone' }], can: { 'security/': [] }, by: minter.id })
    expect(Object.values(state.grants).map((grant) => [grant.id, grant.principals])).toEqual([
      [1, [{ kind: 'all-users' }]],
      [2, [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }]],
      [3, [{ kind: 'all-apps' }]],
      [4, [{ kind: 'everyone' }]],
    ])
  })

  it('drops a revoked token at once, and its hash with it', () => {
    const { state, at, mint } = history()
    const id = mint(T0, T0 + 30 * DAY)
    at(T0 + 1000, 'token.revoked', { id, by: minter.id })
    expect(state.tokens).toEqual({})
    expect(state.hashes).toEqual({})
  })

  it('drops expired tokens with the first event of a later day, and keeps the live ones', () => {
    const { state, at, mint } = history()
    const short = mint(T0, T0 + DAY)
    const long = mint(T0, T0 + 30 * DAY)
    // The day it expires, it's still there: it goes with the first event after that day.
    at(T0 + DAY, 'grant.revoked', { id: 999, by: minter.id })
    expect(Object.keys(state.tokens).map(Number)).toEqual([short, long])
    at(T0 + 2 * DAY, 'grant.revoked', { id: 999, by: minter.id })
    expect(Object.keys(state.tokens).map(Number)).toEqual([long])
    expect(Object.keys(state.hashes)).toHaveLength(1)
    at(T0 + 40 * DAY, 'grant.revoked', { id: 999, by: minter.id })
    expect(state.tokens).toEqual({})
    expect(state.expiring).toEqual({})
  })
})
