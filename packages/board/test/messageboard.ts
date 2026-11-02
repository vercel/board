// An in-memory `/v1/messageboard`, as Vercel's API behaves: what
// `vercel()` from `@vercel/board/backend-vercel` is tested against. A bearer token names its principal:
// `user:u_jb`, `app:oac_1`, or `project:prj_pong:production`.
import { randomUUID } from 'node:crypto'

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
type Actor = { id: string; principal: Principal; profile?: { name: string; avatar?: string }; session?: string }
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
type ActorView = { id: string; kind: 'person' | 'agent' | 'deployment' | 'app'; handle: string; name?: string; lastSeenAt: number }

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

export function fakeMessageboard(options: { teamId?: string; slug?: string; boardId?: string | null; accounts?: Record<string, { username: string; name: string }> } = {}) {
  const accounts = options.accounts ?? ACCOUNTS
  const teamId = options.teamId ?? 'team_test'
  const slug = options.slug ?? 'test'
  let boardId = options.boardId === undefined ? 'brd_test' : options.boardId
  const channels: { id: string; name: string }[] = [{ id: 'general', name: 'general' }]
  const threads = new Map<string, Thread>()
  const posts = new Map<string, string>()
  const feeds = new Map<string, Change[]>()
  const actors = new Map<string, ActorView>()
  const requests: string[] = []
  const attachments = new Map<string, Attachment>()
  /** The bucket: bytes by attachment ID, as presigned PUTs leave them. */
  const stored = new Map<string, Uint8Array<ArrayBuffer>>()
  const STORAGE = 'http://storage.test/'
  type Filter = { channelIds?: string[]; channelTree?: string; threadId?: string; authors?: string[]; text?: string; labels?: { key: string; values?: string[] }[] }
  type Registration = { owner: string; url: string | null; path?: string; branch?: string; watch: Record<string, { filter: Filter; when: 'matches' | 'enters' }>; hash: string }
  type Match = { id: string; watcher: string; threadId: string; change: Change; lease?: string; leaseUntil?: number; attempts: number }
  /** By principal, as the API keeps them: one each. */
  const registrations = new Map<string, Registration>()
  const queued = new Map<string, Match[]>()
  let clock = 0
  const now = () => (clock = Math.max(Date.now(), clock + 1))

  const principalId = (p: Principal) => (p.type === 'user' ? `vercel:user:${p.userId}` : p.type === 'app' ? `vercel:app:${p.clientId}` : `vercel:project:${p.projectId}:${p.environment}`)
  const samePrincipal = (a: Principal, b: Principal) => principalId(a) === principalId(b)

  function actorOf(request: Request): Actor {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const [type, id, environment] = token.split(':')
    const principal: Principal | null =
      type === 'user' && id ? { type, userId: id } : type === 'app' && id ? { type, clientId: id } : type === 'project' && id && environment ? { type, projectId: id, environment } : null
    if (!principal) throw new Refused(401, 'unauthorized')
    const name = request.headers.get('x-board-profile') ?? undefined
    const avatar = request.headers.get('x-board-avatar') ?? undefined
    const session = request.headers.get('x-board-session') ?? undefined
    const base = principalId(principal)
    return {
      id: name ? `${base}+${name.toLowerCase()}` : base,
      principal,
      ...(name ? { profile: { name, ...(avatar ? { avatar } : {}) } } : {}),
      ...(session ? { session } : {}),
    }
  }

  /** An actor as the API names them (`viewFor` in api-messageboard): a person by their account. */
  function viewOf(actor: Actor): Omit<ActorView, 'lastSeenAt'> {
    const p = actor.principal
    const account = p.type === 'user' ? accounts[p.userId] : undefined
    const base = p.type === 'user' ? (account?.username ?? p.userId) : p.type === 'app' ? p.clientId : `project:${p.projectId}:${p.environment}`
    if (actor.profile) return { id: actor.id, kind: 'agent', handle: `${base}/${actor.profile.name.toLowerCase()}`, name: actor.profile.name }
    if (p.type === 'user') return { id: actor.id, kind: 'person', handle: base, ...(account ? { name: account.name } : {}) }
    return { id: actor.id, kind: p.type === 'app' ? 'app' : 'deployment', handle: base }
  }
  const seen = (actor: Actor) => actors.set(actor.id, { ...viewOf(actor), lastSeenAt: now() })

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
    if (!message || !String(change.type).startsWith('message.')) return
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
      for (const [watcher, spec] of Object.entries(registration.watch)) {
        if ((change.actor as Actor).id === `${registration.owner}+${watcher.toLowerCase()}` || !sees(spec.filter)) continue
        const lane = queued.get(registration.owner) ?? []
        queued.set(registration.owner, lane)
        lane.push({ id: `mat_${randomUUID()}`, watcher, threadId: message.threadId, change, attempts: 0 })
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

  function post(actor: Actor, thread: Thread, body: { text: string; replyTo?: number; clientId?: string; labels?: Record<string, string>; attachments?: string[] }) {
    const files = (body.attachments ?? []).map((id) => {
      const attachment = attachments.get(id)
      if (!attachment || !samePrincipal(attachment.createdBy.principal, actor.principal)) throw new Refused(404, 'attachment_not_found')
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
      feedSequence: 0,
      ...(files.length ? { attachments: files.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
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
    const view = (r: Registration) => ({ owner: r.owner, url: r.url, ...(r.path ? { path: r.path, ...(r.branch ? { branch: r.branch } : {}) } : {}), watch: r.watch, hash: r.hash })
    if (method === 'GET' && rest === '/watchers') {
      const found = registrations.get(owner)
      return { watchers: found ? [view(found)] : [] }
    }
    if (method === 'PUT' && rest === '/watchers') {
      const body = parsed as { url?: string | null; path?: string; branch?: string; watch: Registration['watch']; tag?: string }
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
      const made: Registration = { owner, ...where, watch: body.watch, hash: body.tag ?? randomUUID().replaceAll('-', '') }
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

  async function route(request: Request): Promise<unknown> {
    const url = new URL(request.url)
    if (url.searchParams.get('teamId') && url.searchParams.get('teamId') !== teamId) throw new Refused(403, 'forbidden')
    if (url.searchParams.get('slug') && url.searchParams.get('slug') !== slug) throw new Refused(403, 'forbidden')
    const actor = actorOf(request)
    const path = url.pathname.replace(/^\/v1\/messageboard/, '')
    const method = request.method
    requests.push(`${method} ${path}`)
    // Completing an upload takes no body.
    const body = method === 'GET' || /\/attachments\/[^/]+\/complete$/.test(path) ? {} : ((await request.json()) as Record<string, any>)
    // Registering and acking watchers, and completing uploads, take no operation ID: each is idempotent as it is.
    if (method !== 'GET' && !/\/watchers(\/|$)|\/complete$/.test(path) && typeof body.operationId !== 'string') throw new Refused(400, 'invalid_operation_id')
    if (method === 'GET' && path === '/me') return { teamId, actor, view: viewOf(actor) }
    if (method === 'GET' && path === '/boards') return { boards: boardId ? [{ id: boardId, teamId, name: 'General', visibility: 'team' }] : [], defaultBoardId: boardId, cursor: null }
    if (method === 'POST' && path === '/boards/default') {
      // Board creates record a person's event, so project tokens can't.
      if (actor.principal.type === 'project') throw new Refused(403, 'forbidden')
      boardId ??= 'brd_default'
      return { board: { id: boardId, teamId, name: 'General', visibility: 'team' } }
    }
    const onBoard = /^\/boards\/([^/]+)(\/.*)?$/.exec(path)
    if (!onBoard || onBoard[1] !== boardId) throw new Refused(404, 'board_not_found')
    const rest = onBoard[2] ?? ''
    let found: RegExpExecArray | null

    if (method === 'GET' && rest === '') return { board: { id: boardId, teamId, name: 'General', visibility: 'team' } }

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
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: actor, messages: [] }
      threads.set(thread.id, thread)
      const message = post(actor, thread, body as { text: string; clientId?: string; labels?: Record<string, string>; attachments?: string[] })
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
    if (method === 'POST' && rest === '/attachments') {
      const attachment: Attachment = { id: `att_${randomUUID()}`, boardId: boardId!, name: body.name, type: body.type, size: body.size, sha256: body.sha256, state: 'pending', createdAt: now(), createdBy: actor }
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
      return { thread: showThread(thread), message: show(post(actor, thread, body as { text: string; replyTo?: number; clientId?: string; attachments?: string[] })) }
    }
    if ((found = /^\/threads\/([^/]+)\/messages\/(\d+)(\/delete|\/reactions|\/labels)?$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      const message = messageAt(thread.id, Number(found[2]))
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      const action = found[3] ?? ''
      if (method === 'PATCH' && action === '') {
        if (!samePrincipal(message.createdBy.principal, actor.principal)) throw new Refused(403, 'message_not_owned')
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        if (message.text !== body.text) {
          Object.assign(message, { text: body.text, editedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision }, actor)
        }
        return { message: show(message) }
      }
      if (method === 'POST' && action === '/delete') {
        if (!samePrincipal(message.createdBy.principal, actor.principal)) throw new Refused(403, 'message_not_owned')
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
    throw new Refused(404, 'not_found', `${method} ${path}`)
  }

  return {
    /** Every request it answered, as `METHOD /path`. */
    requests,
    /** The watchers each principal registered, as the API keeps them. */
    registrations,
    /** The attachments bucket, as presigned URLs reach it: a PUT stores bytes, a GET reads them. */
    files: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const id = request.url.slice(STORAGE.length)
      if (request.headers.has('authorization')) return new Response('credentials never go to storage', { status: 400 })
      if (request.method === 'PUT') {
        if (stored.has(id)) return new Response(null, { status: 412 })
        stored.set(id, new Uint8Array(await request.arrayBuffer()))
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
        if (error instanceof Refused) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
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
