import { describe, expect, it } from 'vitest'
import { ChannelPath } from '../src/contract/schemas.ts'
import {
  authorize,
  compileAccess,
  expand,
  IMPLIES,
  parsePattern,
  parseScope,
  PERMISSIONS,
  type Access,
  type Permission,
} from '../src/server/access.ts'

// The real evaluator over the small universe of model/Access.tla, every case
// of it, so the code and the model agree. The model's definitions are
// transcribed below with their TLA+ names; the evaluator is never asked to
// check itself.

const CHANNELS = ['a', 'a/b', 'c'] as const
const PATTERNS = ['*', 'a', 'a/', 'a/b', 'a/b/', 'c', 'c/'] as const
/**
 * The model's channels, plus channels its patterns govern that don't exist
 * yet (`a/x`, a new top-level `z`) and one that only shares a prefix (`ab`,
 * which `a/` must not cover). Together they decide `everywhere` and
 * `anywhere`: every pattern governs at least one of them alone.
 */
const PROBES = [...CHANNELS, 'a/x', 'a/b/x', 'c/x', 'ab', 'z'] as const

type Perms = ReadonlySet<Permission>
type Map_ = Readonly<Record<string, readonly Permission[]>>

// TrueImplies and Close.
const TRUE_IMPLIES: Record<Permission, readonly Permission[]> = {
  read: [],
  post: [],
  react: ['read'],
  label: ['read'],
  sync: ['read'],
  manage: PERMISSIONS.filter((permission) => permission !== 'manage'),
}
const close = (set: Iterable<Permission>): Perms => {
  const out = new Set(set)
  for (const permission of [...out]) for (const implied of TRUE_IMPLIES[permission]) out.add(implied)
  return out
}

// IsSubtree, Matches, Rank, and At: the most specific matching pattern decides.
const isSubtree = (pattern: string) => pattern !== '*' && pattern.endsWith('/')
const matches = (pattern: string, channel: string) =>
  pattern === '*' ||
  pattern === channel ||
  (isSubtree(pattern) &&
    (pattern.slice(0, -1) === channel || (channel.length > pattern.length && channel.startsWith(pattern))))
const rank = (pattern: string) =>
  pattern === '*' ? 0 : isSubtree(pattern) ? 2 * pattern.length - 3 : 2 * pattern.length
const at = (map: Map_, channel: string): readonly Permission[] => {
  const matching = Object.keys(map).filter((pattern) => matches(pattern, channel))
  if (matching.length === 0) return []
  return map[matching.reduce((best, pattern) => (rank(pattern) > rank(best) ? pattern : best))]!
}

// Entitled: the grant closed by the table, intersected with any scope.
const entitled = (map: Map_, channel: string, scope?: Map_): Perms => {
  const grant = close(at(map, channel))
  if (!scope) return grant
  const narrowing = close(at(scope, channel))
  return new Set([...grant].filter((permission) => narrowing.has(permission)))
}

/** What each permission needs where it's used, from the model's Needs: a verb that addresses a message by ID also needs read. */
const NEEDS: Record<Permission, readonly Permission[]> = {
  read: ['read'],
  post: ['post'],
  react: ['react', 'read'],
  label: ['label', 'read'],
  sync: ['sync', 'read'],
  // Cancelling someone's schedule, which must be readable first.
  manage: ['manage', 'read'],
}

/** Every subset of `items`. */
const subsets = <T>(items: readonly T[]): T[][] =>
  items.reduce<T[][]>((all, item) => [...all, ...all.map((subset) => [...subset, item])], [[]])

/** Every map that gives each of `patterns` one of `grants`, or leaves it out. */
const maps = (patterns: readonly string[], grants: readonly (readonly Permission[])[]): Map_[] =>
  patterns.reduce<Map_[]>(
    (all, pattern) => all.flatMap((map) => [map, ...grants.map((grant) => ({ ...map, [pattern]: grant }))]),
    [{}],
  )

const hidden = () => new Error('hidden')

/**
 * The evaluator's answer for every permission in every probe is the model's,
 * every permission it gives can be used (`authorize` lets it through, the
 * 404-unless-readable guard included), and what it says about every channel,
 * including ones that don't exist yet, is what the probes say.
 */
function agrees(access: Access, expected: (channel: string) => Perms, label: string) {
  const held = new Map(PROBES.map((channel) => [channel, expected(channel)]))
  for (const [channel, permissions] of held) {
    for (const permission of PERMISSIONS) {
      const can = access.can(permission, channel)
      if (can !== permissions.has(permission))
        expect.fail(`${label}: ${permission} in ${channel} is ${can}, the model says ${!can}`)
      if (!can) continue
      for (const needed of NEEDS[permission])
        if (!access.can(needed, channel)) expect.fail(`${label}: ${permission} in ${channel} without ${needed} can never be used`)
      // Starting a thread addresses nothing, so only post goes without the guard.
      const proof = authorize(access, permission, channel, permission === 'post' ? undefined : hidden)
      if (proof.channel !== channel) expect.fail(`${label}: a proof for another channel`)
    }
    if (access.readable(channel) !== permissions.has('read')) expect.fail(`${label}: readable(${channel}) disagrees with can`)
  }
  for (const permission of PERMISSIONS) {
    const everywhere = [...held.values()].every((permissions) => permissions.has(permission))
    const anywhere = [...held.values()].some((permissions) => permissions.has(permission))
    if (access.everywhere(permission) !== everywhere) expect.fail(`${label}: everywhere(${permission}) is ${!everywhere}`)
    if (access.anywhere(permission) !== anywhere) expect.fail(`${label}: anywhere(${permission}) is ${!anywhere}`)
  }
  if (access.readsAll !== access.everywhere('read')) expect.fail(`${label}: readsAll disagrees with everywhere(read)`)
}

const show = (map: Map_) => JSON.stringify(map)

describe('access, exhaustively over the model’s universe', () => {
  it('keeps the model’s implications table, closed', () => {
    expect(Object.fromEntries(PERMISSIONS.map((permission) => [permission, [...IMPLIES[permission]].sort()]))).toEqual(
      Object.fromEntries(PERMISSIONS.map((permission) => [permission, [...TRUE_IMPLIES[permission]].sort()])),
    )
    for (const grant of subsets(PERMISSIONS)) {
      const expanded = expand(grant)
      // Holding a permission is holding everything it implies, and nothing more.
      expect(expanded, grant.join(',')).toEqual(close(grant))
      // One hop is enough: the table is closed (the model's ASSUME).
      expect(close(expanded)).toEqual(expanded)
      if (grant.includes('manage')) expect(expanded).toEqual(new Set(PERMISSIONS))
    }
    expect(expand('all')).toEqual(new Set(PERMISSIONS))
  })

  it('resolves every grant on every pattern, and the list shorthand, as the model does', () => {
    for (const grant of subsets(PERMISSIONS)) {
      for (const pattern of PATTERNS) {
        const map = { [pattern]: grant }
        agrees(compileAccess(map), (channel) => entitled(map, channel), show(map))
      }
      agrees(compileAccess(grant), (channel) => entitled({ '*': grant }, channel), `list ${grant.join(',')}`)
    }
    agrees(compileAccess('all'), () => new Set(PERMISSIONS), 'all')
  })

  it('lets the most specific pattern decide, for every map of the model’s patterns', () => {
    // Three answers on seven patterns, each also left out: 4^7 maps. Any two
    // patterns that could be confused get different answers in one of them.
    const grants: Permission[][] = [[], ['read'], ['react', 'post']]
    for (const map of maps(PATTERNS, grants)) {
      const access = compileAccess(map)
      agrees(access, (channel) => entitled(map, channel), show(map))
      // The summary `vb whoami` prints says the same thing.
      agrees(compileAccess(access.summary()), (channel) => entitled(map, channel), `summary of ${show(map)}`)
    }
  })

  it('only narrows: a scope is the intersection, channel by channel, for every pair of maps', () => {
    // Up to two patterns a side, so a scope's patterns meet the grant's
    // in every arrangement: 1 + 7·3 + 21·9 = 211 maps a side.
    const grants: Permission[][] = [[], ['read'], ['react', 'post']]
    const small = maps(PATTERNS, grants).filter((map) => Object.keys(map).length <= 2)
    const compiled = small.map((map) => compileAccess(map))
    for (const [i, map] of small.entries())
      for (const [j, scope] of small.entries()) {
        const label = `${show(map)} scoped to ${show(scope)}`
        const narrowed = compiled[i]!.narrow(compiled[j]!)
        agrees(narrowed, (channel) => entitled(map, channel, scope), label)
        for (const channel of PROBES)
          for (const permission of PERMISSIONS)
            if (narrowed.can(permission, channel) && !compiled[i]!.can(permission, channel)) expect.fail(`${label} widens`)
      }
  })

  it('narrows the same from the header as from config, as Pi’s proxy sends it', () => {
    const grants: Permission[][] = [[], ['read'], ['react', 'post']]
    const owner = { '*': ['manage'] } as const satisfies Map_
    const intake = { 'a/': ['post'], 'a/b': [], c: ['react'] } as const satisfies Map_
    for (const scope of maps(PATTERNS, grants).filter((map) => Object.keys(map).length > 0 && Object.keys(map).length <= 3)) {
      const header = Object.entries(scope)
        .map(([pattern, grant]) => `${pattern}=${grant.join(',')}`)
        .join(';')
      expect(parseScope(header), header).toEqual(scope)
      for (const map of [owner, intake])
        agrees(compileAccess(map).narrow(parseScope(header)), (channel) => entitled(map, channel, scope), `${show(map)} with ${header}`)
    }
    // The model's pi: full access behind its proxy's scope.
    const pi = { 'a/': ['read', 'post', 'react', 'label'], 'a/b': ['read', 'sync'] } as const satisfies Map_
    agrees(compileAccess(owner).narrow(parseScope('a/=read,post,react,label;a/b=read,sync')), (channel) => entitled(owner, channel, pi), 'pi')
  })

  it('reads only *, a channel, or a channel and its subtree, and says what to type for any other *', () => {
    // Every string up to five characters over a, b, /, *, and -.
    const alphabet = ['a', 'b', '/', '*', '-']
    let strings = ['']
    for (let length = 1, last = ['']; length <= 5; length++)
      strings = [...strings, ...(last = last.flatMap((prefix) => alphabet.map((char) => prefix + char)))]
    const channel = (path: string) => ChannelPath.safeParse(path).success
    for (const pattern of strings) {
      const valid = pattern === '*' || channel(pattern) || (pattern.endsWith('/') && channel(pattern.slice(0, -1)))
      const parsed = (() => {
        try {
          parsePattern(pattern)
          return null
        } catch (error) {
          return (error as Error).message
        }
      })()
      if (valid) {
        if (parsed !== null) expect.fail(`${pattern} is a pattern, but: ${parsed}`)
        expect(() => compileAccess({ [pattern]: ['read'] })).not.toThrow()
        expect(() => parseScope(`${pattern}=read`)).not.toThrow()
        continue
      }
      if (parsed === null) expect.fail(`${pattern || '(empty)'} isn't a pattern, but parsed`)
      if (!parsed.startsWith(`invalid channel pattern ${pattern || '(empty)'}: write `)) expect.fail(`${pattern}: ${parsed}`)
      // A glob says what it should have been: `*`, or the subtree of what comes before it.
      const before = pattern.split('*')[0]!.replace(/\/+$/, '')
      if (pattern.includes('*') && (before === '' || channel(before))) {
        const hint = before === '' ? 'write * for every channel' : `write ${before}/ for ${before} and its subtree`
        if (!parsed.endsWith(hint)) expect.fail(`${pattern}: ${parsed}, not ${hint}`)
      }
      expect(() => compileAccess({ [pattern]: ['read'] }), pattern).toThrow('invalid channel pattern')
      expect(() => parseScope(`${pattern}=read`), pattern).toThrow('invalid channel pattern')
    }
  })
})
