// An in-memory `/v1/messageboard`, as Vercel's API behaves: what
// `vercel()` from `@vercel/board/backend-vercel` is tested against. A bearer token names its principal:
// `user:u_jb`, `app:oac_1`, or `project:prj_pong:production`.
import { randomUUID } from 'node:crypto'
import { fakeGrants, GrantRefused, type Role, type Who } from './messageboard-grants.ts'
import { importedHandle, userIdOf } from '../src/contract/profiles.ts'
import { parseProfileHeader } from '../src/contract/profile-header.ts'
import { compileAccess, parseCan } from '../src/server/access.ts'

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
  | { type: 'external'; id: string; syncKey: string }
type Actor = {
  id: string
  principal: Principal
  /** An agent's name, or for a platform user a project's sync imported, `<key>:<user>`, with `platform` its key, that key's platform, and the user's ID. */
  profile?: { name: string; avatar?: string; platform?: { key: string; platform: string; userId: string } }
  session?: string
  /** What it may do at most, past what grants give its principal: the `x-board-can` it sent, where the API reads that. */
  can?: Record<string, 'all' | string[]>
  /** It sent an `x-board-can` the API holds it to: never its principal's integration, so no watchers or sync's records. */
  narrowed?: true
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
/** On a platform user a project's sync imported, `via` is the project's name, or null, and its environment, and `platform` its key's platform. */
type ActorView = {
  id: string
  kind: 'person' | 'agent' | 'deployment' | 'app' | 'external'
  handle: string
  name?: string
  avatar?: string
  via?: { name: string | null; environment: string }
  platform?: string
  lastSeenAt: number
}

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
/** Whether `actor` may change what `by` wrote: its principal did, and as its profile when it writes as one. */
const owns = (actor: Actor, by: Actor) => samePrincipal(by.principal, actor.principal) && (!actor.profile || by.id === actor.id)

/**
 * Who a request is: its bearer names a principal, or is a credential `tokens` maps to one. Its
 * profile is what `x-board-profile` names, with `x-board-avatar` and `x-board-session` beside it, as
 * Vercel's API reads them today; `protocol` reads them as board's protocol has it: the profile and
 * its avatar in one structured `x-board-profile`, and the other two ignored.
 */
function actorOf(request: Request, tokens: Record<string, string> = {}, protocol = false): Actor {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const token = tokens[bearer] ?? bearer
  const [type, id, environment] = token.split(':')
  const principal: Principal | null =
    type === 'user' && id
      ? { type, userId: id }
      : type === 'app' && id
        ? { type, clientId: id }
        : type === 'project' && id && environment
          ? { type, projectId: id, environment }
          : null
  if (!principal) throw new Refused(401, 'invalid_token', 'This token is invalid, expired, or revoked.')
  let { name, avatar, session } = {
    name: request.headers.get('x-board-profile') ?? undefined,
    avatar: request.headers.get('x-board-avatar') ?? undefined,
    session: request.headers.get('x-board-session') ?? undefined,
  }
  if (protocol) {
    // What released clients still send, read by nothing: an avatar comes with a profile's header, and no session is kept.
    avatar = undefined
    session = undefined
    const header = request.headers.get('x-board-profile')
    if (header !== null) {
      try {
        const parsed = parseProfileHeader(header)
        ;({ name, avatar } = { name: parsed.name, avatar: parsed.avatar ?? undefined })
      } catch (error) {
        throw new Refused(400, 'invalid_profile', (error as Error).message)
      }
    }
  }
  // A proxy that holds the credential narrows it.
  const header = request.headers.get('x-board-can')
  let can: Actor['can']
  if (header !== null) {
    try {
      can = compileAccess(parseCan(header)).summary() as Actor['can']
    } catch (error) {
      throw new Refused(400, 'invalid_scope', (error as Error).message)
    }
  }
  const base = principalId(principal)
  return {
    id: name ? `${base}+${name.toLowerCase()}` : base,
    principal,
    ...(name ? { profile: { name, ...(avatar ? { avatar } : {}) } } : {}),
    ...(session ? { session } : {}),
    ...(can ? { can, narrowed: true as const } : {}),
  }
}

function page<T>(items: T[], cursor: string | null, size: number) {
  const from = cursor ? Number(cursor) : 0
  const next = from + size < items.length ? String(from + size) : null
  return { items: items.slice(from, from + size), cursor: next }
}

type Accounts = Record<string, { username: string; name: string }>

/**
 * An actor as the API names them: a person by their account, and a deployment by its project's name, in every
 * environment, or with `projectIdHandles`, as `project:<id>:<environment>`, as the API named one before. One whose
 * project it doesn't know it names that way too.
 */
function viewOf(names: Pick<Shared, 'accounts' | 'directory' | 'projectIdHandles'>, actor: Actor): Omit<ActorView, 'lastSeenAt'> {
  const p = actor.principal
  if (p.type === 'external') return { id: actor.id, kind: 'external', handle: p.id }
  const account = p.type === 'user' ? names.accounts[p.userId] : undefined
  const project = p.type === 'project' && !names.projectIdHandles ? names.directory.projects[p.projectId] : undefined
  const base = p.type === 'user' ? (account?.username ?? p.userId) : p.type === 'app' ? p.clientId : (project ?? `project:${p.projectId}:${p.environment}`)
  if (actor.profile?.platform) return { id: actor.id, kind: 'external', handle: actor.profile.platform.userId, platform: actor.profile.platform.platform }
  if (actor.profile) return { id: actor.id, kind: 'agent', handle: `${base}/${actor.profile.name.toLowerCase()}`, name: actor.profile.name, ...(actor.profile.avatar ? { avatar: actor.profile.avatar } : {}) }
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

/** Who a token is, as grants see it. */
const whoOf = (actor: Actor): Who => {
  // A platform user a sync imported makes no requests of their own.
  if (actor.principal.type === 'external') throw new Refused(403, 'forbidden')
  const limit = actor.can ? { limit: actor.can as NonNullable<Who['limit']> } : {}
  return actor.principal.type === 'user'
    ? { kind: 'user', userId: actor.principal.userId, ...limit }
    : actor.principal.type === 'project'
      ? { kind: 'project', projectId: actor.principal.projectId, environment: actor.principal.environment, ...limit }
      : { kind: 'app', clientId: actor.principal.clientId, ...limit }
}

/**
 * What every board in one fake API shares: its team, its accounts and directory, its clock, and its bucket. `externalImports`:
 * an import's author is the platform user alone, as Vercel's API named them before platform profiles. `platformHandles`: an
 * import's handle is the platform user's own, as the API named them before it put them under their project's name. `boardWideKeys`:
 * a sync key is one registrant's on the whole board, as Vercel's API kept them before each project had its own. `projectIdHandles`:
 * a deployment's handle is `project:<id>:<environment>`, as the API named one before it named it by its project. `unscopedSync`:
 * a thread's binding goes to every registrant of its key, and `syncThread` lists every target, whose project and key they are.
 */
type Shared = {
  teamId: string
  inlineThreadMessages: boolean
  accounts: Accounts
  directory: Directory
  now: () => number
  stored: Map<string, Uint8Array<ArrayBuffer>>
  externalImports: boolean
  actorsById: boolean
  platformHandles: boolean
  boardWideKeys: boolean
  projectIdHandles: boolean
  unscopedSync: boolean
}

const STORAGE = 'http://storage.test/'

/** One board in the fake API, with its own channels, threads, files, watchers, and schedules. */
function fakeBoard(shared: Shared, boardId: string) {
  const { teamId, accounts, now, stored } = shared
  /** Its grants, g1 and g2 to start, as each board on the API has its own. */
  const access = fakeGrants({ teamId, ...shared.directory })
  const channels: { id: string; name: string }[] = [{ id: 'general', name: 'general' }]
  const threads = new Map<string, Thread>()
  const posts = new Map<string, string>()
  /** What each post's operation answered, by its caller: the API answers a repeated operation with what it answered first, and writes nothing. */
  const posted = new Map<string, unknown>()
  const once = <T,>(actor: Actor, operationId: unknown, write: () => T): T => {
    if (typeof operationId !== 'string') return write()
    const key = `${principalId(actor.principal)}|${operationId}`
    if (!posted.has(key)) posted.set(key, write())
    return posted.get(key) as T
  }
  const feeds = new Map<string, Change[]>()
  const actors = new Map<string, ActorView>()
  const attachments = new Map<string, Attachment>()
  type Filter = { channelIds?: string[]; channelTree?: string; threadId?: string; authors?: string[]; text?: string; labels?: { key: string; values?: string[] }[] }
  type Registration = { owner: string; path?: string; branch?: string; watch: Record<string, { filter: Filter }>; sync: { key: string; platform: string }[]; hash: string }
  type Match = { id: string; watcher: string; threadId: string; change: Change; lease?: string; leaseUntil?: number; retryAt?: number; attempts: number }
  /** By principal, as the API keeps them: one each. */
  const registrations = new Map<string, Registration>()
  const queued = new Map<string, Match[]>()
  const schedules = new Map<string, Schedule>()
  /**
   * Sync, as Vercel's API keeps it: each key's owner, platform IDs to the board's, copies, bindings, and inboxes, all
   * under the project whose key it is (`<projectId>|…`), or the whole board's with `boardWideKeys` (`|…`).
   */
  const syncKeys = new Map<string, string>()
  const platformThreads = new Map<string, string>()
  const platformMessages = new Map<string, string>()
  const importIds = new Map<string, string>()
  /** A thread's targets: `external` is the platform thread it is there, a channel's once its root lands. `projectId` is whose. */
  const bindings = new Map<string, { target: string; targetKind: 'channel' | 'thread'; cause: string; external?: string; projectId?: string }[]>()
  /** Each message's copies, and why it didn't reach a target, by `<projectId>|<target>`. */
  const copies = new Map<string, Record<string, { thread: string; message: string; files?: string[] | null; asUser?: true }>>()
  const failures = new Map<string, Record<string, string>>()
  /** Whose sync keys a principal's are: its project's, or with `boardWideKeys`, the board's. */
  const scopeOf = (principal: Principal) => (shared.boardWideKeys || principal.type !== 'project' ? '' : principal.projectId)
  /** What a binding says of whose it is: its project, unless keys are the board's. */
  const projectOf = (principal: Principal) => (scopeOf(principal) ? { projectId: scopeOf(principal) } : {})
  type InboxEntry = { id: string; eventId: string; thread: string; event?: unknown; raw?: unknown; pushedAt: number; attempts: number; lease?: string; leaseUntil?: number; retryAt?: number; done?: boolean }
  const inboxes = new Map<string, InboxEntry[]>()

  const seen = (actor: Actor) => {
    // A platform user is named by what its sync last said of them.
    if (actor.principal.type === 'external' || actor.profile?.platform) return
    actors.set(actor.id, { ...viewOf(shared, actor), lastSeenAt: now() })
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
    // A thread's binding goes only to the sync that owns the target's key, in the binding's project.
    const binding = (change as { binding?: { target: string; projectId?: string } }).binding
    if (change.type === 'thread.synced' && binding) {
      for (const registration of registrations.values()) {
        const project = registration.owner.split(':')[2]
        if (registration.sync.some((entry) => entry.key === prefixOf(binding.target)) && (binding.projectId === undefined || binding.projectId === project || shared.unscopedSync)) {
          queue(registration.owner, '@sync')
        }
      }
      return
    }
    if (!String(change.type).startsWith('message.')) return
    const thread = threads.get(message.threadId)!
    const channel = channels.find((c) => c.id === thread.channelId)!
    const rootLabels = thread.messages[0]?.labels ?? {}
    const scheduled = change.type === 'message.posted' && (message as { schedule?: unknown }).schedule !== undefined
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
        // A watcher's own writes never wake it, but for what a schedule of its own posted.
        const own = (change.actor as Actor).id === `${registration.owner}+${watcher.toLowerCase()}`
        if ((!own || scheduled) && sees(spec.filter)) {
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

  /** A caller narrowed with `x-board-can` does only what it gives at the channel's closest pattern: the channel, then its parents (`dev/`), then `*`. */
  function tokenMay(actor: Actor, permission: string, channelId: string) {
    tokenMayIn(actor, permission, channels.find((channel) => channel.id === channelId)?.name ?? '')
  }
  /** The same, by the channel's name, which needn't exist yet. */
  function tokenMayIn(actor: Actor, permission: string, name: string) {
    const { can } = actor
    if (!can) return
    const parts = name.split('/')
    const candidates = [name, ...parts.map((_, i) => `${parts.slice(0, parts.length - i).join('/')}/`), '*']
    const pattern = candidates.find((candidate) => Object.hasOwn(can, candidate))
    const grant = pattern === undefined ? [] : can[pattern]!
    if (!(grant === 'all' || grant.includes(permission))) throw new Refused(403, 'forbidden', `This caller may not ${permission} in ${name}.`)
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

  /** Whether `actor` may read in the channel: a narrowed caller only where its `x-board-can` gives `read`. */
  const mayRead = (actor: Actor, channelId: string) => {
    try {
      tokenMay(actor, 'read', channelId)
      return true
    } catch {
      return false
    }
  }

  /** A repeat of a post with the same client ID, by the same principal: the first one. */
  function repeat(actor: Actor, clientId: unknown) {
    if (clientId === undefined) return null
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)) throw new Refused(400, 'invalid_client_id')
    const id = posts.get(`${principalId(actor.principal)}|${clientId}`)
    if (!id) return null
    const [, uuid, sequence] = MESSAGE_ID.exec(id)!
    const thread = threadAt(`thr_${uuid}`)
    const message = thread.messages[Number(sequence) - 1]!
    if (!mayRead(actor, thread.channelId)) return { thread: { id: thread.id }, message: { id: message.id, threadId: thread.id, sequence: message.sequence } }
    return { thread: showThread(thread), message: show(message) }
  }

  async function watchers(method: string, rest: string, actor: Actor, parsed: Record<string, any>, url: URL): Promise<unknown> {
    const owner = principalId(actor.principal)
    const view = (r: Registration) => ({ owner: r.owner, ...(r.path ? { path: r.path, ...(r.branch ? { branch: r.branch } : {}) } : {}), watch: r.watch, ...(r.sync.length ? { sync: r.sync } : {}), hash: r.hash })
    if (method === 'GET' && rest === '/watchers') {
      const found = registrations.get(owner)
      return { watchers: found ? [view(found)] : [] }
    }
    if (method === 'PUT' && rest === '/watchers') {
      const body = parsed as { path?: string; branch?: string; watch: Registration['watch']; tag?: string; sync?: Registration['sync'] }
      // A path on the caller's own project (a preview's with its branch), or none to pull, as api-messageboard checks one.
      // A deployment is woken by its path on its project, or pulls: never at a URL, and the API refuses any `url`, even null.
      if ('url' in parsed) throw new Refused(400, 'bad_request', 'Watchers are woken by a path, not a url.')
      if (body.branch !== undefined && body.path === undefined) throw new Refused(400, 'bad_request', 'A branch goes with a path.')
      const principal = actor.principal
      if (body.path !== undefined) {
        if (principal.type !== 'project') throw new Refused(403, 'not_a_project')
        // Any environment's: the API finds what to wake from the caller's token, and a preview's by its branch when it names one.
        if (body.branch !== undefined && principal.environment !== 'preview') throw new Refused(400, 'invalid_branch')
        if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.startsWith('//')) throw new Refused(400, 'invalid_path')
      }
      const where = body.path !== undefined ? { path: body.path.replace(/(.)\/+$/, '$1'), ...(body.branch ? { branch: body.branch } : {}) } : {}
      const sync = body.sync ?? []
      // Only a project's own token syncs.
      if (sync.length > 0 && principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      // Watchers are for waking a deployment: only its own credentials register them.
      if (principal.type !== 'project') throw new Refused(403, 'watchers_need_project', 'Only a deployment can register watchers.')
      // A key is one registrant's in its project: production takes it from a preview or development, and otherwise
      // whoever registered it first keeps it, and the rest hear who has it. With `boardWideKeys`, one's on the board, and a second's 409.
      const scope = scopeOf(principal)
      const environmentOf = (holder: string) => holder.split(':')[3]!
      const held: Registration['sync'] = []
      const elsewhere: { key: string; platform: string; owner: string; environment: string }[] = []
      for (const entry of sync) {
        const holder = syncKeys.get(`${scope}|${entry.key}`)
        if (holder === undefined || holder === owner || (!shared.boardWideKeys && principal.environment === 'production' && environmentOf(holder) !== 'production')) held.push(entry)
        else if (shared.boardWideKeys) throw new Refused(409, 'sync_key_taken')
        else elsewhere.push({ key: entry.key, platform: entry.platform, owner: holder, environment: environmentOf(holder) })
      }
      for (const [at, holder] of syncKeys) if (holder === owner && !held.some((entry) => at === `${scope}|${entry.key}`)) syncKeys.delete(at)
      for (const { key } of held) {
        // The deployment production took it from stops syncing it, and is no longer woken for it.
        const before = syncKeys.get(`${scope}|${key}`)
        const taken = before === undefined || before === owner ? undefined : registrations.get(before)
        if (taken) taken.sync = taken.sync.filter((entry) => entry.key !== key)
        syncKeys.set(`${scope}|${key}`, owner)
      }
      const made: Registration = { owner, ...where, watch: body.watch, sync: held, hash: body.tag ?? randomUUID().replaceAll('-', '') }
      registrations.set(owner, made)
      return shared.boardWideKeys ? view(made) : { ...view(made), elsewhere: elsewhere.sort((a, b) => a.key.localeCompare(b.key)) }
    }
    if (!registrations.has(owner)) throw new Refused(404, 'no_registration')
    if (method === 'GET' && rest === '/watchers/matches') {
      const until = Date.now() + Number(url.searchParams.get('wait') ?? 0) * 1000
      const limit = Number(url.searchParams.get('limit') ?? 10)
      for (;;) {
        // Read again each time: a match queued while it waits may be the registrant's first.
        const lane = queued.get(owner) ?? []
        // One leased, or waiting after an error, holds up its watcher's thread.
        const held = new Set(lane.filter((m) => (m.lease && m.leaseUntil! > Date.now()) || (m.retryAt ?? 0) > Date.now()).map((m) => `${m.watcher}|${m.threadId}`))
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
    const lane = queued.get(owner) ?? []
    const acking = /^\/watchers\/matches\/([^/]+)\/ack$/.exec(rest)
    if (method === 'POST' && acking) {
      const body = parsed as { lease: string; error?: string; skip?: boolean }
      const at = lane.findIndex((m) => m.id === decodeURIComponent(acking[1]!))
      if (at === -1) throw new Refused(404, 'no_match')
      if (lane[at]!.lease !== body.lease) throw new Refused(409, 'stale_lease')
      // After an error it waits a second, doubling to 30, as the API's does.
      if (body.error !== undefined && !body.skip) {
        lane[at]!.attempts++
        lane[at]!.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (lane[at]!.attempts - 1))
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
      if (!owns(actor, target.createdBy)) throw new Refused(403, 'schedule_not_owned')
      if (target.state !== 'pending') return { schedule: showSchedule(target), canceled: false }
      Object.assign(target, { state: 'canceled', nextAt: null, canceled: { by: actor, at: now(), reason: 'canceled' }, revision: target.revision + 1 })
      return { schedule: showSchedule(target), canceled: true }
    }
    return undefined
  }


  const prefixOf = (id: string) => id.slice(0, id.indexOf(':'))
  /** Only a project's own token syncs, through the keys it holds. */
  function requireKey(actor: Actor, key: string) {
    if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
    if (syncKeys.get(`${scopeOf(actor.principal)}|${key}`) !== principalId(actor.principal)) throw new Refused(403, 'sync_key_not_owned')
  }
  /** The platform the caller registered a sync key with. */
  const platformOf = (owner: string, key: string) => registrations.get(owner)?.sync.find((entry) => entry.key === key)?.platform ?? key
  const ownedKeys = (actor: Actor) =>
    new Set([...syncKeys].filter(([, owner]) => owner === principalId(actor.principal)).map(([at]) => at.slice(at.indexOf('|') + 1)))

  /** Vercel's API's sync routes, as they behave: undefined for a route that isn't one. */
  function syncRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    const owner = principalId(actor.principal)
    const scope = scopeOf(actor.principal)
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/sync/imports') {
      // The key it came through, or for a write a sync makes as the user, the user's own.
      const key: string = body.from ?? prefixOf(body.author.id)
      requireKey(actor, key)
      if (!String(body.author.id).startsWith(`${key}:`)) throw new Refused(403, 'foreign_author')
      if (body.origin && !body.from) throw new Refused(400, 'invalid_import', 'An import with an origin names the sync key it came through: pass `from`.')
      // A change it imported says which sync it came through, so that sync doesn't send it back.
      const through = body.from ? { from: body.from } : {}
      // The platform user is a profile of the project whose sync speaks for them, under the key it came through.
      const principal = actor.principal as Extract<Principal, { type: 'project' }>
      const author: Actor = shared.externalImports
        ? { id: body.author.id, principal: { type: 'external', id: body.author.id, syncKey: key } }
        : { id: `${owner}+${body.author.id}`, principal, profile: { name: body.author.id, platform: { key, platform: platformOf(owner, key), userId: String(body.author.id).slice(key.length + 1) } } }
      const via = shared.externalImports ? {} : { via: { name: shared.directory.projects[principal.projectId] ?? null, environment: principal.environment }, platform: platformOf(owner, key) }
      const handle = shared.externalImports || shared.platformHandles ? body.author.handle : importedHandle(shared.directory.projects[principal.projectId] ?? principal.projectId, body.author.handle, userIdOf(body.author.id))
      actors.set(author.id, { id: author.id, kind: 'external', handle, name: body.author.name, ...(body.author.avatar ? { avatar: body.author.avatar } : {}), ...via, lastSeenAt: now() })
      if (body.op === 'post') {
        const landed = body.id !== undefined ? importIds.get(`${owner}|${body.id}`) : undefined
        if (landed) return { message: landed }
        const origin = body.origin as { thread: string; message: string } | null | undefined
        if (origin && body.channelId !== undefined && platformThreads.has(`${scope}|${key}|${origin.thread}`)) throw new Refused(409, 'already_synced')
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
          const bound = origin ? platformThreads.get(`${scope}|${key}|${origin.thread}`) : undefined
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
            platformThreads.set(`${scope}|${key}|${origin.thread}`, thread.id)
            bindings.set(thread.id, [{ target: origin.thread, targetKind: 'thread', cause: 'import', external: origin.thread, ...projectOf(actor.principal) }])
          }
          platformMessages.set(`${scope}|${key}|${origin.thread}|${origin.message}`, message.id)
        }
        if (body.id !== undefined) importIds.set(`${owner}|${body.id}`, message.id)
        return { message: message.id }
      }
      const origin = body.origin as { thread: string; message?: string } | undefined
      const id = origin
        ? origin.message !== undefined
          ? platformMessages.get(`${scope}|${key}|${origin.thread}|${origin.message}`)
          : platformThreads.has(`${scope}|${key}|${origin.thread}`) ? `msg_${platformThreads.get(`${scope}|${key}|${origin.thread}`)!.slice('thr_'.length)}_1` : undefined
        : body.message
      const message = id ? messageNamed(id) : undefined
      if (!message) return { message: null }
      const by = message.createdBy
      // A sync edits and deletes only its own platform users' messages; it reacts and labels on any.
      if (body.op === 'edit' || body.op === 'delete') {
        const own = by.principal.type === 'external' ? by.principal.syncKey === key : by.profile?.platform?.key === key && samePrincipal(by.principal, actor.principal)
        if (!own || (body.message !== undefined && by.id !== author.id)) {
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
      const key = prefixOf(body.target)
      requireKey(actor, key)
      const project = projectOf(actor.principal)
      const at = `${scope}|${body.target}`
      if (body.kind === 'thread') {
        const list = bindings.get(message.threadId) ?? []
        bindings.set(message.threadId, list)
        if (list.some((bound) => bound.target === body.target && bound.projectId === project.projectId)) return { ok: true, attached: false }
        if (body.targetKind === 'thread') {
          const bound = platformThreads.get(`${scope}|${key}|${body.target}`)
          if (bound && bound !== message.threadId) throw new Refused(409, 'already_synced')
          platformThreads.set(`${scope}|${key}|${body.target}`, message.threadId)
        }
        const binding = { target: body.target, targetKind: body.targetKind, cause: body.cause, ...project }
        list.push({ ...binding, ...(body.targetKind === 'thread' ? { external: body.target } : {}) })
        const thread = threadAt(message.threadId)
        emit(thread.channelId, { type: 'thread.synced', threadId: thread.id, messageId: thread.messages[0]!.id, binding }, actor)
        return { ok: true, attached: true }
      }
      const mine = copies.get(message.id) ?? {}
      copies.set(message.id, mine)
      if (body.kind === 'message') {
        mine[at] ??= { thread: body.external.thread, message: body.external.message, ...(body.external.asUser ? { asUser: true as const } : {}), ...(body.files !== undefined ? { files: body.files } : {}) }
        // A channel's platform thread is the one its root landed in.
        const bound = message.sequence === 1 ? bindings.get(message.threadId)?.find((one) => one.target === body.target && one.targetKind === 'channel' && one.projectId === project.projectId) : undefined
        if (bound && bound.external === undefined) {
          bound.external = body.external.thread
          platformThreads.set(`${scope}|${key}|${body.external.thread}`, message.threadId)
        }
        platformMessages.set(`${scope}|${key}|${body.external.thread}|${body.external.message}`, message.id)
        delete failures.get(message.id)?.[at]
      } else if (body.kind === 'files') {
        if (mine[at]) mine[at]!.files = body.files
      } else {
        const failed = failures.get(message.id) ?? {}
        failures.set(message.id, failed)
        failed[at] = body.error
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
        thread = platformThreads.get(`${scope}|${prefixOf(query.thread)}|${query.thread}`) ?? null
        if (query.message !== undefined) message = platformMessages.get(`${scope}|${prefixOf(query.thread)}|${query.thread}|${query.message}`) ?? message
      }
      // The API links no platform accounts to people, so it finds none.
      return { thread, message, person: null, accounts: [], holder: null }
    }
    if ((found = /^\/sync\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const thread = threadAt(decodeURIComponent(found[1]!))
      const owned = ownedKeys(actor)
      // Its own project's targets, through the keys it holds: with `unscopedSync`, every one.
      const mine = (bindings.get(thread.id) ?? []).filter((bound) => shared.unscopedSync || (owned.has(prefixOf(bound.target)) && (bound.projectId ?? '') === scope))
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
      const own = (id: string) =>
        Object.entries(copies.get(id) ?? {}).flatMap(([at, copy]) => {
          const target = at.slice(at.indexOf('|') + 1)
          return at.startsWith(`${scope}|`) && owned.has(prefixOf(target)) ? [[target, copy] as const] : []
        })
      return { copies: Object.fromEntries(url.searchParams.getAll('message').map((id) => [id, Object.fromEntries(own(id))])) }
    }
    if ((found = /^\/messages\/([^/]+)\/synced$/.exec(rest)) && method === 'GET') {
      const message = messageNamed(decodeURIComponent(found[1]!))
      if (!message) throw new Refused(404, 'message_not_found')
      const mine = copies.get(message.id) ?? {}
      const failed = failures.get(message.id) ?? {}
      return {
        // Every project's targets, each saying whose it is.
        targets: (bindings.get(message.threadId) ?? []).map(({ target, projectId }) => ({
          target,
          key: prefixOf(target),
          thread: mine[`${projectId ?? ''}|${target}`]?.thread ?? null,
          message: mine[`${projectId ?? ''}|${target}`]?.message ?? null,
          undelivered: failed[`${projectId ?? ''}|${target}`] ?? null,
          ...(projectId !== undefined ? { projectId } : {}),
        })),
      }
    }
    if (method === 'GET' && rest === '/sync/linked') {
      const thread = url.searchParams.get('thread') ?? ''
      const named = url.searchParams.get('message')
      // Every project's that holds the key, the caller's own first.
      const scopes = new Set([scope, ...[...platformThreads.keys()].map((at) => at.slice(0, at.indexOf('|')))])
      const idIn = (where: string) => {
        const at = `${where}|${prefixOf(thread)}|${thread}`
        return named !== null ? platformMessages.get(`${at}|${named}`) : platformThreads.has(at) ? `msg_${platformThreads.get(at)!.slice('thr_'.length)}_1` : undefined
      }
      const id = [...scopes].map(idIn).find((one) => one !== undefined)
      const message = id ? messageNamed(id) : undefined
      if (!message) throw new Refused(404, 'message_not_found')
      return { thread: message.threadId, message: message.id }
    }
    if ((found = /^\/sync\/inbox\/([^/]+)(\/next|\/([^/]+)\/ack)?$/.exec(rest))) {
      const key = decodeURIComponent(found[1]!)
      requireKey(actor, key)
      const inbox = inboxes.get(`${scope}|${key}`) ?? []
      inboxes.set(`${scope}|${key}`, inbox)
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
      // It lists only the channels the caller may read.
      const readable = channels.filter((c) => mayRead(actor, c.id))
      return { channels: name === null ? readable : readable.filter((c) => c.name === name), cursor: null }
    }
    const makeChannel = (name: unknown) => {
      if (typeof name !== 'string' || name.length > 80 || !CHANNEL.test(name)) throw new Refused(400, 'invalid_channel_name')
      if (channels.some((c) => c.name === name)) throw new Refused(409, 'channel_name_taken')
      const channel = { id: `chn_${randomUUID()}`, name }
      channels.push(channel)
      return channel
    }
    if (method === 'POST' && rest === '/channels') {
      tokenMayIn(actor, 'read', typeof body.name === 'string' ? body.name : '')
      return { channel: makeChannel(body.name) }
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
      const include = url.searchParams.get('include')
      // An API from before `include=messages` takes no `include`, as it takes no other parameter it doesn't know.
      if (include !== null && !shared.inlineThreadMessages) throw new Refused(400, 'bad_request', 'Invalid request: should NOT have additional property `include`.')
      if (include !== null && include !== 'messages') throw new Refused(400, 'bad_request')
      return {
        threads: items.map((t) => {
          if (include === null) return showThread(t)
          // Each thread's first message, and its newest when it has replies.
          const latest = t.lastMessage && t.lastMessage.sequence > 1 ? t.messages.find((m) => m.sequence === t.lastMessage!.sequence) : undefined
          return { ...showThread(t), ...(t.messages[0] ? { rootMessage: show(t.messages[0]) } : {}), ...(latest ? { latestMessage: show(latest) } : {}) }
        }),
        cursor,
      }
    }
    if (method === 'POST' && rest === '/threads') {
      const again = repeat(actor, body.clientId)
      if (again) return again
      return once(actor, body.operationId, () => {
      // By `channel`, its name, it checks `post` there and makes the channel on its first post, as a board does; or by `channelId`.
      if (body.channel !== undefined) tokenMayIn(actor, 'post', String(body.channel))
      const channel = body.channel !== undefined ? (channels.find((c) => c.name === body.channel) ?? makeChannel(body.channel)) : channelAt(body.channelId)
      tokenMay(actor, 'post', channel.id)
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: actor, messages: [] }
      threads.set(thread.id, thread)
      const message = post(actor, thread, body as { text: string; clientId?: string; labels?: Record<string, string>; attachments?: string[]; noSync?: boolean })
      return { thread: showThread(thread), message: show(message) }
      })
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
    if (method === 'GET' && rest === '/actors') {
      const ids = url.searchParams.getAll('id')
      if (ids.length === 0) return { actors: [...actors.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt), cursor: null }
      // An API from before actors by ID takes no `id`, as it takes no other parameter it doesn't know.
      if (!shared.actorsById) throw new Refused(400, 'bad_request', 'Invalid request: should NOT have additional property `id`.')
      if (ids.length > 100 || new Set(ids).size !== ids.length || url.searchParams.has('cursor')) throw new Refused(400, 'bad_request')
      return { actors: ids.flatMap((id) => actors.get(id) ?? []), cursor: null }
    }
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
      return once(actor, body.operationId, () => ({ thread: showThread(thread), message: show(post(actor, thread, body as { text: string; replyTo?: number; clientId?: string; attachments?: string[]; after?: number; noSync?: boolean })) }))
    }
    if ((found = /^\/threads\/([^/]+)\/messages\/(\d+)(\/delete|\/reactions|\/labels)?$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      const message = messageAt(thread.id, Number(found[2]))
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      const action = found[3] ?? ''
      if (method !== 'GET') tokenMay(actor, action === '/reactions' ? 'react' : action === '/labels' ? 'label' : 'post', thread.channelId)
      if (method === 'PATCH' && action === '') {
        if (!owns(actor, message.createdBy)) throw new Refused(403, 'message_not_owned')
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) throw new Refused(400, 'invalid_message')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        if (message.text !== body.text) {
          Object.assign(message, { text: body.text, editedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision }, actor)
        }
        return { message: show(message) }
      }
      if (method === 'POST' && action === '/delete') {
        if (!owns(actor, message.createdBy)) throw new Refused(403, 'message_not_owned')
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

  return { route, registrations, schedules, send, grants: access.grants, within: (actor: Actor, can: Record<string, string[]>) => access.within(whoOf(actor), can) }
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

/** A schema version, as the API shows it: a built-in's `createdAt` is 0, and it has no `createdBy`. */
type SchemaRow = { id: string; name: string; version: number; description?: string; schema: Record<string, unknown>; builtIn: boolean; createdAt: number; createdBy?: Actor }

const SCHEMA_KEYWORDS = new Set([
  '$schema', 'type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'not', 'format',
])

/** Whether every schema in `value` uses the API's structural keywords only: `properties` maps names to schemas, and `enum` and `const` hold data. */
function structural(value: unknown, properties = false): boolean {
  if (typeof value !== 'object' || value === null) return true
  if (Array.isArray(value)) return value.every((item) => structural(item))
  return Object.entries(value).every(([key, child]) => (properties ? structural(child) : SCHEMA_KEYWORDS.has(key) && (key === 'enum' || key === 'const' || structural(child, key === 'properties'))))
}

/** `value` as JSON with its keys in order, as the API compares two definitions. */
const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) => (child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : 1))) : child))

const sha = { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$', description: 'Full lowercase commit SHA' }
const BUILT_IN_SCHEMAS: SchemaRow[] = [
  {
    id: 'git-commit@1',
    name: 'git-commit',
    version: 1,
    description: 'A Git commit, by its full SHA and the first line of its message.',
    schema: { type: 'object', additionalProperties: false, required: ['sha', 'title'], properties: { sha, title: { type: 'string', minLength: 1, maxLength: 1024 } } },
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'vercel-deployment@1',
    name: 'vercel-deployment',
    version: 1,
    description: 'A Vercel deployment, by its URL and optionally the commit it was built from.',
    schema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 }, gitSha: sha } },
    builtIn: true,
    createdAt: 0,
  },
]

/**
 * The team's data schemas, as Vercel's API keeps them, one registry for every board on the team: its
 * built-ins first, then the team's own by their IDs as text. A version registers once: the same
 * definition again answers it with `created: false`, and another is 409. People and apps
 * register, but for a viewer, and read them on the team's routes, which answer a project's token 403.
 * Whoever a board lets in reads them through it (`/boards/:boardId/schemas…`), a project included.
 */
function fakeSchemas({ now, roles }: { now: () => number; roles: Record<string, Role> }) {
  const kept = new Map<string, SchemaRow>()
  const ID = /^([a-z][a-z0-9._-]{0,79})@([1-9][0-9]{0,4})$/
  return {
    /** Every version the team registered, by its ID. */
    kept,
    /** What a read of `/schemas` or `/schemas/:id` answers, on the team's routes and through a board alike, or undefined for another path. */
    read(path: string): unknown {
      if (path === '/schemas') return { schemas: [...BUILT_IN_SCHEMAS, ...[...kept.values()].sort((a, b) => (a.id < b.id ? -1 : 1))], cursor: null }
      if (!path.startsWith('/schemas/')) return undefined
      const id = decodeURIComponent(path.slice('/schemas/'.length))
      if (!ID.test(id)) throw new Refused(400, 'invalid_schema_id', 'Name a schema as name@version, such as git-commit@1.')
      const schema = BUILT_IN_SCHEMAS.find((found) => found.id === id) ?? kept.get(id)
      if (!schema) throw new Refused(404, 'schema_not_found', `Schema ${id} isn't registered for this team.`)
      return { schema }
    },
    /** What the team's `/schemas…` answers, or undefined for another route. */
    route(method: string, path: string, body: Record<string, any>, actor: Actor): unknown {
      if (path !== '/schemas' && !path.startsWith('/schemas/')) return undefined
      if (actor.principal.type === 'project') throw new Refused(403, 'forbidden')
      if (method === 'GET') return this.read(path)
      if (method !== 'POST' || path !== '/schemas') return undefined
      if (actor.principal.type === 'user' && (roles[actor.principal.userId] ?? 'member') === 'viewer') throw new Refused(403, 'forbidden')
      if (actor.narrowed) throw new Refused(403, 'forbidden', "A caller narrowed with x-board-can can't change the team's schemas: that's its principal's job.")
      const { operationId: _operationId, name, version, description, schema, ...unknown } = body
      if (Object.keys(unknown).length > 0) throw new Refused(400, 'bad_request', `Unknown property ${Object.keys(unknown)[0]}.`)
      const id = `${name}@${version}`
      if (typeof name !== 'string' || !ID.test(id)) throw new Refused(400, 'invalid_schema_id', 'Schema names use lowercase letters, numbers, ".", "_" and "-", starting with a letter.')
      if (BUILT_IN_SCHEMAS.some((found) => found.name === name)) throw new Refused(409, 'reserved_schema', `${name} is a built-in schema and can't be registered.`)
      if (typeof schema !== 'object' || schema === null || schema.type !== 'object') throw new Refused(400, 'invalid_schema', 'A schema must describe a JSON object ("type": "object").')
      if (!structural(schema)) throw new Refused(400, 'invalid_schema', "Schemas don't support that keyword. References, patterns, uniqueItems, and custom keywords aren't allowed.")
      const existing = kept.get(id)
      if (existing) {
        if (sortedJson(existing.schema) !== sortedJson(schema) || existing.description !== description)
          throw new Refused(409, 'schema_immutable', `${id} is already registered with a different definition. Register a new version instead.`)
        return { schema: existing, created: false }
      }
      const row: SchemaRow = { id, name, version, ...(description !== undefined ? { description } : {}), schema, builtIn: false, createdAt: now(), createdBy: actor }
      kept.set(id, row)
      return { schema: row, created: true }
    },
  }
}

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
 * or an app may read, post, react, and label, and a project sync, everywhere, none with an expiry. `me` says otherwise
 * of some credentials, by the bearer it's sent (`user:u_jb`). A board's `/me` says the same, within what the board's grants give.
 * `me: false` says neither, as Vercel's API answered before it sent them.
 */
export function fakeMessageboard(
  options: {
    teamId?: string
    slug?: string
    boardId?: string | null
    /** False for an API from before it answered actors by their IDs: `GET /actors?id=` is 400. */
    actorsById?: boolean
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
    /** True for an API that lists threads with their first and newest messages (`include=messages`). Vercel's doesn't yet: `include` is 400 there. */
    inlineThreadMessages?: boolean
    /** Credentials the API takes, by their bearer, whatever it looks like: the principal each is, as `as()` names it. */
    tokens?: Record<string, string>
    /** An import's author is the platform user alone (`principal: { type: 'external' }`), as Vercel's API named them before platform profiles. */
    externalImports?: boolean
    /** An import's handle is the platform user's own (`Malte Ubl`), as Vercel's API named them before it put them under their project's name. */
    platformHandles?: boolean
    /**
     * A sync key is one registrant's on the whole board, as Vercel's API kept them before each project had its own: a
     * second registrant's is 409 `sync_key_taken`, a registration names no `elsewhere`, and nothing names a binding's project.
     */
    boardWideKeys?: boolean
    /** A deployment's handle is `project:prj_pong:production`, as Vercel's API named one before it named it by its project (`pong`). */
    projectIdHandles?: boolean
    /**
     * Who writes is read as board's protocol has it, as Vercel's API will once it conforms: the profile and its avatar
     * in one structured `x-board-profile` (`fixer;avatar="https://…"`), and `x-board-avatar` and `x-board-session`
     * ignored, as released clients still send them. Without it, as the API reads them today: the name alone in `x-board-profile`, the avatar in
     * `x-board-avatar`, and a session it keeps on the actor.
     */
    protocolProfile?: boolean
    /**
     * Sync's records aren't kept apart, as board can't take for granted of an API it doesn't run: a thread's binding goes
     * to every registrant that syncs its key, another project's included, and `syncThread` lists every target of a thread.
     */
    unscopedSync?: boolean
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
  const directory = { members: { ...(options.members ?? MEMBERS) }, roles, projects: options.projects ?? PROJECTS, repositories: options.repositories ?? REPOSITORIES, apps: APPS }
  const shared: Shared = {
    teamId,
    accounts,
    directory,
    now,
    stored,
    inlineThreadMessages: options.inlineThreadMessages ?? false,
    externalImports: options.externalImports ?? false,
    actorsById: options.actorsById ?? true,
    platformHandles: options.platformHandles ?? false,
    boardWideKeys: options.boardWideKeys ?? false,
    projectIdHandles: options.projectIdHandles ?? false,
    unscopedSync: options.unscopedSync ?? false,
  }

  const schemas = fakeSchemas({ now, roles })

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
    const actor = actorOf(request, options.tokens, options.protocolProfile ?? false)
    const path = url.pathname.replace(/^\/v1\/messageboard/, '')
    const method = request.method
    requests.push(`${method} ${path}`)
    // Completing an upload takes no body.
    const body = method === 'GET' || /\/attachments\/[^/]+\/complete$/.test(path) ? {} : ((await request.json()) as Record<string, any>)
    // Registering and acking watchers, and completing uploads, take no operation ID: each is idempotent as it is.
    // Sync's routes take none either, but imports.
    if (method !== 'GET' && !/\/watchers(\/|$)|\/complete$|\/sync\/(?!imports$)/.test(path) && typeof body.operationId !== 'string') throw new Refused(400, 'invalid_operation_id')
    const me = () => {
      if (options.me === false) return { teamId, actor, view: viewOf(shared, actor) }
      const role = actor.principal.type === 'user' ? (roles[actor.principal.userId] ?? 'member') : null
      // A deployment's own credential may sync too, which no team role says: where, its grants do.
      const can = role === null ? ['read', 'post', 'react', 'label', ...(actor.principal.type === 'project' ? ['sync'] : [])] : role === 'viewer' ? ['read', 'react'] : ALL
      const says = options.me?.[bearer] ?? { can: { '*': can }, expiresAt: null }
      return { teamId, actor, view: viewOf(shared, actor), can: says.can, expiresAt: says.expiresAt }
    }
    if (method === 'GET' && path === '/me') return me()
    if (method === 'GET' && path === '/boards') {
      // `name` matches whatever its case, among the boards the caller may use, in one answer.
      const name = url.searchParams.get('name')
      if (name !== null && !BOARD_NAME.test(name)) throw new Refused(400, 'bad_request', 'A board name is 1 to 64 characters with no /.')
      if (name !== null && url.searchParams.has('cursor')) throw new Refused(400, 'invalid_request', 'A name lookup takes no cursor.')
      const listed = boards().filter((board) => mayUse(actor, board) && (name === null || board.name.toLowerCase() === name.toLowerCase()))
      return { boards: listed.map(show), defaultBoardId: made && mayUse(actor, general) ? general.id : null, cursor: null }
    }
    // The team's boards are its principal's to change, not a caller narrowed to some channels.
    if (actor.narrowed && method === 'POST' && (path === '/boards/default' || path === '/boards/ensure')) throw new Refused(403, 'forbidden', "A caller narrowed with x-board-can can't change the team's boards: that's its principal's job.")
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
    const registry = schemas.route(method, path, body, actor)
    if (registry !== undefined) return registry
    const onBoard = /^\/boards\/([^/]+)(\/.*)?$/.exec(path)
    const board = onBoard ? boards().find((candidate) => candidate.id === decodeURIComponent(onBoard[1]!)) : undefined
    if (!onBoard || !board || !mayUse(actor, board)) throw new Refused(404, 'board_not_found')
    const rest = onBoard[2] ?? ''
    // A narrowed caller is never its principal's integration: a narrowed register would replace its registration.
    if (actor.narrowed && /^\/(watchers|sync|inbox)(\/|$)/.test(rest)) throw new Refused(403, 'forbidden', "A caller narrowed with x-board-can can't use its principal's watchers or sync's records.")
    if (method === 'GET' && rest === '') {
      // The board itself is read by a caller who reads somewhere on it.
      if (actor.can && !Object.values(actor.can).some((grant) => grant === 'all' || grant.includes('read'))) throw new Refused(403, 'forbidden', 'This caller may not read on this board.')
      return { board: show(board) }
    }
    // The team's schemas, through a board: whoever it lets in reads them.
    if (method === 'GET' && (rest === '/schemas' || rest.startsWith('/schemas/'))) return schemas.read(rest)
    // A board's own me: what the team's says, within what this board's grants give the caller.
    if (method === 'GET' && rest === '/me') {
      const said = me()
      return 'can' in said && said.can ? { ...said, can: board.data.within(actor, said.can) } : said
    }
    return board.data.route(method, rest, url, body, actor)
  }

  const { registrations, schedules, send } = general.data
  return {
    /** Every request it answered, as `METHOD /path`. */
    requests,
    /** The default board's grants, by ID, as the API keeps them. */
    grants: general.data.grants,
    /** Every schema version the team registered, by ID, as the API keeps them. */
    schemas: schemas.kept,
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
