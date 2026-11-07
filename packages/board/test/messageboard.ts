// An in-memory `/v1/messageboard`, as Vercel's API behaves: what
// `vercel()` from `@vercel/board/backend-vercel` is tested against. A bearer token names its principal:
// `user:u_jb`, `app:oac_1`, or `project:prj_pong:production`.
import { randomBytes, randomUUID } from 'node:crypto'
import { fakeGrants, GrantRefused, type Role, type Who } from './messageboard-grants.ts'

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
  | { type: 'external'; id: string; syncKey: string }
type Actor = {
  id: string
  principal: Principal
  profile?: { name: string; avatar?: string }
  session?: string
  /** The board token the request came with: it acts as `principal`, narrowed, on its own board. */
  token?: Minted
  /** A development token that carries a person: it's them, but it can't mint board tokens. */
  development?: true
}
/** A board token, as Vercel's API keeps it: one board's, minted by a person, a deployment, or another token. */
type Minted = {
  id: string
  boardId: string
  name: string
  can: Record<string, 'all' | string[]>
  profile: string | null
  session: string | null
  /** The actor that minted it. */
  by: string
  /** Who it acts as: whoever minted the first token in its line. */
  principal: Principal
  parent: string | null
  at: number
  expiresAt: number
  revoked: boolean
}
type Message = {
  id: string
  threadId: string
  sequence: number
  replyTo?: number
  text: string
  revision: number
  createdAt: number
  createdBy: Actor
  editedAt?: number
  deletedAt?: number
  changes: number
  reactions: Map<string, Map<string, { actor: Actor; createdAt: number }>>
  labels: Record<string, string>
  /** Its post's place in its channel's feed, which a channel cursor counts. */
  feedSequence: number
  attachments?: { id: string; name: string; type: string; size: number }[]
  schedule?: { id: string; n: number }
  /** An import's sync key, and where it is on its platform. */
  from?: string
  origin?: Record<string, unknown>
  noSync?: boolean
  links?: { url: string; message?: string | null; snapshot?: unknown; unavailable?: string | null }[]
}
type Schedule = {
  id: string
  channelId: string
  threadId?: string
  text: string
  labels?: Record<string, string>
  noSync?: boolean
  firstAt: number
  every?: number
  until?: number
  times?: number
  sent: number
  nextAt: number | null
  lastMessageId?: string
  state: 'pending' | 'done' | 'canceled'
  canceled?: { by?: Actor; at: number; reason: 'canceled' | 'revoked' | 'disabled' }
  createdAt: number
  createdBy: Actor
  revision: number
}
type Attachment = { id: string; boardId: string; name: string; type: string; size: number; sha256: string; state: 'pending' | 'ready'; messageId?: string; createdAt: number; createdBy: Actor }
type Thread = {
  id: string
  channelId: string
  messageCount: number
  lastActivityAt: number
  lastMessage?: { id: string; sequence: number; createdAt: number; createdBy: Actor }
  createdAt: number
  createdBy: Actor
  messages: Message[]
}
type Change = Record<string, unknown> & { createdAt: number; messageId?: string }
type ActorView = { id: string; kind: 'person' | 'agent' | 'deployment' | 'app' | 'external'; handle: string; name?: string; avatar?: string; lastSeenAt: number }

const EMOJI = /^[a-z0-9_+-]{1,64}$/
const CHANNEL = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/
const MESSAGE_ID = /^msg_([0-9a-f-]{36})_(\d+)$/

class Refused extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Vercel accounts the fake knows, by user ID: how the API names a person (their username, then their name). */
const ACCOUNTS: Record<string, { username: string; name: string }> = {
  u_jb: { username: 'julian', name: 'Julián Benegas' },
  u_ada: { username: 'ada', name: 'Ada Lovelace' },
}

const principalId = (p: Principal) =>
  p.type === 'external' ? p.id : p.type === 'user' ? `vercel:user:${p.userId}` : p.type === 'app' ? `vercel:app:${p.clientId}` : `vercel:project:${p.projectId}:${p.environment}`
const samePrincipal = (a: Principal, b: Principal) => principalId(a) === principalId(b)

/**
 * Who a request is: its bearer names a principal (`user:u_jb:development` a development token that
 * carries one), is a credential `tokens` maps to one, or is the secret of a board token `minted`,
 * which acts as whoever minted its line.
 */
function actorOf(request: Request, tokens: Record<string, string> = {}, minted: Minted | null = null): Actor {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const token = tokens[bearer] ?? bearer
  const [type, id, environment] = token.split(':')
  const principal: Principal | null = minted
    ? minted.principal
    : type === 'user' && id
      ? { type, userId: id }
      : type === 'app' && id
        ? { type, clientId: id }
        : type === 'project' && id && environment
          ? { type, projectId: id, environment }
          : null
  if (!principal) throw new Refused(401, 'invalid_token', 'This token is invalid, expired, or revoked.')
  const development = !minted && type === 'user' && environment === 'development'
  const name = request.headers.get('x-board-profile') ?? minted?.profile ?? undefined
  const avatar = request.headers.get('x-board-avatar') ?? undefined
  const session = request.headers.get('x-board-session') ?? undefined
  const base = principalId(principal)
  return {
    id: name ? `${base}+${name.toLowerCase()}` : base,
    principal,
    ...(name ? { profile: { name, ...(avatar ? { avatar } : {}) } } : {}),
    ...(session ?? minted?.session ? { session: (session ?? minted?.session)! } : {}),
    ...(minted ? { token: minted } : {}),
    ...(development ? { development: true as const } : {}),
  }
}

const TOKEN_PERMISSIONS = ['read', 'post', 'react', 'label', 'sync', 'manage']
const TOKEN_PATTERN = /^(\*|[a-z0-9_-]+(\/[a-z0-9_-]+)*\/?)$/
const DAY = 86_400_000

/**
 * Board tokens, as Vercel's API keeps them: each one board's, its secret shown once, a retried mint
 * 409. People, deployments, and tokens mint; apps and development tokens that carry a person don't.
 * A token lists and revokes only itself and the tokens made from it; anyone else, the tokens that act
 * as them. One that's revoked, expired, or whose person left the team is 401 `invalid_token`.
 */
function fakeTokens(shared: { member: (userId: string) => boolean; now: () => number }) {
  const minted = new Map<string, Minted>()
  const secrets = new Map<string, string>()
  const replays = new Map<string, string>()
  let next = 1

  /** The token `bearer` is the secret of, if any: one that's no longer good is 401. */
  function authenticate(bearer: string): Minted | null {
    const id = secrets.get(bearer)
    if (id === undefined) return null
    const token = minted.get(id)!
    const left = token.principal.type === 'user' && !shared.member(token.principal.userId)
    if (token.revoked || token.expiresAt <= shared.now() || left) throw new Refused(401, 'invalid_token', 'This token is invalid, expired, or revoked.')
    return token
  }

  const summary = (can: Minted['can']) => Object.fromEntries(Object.entries(can).map(([pattern, grant]) => [pattern, grant === 'all' ? [...TOKEN_PERMISSIONS] : [...grant]]))
  const view = (token: Minted) => ({
    id: token.id,
    name: token.name,
    can: summary(token.can),
    profile: token.profile,
    session: token.session,
    by: token.by,
    at: token.at,
    expiresAt: token.expiresAt,
    parent: token.parent,
  })

  function canOf(can: unknown): Minted['can'] {
    if (can === undefined) return { '*': 'all' }
    const valid =
      typeof can === 'object' && can !== null && !Array.isArray(can) && Object.keys(can).length > 0 &&
      Object.entries(can).every(([pattern, grant]) => TOKEN_PATTERN.test(pattern) && (grant === 'all' || (Array.isArray(grant) && grant.every((permission) => TOKEN_PERMISSIONS.includes(permission)))))
    if (!valid) throw new Refused(400, 'invalid_scope', 'A scope maps channel patterns to permissions.')
    return can as Minted['can']
  }

  function lifetime(expires: unknown): number {
    if (expires === undefined) return 30 * DAY
    const found = typeof expires === 'string' ? /^(\d+)(m|h|d)$/.exec(expires) : null
    const ms = found ? Number(found[1]) * { m: 60_000, h: 3_600_000, d: DAY }[found[2] as 'm' | 'h' | 'd'] : NaN
    if (!(ms > 0 && ms <= 90 * DAY)) throw new Refused(400, 'invalid_request', 'A token lives up to 90 days.')
    return ms
  }

  /** Whether `actor` may see and revoke `token`: one that acts as it, or, as a token, itself and what was made from it. */
  function mine(actor: Actor, token: Minted): boolean {
    if (!actor.token) return principalId(token.principal) === principalId(actor.principal)
    for (let at: Minted | undefined = token; at; at = at.parent ? minted.get(at.parent) : undefined) if (at.id === actor.token.id) return true
    return false
  }

  function revoke(token: Minted) {
    token.revoked = true
    for (const other of minted.values()) if (other.parent === token.id && !other.revoked) revoke(other)
  }

  /** What `/boards/:id/tokens…` answers, or undefined for another route. */
  function route(method: string, rest: string, body: Record<string, any>, actor: Actor, boardId: string): unknown {
    if (rest === '/tokens' && method === 'POST') {
      if (actor.principal.type === 'app' || actor.development) throw new Refused(403, 'unsupported_principal', "This principal can't mint board tokens.")
      const key = `${actor.token?.id ?? principalId(actor.principal)}|${body.operationId}`
      if (replays.has(key)) throw new Refused(409, 'token_already_minted', 'That token was minted already, and its secret is shown only once.')
      const now = shared.now()
      const token: Minted = {
        id: `tok_${next++}`,
        boardId,
        name: String(body.name),
        can: canOf(body.can),
        profile: body.profile ?? null,
        session: body.session ?? null,
        by: actor.id,
        principal: actor.principal,
        parent: actor.token?.id ?? null,
        at: now,
        expiresAt: now + lifetime(body.expires),
        revoked: false,
      }
      // Opaque: the API's has a prefix of its own, and no one should rely on it.
      const secret = randomBytes(24).toString('base64url')
      minted.set(token.id, token)
      secrets.set(secret, token.id)
      replays.set(key, token.id)
      return { token: view(token), secret }
    }
    if (rest === '/tokens' && method === 'GET') {
      const live = [...minted.values()].filter((token) => token.boardId === boardId && !token.revoked && token.expiresAt > shared.now() && mine(actor, token))
      return { tokens: live.map(view) }
    }
    const revoking = /^\/tokens\/([^/]+)\/revoke$/.exec(rest)
    if (revoking && method === 'POST') {
      const token = minted.get(decodeURIComponent(revoking[1]!))
      if (!token || token.boardId !== boardId || !mine(actor, token)) throw new Refused(404, 'token_not_found')
      if (token.revoked) return { revoked: false }
      revoke(token)
      return { revoked: true }
    }
    return undefined
  }

  return { authenticate, route, summary, minted }
}

type Accounts = Record<string, { username: string; name: string }>

/** An actor as the API names them (`viewFor` in api-messageboard): a person by their account. */
function viewOf(accounts: Accounts, actor: Actor): Omit<ActorView, 'lastSeenAt'> {
  const p = actor.principal
  if (p.type === 'external') return { id: actor.id, kind: 'external', handle: p.id }
  const account = p.type === 'user' ? accounts[p.userId] : undefined
  const base = p.type === 'user' ? (account?.username ?? p.userId) : p.type === 'app' ? p.clientId : `project:${p.projectId}:${p.environment}`
  if (actor.profile) return { id: actor.id, kind: 'agent', handle: `${base}/${actor.profile.name.toLowerCase()}`, name: actor.profile.name }
  if (p.type === 'user') return { id: actor.id, kind: 'person', handle: base, ...(account ? { name: account.name } : {}) }
  return { id: actor.id, kind: p.type === 'app' ? 'app' : 'deployment', handle: base }
}

/** The team's people, by user ID, with their emails, and its projects and the repositories GitHub knows: what grants name. */
type Directory = { members: Record<string, string>; roles: Record<string, Role>; projects: Record<string, string>; repositories: Record<string, string>; apps: Record<string, string> }
const MEMBERS: Record<string, string> = { u_jb: 'julian@acme.com', u_ada: 'ada@acme.com', u_bob: 'bob@acme.com', u_val: 'val@acme.com' }
const ROLES: Record<string, Role> = { u_jb: 'owner', u_val: 'viewer' }
const PROJECTS: Record<string, string> = { prj_board: 'board', prj_pong: 'pong', prj_web: 'web', prj_sec: 'sec' }
const REPOSITORIES: Record<string, string> = { 'acme/web': '700001', 'acme/api': '700002' }
/** Apps installed on the team, by client ID, with their slugs. */
const APPS: Record<string, string> = { oac_1: 'ship', oac_2: 'deploy' }

/** Who a token is, as grants see it: a board token, as its minter, held to its can. */
const whoOf = (actor: Actor): Who => {
  // A platform user a sync imported makes no requests of their own.
  if (actor.principal.type === 'external') throw new Refused(403, 'forbidden')
  const limit = actor.token ? { limit: actor.token.can as NonNullable<Who['limit']> } : {}
  return actor.principal.type === 'user'
    ? { kind: 'user', userId: actor.principal.userId, ...limit }
    : actor.principal.type === 'project'
      ? { kind: 'project', projectId: actor.principal.projectId, environment: actor.principal.environment, ...limit }
      : { kind: 'app', clientId: actor.principal.clientId, ...limit }
}

/** What every board in one fake API shares: its team, its accounts and directory, its clock, and its bucket. */
type Shared = { teamId: string; accounts: Accounts; directory: Directory; now: () => number; stored: Map<string, Uint8Array<ArrayBuffer>> }

const STORAGE = 'http://storage.test/'

/** One board in the fake API, with its own channels, threads, files, watchers, and schedules. */
function fakeBoard(shared: Shared, boardId: string) {
  const { teamId, accounts, now, stored } = shared
  /** Its grants, g1 and g2 to start, as each board on the API has its own. */
  const access = fakeGrants({ teamId, ...shared.directory })
  const channels: { id: string; name: string }[] = [{ id: 'general', name: 'general' }]
  const threads = new Map<string, Thread>()
  const posts = new Map<string, string>()
  const feeds = new Map<string, Change[]>()
  const actors = new Map<string, ActorView>()
  const attachments = new Map<string, Attachment>()
  type Filter = { channelIds?: string[]; channelTree?: string; threadId?: string; authors?: string[]; text?: string; labels?: { key: string; values?: string[] }[] }
  type Registration = { owner: string; url: string | null; path?: string; branch?: string; watch: Record<string, { filter: Filter; when: 'matches' | 'enters' }>; sync: { key: string; platform: string }[]; hash: string }
  type Match = { id: string; watcher: string; threadId: string; change: Change; lease?: string; leaseUntil?: number; attempts: number }
  /** By principal, as the API keeps them: one each. */
  const registrations = new Map<string, Registration>()
  const queued = new Map<string, Match[]>()
  const schedules = new Map<string, Schedule>()
  /** Sync, as Vercel's API keeps it: each key's owner, platform IDs to the board's, copies, bindings, and inboxes. */
  const syncKeys = new Map<string, string>()
  const platformThreads = new Map<string, string>()
  const platformMessages = new Map<string, string>()
  const importIds = new Map<string, string>()
  /** A thread's targets: `external` is the platform thread it is there, a channel's once its root lands. */
  const bindings = new Map<string, { target: string; targetKind: 'channel' | 'thread'; cause: string; external?: string }[]>()
  const copies = new Map<string, Record<string, { thread: string; message: string; files?: string[] | null; asUser?: true }>>()
  const failures = new Map<string, Record<string, string>>()
  type InboxEntry = { id: string; eventId: string; thread: string; event?: unknown; raw?: unknown; pushedAt: number; attempts: number; lease?: string; leaseUntil?: number; retryAt?: number; done?: boolean }
  const inboxes = new Map<string, InboxEntry[]>()

  const seen = (actor: Actor) => {
    // A platform user is named by what its sync last said of them.
    if (actor.principal.type === 'external') return
    actors.set(actor.id, { ...viewOf(accounts, actor), lastSeenAt: now() })
  }

  /** A channel's feed position, as the API's `c1.` cursor carries it: shared by its messages and its events. */
  const cursorAt = (channelId: string, position: number) => `c1.${position}.${channelId}`
  function positionOf(channelId: string, cursor: string): number {
    const found = /^c1\.(\d+)\.(.+)$/.exec(cursor)
    if (!found) throw new Refused(400, 'invalid_cursor')
    if (found[2] !== channelId) throw new Refused(400, 'invalid_cursor', 'Cursor belongs to another channel.')
    const position = Number(found[1])
    if (position > (feeds.get(channelId)?.length ?? 0)) throw new Refused(400, 'invalid_cursor', 'Cursor is ahead of this channel.')
    return position
  }

  const show = (m: Message) => ({
    id: m.id,
    threadId: m.threadId,
    sequence: m.sequence,
    ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
    text: m.text,
    revision: m.revision,
    version: 1 + m.changes,
    createdAt: m.createdAt,
    createdBy: m.createdBy,
    ...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
    ...(m.deletedAt !== undefined ? { deletedAt: m.deletedAt } : {}),
    ...(m.reactions.size ? { reactions: Object.fromEntries([...m.reactions].map(([emoji, by]) => [emoji, by.size])) } : {}),
    // Up to 20 reactors an emoji, earliest first: the count is exact.
    ...(m.reactions.size ? { reactors: Object.fromEntries([...m.reactions].map(([emoji, by]) => [emoji, [...by.keys()].slice(0, 20)])) } : {}),
    ...(Object.keys(m.labels).length ? { labels: { ...m.labels } } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.schedule ? { schedule: m.schedule } : {}),
    ...(m.from !== undefined ? { from: m.from } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.noSync ? { noSync: true } : {}),
    ...(m.links?.length ? { links: m.links } : {}),
  })
  const showThread = (t: Thread) => {
    const { messages, ...rest } = t
    const labels = messages[0]?.labels ?? {}
    return { ...rest, teamId, boardId, ...(Object.keys(labels).length ? { labels: { ...labels } } : {}) }
  }
  const meta = (m: Message) => {
    const { id, threadId, sequence, version, reactions, reactors, labels } = show(m)
    return { id, threadId, sequence, version, ...(reactions ? { reactions, reactors } : {}), ...(labels ? { labels } : {}) }
  }

  function emit(channelId: string, change: Record<string, unknown>, actor: Actor) {
    const feed = feeds.get(channelId) ?? []
    feeds.set(channelId, feed)
    const made = { id: `evt_${randomUUID()}`, channelId, actor, createdAt: now(), shard: 0, sequence: feed.length + 1, ...change } as Change
    feed.push(made)
    seen(actor)
    match(made)
    return feed.length
  }

  /** What subscriber-messageboard-changes does with each event: matched against every watcher on the board. */
  function match(change: Change) {
    const messageId = (change as { messageId?: string }).messageId
    const message = messageId ? messageNamed(messageId) : undefined
    if (!message) {
      return
    }
    const queue = (owner: string, watcher: string) => {
      const lane = queued.get(owner) ?? []
      queued.set(owner, lane)
      lane.push({ id: `mat_${randomUUID()}`, watcher, threadId: message.threadId, change, attempts: 0 })
    }
    // A thread's binding goes only to the sync that owns the target's key.
    const binding = (change as { binding?: { target: string } }).binding
    if (change.type === 'thread.synced' && binding) {
      for (const registration of registrations.values()) {
        if (registration.sync.some((entry) => entry.key === prefixOf(binding.target))) {
          queue(registration.owner, '@sync')
        }
      }
      return
    }
    if (!String(change.type).startsWith('message.')) return
    const thread = threads.get(message.threadId)!
    const channel = channels.find((c) => c.id === thread.channelId)!
    const rootLabels = thread.messages[0]?.labels ?? {}
    const hasLabel = (labels: Record<string, string>, { key, values }: { key: string; values?: string[] }) =>
      Object.hasOwn(labels, key) && (values === undefined || values.includes(labels[key]!))
    const sees = (filter: Filter) =>
      (filter.channelIds === undefined && filter.channelTree === undefined ? true : (filter.channelIds?.includes(channel.id) ?? false) ||
        (filter.channelTree !== undefined && (channel.name === filter.channelTree || channel.name.startsWith(`${filter.channelTree}/`)))) &&
      (filter.threadId === undefined || filter.threadId === message.threadId) &&
      (filter.authors === undefined || filter.authors.includes(message.createdBy.id) || filter.authors.includes(principalId(message.createdBy.principal))) &&
      (filter.text === undefined || message.text.toLowerCase().includes(filter.text.toLowerCase())) &&
      (filter.labels ?? []).every((label) => hasLabel(message.labels, label) || hasLabel(rootLabels, label))
    for (const registration of registrations.values())
      // A sync gets every message change on the board as a match of its watcher `@sync`.
      if (registration.sync.length > 0) {
        queue(registration.owner, '@sync')
      }
    for (const registration of registrations.values())
      for (const [watcher, spec] of Object.entries(registration.watch)) {
        if ((change.actor as Actor).id !== `${registration.owner}+${watcher.toLowerCase()}` && sees(spec.filter)) {
          queue(registration.owner, watcher)
        }
      }
  }

  const messageNamed = (id: string) => {
    const found = MESSAGE_ID.exec(id)
    return found ? threads.get(`thr_${found[1]}`)?.messages[Number(found[2]) - 1] : undefined
  }

  const threadAt = (id: string) => {
    const thread = threads.get(id)
    if (!thread) throw new Refused(404, 'thread_not_found')
    return thread
  }
  const messageAt = (threadId: string, sequence: number) => {
    const message = threadAt(threadId).messages[sequence - 1]
    if (!message) throw new Refused(404, 'message_not_found')
    return message
  }
  const channelAt = (id: string) => {
    const channel = channels.find((c) => c.id === id)
    if (!channel) throw new Refused(404, 'channel_not_found')
    return channel
  }

  /** A board token does only what its scope gives at the channel's closest pattern: the channel, then its parents (`dev/`), then `*`. */
  function tokenMay(actor: Actor, permission: string, channelId: string) {
    if (!actor.token) return
    const name = channels.find((channel) => channel.id === channelId)?.name ?? ''
    const parts = name.split('/')
    const candidates = [name, ...parts.map((_, i) => `${parts.slice(0, parts.length - i).join('/')}/`), '*']
    const pattern = candidates.find((candidate) => Object.hasOwn(actor.token!.can, candidate))
    const grant = pattern === undefined ? [] : actor.token.can[pattern]!
    if (!(grant === 'all' || grant.includes(permission))) throw new Refused(403, 'forbidden', `This token may not ${permission} in ${name}.`)
  }

  /** `uploader` is who must have uploaded its files: the caller, which for an import is the sync's project, not the platform user it posts as. */
  function post(actor: Actor, thread: Thread, body: { text: string; replyTo?: number; clientId?: string; labels?: Record<string, string>; attachments?: string[]; schedule?: { id: string; n: number }; after?: number; noSync?: boolean }, uploader: Actor = actor) {
    tokenMay(actor, 'post', thread.channelId)
    // A reply's precondition, checked with the post: the thread's newest is still the one it names.
    if (body.after !== undefined && (!Number.isInteger(body.after) || body.after < 1 || body.after > thread.messageCount)) throw new Refused(400, 'invalid_after')
    if (body.after !== undefined && body.after !== thread.messageCount) throw new Refused(409, 'newer_message', `message ${thread.messageCount} came after ${body.after}`)
    const files = (body.attachments ?? []).map((id) => {
      const attachment = attachments.get(id)
      if (!attachment || !samePrincipal(attachment.createdBy.principal, uploader.principal)) throw new Refused(404, 'attachment_not_found')
      if (attachment.state !== 'ready') throw new Refused(409, 'attachment_not_ready')
      if (attachment.messageId) throw new Refused(409, 'attachment_already_posted')
      return attachment
    })
    // A post with attachments may have no text.
    if (typeof body.text !== 'string' || (!body.text.trim() && !(files.length && body.text === '')) || body.text.length > 10_000) throw new Refused(400, 'invalid_message')
    if (body.replyTo !== undefined && (body.replyTo < 1 || body.replyTo > thread.messageCount)) throw new Refused(400, 'invalid_reply')
    const sequence = thread.messageCount + 1
    const createdAt = now()
    const message: Message = {
      id: `msg_${thread.id.slice('thr_'.length)}_${sequence}`,
      threadId: thread.id,
      sequence,
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
      text: body.text,
      revision: 1,
      createdAt,
      createdBy: actor,
      changes: 0,
      reactions: new Map(),
      // A post's labels commit with it, so its event's message already has them.
      labels: { ...body.labels },
      // A root kept off every platform keeps its whole thread off, its replies too.
      ...(body.noSync || thread.messages[0]?.noSync ? { noSync: true } : {}),
      feedSequence: 0,
      ...(files.length ? { attachments: files.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
      ...(body.schedule ? { schedule: body.schedule } : {}),
    }
    for (const file of files) file.messageId = message.id
    thread.messages.push(message)
    thread.messageCount = sequence
    thread.lastActivityAt = createdAt
    thread.lastMessage = { id: message.id, sequence, createdAt, createdBy: actor }
    if (body.clientId) posts.set(`${principalId(actor.principal)}|${body.clientId}`, message.id)
    message.feedSequence = emit(thread.channelId, { type: 'message.posted', threadId: thread.id, message: sequence, messageId: message.id, revision: 1 }, actor)
    return message
  }

  /** A repeat of a post with the same client ID, by the same principal: the first one. */
  function repeat(actor: Actor, clientId: unknown) {
    if (clientId === undefined) return null
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)) throw new Refused(400, 'invalid_client_id')
    const id = posts.get(`${principalId(actor.principal)}|${clientId}`)
    if (!id) return null
    const [, uuid, sequence] = MESSAGE_ID.exec(id)!
    const thread = threadAt(`thr_${uuid}`)
    return { thread: showThread(thread), message: show(thread.messages[Number(sequence) - 1]!) }
  }

  function page<T>(items: T[], cursor: string | null, size: number) {
    const from = cursor ? Number(cursor) : 0
    const next = from + size < items.length ? String(from + size) : null
    return { items: items.slice(from, from + size), cursor: next }
  }

  async function watchers(method: string, rest: string, actor: Actor, parsed: Record<string, any>, url: URL): Promise<unknown> {
    const owner = principalId(actor.principal)
    const view = (r: Registration) => ({ owner: r.owner, url: r.url, ...(r.path ? { path: r.path, ...(r.branch ? { branch: r.branch } : {}) } : {}), watch: r.watch, ...(r.sync.length ? { sync: r.sync } : {}), hash: r.hash })
    if (method === 'GET' && rest === '/watchers') {
      const found = registrations.get(owner)
      return { watchers: found ? [view(found)] : [] }
    }
    if (method === 'PUT' && rest === '/watchers') {
      const body = parsed as { url?: string | null; path?: string; branch?: string; watch: Registration['watch']; tag?: string; sync?: Registration['sync'] }
      // A URL, or a path on the caller's own project (a preview's with its branch), as api-messageboard checks one.
      if (body.url !== undefined && body.path !== undefined) throw new Refused(400, 'bad_request', 'A url or a path, not both.')
      if (body.branch !== undefined && body.path === undefined) throw new Refused(400, 'bad_request', 'A branch goes with a path.')
      const principal = actor.principal
      if (body.path !== undefined) {
        if (principal.type !== 'project') throw new Refused(403, 'not_a_project')
        if (principal.environment !== 'production' && principal.environment !== 'preview') throw new Refused(400, 'invalid_environment')
        if ((principal.environment === 'preview') !== (body.branch !== undefined)) throw new Refused(400, 'invalid_branch')
        if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.startsWith('//')) throw new Refused(400, 'invalid_path')
      }
      for (const [id, spec] of Object.entries(body.watch))
        if (spec.when === 'enters' && Object.keys(spec.filter).length === 0) throw new Refused(400, 'bad_watcher', `watch ${id}: \`when: enters\` needs a filter to enter`)
      const where = body.path !== undefined ? { url: null, path: body.path.replace(/(.)\/+$/, '$1'), ...(body.branch ? { branch: body.branch } : {}) } : { url: body.url ?? null }
      const sync = body.sync ?? []
      // Only a project's own token syncs, and a key is one registrant's on the board.
      if (sync.length > 0 && principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      for (const { key } of sync) if ((syncKeys.get(key) ?? owner) !== owner) throw new Refused(409, 'sync_key_taken')
      for (const [key, holder] of syncKeys) if (holder === owner && !sync.some((entry) => entry.key === key)) syncKeys.delete(key)
      for (const { key } of sync) syncKeys.set(key, owner)
      const made: Registration = { owner, ...where, watch: body.watch, sync, hash: body.tag ?? randomUUID().replaceAll('-', '') }
      registrations.set(owner, made)
      return view(made)
    }
    if (!registrations.has(owner)) throw new Refused(404, 'no_registration')
    const lane = queued.get(owner) ?? []
    if (method === 'GET' && rest === '/watchers/matches') {
      const until = Date.now() + Number(url.searchParams.get('wait') ?? 0) * 1000
      const limit = Number(url.searchParams.get('limit') ?? 10)
      for (;;) {
        const held = new Set(lane.filter((m) => m.lease && m.leaseUntil! > Date.now()).map((m) => `${m.watcher}|${m.threadId}`))
        const heads = new Map<string, Match>()
        for (const m of lane) if (!heads.has(`${m.watcher}|${m.threadId}`)) heads.set(`${m.watcher}|${m.threadId}`, m)
        const free = [...heads.entries()].filter(([key]) => !held.has(key)).map(([, m]) => m).slice(0, limit)
        if (free.length > 0 || Date.now() >= until) {
          for (const m of free) {
            if (m.lease) m.attempts++
            m.lease = randomUUID()
            m.leaseUntil = Date.now() + 5 * 60_000
          }
          const shown = free.map((m) => {
            const message = messageNamed((m.change as { messageId: string }).messageId)
            return { id: m.id, watcher: m.watcher, threadId: m.threadId, lease: m.lease, attempt: m.attempts, event: { ...m.change, ...(message ? { currentMessage: show(message) } : {}) } }
          })
          return { matches: shown }
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const acking = /^\/watchers\/matches\/([^/]+)\/ack$/.exec(rest)
    if (method === 'POST' && acking) {
      const body = parsed as { lease: string; error?: string; skip?: boolean }
      const at = lane.findIndex((m) => m.id === decodeURIComponent(acking[1]!))
      if (at === -1) throw new Refused(404, 'no_match')
      if (lane[at]!.lease !== body.lease) throw new Refused(409, 'stale_lease')
      if (body.error !== undefined && !body.skip) {
        lane[at]!.attempts++
        delete lane[at]!.lease
      } else lane.splice(at, 1)
      return { ok: true }
    }
    throw new Refused(404, 'not_found')
  }

  const showSchedule = (s: Schedule) => ({ ...s, ...(s.labels ? { labels: { ...s.labels } } : {}) })

  /** Times are whole milliseconds, a year out at most, and a repeat is at least a minute apart, with one stop. */
  function schedule(actor: Actor, body: Record<string, any>): Schedule {
    const invalid = () => new Refused(400, 'invalid_schedule')
    if (actor.principal.type === 'app') throw new Refused(403, 'principal_cannot_schedule')
    if ((body.channelId === undefined) === (body.threadId === undefined)) throw invalid()
    if (body.labels !== undefined && body.threadId !== undefined) throw invalid()
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) throw new Refused(400, 'invalid_message')
    const at = Date.now()
    const time = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= at + 365 * 86_400_000
    if (!time(body.firstAt) || body.firstAt < at - 60_000) throw invalid()
    if (body.every !== undefined && (!Number.isInteger(body.every) || body.every < 60_000)) throw invalid()
    if (body.until !== undefined && !time(body.until)) throw invalid()
    if (body.times !== undefined && (!Number.isInteger(body.times) || body.times < 1)) throw invalid()
    const stops = [body.until, body.times].filter((stop) => stop !== undefined).length
    if (stops > 1 || (stops > 0 && body.every === undefined)) throw invalid()
    const channelId = body.threadId !== undefined ? threadAt(body.threadId).channelId : channelAt(body.channelId).id
    const made: Schedule = {
      id: `sch_${randomUUID()}`,
      channelId,
      ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
      text: body.text,
      ...(body.labels ? { labels: { ...body.labels } } : {}),
      ...(body.noSync ? { noSync: true } : {}),
      firstAt: body.firstAt,
      ...(body.every !== undefined ? { every: body.every } : {}),
      ...(body.until !== undefined ? { until: body.until } : {}),
      ...(body.times !== undefined ? { times: body.times } : {}),
      sent: 0,
      nextAt: Math.max(body.firstAt, at),
      state: 'pending',
      createdAt: now(),
      createdBy: actor,
      revision: 1,
    }
    schedules.set(made.id, made)
    seen(actor)
    return made
  }

  /** A schedule's next send, as the API posts it when it's due: as its creator, marked as the schedule's. */
  function send(id: string) {
    const due = schedules.get(id)
    if (!due || due.state !== 'pending') throw new Error(`schedule ${id} has nothing due`)
    const n = due.sent
    const body = { text: due.text, schedule: { id, n }, ...(due.noSync ? { noSync: true } : {}) }
    let message: Message
    if (due.threadId !== undefined) message = post(due.createdBy, threadAt(due.threadId), body)
    else {
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: due.channelId, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: due.createdBy, messages: [] }
      threads.set(thread.id, thread)
      message = post(due.createdBy, thread, { ...body, ...(due.labels ? { labels: due.labels } : {}) })
    }
    due.sent = n + 1
    due.lastMessageId = message.id
    due.revision++
    const next = due.every === undefined ? null : due.firstAt + due.every * due.sent
    const over = next === null || (due.times !== undefined && due.sent >= due.times) || (due.until !== undefined && next > due.until)
    due.nextAt = over ? null : next
    if (over) due.state = 'done'
    return message.id
  }

  function schedulesRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/schedules') return { schedule: showSchedule(schedule(actor, body)) }
    if (method === 'GET' && rest === '/schedules') {
      const query = (name: string) => url.searchParams.get(name) ?? undefined
      const state = query('state')
      const createdBy = query('createdBy')
      const listed = [...schedules.values()].sort((a, b) => a.createdAt - b.createdAt)
      // Filters apply within each page, so a page can come back short with a cursor to the rest.
      const { items, cursor } = page(listed, url.searchParams.get('cursor'), 2)
      const kept = items.filter(
        (s) =>
          (state === undefined || s.state === state) &&
          (query('channelId') === undefined || s.channelId === query('channelId')) &&
          (query('threadId') === undefined || s.threadId === query('threadId')) &&
          (createdBy === undefined || s.createdBy.id === createdBy || principalId(s.createdBy.principal) === createdBy),
      )
      return { schedules: kept.map(showSchedule), cursor }
    }
    if ((found = /^\/schedules\/([^/]+)\/cancel$/.exec(rest)) && method === 'POST') {
      const target = schedules.get(decodeURIComponent(found[1]!))
      if (!target) throw new Refused(404, 'schedule_not_found')
      if (!samePrincipal(target.createdBy.principal, actor.principal)) throw new Refused(403, 'schedule_not_owned')
      if (target.state !== 'pending') return { schedule: showSchedule(target), canceled: false }
      Object.assign(target, { state: 'canceled', nextAt: null, canceled: { by: actor, at: now(), reason: 'canceled' }, revision: target.revision + 1 })
      return { schedule: showSchedule(target), canceled: true }
    }
    return undefined
  }


  const prefixOf = (id: string) => id.slice(0, id.indexOf(':'))
  /** Only a project's own token syncs, through the keys it registered. */
  function requireKey(actor: Actor, key: string) {
    if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
    if (syncKeys.get(key) !== principalId(actor.principal)) throw new Refused(403, 'sync_key_not_owned')
  }
  const ownedKeys = (actor: Actor) => new Set([...syncKeys].filter(([, owner]) => owner === principalId(actor.principal)).map(([key]) => key))

  /** Vercel's API's sync routes, as they behave: undefined for a route that isn't one. */
  function syncRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    const owner = principalId(actor.principal)
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/sync/imports') {
      // The key it came through, or for a write a sync makes as the user, the user's own.
      const key: string = (body.op === 'seen' ? undefined : body.from) ?? prefixOf(body.author.id)
      requireKey(actor, key)
      if (!String(body.author.id).startsWith(`${key}:`)) throw new Refused(403, 'foreign_author')
      if (body.origin && !body.from) throw new Refused(400, 'invalid_import', 'An import with an origin names the sync key it came through: pass `from`.')
      // A change it imported says which sync it came through, so that sync doesn't send it back.
      const through = body.from ? { from: body.from } : {}
      const author: Actor = { id: body.author.id, principal: { type: 'external', id: body.author.id, syncKey: key } }
      actors.set(author.id, { id: author.id, kind: 'external', handle: body.author.handle, name: body.author.name, ...(body.author.avatar ? { avatar: body.author.avatar } : {}), lastSeenAt: now() })
      if (body.op === 'seen') return { message: null }
      if (body.op === 'post') {
        const landed = body.id !== undefined ? importIds.get(`${owner}|${body.id}`) : undefined
        if (landed) return { message: landed }
        const origin = body.origin as { thread: string; message: string } | null | undefined
        if (origin && body.channelId !== undefined && platformThreads.has(`${key}|${origin.thread}`)) throw new Refused(409, 'already_synced')
        let thread: Thread
        if (body.channelId !== undefined) {
          const channel = channelAt(body.channelId)
          const createdAt = now()
          thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: author, messages: [] }
          threads.set(thread.id, thread)
        } else if (body.re !== undefined) {
          const to = messageNamed(body.re)
          if (!to) throw new Refused(404, 'message_not_found')
          thread = threadAt(to.threadId)
          // A platform reply lands only in the thread its platform thread syncs with.
          const bound = origin ? platformThreads.get(`${key}|${origin.thread}`) : undefined
          if (origin && bound !== undefined && bound !== thread.id) throw new Refused(409, 'already_synced')
          if (origin && bound === undefined) throw new Refused(409, 'not_synced')
        } else throw new Refused(400, 'invalid_import')
        const message = post(author, thread, { text: body.text, ...(body.labels ? { labels: body.labels } : {}), ...(body.attachments?.length ? { attachments: body.attachments } : {}), ...(body.after !== undefined ? { after: body.after } : {}) }, actor)
        if (body.from !== undefined && body.from !== null) message.from = body.from
        if (origin) message.origin = origin
        if (body.noSync) message.noSync = true
        if (body.links?.length) message.links = body.links
        if (origin) {
          // A platform root binds its thread to its platform thread, which announces nothing.
          if (body.channelId !== undefined) {
            platformThreads.set(`${key}|${origin.thread}`, thread.id)
            bindings.set(thread.id, [{ target: origin.thread, targetKind: 'thread', cause: 'import', external: origin.thread }])
          }
          platformMessages.set(`${key}|${origin.thread}|${origin.message}`, message.id)
        }
        if (body.id !== undefined) importIds.set(`${owner}|${body.id}`, message.id)
        return { message: message.id }
      }
      const origin = body.origin as { thread: string; message?: string } | undefined
      const id = origin
        ? origin.message !== undefined
          ? platformMessages.get(`${key}|${origin.thread}|${origin.message}`)
          : platformThreads.has(`${key}|${origin.thread}`) ? `msg_${platformThreads.get(`${key}|${origin.thread}`)!.slice('thr_'.length)}_1` : undefined
        : body.message
      const message = id ? messageNamed(id) : undefined
      if (!message) return { message: null }
      const by = message.createdBy.principal
      // A sync edits and deletes only its own platform users' messages; it reacts and labels on any.
      if (body.op === 'edit' || body.op === 'delete') {
        if (by.type !== 'external' || by.syncKey !== key) {
          throw new Refused(403, 'message_not_owned')
        }
        if (body.revision !== undefined && body.revision !== message.revision) {
          throw new Refused(409, 'revision_conflict')
        }
      }
      const thread = threadAt(message.threadId)
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      if (body.op === 'edit') {
        message.text = body.text
        message.revision++
        message.editedAt = now()
        message.changes++
        emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision, ...through }, author)
      } else if (body.op === 'delete') {
        message.deletedAt = now()
        message.revision++
        message.changes++
        emit(thread.channelId, { type: 'message.deleted', ...ref, revision: message.revision, ...through }, author)
      } else if (body.op === 'react') {
        const reactors = message.reactions.get(body.emoji) ?? new Map()
        if (body.remove) {
          reactors.delete(author.id)
        } else {
          reactors.set(author.id, { actor: author, createdAt: now() })
        }
        if (reactors.size) {
          message.reactions.set(body.emoji, reactors)
        } else {
          message.reactions.delete(body.emoji)
        }
        message.changes++
        emit(thread.channelId, { type: body.remove ? 'message.reaction_removed' : 'message.reaction_added', ...ref, emoji: body.emoji, ...through }, author)
      } else if (body.op === 'labels') {
        for (const [label, value] of Object.entries(body.if ?? {})) if ((message.labels[label] ?? null) !== value) throw new Refused(409, 'label_conflict')
        const before = { ...message.labels }
        for (const label of body.unset ?? []) delete message.labels[label]
        Object.assign(message.labels, body.set ?? {})
        message.changes++
        const changed = Object.fromEntries(
          [...new Set([...Object.keys(before), ...Object.keys(message.labels)])]
            .filter((label) => before[label] !== message.labels[label])
            .map((label) => [label, { ...(before[label] !== undefined ? { from: before[label] } : {}), ...(message.labels[label] !== undefined ? { to: message.labels[label] } : {}) }]),
        )
        if (Object.keys(changed).length) emit(thread.channelId, { type: 'message.labeled', ...ref, labels: changed, ...through }, author)
      } else if (body.op === 'links') {
        // The API keeps a message's links as an edit of it.
        message.links = body.links
        message.changes++
        emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision, ...through }, author)
      }
      return { message: message.id }
    }
    if (method === 'POST' && rest === '/sync/receipts') {
      const message = messageNamed(body.message)
      if (!message) throw new Refused(404, 'message_not_found')
      requireKey(actor, prefixOf(body.target))
      if (body.kind === 'thread') {
        const list = bindings.get(message.threadId) ?? []
        bindings.set(message.threadId, list)
        if (list.some((bound) => bound.target === body.target)) return { ok: true, attached: false }
        if (body.targetKind === 'thread') {
          const at = platformThreads.get(`${prefixOf(body.target)}|${body.target}`)
          if (at && at !== message.threadId) throw new Refused(409, 'already_synced')
          platformThreads.set(`${prefixOf(body.target)}|${body.target}`, message.threadId)
        }
        const binding = { target: body.target, targetKind: body.targetKind, cause: body.cause }
        list.push({ ...binding, ...(body.targetKind === 'thread' ? { external: body.target } : {}) })
        const thread = threadAt(message.threadId)
        emit(thread.channelId, { type: 'thread.synced', threadId: thread.id, messageId: thread.messages[0]!.id, binding }, actor)
        return { ok: true, attached: true }
      }
      const mine = copies.get(message.id) ?? {}
      copies.set(message.id, mine)
      if (body.kind === 'message') {
        mine[body.target] ??= { thread: body.external.thread, message: body.external.message, ...(body.external.asUser ? { asUser: true as const } : {}), ...(body.files !== undefined ? { files: body.files } : {}) }
        // A channel's platform thread is the one its root landed in.
        const bound = message.sequence === 1 ? bindings.get(message.threadId)?.find((one) => one.target === body.target && one.targetKind === 'channel') : undefined
        if (bound && bound.external === undefined) {
          bound.external = body.external.thread
          platformThreads.set(`${prefixOf(body.target)}|${body.external.thread}`, message.threadId)
        }
        platformMessages.set(`${prefixOf(body.target)}|${body.external.thread}|${body.external.message}`, message.id)
        delete failures.get(message.id)?.[body.target]
      } else if (body.kind === 'files') {
        if (mine[body.target]) mine[body.target]!.files = body.files
      } else {
        const failed = failures.get(message.id) ?? {}
        failures.set(message.id, failed)
        failed[body.target] = body.error
      }
      return { ok: true }
    }
    if (method === 'GET' && rest === '/sync/find') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const owned = ownedKeys(actor)
      const query = Object.fromEntries(url.searchParams)
      let thread: string | null = null
      let message: string | null = null
      if (query.post !== undefined) message = importIds.get(`${owner}|${query.post}`) ?? null
      if (query.thread !== undefined && owned.has(prefixOf(query.thread))) {
        thread = platformThreads.get(`${prefixOf(query.thread)}|${query.thread}`) ?? null
        if (query.message !== undefined) message = platformMessages.get(`${prefixOf(query.thread)}|${query.thread}|${query.message}`) ?? message
      }
      // The API links no platform accounts to people, so it finds none.
      return { thread, message, person: null, accounts: [], holder: null }
    }
    if ((found = /^\/sync\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const thread = threadAt(decodeURIComponent(found[1]!))
      const owned = ownedKeys(actor)
      const mine = (bindings.get(thread.id) ?? []).filter((bound) => owned.has(prefixOf(bound.target)))
      return {
        thread: thread.id,
        root: thread.messages[0]!.id,
        channel: thread.channelId,
        targets: mine.map((bound) => bound.target),
        external: Object.fromEntries(mine.flatMap((bound) => (bound.external !== undefined ? [[bound.target, bound.external]] : []))),
      }
    }
    if (method === 'GET' && rest === '/sync/copies') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const owned = ownedKeys(actor)
      return { copies: Object.fromEntries(url.searchParams.getAll('message').map((id) => [id, Object.fromEntries(Object.entries(copies.get(id) ?? {}).filter(([target]) => owned.has(prefixOf(target))))])) }
    }
    if ((found = /^\/messages\/([^/]+)\/synced$/.exec(rest)) && method === 'GET') {
      const message = messageNamed(decodeURIComponent(found[1]!))
      if (!message) throw new Refused(404, 'message_not_found')
      const mine = copies.get(message.id) ?? {}
      return {
        targets: (bindings.get(message.threadId) ?? []).map(({ target }) => ({
          target,
          key: prefixOf(target),
          thread: mine[target]?.thread ?? null,
          message: mine[target]?.message ?? null,
          undelivered: failures.get(message.id)?.[target] ?? null,
        })),
      }
    }
    if (method === 'GET' && rest === '/sync/linked') {
      const thread = url.searchParams.get('thread') ?? ''
      const named = url.searchParams.get('message')
      const id = named !== null ? platformMessages.get(`${prefixOf(thread)}|${thread}|${named}`) : platformThreads.has(`${prefixOf(thread)}|${thread}`) ? `msg_${platformThreads.get(`${prefixOf(thread)}|${thread}`)!.slice('thr_'.length)}_1` : undefined
      const message = id ? messageNamed(id) : undefined
      if (!message) throw new Refused(404, 'message_not_found')
      return { thread: message.threadId, message: message.id }
    }
    if ((found = /^\/sync\/inbox\/([^/]+)(\/next|\/([^/]+)\/ack)?$/.exec(rest))) {
      const key = decodeURIComponent(found[1]!)
      requireKey(actor, key)
      const inbox = inboxes.get(key) ?? []
      inboxes.set(key, inbox)
      if (method === 'POST' && found[2] === undefined) {
        let queued = 0
        for (const event of body.events as { id: string; thread: string; event?: unknown; raw?: unknown }[]) {
          if (!event.thread.startsWith(`${key}:`)) throw new Refused(400, 'invalid_inbox_event')
          if (inbox.some((entry) => entry.eventId === event.id)) continue
          inbox.push({ id: `inb_${randomUUID()}`, eventId: event.id, thread: event.thread, event: event.event, raw: event.raw, pushedAt: now(), attempts: 0 })
          queued++
        }
        return { ok: true, queued }
      }
      if (method === 'GET' && found[2] === '/next') {
        const limit = Number(url.searchParams.get('limit') ?? 10)
        const items: unknown[] = []
        for (const thread of new Set(inbox.filter((entry) => !entry.done).map((entry) => entry.thread))) {
          if (items.length >= limit) break
          const head = inbox.find((entry) => !entry.done && entry.thread === thread)!
          if ((head.lease && head.leaseUntil! > Date.now()) || (head.retryAt ?? 0) > Date.now()) continue
          if (head.lease) head.attempts++
          head.lease = randomUUID()
          head.leaseUntil = Date.now() + 5 * 60_000
          items.push({ id: head.id, key, thread: head.thread, lease: head.lease, attempt: head.attempts, ...(head.event !== undefined ? { event: head.event } : {}), ...(head.raw !== undefined ? { raw: head.raw } : {}) })
        }
        return { items }
      }
      if (method === 'POST' && found[3] !== undefined) {
        const entry = inbox.find((one) => one.id === decodeURIComponent(found![3]!) && !one.done)
        if (!entry) throw new Refused(404, 'no_item')
        if (entry.lease !== body.lease) throw new Refused(409, 'stale_lease')
        // After an error it waits a second, doubling to 30, and the fifth is its last try.
        if (body.error !== undefined && entry.attempts + 1 < 5) {
          entry.attempts++
          entry.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (entry.attempts - 1))
          delete entry.lease
          delete entry.leaseUntil
        } else entry.done = true
        return { ok: true }
      }
      if (method === 'GET' && found[2] === undefined) {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return { events: [...inbox].reverse().slice(0, limit).map((entry) => ({ id: entry.eventId, thread: entry.thread, createdAt: new Date(entry.pushedAt).toISOString(), ...(entry.event !== undefined ? { event: entry.event } : {}), ...(entry.raw !== undefined ? { raw: entry.raw } : {}) })) }
      }
    }
    return undefined
  }

  /** A request to this board, at `rest` under `/boards/:id`, from a caller who may use it. */
  async function route(method: string, rest: string, url: URL, body: Record<string, any>, actor: Actor): Promise<unknown> {
    let found: RegExpExecArray | null

    if (method === 'GET' && rest === '/channels') {
      const name = url.searchParams.get('name')
      return { channels: name === null ? channels : channels.filter((c) => c.name === name), cursor: null }
    }
    if (method === 'POST' && rest === '/channels') {
      if (typeof body.name !== 'string' || body.name.length > 80 || !CHANNEL.test(body.name)) throw new Refused(400, 'invalid_channel_name')
      if (channels.some((c) => c.name === body.name)) throw new Refused(409, 'channel_name_taken')
      const channel = { id: `chn_${randomUUID()}`, name: body.name }
      channels.push(channel)
      return { channel }
    }
    const granted = access.route(method, rest, whoOf(actor), actor.id, body, url)
    if (granted !== undefined) return granted
    if (method === 'GET' && rest === '/threads') {
      const channelId = url.searchParams.get('channelId') ?? ''
      channelAt(channelId)
      const label = url.searchParams.get('label')
      let listed = [...threads.values()].filter((t) => t.channelId === channelId)
      if (label !== null) {
        const [key, value] = label.split('=', 2) as [string, string | undefined]
        listed = listed.filter((t) => Object.hasOwn(t.messages[0]!.labels, key) && (value === undefined || t.messages[0]!.labels[key] === value))
        listed.sort((a, b) => a.createdAt - b.createdAt)
      } else listed.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      const { items, cursor } = page(listed, url.searchParams.get('cursor'), 25)
      return { threads: items.map(showThread), cursor }
    }
    if (method === 'POST' && rest === '/threads') {
      const again = repeat(actor, body.clientId)
      if (again) return again
      const channel = channelAt(body.channelId)
      tokenMay(actor, 'post', channel.id)
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: actor, messages: [] }
      threads.set(thread.id, thread)
      const message = post(actor, thread, body as { text: string; clientId?: string; labels?: Record<string, string>; attachments?: string[]; noSync?: boolean })
      return { thread: showThread(thread), message: show(message) }
    }
    if ((found = /^\/messages\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const id = /^msg_([0-9a-f-]{36})_([1-9]\d*)$/.exec(decodeURIComponent(found[1]!))
      if (!id) throw new Refused(404, 'message_not_found')
      const thread = threads.get(`thr_${id[1]}`)
      const message = thread?.messages[Number(id[2]) - 1]
      if (!thread || !message) throw new Refused(404, 'message_not_found')
      return { thread: showThread(thread), message: show(message) }
    }
    if ((found = /^\/posts\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const again = repeat(actor, decodeURIComponent(found[1]!))
      if (!again) throw new Refused(404, 'post_not_found')
      return again
    }
    if (rest === '/watchers' || rest.startsWith('/watchers/')) return watchers(method, rest, actor, body, url)
    if (rest.startsWith('/sync/') || /^\/messages\/[^/]+\/synced$/.test(rest)) {
      const answered = syncRoute(method, rest, actor, body, url)
      if (answered !== undefined) return answered
    }
    if (rest === '/schedules' || rest.startsWith('/schedules/')) {
      const answered = schedulesRoute(method, rest, actor, body, url)
      if (answered !== undefined) return answered
    }
    if (method === 'POST' && rest === '/attachments') {
      const attachment: Attachment = { id: `att_${randomUUID()}`, boardId, name: body.name, type: body.type, size: body.size, sha256: body.sha256, state: 'pending', createdAt: now(), createdBy: actor }
      attachments.set(attachment.id, attachment)
      return { attachment, upload: { url: `${STORAGE}${attachment.id}`, method: 'PUT', headers: { 'content-type': body.type, 'x-amz-checksum-sha256': body.sha256 }, expiresAt: now() + 600_000 } }
    }
    if ((found = /^\/attachments\/([^/]+)(\/complete)?$/.exec(rest))) {
      const attachment = attachments.get(decodeURIComponent(found[1]!))
      const own = attachment && samePrincipal(attachment.createdBy.principal, actor.principal)
      if (method === 'POST' && found[2]) {
        if (!attachment || !own) throw new Refused(404, 'attachment_not_found')
        const bytes = stored.get(attachment.id)
        if (!bytes) throw new Refused(409, 'attachment_not_uploaded')
        if (bytes.byteLength !== attachment.size) throw new Refused(422, 'attachment_mismatch')
        attachment.state = 'ready'
        return { attachment }
      }
      if (method === 'GET' && !found[2]) {
        const posted = attachment?.messageId ? MESSAGE_ID.exec(attachment.messageId) : null
        const message = posted ? threads.get(`thr_${posted[1]}`)?.messages[Number(posted[2]) - 1] : undefined
        if (!attachment || attachment.state !== 'ready' || !(own || (message && message.deletedAt === undefined))) throw new Refused(404, 'attachment_not_found')
        return { attachment, url: `${STORAGE}${attachment.id}`, expiresAt: now() + 60_000 }
      }
    }
    if (method === 'GET' && rest === '/actors') return { actors: [...actors.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt), cursor: null }
    if (method === 'GET' && rest === '/messages') {
      const channelId = url.searchParams.get('channelId') ?? ''
      channelAt(channelId)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Refused(400, 'invalid_request')
      const head = feeds.get(channelId)?.length ?? 0
      const listed = [...threads.values()].filter((t) => t.channelId === channelId).flatMap((t) => t.messages).sort((a, b) => a.feedSequence - b.feedSequence)
      const after = url.searchParams.get('after')
      if (after === null) return { messages: listed.slice(-limit).map(show), cursor: cursorAt(channelId, head) }
      const from = positionOf(channelId, after)
      const taken = listed.filter((m) => m.feedSequence > from).slice(0, limit)
      const more = listed.filter((m) => m.feedSequence > from).length > limit
      return { messages: taken.map(show), cursor: cursorAt(channelId, more ? taken.at(-1)!.feedSequence : head) }
    }
    if (method === 'GET' && rest === '/changes') {
      const channelId = url.searchParams.get('channelId') ?? ''
      channelAt(channelId)
      const feed = () => feeds.get(channelId) ?? []
      const cursor = url.searchParams.get('cursor')
      if (cursor !== null && url.searchParams.get('from') !== null) throw new Refused(400, 'invalid_cursor')
      const from = url.searchParams.get('from') === 'latest' ? feed().length : cursor === null ? 0 : positionOf(channelId, cursor)
      // A long-poll holds until the next change, as the API's does.
      const until = Date.now() + Math.min(Number(url.searchParams.get('wait') ?? 0), 25) * 1000
      while (feed().length === from && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
      const include = url.searchParams.get('include') === 'message'
      const events = feed()
        .slice(from, from + 48)
        .map((change, i) => {
          const message = include && change.messageId ? messageNamed(change.messageId) : undefined
          return { ...change, cursor: cursorAt(channelId, from + i + 1), ...(message ? { currentMessage: show(message) } : {}) }
        })
      return { events, cursor: cursorAt(channelId, from + events.length), caughtUp: from + events.length >= feed().length }
    }
    if ((found = /^\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') return { thread: showThread(threadAt(found[1]!)) }
    if ((found = /^\/threads\/([^/]+)\/messages$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      if (method === 'GET') {
        const { items, cursor } = page(thread.messages, url.searchParams.get('cursor'), 50)
        return { messages: items.map(show), cursor }
      }
      const again = repeat(actor, body.clientId)
      if (again) return again
      return { thread: showThread(thread), message: show(post(actor, thread, body as { text: string; replyTo?: number; clientId?: string; attachments?: string[]; after?: number; noSync?: boolean })) }
    }
    if ((found = /^\/threads\/([^/]+)\/messages\/(\d+)(\/delete|\/reactions|\/labels)?$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      const message = messageAt(thread.id, Number(found[2]))
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      const action = found[3] ?? ''
      if (method !== 'GET') tokenMay(actor, action === '/reactions' ? 'react' : action === '/labels' ? 'label' : 'post', thread.channelId)
      if (method === 'PATCH' && action === '') {
        if (!samePrincipal(message.createdBy.principal, actor.principal)) throw new Refused(403, 'message_not_owned')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        if (message.text !== body.text) {
          Object.assign(message, { text: body.text, editedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision }, actor)
        }
        return { message: show(message) }
      }
      if (method === 'POST' && action === '/delete') {
        if (!samePrincipal(message.createdBy.principal, actor.principal)) throw new Refused(403, 'message_not_owned')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt === undefined) {
          Object.assign(message, { text: '', attachments: undefined, deletedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.deleted', ...ref, revision: message.revision }, actor)
        }
        return { message: show(message) }
      }
      if (method === 'GET' && action === '/reactions') {
        const reactions = [...message.reactions].flatMap(([emoji, by]) => [...by.values()].map(({ actor, createdAt }) => ({ emoji, actor, createdAt })))
        return { reactions, cursor: null }
      }
      if (method === 'POST' && action === '/reactions') {
        if (typeof body.emoji !== 'string' || !EMOJI.test(body.emoji) || Object.hasOwn(Object.prototype, body.emoji)) throw new Refused(400, 'invalid_emoji')
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        const by = message.reactions.get(body.emoji) ?? new Map()
        if (body.remove ? by.has(actor.id) : !by.has(actor.id)) {
          if (body.remove) by.delete(actor.id)
          else by.set(actor.id, { actor, createdAt: now() })
          if (by.size) message.reactions.set(body.emoji, by)
          else message.reactions.delete(body.emoji)
          message.changes++
          emit(thread.channelId, { type: body.remove ? 'message.reaction_removed' : 'message.reaction_added', ...ref, emoji: body.emoji }, actor)
        }
        return { meta: meta(message) }
      }
      if (method === 'POST' && action === '/labels') {
        const set = (body.set ?? {}) as Record<string, string>
        const unset = (body.unset ?? []) as string[]
        if (unset.some((key) => Object.hasOwn(set, key))) throw new Refused(400, 'invalid_label')
        // What the labels must be now, checked with the change: a value, or null for none.
        for (const [key, want] of Object.entries((body.if ?? {}) as Record<string, string | null>).sort(([a], [b]) => (a < b ? -1 : 1))) {
          const now = Object.hasOwn(message.labels, key) ? message.labels[key] : undefined
          if (now !== (want ?? undefined)) throw new Refused(409, 'label_conflict', want === null ? `${key} is set` : now === undefined ? `${key} isn't set` : `${key} isn't ${want}`)
        }
        const changes: Record<string, { from?: string; to?: string }> = {}
        for (const key of unset)
          if (Object.hasOwn(message.labels, key)) {
            changes[key] = { from: message.labels[key]! }
            delete message.labels[key]
          }
        for (const [key, value] of Object.entries(set))
          if (message.labels[key] !== value) {
            changes[key] = { ...(Object.hasOwn(message.labels, key) ? { from: message.labels[key]! } : {}), to: value }
            message.labels[key] = value
          }
        if (Object.keys(message.labels).length > 16) throw new Refused(400, 'too_many_labels')
        if (Object.keys(changes).length) {
          message.changes++
          emit(thread.channelId, { type: 'message.labeled', ...ref, labels: changes }, actor)
        }
        return { meta: meta(message) }
      }
    }
    throw new Refused(404, 'not_found', `${method} ${rest}`)
  }

  return { route, registrations, schedules, send, grants: access.grants }
}

/** A board the fake API keeps: who may use it, and what's on it. */
type Kept = {
  id: string
  name: string
  /** The projects granted it, as `prj_x:production`, or `all` for every project in the team. */
  granted: Set<string> | 'all'
  /** For a private board, the people who see it, by user ID; null for a team-visible one. */
  members: Set<string> | null
  data: ReturnType<typeof fakeBoard>
}

/** A name a board may have: 1 to 64 characters, no `/`. */
const BOARD_NAME = /^[^/]{1,64}$/

/** What `GET /me` says a principal may do, and until when, in milliseconds: the API's `can` and `expiresAt`. */
type MeSays = { can: Record<string, string[]>; expiresAt: number | null }


/** Everything, in the protocol's order: what `GET /me` says an owner, member, or developer may do. */
const ALL = ['read', 'post', 'react', 'label', 'sync', 'manage']

/**
 * The team's API: its default board, `General` (`brd_test`, or none with `boardId: null` until a
 * person makes it), and `boards`, each with the projects granted it as `prj_x:production`. A person
 * uses every board in the team; a project, those granted it in its environment. A board made here
 * takes no name another has, whatever its case, private ones included. A private board (`members`)
 * is seen only by the people it lists.
 * `notDefault`: this team isn't the token's default team, so a request reaches it only when it
 * names it (`teamId` or `slug`), as Vercel's API sends one that names none to the default team.
 *
 * What `GET /me` says, as Vercel's API does: a person may do what their team role lets them
 * (`roles`, by user ID: everything, or `['read', 'react']` for a viewer; a member by default), and a project
 * or an app may read, post, react, and label, everywhere, none with an expiry. `me` says otherwise
 * of some credentials, by the bearer it's sent (`user:u_jb`, or a board token's secret), as it will
 * of board tokens.
 * `me: false` says neither, as Vercel's API answered before it sent them.
 */
export function fakeMessageboard(
  options: {
    teamId?: string
    slug?: string
    boardId?: string | null
    accounts?: Accounts
    boards?: { name: string; id?: string; granted?: string[]; members?: string[] }[]
    /** By user ID: u_jb is an owner and u_val a viewer unless it says, and anyone else a member. */
    roles?: Record<string, Role>
    /** The team's people, by user ID, with their emails: whom a grant's `email` finds. */
    members?: Record<string, string>
    /** The team's projects, by ID, with their names. */
    projects?: Record<string, string>
    /** GitHub repositories, by `owner/repo`, with their IDs. */
    repositories?: Record<string, string>
    me?: Record<string, MeSays> | false
    notDefault?: boolean
    /** Board tokens the API takes, by their secret, whatever it looks like: the principal each acts as, as `as()` names it. */
    tokens?: Record<string, string>
  } = {},
) {
  const accounts = options.accounts ?? ACCOUNTS
  const teamId = options.teamId ?? 'team_test'
  const slug = options.slug ?? 'test'
  const requests: string[] = []
  /** The bucket: bytes by attachment ID, as presigned PUTs leave them. */
  const stored = new Map<string, Uint8Array<ArrayBuffer>>()
  let clock = 0
  const now = () => (clock = Math.max(Date.now(), clock + 1))
  const roles = options.roles ?? ROLES
  // Its own copy: someone leaving one fake's team leaves no other's.
  const directory = { members: { ...(options.members ?? MEMBERS) }, roles, projects: options.projects ?? PROJECTS, repositories: options.repositories ?? REPOSITORIES, apps: APPS }
  const shared: Shared = { teamId, accounts, directory, now, stored }

  const tokens = fakeTokens({ member: (userId) => userId in directory.members, now })

  const kept = (id: string, name: string, granted: Kept['granted'], members: Kept['members'] = null): Kept => ({ id, name, granted, members, data: fakeBoard(shared, id) })
  // The default board is kept from the start, so what a test reads of it holds once a person makes it.
  const general = kept(options.boardId === undefined ? 'brd_test' : (options.boardId ?? 'brd_default'), 'General', 'all')
  let made = options.boardId !== null
  const others = (options.boards ?? []).map((board) => kept(board.id ?? `brd_${randomUUID()}`, board.name, new Set(board.granted ?? []), board.members ? new Set(board.members) : null))
  const boards = () => [...(made ? [general] : []), ...others]
  /** What each ensure made, by its caller and operation ID, for a retry to answer again. */
  const ensured = new Map<string, Kept>()

  const grantOf = (principal: Extract<Principal, { type: 'project' }>) => `${principal.projectId}:${principal.environment}`
  /**
   * Who uses a board: a project, where it's granted in its environment; a person, a team-visible
   * board, or a private one that lists them.
   */
  const mayUse = (actor: Actor, board: Kept) =>
    actor.principal.type === 'project'
      ? board.granted === 'all' || board.granted.has(grantOf(actor.principal))
      : board.members === null || (actor.principal.type === 'user' && board.members.has(actor.principal.userId))
  const show = (board: Kept) => ({ id: board.id, teamId, name: board.name, visibility: board.members === null ? 'team' : 'private' })
  const named = (name: string) => boards().some((board) => board.name.toLowerCase() === name.toLowerCase())

  async function route(request: Request): Promise<unknown> {
    const url = new URL(request.url)
    if (url.searchParams.get('teamId') && url.searchParams.get('teamId') !== teamId) throw new Refused(403, 'forbidden')
    if (url.searchParams.get('slug') && url.searchParams.get('slug') !== slug) throw new Refused(403, 'forbidden')
    if (options.notDefault && !url.searchParams.get('teamId') && !url.searchParams.get('slug')) throw new Refused(403, 'forbidden')
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const actor = actorOf(request, options.tokens, tokens.authenticate(bearer))
    const path = url.pathname.replace(/^\/v1\/messageboard/, '')
    const method = request.method
    requests.push(`${method} ${path}`)
    // A board token is its board's: the team's routes aren't.
    if (actor.token && (path === '/boards' || path.startsWith('/boards/default') || path.startsWith('/boards/ensure')))
      throw new Refused(403, 'board_token_scope', "A board token can't use the team's routes.")
    // Completing an upload takes no body.
    const body = method === 'GET' || /\/attachments\/[^/]+\/complete$/.test(path) ? {} : ((await request.json()) as Record<string, any>)
    // Registering and acking watchers, and completing uploads, take no operation ID: each is idempotent as it is.
    // Sync's routes take none either, but imports.
    if (method !== 'GET' && !/\/watchers(\/|$)|\/complete$|\/sync\/(?!imports$)/.test(path) && typeof body.operationId !== 'string') throw new Refused(400, 'invalid_operation_id')
    if (method === 'GET' && path === '/me') {
      if (options.me === false) return { teamId, actor, view: viewOf(accounts, actor) }
      const role = actor.principal.type === 'user' ? (roles[actor.principal.userId] ?? 'member') : null
      const can = role === null ? ['read', 'post', 'react', 'label'] : role === 'viewer' ? ['read', 'react'] : ALL
      // A board token may do what its scope says, until it expires, in milliseconds as the API sends times.
      const says = options.me?.[bearer] ?? (actor.token ? { can: tokens.summary(actor.token.can), expiresAt: actor.token.expiresAt } : { can: { '*': can }, expiresAt: null })
      return { teamId, actor, view: viewOf(accounts, actor), can: says.can, expiresAt: says.expiresAt }
    }
    if (method === 'GET' && path === '/boards') {
      // `name` matches whatever its case, among the boards the caller may use, in one answer.
      const name = url.searchParams.get('name')
      if (name !== null && !BOARD_NAME.test(name)) throw new Refused(400, 'bad_request', 'A board name is 1 to 64 characters with no /.')
      if (name !== null && url.searchParams.has('cursor')) throw new Refused(400, 'invalid_request', 'A name lookup takes no cursor.')
      const listed = boards().filter((board) => mayUse(actor, board) && (name === null || board.name.toLowerCase() === name.toLowerCase()))
      return { boards: listed.map(show), defaultBoardId: made && mayUse(actor, general) ? general.id : null, cursor: null }
    }
    if (method === 'POST' && path === '/boards/default') {
      // Board creates record a person's event, so project tokens can't.
      if (actor.principal.type === 'project') throw new Refused(403, 'forbidden')
      if (!made && named(general.name)) throw new Refused(409, 'board_name_taken')
      made = true
      return { board: show(general) }
    }
    if (method === 'POST' && path === '/boards/ensure') {
      if (typeof body.name !== 'string' || !BOARD_NAME.test(body.name)) throw new Refused(400, 'bad_request', 'A board name is 1 to 64 characters with no /.')
      // A retry with the same operation ID answers what the first did, as one that made nothing.
      const replayed = ensured.get(`${principalId(actor.principal)}|${body.operationId}`)
      if (replayed) return { board: show(replayed), created: false }
      const found = boards().filter((board) => board.name.toLowerCase() === body.name.toLowerCase())
      if (found[0]) {
        // A name is taken whoever can see its board: a private one stays unseen, and isn't made again.
        if (found[0].members !== null && !mayUse(actor, found[0])) throw new Refused(409, 'board_name_taken', 'A board has that name.')
        if (!mayUse(actor, found[0])) throw new Refused(403, 'board_not_granted', "This project isn't granted that board.")
        return { board: show(found[0]), created: false }
      }
      // A new team-visible board, granted to the project that made it, in its own environment.
      const board = kept(`brd_${randomUUID()}`, body.name, new Set(actor.principal.type === 'project' ? [grantOf(actor.principal)] : []))
      others.push(board)
      ensured.set(`${principalId(actor.principal)}|${body.operationId}`, board)
      return { board: show(board), created: true }
    }
    const onBoard = /^\/boards\/([^/]+)(\/.*)?$/.exec(path)
    const board = onBoard ? boards().find((candidate) => candidate.id === decodeURIComponent(onBoard[1]!)) : undefined
    // A board token is one board's: any other is none to it.
    if (!onBoard || !board || !mayUse(actor, board) || (actor.token && actor.token.boardId !== board.id)) throw new Refused(404, 'board_not_found')
    const rest = onBoard[2] ?? ''
    if (method === 'GET' && rest === '') return { board: show(board) }
    const minting = tokens.route(method, rest, body, actor, board.id)
    if (minting !== undefined) return minting
    if (actor.token && method === 'PUT' && rest === '/watchers') throw new Refused(403, 'board_token_unsupported', "A board token can't register watchers yet.")
    return board.data.route(method, rest, url, body, actor)
  }

  const { registrations, schedules, send } = general.data
  return {
    /** Every request it answered, as `METHOD /path`. */
    requests,
    /** The default board's grants, by ID, as the API keeps them. */
    grants: general.data.grants,
    /** Every board token, by ID, as the API keeps them. */
    tokens: tokens.minted,
    /** Takes a person off the team: the board tokens in their line stop. */
    leave: (userId: string) => void delete directory.members[userId],
    /** The watchers each principal registered on the default board, as the API keeps them. */
    registrations,
    /** Every schedule on the default board, by ID, as the API keeps them. */
    schedules,
    /** Posts a default board schedule's next send now, as its timer would: the message's ID. */
    send,
    /** The attachments bucket, as presigned URLs reach it: a PUT stores bytes, held to its signed SHA-256 as S3 holds it, and a GET reads them. */
    files: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const id = request.url.slice(STORAGE.length)
      if (request.headers.has('authorization')) return new Response('credentials never go to storage', { status: 400 })
      if (request.method === 'PUT') {
        if (stored.has(id)) return new Response(null, { status: 412 })
        const bytes = new Uint8Array(await request.arrayBuffer())
        const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))
        if (request.headers.get('x-amz-checksum-sha256') !== digest) return new Response('BadDigest', { status: 400 })
        stored.set(id, bytes)
        return new Response(null, { status: 200 })
      }
      const bytes = stored.get(id)
      return bytes ? new Response(bytes) : new Response(null, { status: 404 })
    }) as typeof fetch,
    /** The API, as `fetch` reaches it. */
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      try {
        return Response.json(await route(request))
      } catch (error) {
        if (error instanceof Refused || error instanceof GrantRefused) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        throw error
      }
    }) as typeof fetch,
  }
}

/** A fetch to `api` as `principal` (`user:u_jb`, `project:prj_pong:production`): the bearer token the fake reads. */
export const as = (api: ReturnType<typeof fakeMessageboard>, principal: string): typeof fetch =>
  (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${principal}`)
    return api.fetch(input, { ...init, headers })
  }) as typeof fetch
