import type { Method, Protocol } from '../api/protocol.ts'
import { RegisterBody, type ActorView, type BoardEventView, type ChannelView, type Discovery, type Me, type MessageView, type RegistrationView, type ScheduleView, type ThreadSummaryView } from '../api/routes.ts'
import { duration, type ProfileOption } from '../client/client.ts'
import { derivedId, sha256 } from '../client/ids.ts'
import { IMPORT_BYTES_MAX, RemoteWatcherId, type Attachment, type Author, type Labels } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import type { Access, Permission } from './access.ts'
import { type Backend, type BoardBinding, type Caller, type Identity, type ProtocolMethods } from './backend.ts'
import { callerProfile, PROJECTS_OWN } from './backend-http.ts'
import { fileName, mediaType } from './blob.ts'
import { badRequest, forbidden, HttpError, json, notFound } from './errors.ts'
import { registrant, wakePath, type WakeAt } from './registrant.ts'
import { METHODS } from './routing.ts'
import { compileWatcher } from './watch-spec.ts'
import { canonicalWatchers, type WatcherSpec } from './watchers-hash.ts'

// The `/v1/messageboard` API's shapes, as this backend reads them. `@api/messageboard-types` is
// private to Vercel's monorepo, so these are written out: conformance catches drift.
type ApiPrincipal =
  | { type: 'user'; userId: string; clientId?: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
type ApiActor = { id: string; principal: ApiPrincipal; profile?: { name: string; avatar?: string }; session?: string }
type ApiChannel = { id: string; name: string }
type ApiThread = {
  id: string
  channelId: string
  messageCount: number
  lastActivityAt: number
  lastMessage?: { id: string; sequence: number; createdAt: number; createdBy: ApiActor }
  createdAt: number
  createdBy: ApiActor
  labels?: Labels
}
type ApiMessage = {
  id: string
  threadId: string
  sequence: number
  replyTo?: number
  text: string
  version: number
  /** Counts its edits and its delete, as an edit's or a delete's `revision` checks. */
  revision: number
  createdAt: number
  createdBy: ApiActor
  editedAt?: number
  deletedAt?: number
  reactions?: Record<string, number>
  /** Up to 20 actor IDs an emoji, earliest first. */
  reactors?: Record<string, string[]>
  labels?: Labels
  attachments?: Attachment[]
  /** Set when a schedule posted it: which schedule, and which of its sends, from 0. */
  schedule?: { id: string; n: number }
}
/** A message posted later as its creator, in `channelId` or as a reply in `threadId`. Times are milliseconds. */
type ApiSchedule = {
  id: string
  channelId: string
  threadId?: string
  text: string
  labels?: Labels
  firstAt: number
  every?: number
  until?: number
  times?: number
  sent: number
  nextAt: number | null
  lastMessageId?: string
  state: 'pending' | 'done' | 'canceled'
  canceled?: { by?: ApiActor; at: number; reason: 'canceled' | 'revoked' | 'disabled' }
  createdAt: number
  createdBy: ApiActor
}
/** A file on the board: `messageId` once a post carries it. */
type ApiAttachment = Attachment & { boardId: string; sha256: string; state: 'pending' | 'ready'; messageId?: string }
type ApiActorView = { id: string; kind: 'person' | 'agent' | 'deployment' | 'app'; handle: string; name?: string; avatar?: string }
type ApiChange = {
  type: string
  channelId: string
  actor: ApiActor
  createdAt: number
  threadId?: string
  messageId?: string
  emoji?: string
  labels?: Record<string, { from?: string; to?: string }>
  /** Where the channel's feed goes on from, right after this change. */
  cursor?: string
  /** With `include=message`, the message as it is now. */
  currentMessage?: ApiMessage
}
type ApiMe = { teamId: string; actor: ApiActor; view?: ApiActorView; project?: { id: string; environment: string } }
/** Which messages a watcher sees, in the API's terms: a tail is translated into one. */
type ApiWatcherFilter = {
  channelIds?: string[]
  channelTree?: string
  threadId?: string
  authors?: string[]
  text?: string
  labels?: { key: string; values?: string[] }[]
}
type ApiWatcherSpec = { filter: ApiWatcherFilter; when: 'matches' | 'enters' }
type ApiRegistration = { owner: string; url: string | null; path?: string; branch?: string; watch: Record<string, ApiWatcherSpec>; hash: string }
type ApiMatch = { id: string; watcher: string; threadId: string; lease: string; attempt: number; event: ApiChange & { messageId: string } }

export type VercelOptions = {
  /** The team whose board it is: its ID (`team_…`) or its slug. In Node, by default your deployment's, or `VERCEL_ORG_ID`. */
  team?: string
  /** The board's ID. By default the team's board, which `GET /boards` names. */
  board?: string
  /** Vercel's API, `https://api.vercel.com` by default. */
  api?: string
  /**
   * How requests reach the API, with credentials it takes. In Node it defaults to `VERCEL_TOKEN`,
   * a deployment's OIDC token, or your `vercel login`. Elsewhere, pass one that sends them.
   */
  fetch?: typeof fetch
  /** How files reach Vercel's storage, on URLs the API signs: `fetch` by default, never with credentials. */
  files?: typeof fetch
}

/** What finds the API's credentials and the team, in the Node build. A browser has none. */
export type VercelEnvironment = {
  /** A fetch that adds the credentials. */
  fetch(): typeof fetch
  /** The team, when the environment says which. */
  team(): Promise<string | null>
  /** The profile the environment picks (`BOARD_AS`, or the coding agent it runs in), and that agent's session. */
  profile(): { profile: ProfileOption; session: string | null }
}

/** Who a request to the API is from, beside its credentials: a label it shows, never who it is. */
type Who = { profile: { name: string; avatar?: string } | null; session: string | null }

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const MESSAGE_ID = /^msg_([0-9a-f-]{36})_([1-9]\d*)$/
/** Whether `value` is a message ID Vercel's API hands out (`msg_<thread>_<n>`): the CLI takes one as a message, even where a channel has its name. */
export const isApiMessageId = (value: string) => MESSAGE_ID.test(value)
/** A cursor this backend made: a time, then the position it names, in base 36. */
const CURSOR = /^([0-9a-z]+)(?:\.([0-9a-z]+))?$/
/** The API's own cursor for one channel, which its message list and feed share, and any process resumes. */
const API_CURSOR = /^c1\./
/** The API's longest page of a channel's messages, and longest long-poll, in seconds. */
const PAGE_MAX = 100
const WAIT_MAX_S = 25
/** Pages a filtered read of one channel scans for matches before it answers with what it found. */
const SCAN_PAGES = 10

/** A file as the board names it. */
const fileOf = ({ id, name, type, size }: Attachment): Attachment => ({ id, name, type, size })

const notSupported = (what: string) => new HttpError(501, 'not_supported', `Vercel's boards don't support ${what} yet`)

/** What a caller board() verified may do. Null for this deployment's own code, which may do what its credentials may. */
const accessOf = (caller: Caller): Access | null => ('identity' in caller ? caller.identity.principal.access : null)

/** A verified caller's grant, which the API can't check: it sees this deployment's credentials. */
function need(access: Access | null, permission: Permission, channel: string): void {
  if (access && !access.can(permission, channel)) throw forbidden(`this token can't ${permission} in ${channel}`)
}

const apiKind = (kind: ApiActorView['kind']): ActorView['kind'] => (kind === 'app' ? 'workflow' : kind)

/** A UUIDv7, which the API takes as an operation ID. */
function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const now = BigInt(Date.now())
  for (let i = 0; i < 6; i++) bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const iso = (ms: number) => new Date(ms).toISOString()
const idAt = (threadId: string, sequence: number) => `msg_${threadId.slice('thr_'.length)}_${sequence}`

/** Where a message ID points: its thread and its place in it. Null for one that isn't a message's. */
function locate(id: string): { threadId: string; sequence: number } | null {
  const found = MESSAGE_ID.exec(id)
  return found ? { threadId: `thr_${found[1]}`, sequence: Number(found[2]) } : null
}

/** A principal as board names it: `vercel:user:<id>`, `vercel:app:<id>`, `vercel:project:<id>:<env>`. */
function principalId(principal: ApiPrincipal): string {
  if (principal.type === 'user') return `vercel:user:${principal.userId}`
  if (principal.type === 'app') return `vercel:app:${principal.clientId}`
  return `vercel:project:${principal.projectId}:${principal.environment}`
}

const authorOf = (actor: ApiActor): Author => ({
  actor: actor.id,
  principal: principalId(actor.principal),
  profile: actor.profile?.name ?? null,
  session: actor.session ?? null,
})

/** Who cancels a schedule when no one did: the API, once its creator can no longer post it, as a2()'s scheduler. */
const SCHEDULER: Author = { actor: 'board:schedule', principal: 'board:schedule', profile: null, session: null }

/** The API names nobody, so an actor's handle is its profile, or a short form of its principal. */
function actorView(actor: ApiActor): ActorView & { id: string } {
  const { principal } = actor
  const base =
    principal.type === 'user'
      ? `user-${principal.userId.slice(0, 6).toLowerCase()}`
      : principal.type === 'app'
        ? `app-${principal.clientId.slice(0, 6).toLowerCase()}`
        : principal.environment === 'production'
          ? principal.projectId
          : `${principal.projectId}@${principal.environment}`
  const handle = actor.profile?.name ?? base
  const kind = actor.profile ? 'agent' : principal.type === 'user' ? 'person' : principal.type === 'project' ? 'deployment' : 'workflow'
  return { id: actor.id, kind, handle, name: handle, avatar: actor.profile?.avatar ?? null }
}

type Filters = Protocol['messages']['input']

/**
 * Vercel's board for your team, in Vercel's API: this deployment keeps nothing and reads and writes
 * it as itself, its people as themselves. Messages, threads, reactions, labels, a channel's
 * changes, schedules, files, and watchers work; what the API keeps none of yet (sync) answers 501.
 */
export function createVercel(options: VercelOptions, environment: VercelEnvironment | null) {
  const origin = (options.api ?? 'https://api.vercel.com').replace(/\/+$/, '')
  if (!/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error(`vercel: ${origin} isn't Vercel's API: pass an https origin`)
  if (!options.fetch && !environment) throw new Error("vercel: pass a fetch that sends credentials: outside Node there's no environment to find them in")
  const doFetch: typeof fetch = options.fetch ?? environment!.fetch()
  const filesFetch: typeof fetch = options.files ?? fetch
  let binding: BoardBinding | null = null
  /** This board's own code's names, which a caller here never takes as its profile. */
  const own = new Set<string>()

  let team: Promise<string | null> | null = null
  const teamId = () => (team ??= options.team ? Promise.resolve(options.team) : (environment?.team() ?? Promise.resolve(null)))

  /** One request to the API, as `who`. Its errors are the API's own, with its status and code. */
  async function api<T>(who: Who, method: string, path: string, init: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(`${origin}/v1/messageboard${path}`)
    const id = await teamId()
    // A team's ID, or its slug, as Vercel's API takes either.
    if (id) url.searchParams.set(id.startsWith('team_') ? 'teamId' : 'slug', id)
    for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, value)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (who.profile) headers['x-board-profile'] = who.profile.name
    if (who.profile?.avatar?.startsWith('https://')) headers['x-board-avatar'] = who.profile.avatar
    if (who.session && SESSION.test(who.session)) headers['x-board-session'] = who.session
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers,
        redirect: 'error',
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      })
    } catch (error) {
      if (error instanceof HttpError || (error instanceof Error && error.name === 'AbortError')) throw error
      throw new HttpError(502, 'unreachable', `Vercel's API didn't answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {}
    if (response.ok) return body as T
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new HttpError(response.status, error?.code ?? 'remote_error', error?.message ?? `Vercel's API answered ${response.status}`)
  }

  /** Every page of a list, in order. */
  async function all<T>(who: Who, path: string, key: string, query: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    do {
      const page = await api<Record<string, unknown> & { cursor: string | null }>(who, 'GET', path, { query: { ...query, cursor }, ...(signal ? { signal } : {}) })
      out.push(...(page[key] as T[]))
      cursor = page.cursor ?? undefined
    } while (cursor)
    return out
  }

  let board: Promise<string> | null = null
  /**
   * The board's ID: the one given, or the team's, which the API names only to those it lets in. A
   * team with none gets one the first time a person uses it, as the API asks of its clients; a
   * project can't make it, and needs a person to grant it the board anyway.
   */
  const boardId = (who: Who) =>
    (board ??= options.board
      ? Promise.resolve(options.board)
      : api<{ defaultBoardId: string | null }>(who, 'GET', '/boards').then(async ({ defaultBoardId }) => {
          if (defaultBoardId) return defaultBoardId
          if ((await self(who)).actor.principal.type === 'project')
            throw new HttpError(404, 'no_board', "Vercel's API names no board this project may use: ask someone on the team to grant it the team's board, or pass `board`")
          const { board: made } = await api<{ board: { id: string } }>(who, 'POST', '/boards/default', { body: { operationId: operationId() } })
          return made.id
        })).catch((error: unknown) => {
      board = null
      throw error
    })
  const onBoard = async (who: Who, path = '') => `/boards/${encodeURIComponent(await boardId(who))}${path}`

  // Channels are named on the board and addressed by ID in the API.
  let channels: Promise<ApiChannel[]> | null = null
  const loadChannels = async (who: Who, fresh = false): Promise<ApiChannel[]> => {
    if (fresh) channels = null
    channels ??= onBoard(who, '/channels').then((path) => all<ApiChannel>(who, path, 'channels'))
    return channels.catch((error: unknown) => {
      channels = null
      throw error
    })
  }
  /** The channel by `name`, which the API finds without listing the board's. */
  const named = new Map<string, ApiChannel>()
  async function channelNamed(who: Who, name: string): Promise<ApiChannel | null> {
    const known = named.get(name)
    if (known) return known
    const { channels: [found] } = await api<{ channels: ApiChannel[] }>(who, 'GET', await onBoard(who, '/channels'), { query: { name } })
    if (found) named.set(name, found)
    return found ?? null
  }
  async function channelById(who: Who, id: string): Promise<ApiChannel> {
    const found = (await loadChannels(who)).find((channel) => channel.id === id) ?? (await loadChannels(who, true)).find((channel) => channel.id === id)
    if (!found) throw new HttpError(502, 'remote_error', `Vercel's API names a channel it doesn't list: ${id}`)
    return found
  }
  /** The channel by `name`, made if it isn't there: `created` says whether this made it. */
  async function ensureChannel(who: Who, name: string): Promise<{ channel: ApiChannel; created: boolean }> {
    const found = await channelNamed(who, name)
    if (found) return { channel: found, created: false }
    try {
      const { channel } = await api<{ channel: ApiChannel }>(who, 'POST', await onBoard(who, '/channels'), { body: { operationId: operationId(), name } })
      channels = null
      named.set(name, channel)
      return { channel, created: true }
    } catch (error) {
      // Someone made it first.
      if (error instanceof HttpError && error.code === 'channel_name_taken') {
        const made = await channelNamed(who, name)
        if (made) return { channel: made, created: false }
      }
      throw error
    }
  }
  /** A channel to post in, made the first time something posts to it, as on any board. */
  const channelToPost = async (who: Who, name: string): Promise<ApiChannel> => (await ensureChannel(who, name)).channel
  /** The channels a filter names that `access` reads: one, a channel and those under it (`dev/`), or every one. */
  async function channelsFor(who: Who, filter: string | undefined, access: Access | null): Promise<ApiChannel[]> {
    const readable = (channel: ApiChannel) => access === null || access.readable(channel.name)
    if (filter !== undefined && !filter.endsWith('/')) {
      const found = await channelNamed(who, filter)
      return found && readable(found) ? [found] : []
    }
    const listed = (await loadChannels(who, true)).filter(readable)
    if (filter === undefined) return listed
    const path = filter.slice(0, -1)
    return listed.filter((channel) => channel.name === path || channel.name.startsWith(filter))
  }

  async function messageById(who: Who, id: string, signal?: AbortSignal): Promise<{ thread: ApiThread; message: ApiMessage }> {
    if (!locate(id)) throw notFound(`message not found: ${id}`, 'message_not_found')
    try {
      return await api(who, 'GET', await onBoard(who, `/messages/${encodeURIComponent(id)}`), signal ? { signal } : {})
    } catch (error) {
      if (error instanceof HttpError && error.code === 'thread_not_found') throw notFound(`message not found: ${id}`, 'message_not_found')
      throw error
    }
  }
  /** A message `access` may read, and its channel: one it can't is as missing as one that isn't there. */
  async function readableMessage(who: Who, access: Access | null, id: string, signal?: AbortSignal) {
    const found = await messageById(who, id, signal)
    const channel = await channelById(who, found.thread.channelId)
    if (access && !access.readable(channel.name)) throw notFound(`message not found: ${id}`, 'message_not_found')
    return { ...found, channel }
  }

  /**
   * Each thread a read needs, read once, with the labels its messages match on: a label matches on
   * its root's, which the API keeps on the thread. It reads the root, which names its thread, so it
   * knows when the root is deleted.
   */
  function threadReader(who: Who, signal?: AbortSignal) {
    const read = new Map<string, Promise<ApiThread>>()
    return (id: string) => {
      let thread = read.get(id)
      if (!thread) read.set(id, (thread = messageById(who, idAt(id, 1), signal).then(({ thread, message }) => labeledBy(thread, message))))
      return thread
    }
  }
  /** A thread as its root's labels find it: the API keeps a deleted root's labels on its thread, and a deleted message has none. */
  const labeledBy = (thread: ApiThread, root: ApiMessage | undefined): ApiThread => {
    if (root?.deletedAt === undefined) return thread
    const { labels: _kept, ...rest } = thread
    return rest
  }
  /** A message's labels: a deleted message keeps none, though the API still holds them. */
  const labelsOf = (message: ApiMessage): Labels => (message.deletedAt === undefined ? { ...message.labels } : {})

  const threadMessages = async (who: Who, threadId: string, signal?: AbortSignal) =>
    all<ApiMessage>(who, await onBoard(who, `/threads/${encodeURIComponent(threadId)}/messages`), 'messages', {}, signal)

  /** Who reacted with each emoji. The API counts them on the message and lists them apart. */
  async function reactors(who: Who, message: ApiMessage): Promise<Record<string, string[]>> {
    if (!message.reactions || Object.keys(message.reactions).length === 0) return {}
    // The message names up to 20 reactors an emoji: only past that are they listed apart.
    const named = message.reactors ?? {}
    if (Object.entries(message.reactions).every(([emoji, count]) => (named[emoji]?.length ?? 0) >= count))
      return Object.fromEntries(Object.entries(named).map(([emoji, actors]) => [emoji, [...actors]]))
    const path = await onBoard(who, `/threads/${encodeURIComponent(message.threadId)}/messages/${message.sequence}/reactions`)
    const out: Record<string, string[]> = {}
    for (const reaction of await all<{ emoji: string; actor: ApiActor }>(who, path, 'reactions')) (out[reaction.emoji] ??= []).push(reaction.actor.id)
    return out
  }

  /** Who's written here, by actor ID, as the API names them: messages carry only the actor. */
  let actorNames: { at: number; views: Promise<Map<string, ApiActorView>> } | null = null
  /** How long names are kept before they're read again: someone renamed shows by their new name after this. */
  const NAMES_FRESH_MS = 5 * 60_000
  /** Actors a list read again for them didn't have: it isn't read again for them. */
  const unlisted = new Set<string>()
  /** Reads the list, kept as the current one; a read that fails isn't kept, so the next name tries again. */
  const readNames = (who: Who) => {
    const views = (async () =>
      new Map((await all<ApiActorView>(who, await onBoard(who, '/actors'), 'actors')).map((view) => [view.id, view] as const)))()
    const read = { at: Date.now(), views }
    actorNames = read
    views.catch(() => {
      if (actorNames === read) actorNames = null
    })
    return read
  }
  /** The actor in a read of the list, or undefined when it doesn't have them or failed. */
  const inList = (read: { views: Promise<Map<string, ApiActorView>> }, id: string) => read.views.then((views) => views.get(id), () => undefined)

  /**
   * An actor as board shows them: a person by their Vercel username and name, and an agent acting
   * for a person by its profile under them, as the API names them; anyone else (a project, an app,
   * an agent of one), or someone the API doesn't list, by their principal. The list is read again
   * every few minutes, and at once for someone who wrote since it was.
   */
  async function nameOf(who: Who, actor: ApiActor): Promise<ActorView & { id: string }> {
    const current = !actorNames || Date.now() - actorNames.at > NAMES_FRESH_MS ? readNames(who) : actorNames
    let found = await inList(current, actor.id)
    if (!found && !unlisted.has(actor.id)) {
      // Someone new since this list: one read again covers everyone it's missing, even several at once.
      const again = actorNames && actorNames !== current ? actorNames : readNames(who)
      found = await inList(again, actor.id)
      // Only a read that worked and still doesn't have them settles it.
      if (!found && (await again.views.then(() => true, () => false))) unlisted.add(actor.id)
    }
    const kind = found && apiKind(found.kind)
    // The API names a project or an app by its ID, and an agent under one after it: board's names say more.
    if (!found || !(kind === 'person' || (kind === 'agent' && actor.principal.type === 'user'))) return actorView(actor)
    return { id: actor.id, kind, handle: found.handle, name: found.name ?? found.handle, avatar: found.avatar ?? null }
  }

  async function view(who: Who, message: ApiMessage, channel: string): Promise<MessageView> {
    const root = message.sequence === 1
    return {
      id: message.id,
      channel,
      text: message.text,
      re: root ? null : idAt(message.threadId, 1),
      replyTo: message.replyTo !== undefined && message.replyTo !== 1 ? idAt(message.threadId, message.replyTo) : null,
      thread: message.threadId,
      labels: labelsOf(message),
      reactions: message.deletedAt === undefined ? await reactors(who, message) : {},
      mentions: [],
      by: authorOf(message.createdBy),
      noSync: false,
      origin: null,
      from: null,
      createdAt: iso(message.createdAt),
      editedAt: message.editedAt === undefined ? null : iso(message.editedAt),
      deleted: message.deletedAt !== undefined,
      undelivered: {},
      attachments: message.attachments ?? [],
      links: [],
      version: message.version,
      revision: message.revision,
      author: await nameOf(who, message.createdBy),
      ...(message.schedule ? { schedule: { id: message.schedule.id, n: message.schedule.n } } : {}),
    }
  }

  async function scheduleView(who: Who, schedule: ApiSchedule): Promise<ScheduleView> {
    const { canceled } = schedule
    return {
      id: schedule.id,
      channel: (await channelById(who, schedule.channelId)).name,
      re: schedule.threadId === undefined ? null : idAt(schedule.threadId, 1),
      text: schedule.text,
      labels: { ...schedule.labels },
      noSync: false,
      attachments: [],
      first: iso(schedule.firstAt),
      every: schedule.every ?? null,
      until: schedule.until === undefined ? null : iso(schedule.until),
      times: schedule.times ?? null,
      sent: schedule.sent,
      next: schedule.nextAt === null ? null : iso(schedule.nextAt),
      last: schedule.lastMessageId ?? null,
      state: schedule.state,
      // The API stops a schedule whose team turned Messageboard off as one whose creator lost access: neither may post.
      canceled: canceled ? { by: canceled.by ? authorOf(canceled.by) : SCHEDULER, reason: canceled.reason === 'disabled' ? 'revoked' : canceled.reason } : null,
      by: authorOf(schedule.createdBy),
      author: await nameOf(who, schedule.createdBy),
      createdAt: iso(schedule.createdAt),
    }
  }

  // Cursors. A read's cursor says what it saw: the time of the newest message, and each channel's
  // feed cursor then, for `events` to go on from. The API's feed cursors are opaque and per
  // channel, more than fits in a cursor here, so a cursor names a position this process keeps,
  // after its time. Another process reads it as the time alone, from each channel's oldest change.
  type Feed = { at: string | null; skip: number }
  type Position = { t: number; feeds: Record<string, Feed> }
  const positions = new Map<string, Position>()
  function cursorOf(position: Position): string {
    const key = `${position.t.toString(36)}.${Math.floor(Math.random() * 36 ** 8).toString(36)}`
    positions.set(key, position)
    if (positions.size > 10_000) positions.delete(positions.keys().next().value!)
    return key
  }
  function positionOf(cursor: string): Position {
    const kept = positions.get(cursor)
    if (kept) return kept
    const found = CURSOR.exec(cursor)
    if (!found) throw new HttpError(400, 'invalid_cursor', `after: ${cursor} isn't a cursor here or a message's ID`)
    return { t: parseInt(found[1]!, 36), feeds: {} }
  }
  /** A time a read goes on from: a cursor's, or a message's own. */
  async function timeOf(who: Who, after: string): Promise<number> {
    return locate(after) ? (await messageById(who, after)).message.createdAt : positionOf(after).t
  }
  /** Each channel's feed now, taken before a read, so what's posted while it reads comes after. */
  async function heads(who: Who, listed: ApiChannel[]): Promise<Record<string, Feed>> {
    const path = await onBoard(who, '/changes')
    const found = await Promise.all(listed.map((channel) => api<{ cursor: string }>(who, 'GET', path, { query: { channelId: channel.id, from: 'latest' } })))
    return Object.fromEntries(listed.map((channel, i) => [channel.id, { at: found[i]!.cursor, skip: 0 }]))
  }

  /** Who a `--by` value covers, as the API's authors. */
  type By = (actor: ApiActor) => boolean

  /**
   * Who `--by` names: `me`, the actor itself; or an actor, a principal and its agents, a profile, or
   * a handle as the board shows it (`julian`, `julian/claude`), a person's covering their agents.
   */
  async function byOf(who: Who, by: string | undefined): Promise<By | undefined> {
    if (by === undefined) return undefined
    if (by === 'me') {
      const me = await actorOf(who)
      return (actor) => actor.id === me
    }
    const named = new Set([by])
    if (!by.startsWith('vercel:')) {
      const handle = by.toLowerCase()
      const find = async (read: { views: Promise<Map<string, ApiActorView>> }) =>
        [...(await read.views)].filter(([, view]) => view.handle.toLowerCase() === handle).map(([id]) => id)
      const kept = actorNames && Date.now() - actorNames.at <= NAMES_FRESH_MS ? actorNames : null
      let ids = await find(kept ?? readNames(who))
      // Someone new since the list was read: one read again finds them.
      if (ids.length === 0 && kept) ids = await find(readNames(who))
      for (const id of ids) named.add(id)
    }
    return (actor) => named.has(actor.id) || named.has(principalId(actor.principal)) || (actor.profile !== undefined && named.has(actor.profile.name))
  }

  /**
   * Whether a message matches a read's filters. A label matches on the message or its thread's root:
   * `thread`'s labels, as `labeledBy` gives them when the read filters on labels.
   */
  function matches(filters: Omit<Filters, 'channel'>, message: ApiMessage, thread: ApiThread, by: By | undefined): boolean {
    if (filters.re !== undefined && filters.re !== message.id && filters.re !== idAt(thread.id, 1)) return false
    if (by && !by(message.createdBy)) return false
    // Nothing here resolves mentions yet, so a mention filter matches nothing.
    if (filters.mentions !== undefined) return false
    // Nothing syncs here: every message was written on the board.
    if (filters.from !== undefined && filters.from !== 'board') return false
    if (filters.text !== undefined && !message.text.toLowerCase().includes(filters.text.toLowerCase())) return false
    for (const [key, values] of filters.label ?? []) {
      const on = (labels: Labels | undefined) => labels !== undefined && Object.hasOwn(labels, key) && (values === null || values.includes(labels[key]!))
      if (!on(labelsOf(message)) && !on(thread.labels)) return false
    }
    return true
  }

  /** The label the API's index can narrow a channel's threads by: a root's `key` or `key=value`. */
  function indexed(filters: Filters): string | undefined {
    const first = filters.label?.find(([, values]) => values === null || values.length === 1)
    return first && (first[1] === null ? first[0] : `${first[0]}=${first[1][0]}`)
  }

  async function threadsOf(who: Who, channel: ApiChannel, filters: Filters, signal?: AbortSignal): Promise<ApiThread[]> {
    const label = indexed(filters)
    return all<ApiThread>(who, await onBoard(who, '/threads'), 'threads', { channelId: channel.id, label }, signal)
  }

  /**
   * A channel's threads, as far as a read needs: the API lists them most recently active first, so
   * it stops at the first not active since `after`, or at the `limit` newest when it's given one
   * (not when the read filters what's listed). One it lists by a label comes oldest first, so it
   * reads every page.
   */
  async function latestThreads(who: Who, channel: ApiChannel, label: string | undefined, page: { after?: number; limit?: number }, signal: AbortSignal): Promise<ApiThread[]> {
    const path = await onBoard(who, '/threads')
    const out: ApiThread[] = []
    let cursor: string | undefined
    do {
      const found = await api<{ threads: ApiThread[]; cursor: string | null }>(who, 'GET', path, { query: { channelId: channel.id, label, cursor }, signal })
      out.push(...found.threads)
      cursor = found.cursor ?? undefined
      const last = out.at(-1)
      if (label === undefined && (page.after !== undefined ? last !== undefined && last.lastActivityAt <= page.after : page.limit !== undefined && out.length >= page.limit)) break
    } while (cursor)
    return out
  }

  /** A thread at a glance: its root, its reply count, and its latest reply, read by reference. */
  async function summary(who: Who, thread: ApiThread, channel: ApiChannel, signal: AbortSignal): Promise<ThreadSummaryView> {
    const [root, last] = await Promise.all([
      messageById(who, idAt(thread.id, 1), signal),
      thread.lastMessage && thread.lastMessage.sequence > 1 ? messageById(who, thread.lastMessage.id, signal) : null,
    ])
    return {
      message: await view(who, root.message, channel.name),
      // The API counts deleted messages too.
      replies: thread.messageCount - 1,
      last: last && (await view(who, last.message, channel.name)),
    }
  }

  let me: Promise<ApiMe> | null = null
  /** Who these credentials are, asked once. */
  const self = (who: Who) =>
    (me ??= api<ApiMe>(who, 'GET', '/me')).catch((error: unknown) => {
      me = null
      throw error
    })
  /** The actor `who` writes as: the credentials' principal, and its profile, as the API names it. */
  const actorOf = async (who: Who) => `${principalId((await self(who)).actor.principal)}${who.profile ? `+${who.profile.name.toLowerCase()}` : ''}`

  /** Who a caller acts as there: its profile and session, beside this deployment's credentials. */
  function whoOf(caller: Caller): Who {
    if ('identity' in caller) {
      const avatar = caller.identity.actor.avatar?.startsWith('https://') ? caller.identity.actor.avatar : undefined
      return { profile: { name: callerProfile(caller.identity.actor.handle, own), ...(avatar ? { avatar } : {}) }, session: null }
    }
    const named = (profile: ProfileOption): Who['profile'] => {
      if (profile === null) return null
      const name = typeof profile === 'string' ? profile : profile.name
      if (!PROFILE.test(name)) throw new HttpError(400, 'invalid_request', `as: ${name}: profiles start with a letter and use up to 32 letters, numbers, and hyphens`)
      return typeof profile === 'string' || !profile.avatar ? { name } : { name, avatar: profile.avatar }
    }
    if (caller.origin.via?.kind === 'client') {
      const asked = 'profile' in caller ? caller.profile : (caller.self ?? undefined)
      const found = environment?.profile() ?? { profile: null, session: null }
      if (asked === undefined) return { profile: named(found.profile), session: found.session }
      return { profile: named(asked), session: asked === null ? null : found.session }
    }
    return { profile: named(caller.self ?? 'client'), session: null }
  }

  /** A post's client ID, as the API takes one: its own when it fits, a hash of it when it doesn't. */
  const clientIdOf = async (id: string) => (CLIENT_ID.test(id) ? id : `h.${(await sha256(id)).slice(0, 64)}`)
  /** A gateway caller's post IDs are its own, derived under who it is here, since the API sees this deployment. */
  const postId = async (caller: Caller, id: string) => clientIdOf('identity' in caller ? await derivedId('board-gateway', caller.identity.principal.id, id) : id)

  /** Messages a read covers, newest last: every thread's in the channels it names, or one thread's. */
  async function collect(who: Who, access: Access | null, filters: Filters, signal: AbortSignal) {
    let listed: ApiChannel[]
    let threads: { thread: ApiThread; channel: ApiChannel }[]
    if (filters.re !== undefined) {
      const found = await readableMessage(who, access, filters.re, signal).catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      })
      if (!found) return { messages: [], feeds: {}, newest: 0 }
      const { channel } = found
      if (filters.channel !== undefined && !(await channelsFor(who, filters.channel, access)).some((c) => c.id === channel.id)) return { messages: [], feeds: {}, newest: 0 }
      listed = [channel]
      threads = [{ thread: found.thread, channel }]
    } else {
      listed = await channelsFor(who, filters.channel, access)
      threads = (await Promise.all(listed.map(async (channel) => (await threadsOf(who, channel, filters, signal)).map((thread) => ({ thread, channel }))))).flat()
    }
    const feeds = await heads(who, listed)
    const by = await byOf(who, filters.by)
    let newest = 0
    const messages: { message: ApiMessage; thread: ApiThread; channel: ApiChannel }[] = []
    for (const { thread, channel } of threads) {
      const all = await threadMessages(who, thread.id, signal)
      const labeled = labeledBy(thread, all.find((message) => message.sequence === 1))
      for (const message of all) {
        newest = Math.max(newest, message.createdAt)
        if (matches(filters, message, labeled, by)) messages.push({ message, thread, channel })
      }
    }
    // A thread's messages are in order; across threads, by time, as a person reads a channel.
    messages.sort((a, b) => a.message.createdAt - b.message.createdAt || a.thread.id.localeCompare(b.thread.id) || a.message.sequence - b.message.sequence)
    return { messages, feeds, newest }
  }

  /** A change in the API's feed as a board event, with the message as it is now. Null for what isn't a message's. */
  async function eventOf(
    who: Who,
    change: ApiChange,
    channel: string,
    cursor: string,
    filters: Filters,
    authors: By | undefined,
    given?: { thread: ApiThread; message: ApiMessage },
    threads: (id: string) => Promise<ApiThread> = threadReader(who),
  ): Promise<BoardEventView | null> {
    if (!change.messageId || !change.type.startsWith('message.')) return null
    let found =
      given ??
      (await messageById(who, change.messageId).catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      }))
    // A reply's read names its thread, not whether its root is deleted: a label filter reads the root.
    if (found && !given && filters.label?.length)
      found = { ...found, thread: found.message.sequence === 1 ? labeledBy(found.thread, found.message) : await threads(found.thread.id) }
    if (!found || !matches(filters, found.message, found.thread, authors)) return null
    const message = await view(who, found.message, channel)
    const by = authorOf(change.actor)
    const base = { id: message.id, thread: message.thread }
    let type: BoardEventView['type']
    let payload: Record<string, unknown>
    switch (change.type) {
      case 'message.posted':
        type = 'message.posted'
        payload = { channel, text: message.text, re: message.re, replyTo: message.replyTo, thread: message.thread, labels: message.labels, noSync: false, mentions: [], by, origin: null, from: null, attachments: message.attachments, links: [] }
        break
      case 'message.edited':
        type = 'message.edited'
        payload = { ...base, text: message.text, mentions: [], by, from: null }
        break
      case 'message.deleted':
        type = 'message.deleted'
        payload = { ...base, by, from: null }
        break
      case 'message.reaction_added':
      case 'message.reaction_removed':
        type = change.type === 'message.reaction_added' ? 'reaction.added' : 'reaction.removed'
        payload = { ...base, emoji: change.emoji, by, from: null }
        break
      case 'message.labeled': {
        const changed = Object.entries(change.labels ?? {})
        type = 'labels.changed'
        payload = {
          ...base,
          set: Object.fromEntries(changed.flatMap(([key, { to }]) => (to === undefined ? [] : [[key, to]]))),
          unset: changed.flatMap(([key, { to }]) => (to === undefined ? [key] : [])),
          by,
        }
        break
      }
      default:
        return null
    }
    return { cursor, type, createdAt: iso(change.createdAt), payload, message, actor: await nameOf(who, change.actor) } as BoardEventView
  }

  /**
   * One read of every channel's feed from `position`: its events, merged by time, each with the
   * position right after it, and the position after them all.
   */
  async function read(who: Who, listed: ApiChannel[], position: Position, filters: Filters, signal: AbortSignal) {
    const path = await onBoard(who, '/changes')
    const pages = await Promise.all(
      listed.map(async (channel) => {
        const from = position.feeds[channel.id]
        // A channel the position doesn't know reads from its oldest change kept, after the position's time.
        const page = await api<{ events: ApiChange[]; cursor: string }>(who, 'GET', path, { query: { channelId: channel.id, ...(from?.at ? { cursor: from.at } : {}) }, signal })
        const skip = from?.skip ?? 0
        const events = page.events.map((change, i) => ({ change, i })).slice(skip).filter(({ change }) => from || change.createdAt > position.t)
        return { channel, at: from?.at ?? null, next: page.cursor, events }
      }),
    )
    const by = await byOf(who, filters.by)
    const threads = threadReader(who, signal)
    const running: Record<string, Feed> = { ...position.feeds }
    const merged = pages.flatMap((page) => page.events.map((event) => ({ ...event, page }))).sort((a, b) => a.change.createdAt - b.change.createdAt)
    const events: BoardEventView[] = []
    for (const { change, i, page } of merged) {
      running[page.channel.id] = { at: page.at, skip: i + 1 }
      const event = await eventOf(who, change, page.channel.name, cursorOf({ t: change.createdAt, feeds: { ...running } }), filters, by, undefined, threads)
      if (event) events.push(event)
    }
    const after: Record<string, Feed> = { ...position.feeds }
    for (const page of pages) after[page.channel.id] = { at: page.next, skip: 0 }
    return { events, position: { t: Math.max(position.t, ...merged.map(({ change }) => change.createdAt)), feeds: after } }
  }

  /** `ms` passing, or `signal` stopping it first. */
  const pause = (ms: number, signal: AbortSignal) =>
    ms <= 0 || signal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
        })

  /**
   * Until one of `listed`'s feeds has something after `position` (true), or it's `until` (false). The API's feed is
   * one channel's, and only it can wait for what comes next, so this waits on each at once and lets
   * the rest go when the first answers with something: a read across channels costs a request a
   * channel each time it waits, not each second it does.
   */
  async function changed(who: Who, listed: ApiChannel[], position: Position, until: number, signal: AbortSignal): Promise<boolean> {
    const wait = Math.min(WAIT_MAX_S, Math.ceil((until - Date.now()) / 1000))
    if (wait <= 0) return false
    if (listed.length === 0) {
      // No channel to wait on: only the time passes.
      await pause(until - Date.now(), signal)
      return false
    }
    const stop = new AbortController()
    const either = AbortSignal.any([signal, stop.signal])
    const path = await onBoard(who, '/changes')
    try {
      return await new Promise<boolean>((resolve, reject) => {
        let pending = listed.length
        for (const channel of listed) {
          const at = position.feeds[channel.id]?.at
          api<{ events: ApiChange[] }>(who, 'GET', path, { query: { channelId: channel.id, ...(at ? { cursor: at } : { from: 'latest' }), wait: String(wait) }, signal: either })
            .then((page) => {
              if (page.events.length > 0) resolve(true)
              else if (--pending === 0) resolve(false)
            })
            // One this let go is no failure; the caller's own stop is, as a read's would be.
            .catch((error: unknown) => (stop.signal.aborted && !signal.aborted ? undefined : reject(error)))
        }
      })
    } finally {
      stop.abort()
    }
  }

  /** Whether a read filters on what messages say, who wrote them, or their labels: what the API can't narrow by. */
  const filtered = (filters: Filters) =>
    filters.by !== undefined || filters.mentions !== undefined || filters.text !== undefined || filters.from !== undefined || (filters.label?.length ?? 0) > 0

  /**
   * One channel's messages, from the API's message list: the latest `limit`, or those after one of
   * its cursors. A filtered read checks each page here, and asks only for as many as it still needs,
   * so the cursor it answers with never passes a match it left out.
   */
  async function channelMessages(who: Who, channel: ApiChannel, query: Filters & { after?: string; limit?: number }, signal: AbortSignal) {
    const path = await onBoard(who, '/messages')
    const limit = query.limit ?? 50
    const thread = threadReader(who, signal)
    const narrowed = filtered(query)
    const by = narrowed ? await byOf(who, query.by) : undefined
    const keep = async (message: ApiMessage) =>
      !narrowed || matches(query, message, query.label?.length ? await thread(message.threadId) : ({ id: message.threadId } as ApiThread), by)
    const kept: ApiMessage[] = []
    if (query.after === undefined) {
      // Without a cursor, the newest: a filtered read looks among the channel's latest page.
      const page = await api<{ messages: ApiMessage[]; cursor: string }>(who, 'GET', path, { query: { channelId: channel.id, limit: String(narrowed ? PAGE_MAX : Math.min(limit, PAGE_MAX)) }, signal })
      for (const message of page.messages) if (await keep(message)) kept.push(message)
      return { messages: kept.slice(-limit), cursor: page.cursor }
    }
    let cursor = query.after
    for (let pages = 0; pages < SCAN_PAGES && kept.length < limit; pages++) {
      const page = await api<{ messages: ApiMessage[]; cursor: string }>(who, 'GET', path, { query: { channelId: channel.id, after: cursor, limit: String(Math.min(limit - kept.length, PAGE_MAX)) }, signal })
      cursor = page.cursor
      for (const message of page.messages) if (await keep(message)) kept.push(message)
      if (page.messages.length === 0) break
    }
    return { messages: kept, cursor }
  }

  /** One channel's events, from the API's feed after one of its cursors, or from now: a long-poll holds there, not here. */
  async function channelEvents(who: Who, channel: ApiChannel, query: Protocol['events']['input'], signal: AbortSignal) {
    const path = await onBoard(who, '/changes')
    const thread = threadReader(who, signal)
    const by = await byOf(who, query.by)
    const until = Date.now() + (query.wait ?? 0) * 1000
    let cursor = query.after
    for (;;) {
      const wait = Math.min(WAIT_MAX_S, Math.max(0, Math.ceil((until - Date.now()) / 1000)))
      const page = await api<{ events: ApiChange[]; cursor: string }>(who, 'GET', path, {
        query: { channelId: channel.id, include: 'message', ...(cursor === undefined ? { from: 'latest' } : { cursor }), ...(wait > 0 ? { wait: String(wait) } : {}) },
        signal,
      })
      cursor = page.cursor
      const events: BoardEventView[] = []
      for (const change of page.events) {
        const message = change.currentMessage
        const found = message && change.threadId ? { message, thread: query.label?.length ? await thread(change.threadId) : ({ id: change.threadId } as ApiThread) } : null
        if (!found) continue
        const event = await eventOf(who, change, channel.name, change.cursor ?? page.cursor, query, by, found)
        if (event) events.push(event)
      }
      if (events.length > 0 || Date.now() >= until || signal.aborted) return { events, cursor }
    }
  }

  /** The one channel a read names, when the API can read it directly: not a subtree, and from one of its cursors or now. */
  async function oneChannel(who: Who, access: Access | null, query: { channel?: string; re?: string; after?: string }): Promise<ApiChannel | null> {
    if (query.channel === undefined || query.channel.endsWith('/') || query.re !== undefined) return null
    if (query.after !== undefined && !API_CURSOR.test(query.after)) return null
    const [channel] = await channelsFor(who, query.channel, access)
    return channel ?? null
  }

  /** Who wrote or reacted in the latest messages of each channel `access` reads. */
  async function actorsSeen(who: Who, access: Access, signal: AbortSignal): Promise<Set<string>> {
    const path = await onBoard(who, '/messages')
    const seen = new Set<string>()
    for (const channel of await channelsFor(who, undefined, access)) {
      const { messages } = await api<{ messages: ApiMessage[] }>(who, 'GET', path, { query: { channelId: channel.id, limit: String(PAGE_MAX) }, signal })
      for (const message of messages) {
        seen.add(message.createdBy.id)
        for (const actors of Object.values(message.reactors ?? {})) for (const actor of actors) seen.add(actor)
      }
    }
    return seen
  }

  /** What a gateway caller does here, as this deployment: never what's the project's own. */
  function checkCaller(method: Method, caller: Caller): void {
    if ('identity' in caller && PROJECTS_OWN.has(method)) throw forbidden(`this board's callers act as its project on Vercel's board, which can't tell them apart: ${method} is the project's own to do there`)
  }

  /**
   * The API owns messages and schedules by principal, and sees every caller here as this project:
   * a caller that is the project (its own deployment's token) changes what it wrote, as on any
   * board, and anyone else would be changing what the project wrote for others.
   */
  /** Whether a caller is this project: the deployment's own code, or a caller verified as its principal. */
  const isProject = async (caller: Caller, who: Who) => !('identity' in caller) || caller.identity.principal.id === principalId((await self(who)).actor.principal)
  async function checkOwner(what: string, caller: Caller, who: Who): Promise<void> {
    if (!(await isProject(caller, who))) throw forbidden(`this board's callers act as its project on Vercel's board, which owns what any of them wrote: only the project itself may ${what} there`)
  }

  /** A file is no use until a post or an import carries it, so uploading takes `post` or `sync` somewhere, as on a2(). */
  async function checkUploader(caller: Caller, who: Who): Promise<void> {
    await checkOwner('upload', caller, who)
    const access = accessOf(caller)
    if (access && !access.anywhere('post') && !access.anywhere('sync')) throw forbidden("this token can't post anywhere, so it can't upload")
  }

  const meOf = (identity: Identity): Me => {
    const { principal, author, actor } = identity
    return {
      actor: actor.id,
      principal: principal.id,
      kind: actor.kind,
      handle: actor.handle,
      name: actor.name,
      avatar: actor.avatar,
      profile: author.profile,
      session: author.session,
      expiresAt: principal.expiresAt?.toISOString() ?? null,
      can: principal.access.summary(),
    }
  }

  /** A watcher's tail registers with the API as its own: an API watcher, so a match is the API's to make. */
  const tagOf = async (watch: Record<string, WatcherSpec>) => (await sha256(canonicalWatchers(watch))).slice(0, 32)

  /** Who `--by` names, as the API's authors: an actor, a principal, or everyone here with that handle or profile, as of now. */
  async function authorsOf(who: Who, by: string): Promise<string[]> {
    if (by === 'me') return [await actorOf(who)]
    if (by.startsWith('vercel:')) return [by]
    const listed = await all<ApiActorView>(who, await onBoard(who, '/actors'), 'actors')
    const named = listed.filter((actor) => actor.handle === by || actor.id.endsWith(`+${by.toLowerCase()}`)).map((actor) => actor.id)
    if (named.length === 0) throw new HttpError(400, 'bad_watcher', `--by ${by}: nobody here goes by that yet: name them by their actor ID`)
    return named
  }

  /**
   * A tail as the filter the API matches. The API reads no tails: channels, people, and threads are
   * looked up here, now, and what it can't match (mentions, other sources) is refused rather than
   * left to match nothing.
   */
  async function filterOf(who: Who, id: string, spec: { tail: string; when?: 'matches' | 'enters' | undefined }): Promise<ApiWatcherSpec> {
    const bad = (message: string) => new HttpError(400, 'bad_watcher', `watch ${id}: ${message}`)
    if (!RemoteWatcherId.safeParse(id).success) throw bad('ids start with a letter and use up to 32 letters, numbers, and hyphens')
    let filters
    try {
      ;({ filters } = compileWatcher(id, spec))
    } catch (error) {
      throw new HttpError(400, 'bad_watcher', (error as Error).message)
    }
    if (filters.mentions !== undefined) throw bad("Vercel's boards can't match mentions yet")
    if (filters.from !== undefined && filters.from !== 'board') throw bad(`nothing comes from ${filters.from} here: every message is written on the board`)
    const filter: ApiWatcherFilter = {}
    if (filters.channel !== undefined) {
      if (filters.channel.endsWith('/')) filter.channelTree = filters.channel.slice(0, -1)
      else {
        const found = await channelNamed(who, filters.channel)
        // A channel that isn't there yet is watched by its name, and so are any made under it.
        if (found) filter.channelIds = [found.id]
        else filter.channelTree = filters.channel
      }
    }
    if (filters.re !== undefined) {
      const at = locate(filters.re)
      if (!at) throw bad(`--re ${filters.re} names no message here`)
      filter.threadId = at.threadId
    }
    if (filters.by !== undefined) filter.authors = await authorsOf(who, filters.by)
    if (filters.text !== undefined) filter.text = filters.text
    if (filters.label?.length) filter.labels = filters.label.map(([key, values]) => (values === null ? { key } : { key, values: [...values] }))
    return { filter, when: spec.when ?? 'matches' }
  }

  /** A filter shown as a tail again, for listing: what it matches, if not always as it was written. */
  async function tailOf(who: Who, { filter }: ApiWatcherSpec): Promise<string> {
    const parts: string[] = []
    if (filter.channelIds?.[0]) parts.push((await channelById(who, filter.channelIds[0])).name)
    else if (filter.channelTree !== undefined) parts.push(`${filter.channelTree}/`)
    if (filter.threadId !== undefined) parts.push(`--re ${idAt(filter.threadId, 1)}`)
    if (filter.authors?.[0]) parts.push(`--by ${filter.authors[0]}`)
    if (filter.text !== undefined) parts.push(`--text ${JSON.stringify(filter.text)}`)
    for (const { key, values } of filter.labels ?? []) parts.push(`--label ${values ? `${key}=${values.join('|')}` : key}`)
    return parts.join(' ')
  }

  /** Where a registration is woken, as board shows it: its URL, or a path on its project (and a preview's branch). */
  const whereOf = (found: ApiRegistration) =>
    found.path ? { url: null, path: found.path, ...(found.branch ? { branch: found.branch } : {}) } : { url: found.url }

  async function registerAs(who: Who, where: WakeAt, watch: Record<string, { tail: string; when?: 'matches' | 'enters' | undefined }>): Promise<RegistrationView> {
    const specs: Record<string, WatcherSpec> = Object.fromEntries(Object.entries(watch).map(([id, spec]) => [id, { tail: spec.tail, when: spec.when ?? 'matches' }]))
    const filters = Object.fromEntries(await Promise.all(Object.entries(specs).map(async ([id, spec]) => [id, await filterOf(who, id, spec)] as const)))
    // vboard's own hash of the tails, which every wake-up carries back, so a board can tell its registration is stale.
    const made = await api<ApiRegistration>(who, 'PUT', await onBoard(who, '/watchers'), { body: { ...where, watch: filters, tag: await tagOf(specs) } })
    return { owner: made.owner, ...whereOf(made), watch: specs, sync: [], hash: made.hash }
  }

  /** A match as vboard hands it out: its event as `vb tail --json` prints it, with its message as it is now. */
  async function matchOf(who: Who, match: ApiMatch) {
    const found = await messageById(who, match.event.messageId).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    })
    const channel = found && (await channelById(who, found.thread.channelId))
    const event = found && channel && (await eventOf(who, match.event, channel.name, match.id, {}, undefined, found))
    if (!event?.message) return null
    return { id: match.id, watcher: match.watcher, thread: event.message.thread, lease: match.lease, attempt: match.attempt, event }
  }

  async function pullAs(who: Who, query: { limit?: number | undefined; wait?: number | undefined }, signal?: AbortSignal | undefined) {
    const path = await onBoard(who, '/watchers/matches')
    const { matches } = await api<{ matches: ApiMatch[] }>(who, 'GET', path, {
      query: { limit: query.limit?.toString(), wait: query.wait?.toString() },
      ...(signal ? { signal } : {}),
    })
    const shown = await Promise.all(matches.map((match) => matchOf(who, match)))
    // A match whose message is gone, or that's about no message, has nothing to run: it's dropped.
    await Promise.all(matches.map((match, i) => (shown[i] ? null : ackAs(who, match.id, { lease: match.lease, skip: true }).catch(() => {}))))
    return shown.filter((match) => match !== null)
  }

  async function ackAs(who: Who, id: string, body: { lease: string; error?: string | undefined; skip?: boolean | undefined }) {
    await api(who, 'POST', await onBoard(who, `/watchers/matches/${encodeURIComponent(id)}/ack`), {
      body: { lease: body.lease, ...(body.error !== undefined ? { error: body.error } : {}), ...(body.skip ? { skip: true } : {}) },
    })
  }

  /**
   * The API keeps one registration per principal, and this board reaches it as its own deployment:
   * one a caller registered through it would replace the deployment's, and every other caller's.
   */
  function ownWatchers(caller: Caller, what: string) {
    if ('identity' in caller) throw forbidden(`this board registers watchers as its own deployment, so it can't ${what} for you: run them in its config, or register with Vercel's API as yourself`)
  }

  /** This deployment's own: what its config's watchers run as. */
  const deployment: Who = { profile: null, session: null }
  /** This board's config's watchers, which run here when the API wakes it. */
  let tails: Record<string, WatcherSpec> = {}

  const bound = () => {
    if (!binding) throw new Error('vercel: used before board() bound it')
    return binding
  }

  // Its watchers run as a board on http()'s do: registered with the API, woken when one matches, and
  // pulling on their own where nothing can wake them.
  const runner = registrant({
    remote: "Vercel's API",
    registry: {
      register: (where) => registerAs(deployment, where, tails),
      matches: ({ signal, ...query }) => pullAs(deployment, query, signal),
      ack: (id, body) => ackAs(deployment, id, body),
    },
    // The API wakes a path on this project, through its Deployment Protection, wherever this board has one.
    wakeAt: async (here) => wakePath(here) ?? { url: here },
    binding: bound,
    hash: () => tagOf(tails),
    hasWork: () => Object.keys(tails).length > 0,
    rethrow: (error) => {
      throw error
    },
    registerFor: async (caller, request) => json(await methods.register(caller, RegisterBody.parse(await request.json()), request.signal)),
  })

  const unsupported = Object.fromEntries(
    METHODS.map((method) => [
      method,
      async () => {
        throw notSupported(method === 'register' || method === 'watchers' || method === 'matches' || method === 'ack' ? 'watchers' : method)
      },
    ]),
  ) as unknown as ProtocolMethods

  const methods: ProtocolMethods = {
    ...unsupported,
    async discovery() {
      const who = { profile: null, session: null }
      const team = await teamId()
      // A board named by its ID is read, so `whoami` names only one there is and you can reach.
      if (options.board) await api(who, 'GET', await onBoard(who))
      // The team's ID: the API says it when this board names the team by its slug, or not at all.
      const id = team?.startsWith('team_') ? team : (await self(who)).teamId
      return {
        version: VERSION,
        // With its team, so the URL alone finds it again: `--url` and `BOARD_URL` take it.
        url: `${origin}/v1/messageboard${await onBoard(who)}?teamId=${encodeURIComponent(id)}`,
        audience: origin,
        team_id: id,
        project_id: null,
        sync: [],
        // The API finds a project's deployment for a path, and wakes it through its Deployment Protection.
        wake_by_path: true,
      } satisfies Discovery
    },
    async me(caller) {
      if ('identity' in caller) return meOf(caller.identity)
      const who = whoOf(caller)
      const found = await api<ApiMe>(who, 'GET', '/me')
      const { view: named } = found
      // The API names you by your account: your username, and an agent's profile under it.
      const shown = named ? { kind: apiKind(named.kind), handle: named.handle, name: named.name ?? named.handle, avatar: named.avatar ?? null } : actorView(found.actor)
      // The API lists no permissions: a board that lets you in lets you read, post, react, and label everywhere.
      return {
        actor: found.actor.id,
        principal: principalId(found.actor.principal),
        kind: shown.kind,
        handle: shown.handle,
        name: shown.name,
        avatar: shown.avatar,
        profile: found.actor.profile?.name ?? null,
        session: found.actor.session ?? null,
        expiresAt: null,
        can: { '*': ['read', 'post', 'react', 'label'] },
      }
    },
    async channels(caller) {
      const who = whoOf(caller)
      // The API counts neither messages nor threads in a channel, so a view says nothing of them.
      const listed: ChannelView[] = (await channelsFor(who, undefined, accessOf(caller)))
        .map((channel) => ({ path: channel.name }))
        .sort((a, b) => a.path.localeCompare(b.path))
      return { channels: listed, cursor: cursorOf({ t: Date.now(), feeds: {} }) }
    },
    async createChannel(caller, { path }) {
      checkCaller('createChannel', caller)
      // As on any board: the answer says whether it was there, so it needs both, whether it was or not.
      const access = accessOf(caller)
      need(access, 'read', path)
      need(access, 'post', path)
      const { created } = await ensureChannel(whoOf(caller), path)
      return { channel: { path }, created }
    },
    async actors(caller, _input, signal) {
      const who = whoOf(caller)
      const listed = (await all<ApiActorView>(who, await onBoard(who, '/actors'), 'actors', {}, signal)).map((actor) => ({
        id: actor.id,
        kind: apiKind(actor.kind),
        handle: actor.handle,
        name: actor.name ?? actor.handle,
        avatar: actor.avatar ?? null,
      }))
      const cursor = cursorOf({ t: Date.now(), feeds: {} })
      // The API lists the whole board's. A reader of every channel sees everyone; anyone else, as on
      // a2(), those it sees where it reads, and itself: here, who wrote or reacted in each readable
      // channel's latest messages.
      if (!('identity' in caller) || caller.identity.principal.access.readsAll) return { actors: listed, cursor }
      const { actor: self, principal } = caller.identity
      const seen = await actorsSeen(who, principal.access, signal)
      const shown = listed.filter((actor) => seen.has(actor.id) && actor.id !== self.id)
      return { actors: [...shown, { id: self.id, kind: self.kind, handle: self.handle, name: self.name, avatar: self.avatar }], cursor }
    },
    async messages(caller, query, signal) {
      const who = whoOf(caller)
      const access = accessOf(caller)
      const channel = query.before === undefined ? await oneChannel(who, access, query) : null
      if (channel) {
        const page = await channelMessages(who, channel, query, signal)
        return { messages: await Promise.all(page.messages.map((message) => view(who, message, channel.name))), cursor: page.cursor }
      }
      if (query.after !== undefined && API_CURSOR.test(query.after)) throw new HttpError(400, 'invalid_request', `after: ${query.after} is one channel's cursor: read that channel`)
      const { messages, feeds, newest } = await collect(who, access, query, signal)
      const after = query.after !== undefined ? await timeOf(who, query.after) : undefined
      const before = query.before !== undefined ? await timeOf(who, query.before) : undefined
      const limit = query.limit ?? 50
      const bounded = messages.filter(({ message }) => (after === undefined || message.createdAt > after) && (before === undefined || message.createdAt < before))
      const page = after !== undefined ? bounded.slice(0, limit) : bounded.slice(-limit)
      return {
        messages: await Promise.all(page.map(({ message, channel }) => view(who, message, channel.name))),
        cursor: cursorOf({ t: newest, feeds }),
      }
    },
    async threads(caller, query, signal) {
      const who = whoOf(caller)
      const after = query.after !== undefined ? await timeOf(who, query.after) : undefined
      const limit = query.limit ?? 50
      const pick = <T extends { at: number }>(found: T[]) => {
        const ordered = found.filter(({ at }) => after === undefined || at > after).sort((a, b) => a.at - b.at)
        return after !== undefined ? ordered.slice(0, limit) : ordered.slice(-limit)
      }
      // A filter on what a message says, or who wrote it, reads every message in the channel.
      const byMessage = query.re !== undefined || query.by !== undefined || query.mentions !== undefined || query.text !== undefined || (query.from !== undefined && query.from !== 'board')
      if (byMessage) {
        const { messages, feeds, newest } = await collect(who, accessOf(caller), query, signal)
        // Each thread with a matching message, by its latest.
        const latest = new Map<string, { thread: ApiThread; channel: ApiChannel; at: number }>()
        for (const { message, thread, channel } of messages) latest.set(thread.id, { thread, channel, at: Math.max(latest.get(thread.id)?.at ?? 0, message.createdAt) })
        const threads = await Promise.all(pick([...latest.values()]).map(({ thread, channel }) => summary(who, thread, channel, signal)))
        return { threads, cursor: cursorOf({ t: newest, feeds }) }
      }
      // Otherwise the threads say enough: a label is matched on the root, whose labels the API
      // keeps on its thread. A reply's own labels aren't indexed, so they don't find its thread here.
      const listed = await channelsFor(who, query.channel, accessOf(caller))
      const feeds = await heads(who, listed)
      const label = indexed(query)
      const found = (
        await Promise.all(listed.map(async (channel) => (await latestThreads(who, channel, label, { ...(after !== undefined ? { after } : {}), ...(query.label?.length ? {} : { limit }) }, signal)).map((thread) => ({ thread, channel, at: thread.lastActivityAt }))))
      ).flat()
      const rooted = found.filter(({ thread }) => (query.label ?? []).every(([key, values]) => thread.labels !== undefined && Object.hasOwn(thread.labels, key) && (values === null || values.includes(thread.labels[key]!))))
      const newest = found.reduce((max, { at }) => Math.max(max, at), 0)
      if (!query.label?.length) {
        const threads = await Promise.all(pick(rooted).map(({ thread, channel }) => summary(who, thread, channel, signal)))
        return { threads, cursor: cursorOf({ t: newest, feeds }) }
      }
      // The API still lists a deleted root by its labels, and only its summary, which reads the
      // root, says it's gone: read them as `pick` would, a page at a time, past any deleted.
      const candidates = rooted.filter(({ at }) => after === undefined || at > after).sort((a, b) => a.at - b.at)
      if (after === undefined) candidates.reverse()
      const threads: ThreadSummaryView[] = []
      for (let next = 0; next < candidates.length && threads.length < limit; ) {
        const page = candidates.slice(next, next + limit - threads.length)
        next += page.length
        for (const shown of await Promise.all(page.map(({ thread, channel }) => summary(who, thread, channel, signal)))) if (!shown.message.deleted) threads.push(shown)
      }
      if (after === undefined) threads.reverse()
      return { threads, cursor: cursorOf({ t: newest, feeds }) }
    },
    async message(caller, { id }, signal) {
      const who = whoOf(caller)
      const { thread, channel } = await readableMessage(who, accessOf(caller), id, signal)
      const [root, ...replies] = await threadMessages(who, thread.id, signal)
      if (!root) throw notFound(`message not found: ${id}`, 'message_not_found')
      return {
        message: await view(who, root, channel.name),
        replies: await Promise.all(replies.map((reply) => view(who, reply, channel.name))),
        cursor: cursorOf({ t: Math.max(root.createdAt, ...replies.map((reply) => reply.createdAt)), feeds: {} }),
      }
    },
    async upload(caller, { data, name, type }) {
      const who = whoOf(caller)
      await checkUploader(caller, who)
      if (data.byteLength === 0) throw new HttpError(400, 'bad_request', 'the file is empty')
      // This deployment's own code (sync's imports among it) holds the bytes already, with no request to fit under.
      if (data.byteLength > IMPORT_BYTES_MAX) throw new HttpError(413, 'too_large', `attachments are at most ${IMPORT_BYTES_MAX / 1024 / 1024} MB`)
      // A copy on its own ArrayBuffer, which digest and fetch take.
      const bytes = new Uint8Array(data)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const started = await api<{ attachment: ApiAttachment; upload: { url: string; method: 'PUT'; headers: Record<string, string> } }>(who, 'POST', await onBoard(who, '/attachments'), {
        body: { operationId: operationId(), name: fileName(name), type: mediaType(type), size: data.byteLength, sha256: btoa(String.fromCharCode(...digest)) },
      })
      // A presigned URL: plain fetch, so this deployment's credentials never reach the bucket.
      const put = await filesFetch(started.upload.url, { method: started.upload.method, headers: started.upload.headers, body: bytes, redirect: 'error' })
      if (!put.ok) throw new HttpError(502, 'upload_failed', `the upload to Vercel's storage answered ${put.status}`)
      const { attachment } = await api<{ attachment: ApiAttachment }>(who, 'POST', await onBoard(who, `/attachments/${encodeURIComponent(started.attachment.id)}/complete`))
      return { attachment: fileOf(attachment) }
    },
    // A file bigger than a request goes straight to Vercel's storage, on the URL the API signs for its size, type, and digest.
    async uploadStart(caller, { name, type, size, sha256 }) {
      const who = whoOf(caller)
      await checkUploader(caller, who)
      if (sha256 === undefined) throw new HttpError(400, 'invalid_request', "Vercel's API signs a direct upload for its bytes' SHA-256: send `sha256`, as board's client does")
      const started = await api<{ attachment: ApiAttachment; upload: { url: string; headers: Record<string, string>; expiresAt: number } }>(who, 'POST', await onBoard(who, '/attachments'), {
        body: { operationId: operationId(), name: fileName(name ?? null), type: mediaType(type ?? null), size, sha256 },
      })
      return { id: started.attachment.id, url: started.upload.url, headers: started.upload.headers, expiresAt: iso(started.upload.expiresAt) }
    },
    async uploadFinish(caller, { id }) {
      const who = whoOf(caller)
      await checkUploader(caller, who)
      const { attachment } = await api<{ attachment: ApiAttachment }>(who, 'POST', await onBoard(who, `/attachments/${encodeURIComponent(id)}/complete`))
      return { attachment: fileOf(attachment) }
    },
    async attachment(caller, { id }, signal) {
      const who = whoOf(caller)
      const access = accessOf(caller)
      const found = await api<{ attachment: ApiAttachment; url: string }>(who, 'GET', await onBoard(who, `/attachments/${encodeURIComponent(id)}`), signal ? { signal } : {})
      // The API sees this project, which uploaded every file here: one not posted yet is the project's own,
      // as an upload is its uploader's, and a caller reads any other only through a message it can.
      if (access && !found.attachment.messageId) {
        if (!(await isProject(caller, who))) throw notFound(`no attachment: ${id}`, 'attachment_not_found')
      } else if (access) {
        const { message } = await readableMessage(who, access, found.attachment.messageId!, signal).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) throw notFound(`no attachment: ${id}`, 'attachment_not_found')
          throw error
        })
        // The API reads a deleted message as its tombstone, and still hands this project, its uploader, the file.
        if (message.deletedAt !== undefined) throw notFound(`no attachment: ${id}`, 'attachment_not_found')
      }
      const response = await filesFetch(found.url, { redirect: 'error', ...(signal ? { signal } : {}) })
      if (!response.ok || !response.body) throw new HttpError(502, 'download_failed', `Vercel's storage answered ${response.status}`)
      return { attachment: fileOf(found.attachment), data: response.body }
    },
    async post(caller, input, signal) {
      checkCaller('post', caller)
      if (input.sync?.length) throw notSupported('sync')
      const who = whoOf(caller)
      const access = accessOf(caller)
      // Every file here is the project's, which uploaded them all: only the project itself posts them.
      if (input.attachments?.length) await checkOwner('post files', caller, who)
      const labeled = Object.keys(input.labels ?? {}).length > 0
      const clientId = input.id !== undefined ? await postId(caller, input.id) : undefined
      let made: { thread: ApiThread; message: ApiMessage }
      if (input.channel !== undefined) {
        need(access, 'post', input.channel)
        if (labeled) need(access, 'label', input.channel)
        const channel = await channelToPost(who, input.channel)
        made = await api(who, 'POST', await onBoard(who, '/threads'), {
          body: { operationId: operationId(), channelId: channel.id, text: input.text, ...(input.labels && Object.keys(input.labels).length ? { labels: input.labels } : {}), ...(clientId ? { clientId } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
          signal,
        })
      } else {
        const { thread, message: to, channel } = await readableMessage(who, access, input.re!, signal)
        need(access, 'post', channel.name)
        if (labeled) need(access, 'label', channel.name)
        // The API checks it with the post, as a sequence in the thread: an ID's says where it is.
        const after = input.after === undefined ? undefined : locate(input.after)
        if (after !== undefined && after?.threadId !== thread.id) {
          // A retry of one that landed gets it back, as the API gives it, whatever its `after` says now.
          const landed = clientId ? await api<{ thread: ApiThread; message: ApiMessage }>(who, 'GET', await onBoard(who, `/posts/${encodeURIComponent(clientId)}`), { signal }).catch(() => null) : null
          if (landed?.thread.id === thread.id) return { message: await view(who, landed.message, channel.name) }
          throw badRequest(`after: ${input.after} isn't in ${input.re}'s thread`, 'invalid_after')
        }
        made = await api<{ thread: ApiThread; message: ApiMessage }>(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(thread.id)}/messages`), {
          body: { operationId: operationId(), text: input.text, ...(to.sequence > 1 ? { replyTo: to.sequence } : {}), ...(clientId ? { clientId } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(after ? { after: after.sequence } : {}) },
          signal,
        }).catch((error: unknown) => {
          // The API names messages by their sequence in the thread, which a board's IDs don't show.
          if (error instanceof HttpError && error.code === 'newer_message') throw new HttpError(409, 'newer_message', `a message came after ${input.after}`)
          throw error
        })
        // The API labels a new thread as it starts, and a reply after.
        if (input.labels && Object.keys(input.labels).length) {
          const labeled = await api<{ meta: { labels?: Labels; version: number } }>(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(thread.id)}/messages/${made.message.sequence}/labels`), {
            body: { operationId: operationId(), set: input.labels },
            signal,
          })
          made = { ...made, message: { ...made.message, ...(labeled.meta.labels ? { labels: labeled.meta.labels } : {}), version: labeled.meta.version } }
        }
      }
      const channel = await channelById(who, made.thread.channelId)
      return { message: await view(who, made.message, channel.name) }
    },
    async posted(caller, { id }, signal) {
      checkCaller('posted', caller)
      const who = whoOf(caller)
      const found = await api<{ thread: ApiThread; message: ApiMessage }>(who, 'GET', await onBoard(who, `/posts/${encodeURIComponent(await postId(caller, id))}`), { signal })
      const channel = await channelById(who, found.thread.channelId)
      const access = accessOf(caller)
      if (access && !access.readable(channel.name)) throw notFound(`no post of yours has id ${id}`, 'post_not_found')
      return { message: await view(who, found.message, channel.name) }
    },
    async edit(caller, { id, text, revision }, signal) {
      const who = whoOf(caller)
      await checkOwner('edit', caller, who)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      const access = accessOf(caller)
      if (access) need(access, 'post', (await readableMessage(who, access, id, signal)).channel.name)
      await api(who, 'PATCH', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}`), { body: { operationId: operationId(), text, ...(revision !== undefined ? { revision } : {}) }, signal })
      return { ok: true }
    },
    async delete(caller, { id, revision }, signal) {
      const who = whoOf(caller)
      await checkOwner('delete', caller, who)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      const access = accessOf(caller)
      if (access) need(access, 'post', (await readableMessage(who, access, id, signal)).channel.name)
      await api(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}/delete`), { body: { operationId: operationId(), ...(revision !== undefined ? { revision } : {}) }, signal })
      return { ok: true }
    },
    async react(caller, { id, emoji, remove }, signal) {
      checkCaller('react', caller)
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      const access = accessOf(caller)
      if (access) need(access, 'react', (await readableMessage(who, access, id, signal)).channel.name)
      await api(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}/reactions`), {
        body: { operationId: operationId(), emoji, ...(remove ? { remove: true } : {}) },
        signal,
      })
      return { ok: true }
    },
    async label(caller, { id, set, unset, if: expected }, signal) {
      checkCaller('label', caller)
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      const access = accessOf(caller)
      if (access) need(access, 'label', (await readableMessage(who, access, id, signal)).channel.name)
      await api(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}/labels`), {
        // The API checks `if` against the labels in the same write that changes them.
        body: { operationId: operationId(), ...(set ? { set } : {}), ...(unset ? { unset } : {}), ...(expected && Object.keys(expected).length ? { if: expected } : {}) },
        signal,
      })
      return { ok: true }
    },
    // Grants and tokens are the API's, in the protocol's shapes: what it doesn't keep yet, it answers.
    // A caller this board serves gets none of them, since it reaches the API as these credentials.
    async grants(caller, _input, signal) {
      checkCaller('grants', caller)
      const who = whoOf(caller)
      return api<Protocol['grants']['output']>(who, 'GET', await onBoard(who, '/grants'), signal ? { signal } : {})
    },
    async createGrant(caller, input, signal) {
      checkCaller('createGrant', caller)
      const who = whoOf(caller)
      return api<Protocol['createGrant']['output']>(who, 'POST', await onBoard(who, '/grants'), { body: { operationId: operationId(), ...input }, ...(signal ? { signal } : {}) })
    },
    async revokeGrant(caller, { id }, signal) {
      checkCaller('revokeGrant', caller)
      const who = whoOf(caller)
      return api<Protocol['revokeGrant']['output']>(who, 'POST', await onBoard(who, `/grants/${encodeURIComponent(id)}/revoke`), { body: { operationId: operationId() }, ...(signal ? { signal } : {}) })
    },
    async tokens(caller, _input, signal) {
      checkCaller('tokens', caller)
      const who = whoOf(caller)
      return api<Protocol['tokens']['output']>(who, 'GET', await onBoard(who, '/tokens'), signal ? { signal } : {})
    },
    async createToken(caller, input, signal) {
      checkCaller('createToken', caller)
      const who = whoOf(caller)
      return api<Protocol['createToken']['output']>(who, 'POST', await onBoard(who, '/tokens'), { body: { operationId: operationId(), ...input }, ...(signal ? { signal } : {}) })
    },
    async revokeToken(caller, { id }, signal) {
      checkCaller('revokeToken', caller)
      const who = whoOf(caller)
      return api<Protocol['revokeToken']['output']>(who, 'POST', await onBoard(who, `/tokens/${encodeURIComponent(id)}/revoke`), { body: { operationId: operationId() }, ...(signal ? { signal } : {}) })
    },
    async schedule(caller, input, signal) {
      if (input.attachments?.length) throw notSupported('files on scheduled messages')
      const who = whoOf(caller)
      await checkOwner('schedule', caller, who)
      const access = accessOf(caller)
      const labels = input.labels && Object.keys(input.labels).length ? input.labels : undefined
      let target: { channelId: string } | { threadId: string }
      if (input.channel !== undefined) {
        need(access, 'post', input.channel)
        if (labels) need(access, 'label', input.channel)
        target = { channelId: (await channelToPost(who, input.channel)).id }
      } else {
        // The API labels a scheduled thread's root, and posts a scheduled reply with no labels.
        if (labels) throw notSupported('labels on a scheduled reply')
        const { thread, channel } = await readableMessage(who, access, input.re!, signal)
        need(access, 'post', channel.name)
        target = { threadId: thread.id }
      }
      // The API takes whole milliseconds since the epoch: the first send, and the stop.
      const ms = (value: string) => Math.round(duration(value))
      const firstAt = input.at !== undefined ? Date.parse(input.at) : Date.now() + ms(input.in ?? input.every!)
      const until = input.until !== undefined ? Date.parse(input.until) : input.for !== undefined ? firstAt + ms(input.for) : undefined
      const { schedule } = await api<{ schedule: ApiSchedule }>(who, 'POST', await onBoard(who, '/schedules'), {
        body: {
          operationId: operationId(),
          ...target,
          text: input.text,
          ...(labels ? { labels } : {}),
          firstAt,
          ...(input.every !== undefined ? { every: ms(input.every) } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(input.times !== undefined ? { times: input.times } : {}),
        },
        signal,
      })
      return { schedule: await scheduleView(who, schedule) }
    },
    async schedules(caller, query, signal) {
      const who = whoOf(caller)
      const access = accessOf(caller)
      const filter: Record<string, string | undefined> = { state: query.all ? undefined : 'pending' }
      if (query.re !== undefined) {
        const found = await readableMessage(who, access, query.re, signal).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) return null
          throw error
        })
        if (!found) return { schedules: [] }
        filter.threadId = found.thread.id
      }
      if (query.channel !== undefined) {
        const channel = await channelNamed(who, query.channel)
        if (!channel) return { schedules: [] }
        filter.channelId = channel.id
      }
      // `by` names an actor, a principal and its agents, or a profile, as a read's does; `me` is the actor itself.
      if (query.by?.startsWith('vercel:')) filter.createdBy = query.by
      const by = await byOf(who, query.by)
      const created = (actor: ApiActor) => by === undefined || by(actor)
      const listed = await all<ApiSchedule>(who, await onBoard(who, '/schedules'), 'schedules', filter, signal)
      const views = await Promise.all(listed.filter((schedule) => created(schedule.createdBy)).map((schedule) => scheduleView(who, schedule)))
      return { schedules: views.filter((schedule) => access === null || access.readable(schedule.channel)) }
    },
    async cancelSchedule(caller, { id }, signal) {
      const who = whoOf(caller)
      await checkOwner('cancelSchedule', caller, who)
      const access = accessOf(caller)
      if (access) {
        // The API reads no one schedule by its ID: a caller here finds it among the board's.
        const found = (await all<ApiSchedule>(who, await onBoard(who, '/schedules'), 'schedules', {}, signal)).find((schedule) => schedule.id === id)
        const channel = found && (await channelById(who, found.channelId))
        if (!channel || !access.readable(channel.name)) throw notFound(`no schedule: ${id}`, 'schedule_not_found')
        need(access, 'post', channel.name)
      }
      const { schedule, canceled } = await api<{ schedule: ApiSchedule; canceled: boolean }>(who, 'POST', await onBoard(who, `/schedules/${encodeURIComponent(id)}/cancel`), {
        body: { operationId: operationId() },
        signal,
      })
      return { schedule: await scheduleView(who, schedule), canceled }
    },
    async events(caller, query, signal) {
      checkCaller('events', caller)
      const who = whoOf(caller)
      const access = accessOf(caller)
      const channel = await oneChannel(who, access, query)
      if (channel) return channelEvents(who, channel, query, signal)
      if (query.after !== undefined && API_CURSOR.test(query.after)) throw new HttpError(400, 'invalid_request', `after: ${query.after} is one channel's cursor: read that channel`)
      const listed = await channelsFor(who, query.channel, access)
      // With no cursor, it starts now, as on any board.
      let position: Position =
        query.after === undefined
          ? { t: Date.now(), feeds: await heads(who, listed) }
          : locate(query.after)
            ? { t: await timeOf(who, query.after), feeds: {} }
            : positionOf(query.after)
      const until = Date.now() + (query.wait ?? 0) * 1000
      // On a busy board a wait wakes at every change, so one that a filter (--mentions me, --by) finds
      // nothing in would read again straight away: once one wakes within a second, it reads every
      // second instead, as often as the board was read before waits, and no more.
      let busy = false
      for (;;) {
        const started = Date.now()
        const page = await read(who, listed, position, query, signal)
        position = page.position
        if (page.events.length > 0 || Date.now() >= until || signal.aborted) return { events: page.events, cursor: cursorOf(position) }
        if (!busy) busy = (await changed(who, listed, position, until, signal)) && Date.now() - started < 1000
        await pause(Math.min(started + 1000, until) - Date.now(), signal)
      }
    },
    // Nothing syncs here, so no platform shows typing.
    async typing() {
      return { targets: [] }
    },
    async readSource(_caller, { key }) {
      throw notFound(`this board doesn't run sync entry ${key}`, 'not_synced_here')
    },
    async watchers(caller) {
      ownWatchers(caller, 'list watchers')
      const who = whoOf(caller)
      const { watchers } = await api<{ watchers: ApiRegistration[] }>(who, 'GET', await onBoard(who, '/watchers'))
      return {
        watchers: await Promise.all(
          watchers.map(async (found) => ({
            owner: found.owner,
            ...whereOf(found),
            watch: Object.fromEntries(await Promise.all(Object.entries(found.watch).map(async ([id, spec]) => [id, { tail: await tailOf(who, spec), when: spec.when }] as const))),
            sync: [],
            hash: found.hash,
          })),
        ),
      }
    },
    async register(caller, body) {
      ownWatchers(caller, 'register watchers')
      if ((body.sync?.length ?? 0) > 0) throw notSupported('sync')
      return registerAs(whoOf(caller), typeof body.path === 'string' ? { path: body.path, ...(body.branch ? { branch: body.branch } : {}) } : { url: body.url ?? null }, body.watch)
    },
    async matches(caller, query, signal) {
      ownWatchers(caller, 'pull matches')
      return { matches: await pullAs(whoOf(caller), query, signal) }
    },
    async ack(caller, { id, ...body }) {
      ownWatchers(caller, 'ack matches')
      await ackAs(whoOf(caller), id, body)
      return { ok: true }
    },
  }

  // Any use of the board is when its watchers can register: its URL is known from a request by then.
  const starting = Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        if (binding) void runner.start()
        return (method as (...input: unknown[]) => unknown)(...args)
      },
    ]),
  ) as unknown as ProtocolMethods

  const backend = {
    ...starting,
    // Its own routes are wake-ups and registering: who may do what on the board is Vercel's API's to say.
    routes: runner.routes,
    // The board is Vercel's: a board here serves requests only with an `access` of its own.
    keeps: false,
    // Vercel's API posts each send, so board()'s middleware screens a schedule when it's made.
    sendsSchedulesHere: false,
    bind(next: BoardBinding) {
      if (binding) throw new Error('vercel: this backend already serves a board: create one vercel() per board()')
      const kinds = Object.values(next.subscriptions).map((subscription) => subscription.kind)
      if (kinds.includes('sync')) throw new Error("vercel: Vercel's boards don't run sync yet: leave `sync` out")
      for (const id of Object.keys(next.subscriptions)) own.add(id)
      tails = Object.fromEntries(
        Object.entries(next.subscriptions).flatMap(([id, subscription]) => (subscription.kind === 'tail' ? [[id, { tail: subscription.tail, when: subscription.when }]] : [])),
      )
      binding = next
    },
    /** Registers this board's watchers with Vercel's API now, as `POST /watchers` does. */
    registerWatchers: runner.registerNow,
    /** Stops pulling, for a board that pulls on its own. */
    close: runner.close,
  }
  return backend satisfies Backend
}

export type VercelBackend = ReturnType<typeof createVercel>
