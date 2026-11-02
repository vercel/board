import { ChannelPath, SCOPE_MAX } from '../contract/schemas.ts'
import { forbidden } from './errors.ts'

/**
 * What a principal may do in a channel. `read` covers messages, threads,
 * `/events`, and schedules; `post` starts threads and edits your own messages;
 * `manage` is the board's own bookkeeping (inbox, sources).
 */
export const PERMISSIONS = ['read', 'post', 'react', 'label', 'sync', 'manage'] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * One hop of implication, kept as data like Vercel's git broker
 * (`ACTION_IMPLICATIONS`). Each verb that addresses a message by ID implies
 * `read`, so none of them is a blind existence oracle. `post` implies nothing:
 * write-only is `['post']`.
 */
export const IMPLIES: Readonly<Record<Permission, readonly Permission[]>> = {
  read: [],
  post: [],
  react: ['read'],
  label: ['read'],
  sync: ['read'],
  manage: ['read', 'post', 'react', 'label', 'sync'],
}

/** `*`, a channel (`feedback`), or a channel and its subtree (`feedback/`). */
export type ChannelPattern = string
export type Grant = 'all' | readonly Permission[]
/** `'all'`, a list for every channel (`['post']` is `{ '*': ['post'] }`), or a map from pattern to grant. */
export type Can = Grant | Readonly<Record<ChannelPattern, Grant>>
/** Each pattern's whole answer, implications included. */
export type AccessSummary = Readonly<Record<ChannelPattern, readonly Permission[]>>

type Pattern = { kind: 'all' } | { kind: 'exact'; path: string } | { kind: 'subtree'; path: string }

const ORDER = new Map(PERMISSIONS.map((permission, index) => [permission, index]))
const SHAPE = 'write *, a channel, or a channel and its subtree (feedback/)'

/** A pattern's parts; any other `*` throws, and says what to type instead. */
export function parsePattern(pattern: string): Pattern {
  if (pattern === '*') return { kind: 'all' }
  if (pattern.includes('*')) {
    const before = pattern.slice(0, pattern.indexOf('*')).replace(/\/+$/, '')
    const hint =
      before === ''
        ? 'write * for every channel'
        : ChannelPath.safeParse(before).success
          ? `write ${before}/ for ${before} and its subtree`
          : SHAPE
    throw new Error(`invalid channel pattern ${pattern}: ${hint}`)
  }
  const subtree = pattern.endsWith('/')
  const path = subtree ? pattern.slice(0, -1) : pattern
  if (!ChannelPath.safeParse(path).success) throw new Error(`invalid channel pattern ${pattern || '(empty)'}: ${SHAPE}`)
  return subtree ? { kind: 'subtree', path } : { kind: 'exact', path }
}

const key = (pattern: Pattern) =>
  pattern.kind === 'all' ? '*' : pattern.kind === 'subtree' ? `${pattern.path}/` : pattern.path

/** A grant with its implications, closed: `['label']` is `read` and `label`. */
export function expand(grant: Grant): ReadonlySet<Permission> {
  const out = new Set<Permission>()
  const add = (permission: Permission) => {
    if (!ORDER.has(permission)) throw new Error(`unknown permission ${String(permission)}: use ${PERMISSIONS.join(', ')}`)
    if (out.has(permission)) return
    out.add(permission)
    for (const implied of IMPLIES[permission]) add(implied)
  }
  for (const permission of grant === 'all' ? PERMISSIONS : grant) add(permission)
  return out
}

const NOTHING: ReadonlySet<Permission> = new Set()

/** Rules compiled for resolution: an exact channel beats the longest subtree, which beats `*`. */
type Rules = {
  all: ReadonlySet<Permission> | null
  exact: ReadonlyMap<string, ReadonlySet<Permission>>
  /** Longest path first. */
  subtrees: readonly (readonly [string, ReadonlySet<Permission>])[]
}

type Entry = readonly [Pattern, ReadonlySet<Permission>]

function compile(entries: Iterable<Entry>): Rules {
  let all: ReadonlySet<Permission> | null = null
  const exact = new Map<string, ReadonlySet<Permission>>()
  const subtrees: [string, ReadonlySet<Permission>][] = []
  for (const [pattern, permissions] of entries) {
    if (pattern.kind === 'all') all = permissions
    else if (pattern.kind === 'exact') exact.set(pattern.path, permissions)
    else subtrees.push([pattern.path, permissions])
  }
  subtrees.sort((a, b) => b[0].length - a[0].length)
  return { all, exact, subtrees }
}

const under = (channel: string, path: string) => channel === path || channel.startsWith(`${path}/`)

/** What the most specific pattern covering `channel` gives; with `subtreeOnly`, ignoring an exact rule for it. */
function resolve(rules: Rules, channel: string, subtreeOnly = false): ReadonlySet<Permission> {
  if (!subtreeOnly) {
    const exact = rules.exact.get(channel)
    if (exact) return exact
  }
  for (const [path, permissions] of rules.subtrees) if (under(channel, path)) return permissions
  return rules.all ?? NOTHING
}

/**
 * What `rules` gives every channel `pattern` governs where nothing more
 * specific does. The patterns matching one channel form a chain, so that's one
 * answer: an exact channel resolves as itself, a subtree as whatever covers the
 * subtree's root, ignoring an exact rule for the root.
 */
const at = (rules: Rules, pattern: Pattern) =>
  pattern.kind === 'all' ? (rules.all ?? NOTHING) : resolve(rules, pattern.path, pattern.kind === 'subtree')

const equal = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>) =>
  a.size === b.size && [...a].every((permission) => b.has(permission))

/** The answer of the pattern next less specific than `pattern` in `rules`. */
function parent(rules: Rules, pattern: Pattern): ReadonlySet<Permission> {
  if (pattern.kind === 'exact') return resolve(rules, pattern.path, true)
  if (pattern.kind === 'subtree')
    for (const [path, permissions] of rules.subtrees)
      if (path !== pattern.path && under(pattern.path, path)) return permissions
  return rules.all ?? NOTHING
}

/** Drops rules that say what their parent says, and an empty `*`, so equal access has one summary. */
function canonical(entries: Entry[]): Rules {
  const rules = compile(entries)
  return compile(
    entries.filter(([pattern, permissions]) =>
      pattern.kind === 'all' ? permissions.size > 0 : !equal(permissions, parent(rules, pattern)),
    ),
  )
}

function entriesOf(can: Can): Entry[] {
  if (can === 'all' || Array.isArray(can)) return [[{ kind: 'all' }, expand(can as Grant)]]
  return Object.entries(can as Record<string, Grant>).map(([pattern, grant]) => [parsePattern(pattern), expand(grant)] as const)
}

const entriesIn = (rules: Rules): Entry[] => [
  ...(rules.all ? [[{ kind: 'all' }, rules.all] as const] : []),
  ...rules.subtrees.map(([path, permissions]) => [{ kind: 'subtree', path }, permissions] as const),
  ...[...rules.exact].map(([path, permissions]) => [{ kind: 'exact', path }, permissions] as const),
]

export type Access = {
  can(permission: Permission, channel: string): boolean
  /** The hot path for feeds: memoized per channel. */
  readable(channel: string): boolean
  /** `read` in every channel, including ones that don't exist yet. */
  readsAll: boolean
  /** `permission` in every channel, including ones that don't exist yet: `everywhere('manage')` is full access. */
  everywhere(permission: Permission): boolean
  /** `permission` in some channel. */
  anywhere(permission: Permission): boolean
  /** Only what both this and `scope` allow, channel by channel. It never widens. */
  narrow(scope: Can | Access): Access
  /** Each pattern and its permissions, `*` first and the rest sorted; an empty `*` is left out. */
  summary(): AccessSummary
}

const RULES = Symbol('board.access')
type Compiled = Access & { readonly [RULES]: Rules }
const isAccess = (value: Can | Access): value is Compiled => typeof value === 'object' && RULES in value

function fromRules(rules: Rules): Access {
  const entries = entriesIn(rules)
  const everywhere = (permission: Permission) =>
    (rules.all?.has(permission) ?? false) && entries.every(([, permissions]) => permissions.has(permission))
  const readable = new Map<string, boolean>()
  const compiled: Compiled = {
    [RULES]: rules,
    can: (permission, channel) => resolve(rules, channel).has(permission),
    readable(channel) {
      let found = readable.get(channel)
      if (found === undefined) readable.set(channel, (found = resolve(rules, channel).has('read')))
      return found
    },
    readsAll: everywhere('read'),
    everywhere,
    anywhere: (permission) => entries.some(([, permissions]) => permissions.has(permission)),
    narrow(scope) {
      const other = isAccess(scope) ? scope[RULES] : canonical(entriesOf(scope as Can))
      // `*` and every pattern either side names: each governs channels where both answers are fixed.
      const patterns = new Map<string, Pattern>([['*', { kind: 'all' }]])
      for (const [pattern] of [...entries, ...entriesIn(other)]) patterns.set(key(pattern), pattern)
      return fromRules(
        canonical(
          [...patterns.values()].map((pattern) => {
            const theirs = at(other, pattern)
            return [pattern, new Set([...at(rules, pattern)].filter((permission) => theirs.has(permission)))] as const
          }),
        ),
      )
    },
    summary() {
      const named = entries.map(([pattern, permissions]) => [key(pattern), permissions] as const)
      named.sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))
      const out: Record<ChannelPattern, Permission[]> = {}
      for (const [name, permissions] of named) out[name] = [...permissions].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)
      return out
    },
  }
  return compiled
}

/** Access from config: `'all'`, a list for every channel, or a map from pattern to grant. Throws on a bad pattern or permission. */
export function compileAccess(can: Can): Access {
  return fromRules(canonical(entriesOf(can)))
}

export const FULL_ACCESS = compileAccess('all')

/**
 * `x-board-scope`: `dev/=read,post,react,label;ci/=read`. Each entry is a
 * pattern and its permissions (or `all`). It's meant for a proxy that holds the
 * credential, like Pi's sandbox: the board intersects it with the principal's
 * access, so it can only narrow, and a caller holding its own token gains
 * nothing by sending it.
 */
export function parseScope(header: string): Can {
  if (header.length > SCOPE_MAX) throw new Error(`x-board-scope is longer than ${SCOPE_MAX} characters`)
  const out: Record<ChannelPattern, Grant> = {}
  const entries = header.split(';').map((entry) => entry.trim())
  if (entries.every((entry) => entry === '')) throw new Error('x-board-scope is empty: write pattern=permissions, like dev/=read,post')
  for (const entry of entries) {
    if (entry === '') continue
    const split = entry.indexOf('=')
    if (split < 0) throw new Error(`x-board-scope entry ${entry} needs =: write pattern=permissions, like dev/=read,post`)
    const pattern = entry.slice(0, split).trim()
    const list = entry.slice(split + 1).trim()
    if (Object.hasOwn(out, pattern)) throw new Error(`x-board-scope lists ${pattern} twice`)
    parsePattern(pattern)
    const permissions = list === '' ? [] : list.split(',').map((permission) => permission.trim())
    if (permissions.length === 1 && permissions[0] === 'all') {
      out[pattern] = 'all'
      continue
    }
    for (const permission of permissions)
      if (!ORDER.has(permission as Permission))
        throw new Error(`x-board-scope: unknown permission ${permission || '(empty)'}: use ${PERMISSIONS.join(', ')}, or all`)
    out[pattern] = permissions as Permission[]
  }
  return out
}

declare const proven: unique symbol
/**
 * That `permission` was checked in `channel`. Write functions take one, look
 * their target up themselves, and refuse a target in another channel, so a
 * check made against one channel can't be spent on another.
 * Only `authorize` makes one.
 */
export type Proof<P extends Permission = Permission> = {
  readonly permission: P
  readonly channel: string
  readonly [proven]: true
}

const PHRASE: Record<Permission, (channel: string) => string> = {
  read: (channel) => `read ${channel}`,
  post: (channel) => `post in ${channel}`,
  react: (channel) => `react in ${channel}`,
  label: (channel) => `label in ${channel}`,
  sync: (channel) => `sync in ${channel}`,
  manage: (channel) => `manage ${channel}`,
}

/**
 * A proof that `access` allows `permission` in `channel`, or a 403 naming what's
 * missing: `this token can't label in dev`. Pass the channel the board looked
 * up, never one the request named. What the caller can't read should answer as
 * if it didn't exist: pass that error as `hidden`, and it's thrown instead
 * whenever `channel` isn't readable.
 */
export function authorize<P extends Permission>(
  access: Access,
  permission: P,
  channel: string,
  hidden?: () => Error,
): Proof<P> {
  if (hidden && !access.readable(channel)) throw hidden()
  if (!access.can(permission, channel)) throw forbidden(`this token can't ${PHRASE[permission](channel)}`)
  return Object.freeze({ permission, channel }) as unknown as Proof<P>
}
