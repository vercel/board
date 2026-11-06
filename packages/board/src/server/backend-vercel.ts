import type { Protocol } from '../api/protocol.ts'
import { RegisterBody, type ActorView, type BoardEventView, type ChannelView, type Discovery, type GrantView, type InboxEntry, type MessageView, type RegistrationView, type ScheduleView, type ThreadSummaryView, type TokenView } from '../api/routes.ts'
import { duration, type ProfileOption } from '../client/client.ts'
import { sha256 } from '../client/ids.ts'
import { IMPORT_BYTES_MAX, RemoteWatcherId, type Attachment, type Author, type Labels } from '../contract/schemas.ts'
import type { ExternalAuthor, Link, Origin } from '../contract/external.ts'
import { VERSION } from '../version.ts'
import { compileAccess, parsePattern, PERMISSIONS, type AccessSummary, type Permission } from './access.ts'
import { type Backend, type BackendRoute, type BoardBinding, type Caller, type ProtocolMethods } from './backend.ts'
import { fileName, mediaType } from '../contract/files.ts'
import { badRequest, HttpError, json, notFound } from './errors.ts'
import { deployedOnVercel, registrant, wakePath, type WakeAt } from './registrant.ts'
import { METHODS } from './routing.ts'
import { compileWatcher } from './watch-spec.ts'
import { tailWatchers } from './tails.ts'
import { canonicalWatchers, type SyncEntrySpec, type WatcherSpec } from './watchers-hash.ts'

// The `/v1/messageboard` API's shapes, as this backend reads them. `@api/messageboard-types` is
// private to Vercel's monorepo, so these are written out: conformance catches drift.
type ApiPrincipal =
  | { type: 'user'; userId: string; clientId?: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
  | { type: 'external'; id: string; syncKey: string }
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
  /** The sync key an import came through, and where it is on its platform. */
  from?: string
  origin?: { channel?: string; thread: string; subthread?: string | null; message: string; context?: string | null }
  noSync?: boolean
  links?: { url: string; message?: string | null; snapshot?: Link['snapshot']; unavailable?: string | null }[]
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
  noSync?: boolean
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
type ApiActorView = { id: string; kind: 'person' | 'agent' | 'deployment' | 'app' | 'external'; handle: string; name?: string; avatar?: string }
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
  /** The sync key a change a sync imported came through, so that sync doesn't send it back. */
  from?: string
  /** For `thread.synced`, which only the sync owning the target's key gets: what the thread was bound to. */
  binding?: { target: string; targetKind: 'channel' | 'thread'; cause: 'config' | 'request' }
}
/**
 * Who these credentials are, as the API says: `can`, what they may do in each channel pattern, in
 * board's words, and `expiresAt`, when they stop working, in milliseconds. An API that says neither
 * leaves them out.
 */
type ApiMe = {
  teamId: string
  actor: ApiActor
  view?: ApiActorView
  project?: { id: string; environment: string }
  can?: Record<string, string[]>
  expiresAt?: number | string | null
}
/** Which messages a watcher sees, in the API's terms: a tail is translated into one. */
type ApiWatcherFilter = {
  channelIds?: string[]
  channelTree?: string
  threadId?: string
  authors?: string[]
  text?: string
  labels?: { key: string; values?: string[] }[]
}
type ApiWatcherSpec = { filter: ApiWatcherFilter }
type ApiRegistration = { owner: string; url: string | null; path?: string; branch?: string; watch: Record<string, ApiWatcherSpec>; sync?: SyncEntrySpec[]; hash: string }
type ApiMatch = { id: string; watcher: string; threadId: string; lease: string; attempt: number; event: ApiChange & { messageId: string } }

export type VercelOptions = {
  /**
   * The team whose board it is: its ID (`team_…`) or its slug. By default the one `board({ team })`
   * names, or in Node your deployment's, or `VERCEL_ORG_ID`. One that isn't `board({ team })`'s
   * fails when board() binds it.
   */
  team?: string
  /**
   * The board's ID, which wins over `board({ name })`. By default the board that name names, or
   * the team's default board, which `GET /boards` names.
   */
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
  /** Whether its fetch sends a board token you set (`BOARD_TOKEN`), whoever made it. */
  boardToken(): boolean
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
/** The most recent inbox events the API lists at once. */
const INBOX_LIST_MAX = 100
/** The API's codes board()'s sync doesn't know: on sync's routes, each is answered as the board's code for its status. */
const API_ONLY_CODES = new Set([
  'board_only',
  'duplicate_sync_key',
  'event_too_large',
  'foreign_author',
  'invalid_find',
  'invalid_import',
  'invalid_inbox_event',
  'invalid_receipt',
  'message_not_owned',
  'mutation_too_large',
  'operation_conflict',
  'operation_expired_or_unknown',
  'sync_key_not_owned',
  'sync_needs_project',
  'too_many_targets',
])
const BOARD_CODES: Record<number, string> = { 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large' }
/** Pages a filtered read of one channel scans for matches before it answers with what it found. */
const SCAN_PAGES = 10
/** How long after it couldn't tell who its credentials are a board waits to ask again. */
const WHO_AGAIN_MS = 10_000

/** A file as the board names it. */
const fileOf = ({ id, name, type, size }: Attachment): Attachment => ({ id, name, type, size })

const notSupported = (what: string) => new HttpError(501, 'not_supported', `Vercel's boards don't support ${what} yet`)

/** What credentials may do when the API doesn't say: read, post, react, and label everywhere, as any it lets in. */
const DEFAULT_CAN: AccessSummary = { '*': ['read', 'post', 'react', 'label'] }

/**
 * What the API says these credentials may do, in board's words: each channel pattern board can
 * read, with the permissions board knows, the rest dropped, and what those imply. `DEFAULT_CAN`
 * when it says nothing board reads as one.
 */
function canOf(can: unknown): AccessSummary {
  if (typeof can !== 'object' || can === null || Array.isArray(can)) return DEFAULT_CAN
  const known = new Set<string>(PERMISSIONS)
  const out: Record<string, Permission[]> = {}
  for (const [pattern, permissions] of Object.entries(can)) {
    if (!Array.isArray(permissions)) continue
    // A pattern board can't read would make whatever compiles this summary throw: it's dropped.
    try {
      parsePattern(pattern)
    } catch {
      continue
    }
    out[pattern] = permissions.filter((permission): permission is Permission => known.has(permission))
  }
  // Implications closed and in board's order, as board's own `me` says it.
  return compileAccess(out).summary()
}

/** Epoch milliseconds before this are the year 2001: a number under it is epoch seconds, as a JWT's `exp` is. */
const SECONDS_BEFORE = 1e12

/**
 * When the API says these credentials stop working, as an ISO time: from epoch milliseconds (or
 * epoch seconds, under `SECONDS_BEFORE`) or a time it gives, null for none.
 */
function expiryOf(at: unknown): string | null {
  if (typeof at === 'number' && Number.isFinite(at)) return new Date(at < SECONDS_BEFORE ? at * 1000 : at).toISOString()
  if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString()
  return null
}

/** What a caller board() verified gets: board() serves no requests for a board on Vercel's, so it never sends one. */
const servesNone = () => new HttpError(404, 'not_found', "this board uses Vercel's, and answers only wake-ups and webhooks")

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

/** A grant as the API answers it, its `at` in milliseconds, as the protocol has it: an ISO string. */
const grantFrom = (grant: GrantView): GrantView => ({ ...grant, at: expiryOf(grant.at) })
/** A token as the API answers it, its times in milliseconds, as the protocol has them. */
const tokenFrom = (token: TokenView): TokenView => ({ ...token, at: expiryOf(token.at) ?? token.at, expiresAt: expiryOf(token.expiresAt) ?? token.expiresAt })
const idAt = (threadId: string, sequence: number) => `msg_${threadId.slice('thr_'.length)}_${sequence}`

/** Where a message ID points: its thread and its place in it. Null for one that isn't a message's. */
function locate(id: string): { threadId: string; sequence: number } | null {
  const found = MESSAGE_ID.exec(id)
  return found ? { threadId: `thr_${found[1]}`, sequence: Number(found[2]) } : null
}

/** A principal as board names it: `vercel:user:<id>`, `vercel:app:<id>`, `vercel:project:<id>:<env>`. */
function principalId(principal: ApiPrincipal): string {
  if (principal.type === 'external') return principal.id
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

/** Who cancels a schedule when no one did: the API, once its creator can no longer post it, as a local board's scheduler. */
const SCHEDULER: Author = { actor: 'board:schedule', principal: 'board:schedule', profile: null, session: null }

/** The API names nobody, so an actor's handle is its profile, or a short form of its principal. */
function actorView(actor: ApiActor): ActorView & { id: string } {
  const { principal } = actor
  // A platform user a sync imported, by their ID on the platform until the API names them.
  if (principal.type === 'external') return { id: actor.id, kind: 'external', handle: principal.id.slice(principal.id.lastIndexOf(':') + 1), name: principal.id, avatar: null }
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

/** A message's labels just before a change, from what they are after it and what it changed. */
function labelsBefore(after: Labels, changed: ApiChange['labels'] = {}): Labels {
  const before = { ...after }
  for (const [key, { from }] of Object.entries(changed)) {
    if (from === undefined) delete before[key]
    else before[key] = from
  }
  return before
}

/** A platform location as board shows one, its optional parts null. */
const originOf = (origin: ApiMessage['origin']): Origin | null =>
  origin ? { ...(origin.channel !== undefined ? { channel: origin.channel } : {}), thread: origin.thread, subthread: origin.subthread ?? null, message: origin.message, context: origin.context ?? null } : null

type Filters = Protocol['messages']['input']

/**
 * Vercel's board for your team, in Vercel's API: this deployment keeps nothing and reads and writes
 * it as itself, its people as themselves. Messages, threads, reactions, labels, a channel's
 * changes, schedules, files, watchers, and sync's records work: the API keeps sync's state, and
 * the platforms stay with board()'s sync.
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

  /** The board `board({ name })` names: null for the team's default board, or when `board` names one by its ID. */
  const boardName = (): string | null => (options.board ? null : (binding?.name ?? null))

  let team: Promise<string | null> | null = null
  const teamId = () => {
    const given = binding?.team ?? options.team
    return (team ??= given ? Promise.resolve(given) : (environment?.team() ?? Promise.resolve(null)))
  }

  /** One request to the API, as `who`. Its errors are the API's own, with its status and code. */
  async function api<T>(who: Who, method: string, path: string, init: { query?: Record<string, string | readonly string[] | undefined>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(`${origin}/v1/messageboard${path}`)
    const id = await teamId()
    // A team's ID, or its slug, as Vercel's API takes either.
    if (id) url.searchParams.set(id.startsWith('team_') ? 'teamId' : 'slug', id)
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue
      if (typeof value === 'string') url.searchParams.set(name, value)
      else for (const one of value) url.searchParams.append(name, one)
    }
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
    // A board token reaches its own board by ID, and none of the team's routes: finding a board by its name or as the team's is one.
    if (error?.code === 'board_token_scope')
      throw new HttpError(403, 'board_token_scope', 'a board token reaches only its own board, by its ID.', { hint: 'Name its board by URL or ID: BOARD_URL, --url, or vercel({ board }).', origin: 'handle' })
    throw new HttpError(response.status, error?.code ?? 'remote_error', error?.message ?? `Vercel's API answered ${response.status}`)
  }

  /** A request on sync's routes, whose refusals board()'s sync knows only by the board's codes. */
  async function syncApi<T>(...args: Parameters<typeof api>): Promise<T> {
    try {
      return await api<T>(...args).catch(async (error: unknown) => {
        // A sync key is this deployment's once it registers, which its first request starts without
        // waiting: a webhook can get there first, so it registers and tries once more.
        if (!(error instanceof HttpError && error.code === 'sync_key_not_owned' && (binding?.sync.length ?? 0) > 0)) throw error
        await runner.registerNow()
        return api<T>(...args)
      })
    } catch (error) {
      if (error instanceof HttpError && API_ONLY_CODES.has(error.code)) {
        throw new HttpError(error.status, BOARD_CODES[error.status] ?? error.code, error.message)
      }
      throw error
    }
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

  /**
   * The board named `name` in the team: the one the API lists for it. Where it lists none, the
   * caller makes it (a project's is granted to that project, in its environment), unless it says
   * not to (`ensure: false`) and is told there's none it can see. Names are unique across the
   * team's boards, the ones you can't see included.
   */
  async function boardNamed(who: Who, name: string): Promise<string> {
    if (!/^[^/]{1,64}$/.test(name))
      throw new HttpError(400, 'invalid_board_name', `${JSON.stringify(name)} isn't a board's name: one is 1 to 64 characters with no /.`, { origin: 'handle' })
    // One answer holds the board with the name, whatever its case. Names are unique from now on; of
    // the few older boards that share one, the API lists the oldest first, and that's the one.
    const { boards } = await api<{ boards: { id: string; name: string }[] }>(who, 'GET', '/boards', { query: { name } })
    if (boards[0]) return boards[0].id
    const { principal } = (await self(who)).actor
    if (binding?.ensure === false)
      throw new HttpError(404, 'no_board', `no board named ${name} on this team, or none you can see.`, {
        hint: 'Check the name, or make it: leave out ensure: false',
        origin: 'handle',
      })
    try {
      const { board: made } = await api<{ board: { id: string }; created: boolean }>(who, 'POST', '/boards/ensure', { body: { name, operationId: operationId() } })
      return made.id
    } catch (error) {
      if (error instanceof HttpError && error.code === 'board_not_granted') throw notLetIn(name, principal)
      // Names are unique across the team's boards, private ones included: this one is someone else's to show.
      if (error instanceof HttpError && error.code === 'board_name_taken')
        throw new HttpError(409, 'board_name_taken', `the board name ${name} is taken.`, { hint: 'Pick another name, or ask whoever can see it for access.', origin: 'handle' })
      throw error
    }
  }

  /**
   * A project a board's grants don't let in, the one `name`s or the team's (null): they were narrowed,
   * since every project on the team gets in by default. Its way out is the grant that lets it back in,
   * naming the project by ID, since `/me` carries no name.
   */
  const notLetIn = (name: string | null, principal: ApiPrincipal) => {
    const board = name === null ? "the team's board" : `board ${name}`
    if (principal.type !== 'project') return new HttpError(403, 'board_not_granted', `this project has no access to ${board}.`, { hint: 'Someone who manages the board can grant it.', origin: 'handle' })
    const grant = `vb grants create --project ${principal.projectId} --environment ${principal.environment}${name === null ? '' : ` --name ${name}`} --can '*=read,post,react,label'`
    return new HttpError(403, 'board_not_granted', `this project has no access to ${board} (${principal.projectId}, ${principal.environment}).`, {
      hint: `Grant it: ${grant}`,
      origin: 'handle',
    })
  }

  let board: Promise<string> | null = null
  /**
   * The board's ID: the one given, the one `board({ name })` names, or the team's, which the API
   * names only to those it lets in. A team with none gets one the first time a person uses it, as
   * the API asks of its clients; a project can't make it, and needs a person to grant it the board
   * anyway. Each is asked for once.
   */
  const boardId = (who: Who) =>
    (board ??= options.board
      ? Promise.resolve(options.board)
      : boardName()
        ? boardNamed(who, boardName()!)
        : api<{ defaultBoardId: string | null }>(who, 'GET', '/boards').then(async ({ defaultBoardId }) => {
            if (defaultBoardId) return defaultBoardId
            const { principal } = (await self(who)).actor
            if (principal.type === 'project') throw notLetIn(null, principal)
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
  /** The channels a filter names: one, a channel and those under it (`dev/`), or every one. */
  async function channelsFor(who: Who, filter: string | undefined): Promise<ApiChannel[]> {
    if (filter !== undefined && !filter.endsWith('/')) {
      const found = await channelNamed(who, filter)
      return found ? [found] : []
    }
    const listed = await loadChannels(who, true)
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
  /** A message, and its channel. */
  async function messageIn(who: Who, id: string, signal?: AbortSignal) {
    const found = await messageById(who, id, signal)
    return { ...found, channel: await channelById(who, found.thread.channelId) }
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
    if (!found || !(kind === 'person' || kind === 'external' || (kind === 'agent' && actor.principal.type === 'user'))) return actorView(actor)
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
      noSync: message.noSync ?? false,
      origin: originOf(message.origin),
      from: message.from ?? null,
      createdAt: iso(message.createdAt),
      editedAt: message.editedAt === undefined ? null : iso(message.editedAt),
      deleted: message.deletedAt !== undefined,
      undelivered: {},
      attachments: message.attachments ?? [],
      links: (message.links ?? []).map((link) => ({ url: link.url, message: link.message ?? null, snapshot: link.snapshot ?? null, unavailable: link.unavailable ?? null })),
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
      noSync: schedule.noSync ?? false,
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

  /** Handles a fresh read of the names didn't have, by when: `--by` doesn't read again for them for a while. */
  const unhandled = new Map<string, number>()
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
      // Someone new since the list was read: one read again finds them. A value no fresh read had
      // (a profile name, an ID, a typo) isn't read again for it until names are read anyway.
      const missed = unhandled.get(handle)
      if (ids.length === 0 && kept && !(missed !== undefined && Date.now() - missed <= NAMES_FRESH_MS)) ids = await find(readNames(who))
      if (ids.length === 0) {
        if (unhandled.size >= 1000) unhandled.clear()
        if (!kept || missed === undefined || Date.now() - missed > NAMES_FRESH_MS) unhandled.set(handle, Date.now())
      }
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
    if (filters.from !== undefined && (message.from ?? 'board') !== filters.from) {
      return false
    }
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
    if ('identity' in caller) throw servesNone()
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

  /** Messages a read covers, newest last: every thread's in the channels it names, or one thread's. */
  async function collect(who: Who, filters: Filters, signal: AbortSignal) {
    let listed: ApiChannel[]
    let threads: { thread: ApiThread; channel: ApiChannel }[]
    if (filters.re !== undefined) {
      const found = await messageIn(who, filters.re, signal).catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 404) return null
        throw error
      })
      if (!found) return { messages: [], feeds: {}, newest: 0 }
      const { channel } = found
      if (filters.channel !== undefined && !(await channelsFor(who, filters.channel)).some((c) => c.id === channel.id)) return { messages: [], feeds: {}, newest: 0 }
      listed = [channel]
      threads = [{ thread: found.thread, channel }]
    } else {
      listed = await channelsFor(who, filters.channel)
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
    messages.sort(byTime)
    return { messages, feeds, newest }
  }

  /** A thread's messages in order; across threads, by time, as a person reads a channel. */
  const byTime = (a: { message: ApiMessage }, b: { message: ApiMessage }) =>
    a.message.createdAt - b.message.createdAt || a.message.threadId.localeCompare(b.message.threadId) || a.message.sequence - b.message.sequence

  /**
   * The latest `limit` in `listed`, unfiltered: each channel's latest page from the API's message
   * list, all at once, never a thread at a time. The list goes back one page, so a full page cuts the
   * answer off at its oldest message: every message newer than the oldest it answers with is in it,
   * even when that's fewer than `limit`. Each page's cursor is its channel's feed then, which the
   * read's cursor goes on from.
   */
  async function latest(who: Who, listed: ApiChannel[], limit: number, signal: AbortSignal) {
    const path = await onBoard(who, '/messages')
    const asked = Math.min(limit, PAGE_MAX)
    const pages = await Promise.all(
      listed.map(async (channel) => ({
        channel,
        ...(await api<{ messages: ApiMessage[]; cursor: string }>(who, 'GET', path, { query: { channelId: channel.id, limit: String(asked) }, signal })),
      })),
    )
    const full = pages.filter((page) => page.messages.length === asked)
    const cutoff = Math.max(-Infinity, ...full.map((page) => Math.min(...page.messages.map((message) => message.createdAt))))
    const messages = pages
      .flatMap(({ channel, messages }) => messages.map((message) => ({ message, channel })))
      .filter(({ message }) => message.createdAt >= cutoff)
      .sort(byTime)
    return {
      messages: messages.slice(-limit),
      feeds: Object.fromEntries(pages.map((page): [string, Feed] => [page.channel.id, { at: page.cursor, skip: 0 }])),
      newest: Math.max(0, ...pages.flatMap((page) => page.messages.map((message) => message.createdAt))),
    }
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
    const from = change.from ?? null
    const base = { id: message.id, thread: message.thread }
    let type: BoardEventView['type']
    let payload: Record<string, unknown>
    switch (change.type) {
      case 'message.posted':
        type = 'message.posted'
        payload = { channel, text: message.text, re: message.re, replyTo: message.replyTo, thread: message.thread, labels: message.labels, noSync: message.noSync, mentions: [], by, origin: message.origin, from: message.from, attachments: message.attachments, links: message.links }
        break
      case 'message.edited':
        type = 'message.edited'
        payload = { ...base, text: message.text, mentions: [], by, from }
        break
      case 'message.deleted':
        type = 'message.deleted'
        payload = { ...base, by, from }
        break
      case 'message.reaction_added':
      case 'message.reaction_removed':
        type = change.type === 'message.reaction_added' ? 'reaction.added' : 'reaction.removed'
        payload = { ...base, emoji: change.emoji, by, from }
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
    return boardEvent(who, change, cursor, type, payload, message)
  }

  const boardEvent = async (who: Who, change: ApiChange, cursor: string, type: BoardEventView['type'], payload: Record<string, unknown>, message: MessageView) =>
    ({ cursor, type, createdAt: iso(change.createdAt), payload, message, actor: await nameOf(who, change.actor) }) as BoardEventView

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

  /** A read of the feed, as `vb tail` makes it: one channel's feed when it names one, or every channel's. */
  async function eventsAs(who: Who, query: Protocol['events']['input'], signal: AbortSignal): Promise<Protocol['events']['output']> {
    const channel = await oneChannel(who, query)
    if (channel) return channelEvents(who, channel, query, signal)
    if (query.after !== undefined && API_CURSOR.test(query.after)) throw new HttpError(400, 'invalid_request', `after: ${query.after} is one channel's cursor: read that channel`)
    const listed = await channelsFor(who, query.channel)
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
  }

  /** The one channel a read names, when the API can read it directly: not a subtree, and from one of its cursors or now. */
  async function oneChannel(who: Who, query: { channel?: string; re?: string; after?: string }): Promise<ApiChannel | null> {
    if (query.channel === undefined || query.channel.endsWith('/') || query.re !== undefined) return null
    if (query.after !== undefined && !API_CURSOR.test(query.after)) return null
    const [channel] = await channelsFor(who, query.channel)
    return channel ?? null
  }

  /** A watcher's tail registers with the API as its own: an API watcher, so a match is the API's to make. */
  const tagOf = async (watch: Record<string, WatcherSpec>, sync: readonly SyncEntrySpec[]) => (await sha256(canonicalWatchers(watch, sync))).slice(0, 32)

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
   * looked up here, now, and what it can't match (mentions) is refused rather than left to match
   * nothing. It matches no `--source` either: that's filtered here, where `fromHere` says it is.
   */
  function checkedTail(id: string, spec: { tail: string }, fromHere: boolean) {
    const bad = (message: string) => new HttpError(400, 'bad_watcher', `watch ${id}: ${message}`)
    if (!RemoteWatcherId.safeParse(id).success) throw bad('ids start with a letter and use up to 32 letters, numbers, and hyphens')
    let compiled
    try {
      compiled = compileWatcher(id, spec)
    } catch (error) {
      throw new HttpError(400, 'bad_watcher', (error as Error).message)
    }
    if (compiled.filters.mentions !== undefined) throw bad("Vercel's boards can't match mentions yet")
    if (compiled.filters.from !== undefined && !fromHere) {
      throw bad("Vercel's API can't match --source: put the watcher in the board's config, which filters its matches itself")
    }
    return compiled
  }

  async function filterOf(who: Who, id: string, spec: { tail: string }, fromHere: boolean): Promise<ApiWatcherSpec> {
    const { filters } = checkedTail(id, spec, fromHere)
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
      if (!at) throw new HttpError(400, 'bad_watcher', `watch ${id}: --re ${filters.re} names no message here`)
      filter.threadId = at.threadId
    }
    if (filters.by !== undefined) filter.authors = await authorsOf(who, filters.by)
    if (filters.text !== undefined) filter.text = filters.text
    if (filters.label?.length) filter.labels = filters.label.map(([key, values]) => (values === null ? { key } : { key, values: [...values] }))
    return { filter }
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
  const syncOf = (found: ApiRegistration) => (found.sync ?? []).map(({ key, platform }) => ({ key, platform }))
  const whereOf = (found: ApiRegistration) =>
    found.path ? { url: null, path: found.path, ...(found.branch ? { branch: found.branch } : {}) } : { url: found.url }

  /**
   * Vercel's API takes watchers only from a deployment's own credentials: never a person's, an app's,
   * or a board token's, whoever made it. Anyone else's registration, pull, or ack is its 403
   * `watchers_need_project`.
   */
  const notADeployment = () =>
    new HttpError(403, 'watchers_need_project', "Vercel's API takes watchers only from a deployment's own credentials.", {
      hint: "Register them from the project's deployment, with no board token. Watchers in board()'s config run in this process instead.",
      origin: 'handle',
    })
  const needsProject = (error: unknown) => (error instanceof HttpError && error.code === 'watchers_need_project' ? notADeployment() : error)
  async function watchersApi<T>(...args: Parameters<typeof api>): Promise<T> {
    try {
      return await api<T>(...args)
    } catch (error) {
      throw needsProject(error)
    }
  }

  async function registerAs(
    who: Who,
    where: WakeAt,
    watch: Record<string, { tail: string }>,
    sync: readonly SyncEntrySpec[],
    fromHere: boolean,
  ): Promise<RegistrationView> {
    const specs: Record<string, WatcherSpec> = Object.fromEntries(Object.entries(watch).map(([id, spec]) => [id, { tail: spec.tail }]))
    const filters = Object.fromEntries(await Promise.all(Object.entries(specs).map(async ([id, spec]) => [id, await filterOf(who, id, spec, fromHere)] as const)))
    const entries = sync.map(({ key, platform }) => ({ key, platform }))
    // vboard's own hash of the tails and sync entries, which every wake-up carries back, so a board can tell its registration is stale.
    let made: ApiRegistration
    try {
      made = await syncApi<ApiRegistration>(who, 'PUT', await onBoard(who, '/watchers'), {
        body: { ...where, watch: filters, tag: await tagOf(specs, entries), ...(entries.length ? { sync: entries } : {}) },
      })
    } catch (error) {
      throw needsProject(error)
    }
    return { owner: made.owner, ...whereOf(made), watch: specs, sync: syncOf(made), hash: made.hash }
  }

  /** A match as vboard hands it out: its event as `vb tail --json` prints it, with its message as it is now. */
  async function matchOf(who: Who, match: ApiMatch, filters: Filters) {
    const found = await messageById(who, match.event.messageId).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    })
    const channel = found && (await channelById(who, found.thread.channelId))
    if (!found || !channel) {
      return null
    }
    const event = match.event.type === 'thread.synced' ? await syncedOf(who, match, found.message, channel.name) : await eventOf(who, match.event, channel.name, match.id, filters, undefined, found)
    if (!event?.message) return null
    // Sync re-renders a copy only when a label change changes what it shows, so it gets the labels from before it too.
    const handed = match.watcher === '@sync' && event.type === 'labels.changed' ? { ...event, before: { ...event.message, labels: labelsBefore(event.message.labels, match.event.labels) } } : event
    return { id: match.id, watcher: match.watcher, thread: event.message.thread, lease: match.lease, attempt: match.attempt, event: handed }
  }

  /** A thread bound to a target, as the event that has the sync owning its key backfill a channel: about the thread's root. */
  async function syncedOf(who: Who, match: ApiMatch, root: ApiMessage, channel: string) {
    const { binding } = match.event
    if (!binding) {
      return null
    }
    const message = await view(who, root, channel)
    return boardEvent(who, match.event, match.id, 'thread.synced', { thread: message.thread, target: binding.target, cause: binding.cause, kind: binding.targetKind, by: authorOf(match.event.actor) }, message)
  }

  async function pullAs(who: Who, query: { limit?: number | undefined; wait?: number | undefined }, signal?: AbortSignal | undefined, specs: Record<string, WatcherSpec> = {}) {
    const path = await onBoard(who, '/watchers/matches')
    const { matches } = await watchersApi<{ matches: ApiMatch[] }>(who, 'GET', path, {
      query: { limit: query.limit?.toString(), wait: query.wait?.toString() },
      ...(signal ? { signal } : {}),
    })
    // The API matches no `--source`: a watcher whose tail has one is filtered here.
    const sources = new Map(Object.entries(specs).map(([id, spec]) => [id, compileWatcher(id, spec).filters.from]))
    const handed = await Promise.all(
      matches.map((match) => {
        const from = sources.get(match.watcher)
        return matchOf(who, match, from === undefined ? {} : { from })
      }),
    )
    // A match whose message is gone, or that's about no message, has nothing to run: it's dropped.
    await Promise.all(matches.map((match, i) => (handed[i] ? null : ackAs(who, match.id, { lease: match.lease, skip: true }).catch(() => {}))))
    return handed.filter((match) => match !== null)
  }

  async function ackAs(who: Who, id: string, body: { lease: string; error?: string | undefined; skip?: boolean | undefined }) {
    await watchersApi(who, 'POST', await onBoard(who, `/watchers/matches/${encodeURIComponent(id)}/ack`), {
      body: { lease: body.lease, ...(body.error !== undefined ? { error: body.error } : {}), ...(body.skip ? { skip: true } : {}) },
    })
  }

  /** This deployment's own: what its config's watchers run as. */
  const deployment: Who = { profile: null, session: null }
  /** This board's config's watchers, which run here when the API wakes it. */
  let tails: Record<string, WatcherSpec> = {}

  const bound = () => {
    if (!binding) throw new Error('vercel: used before board() bound it')
    return binding
  }

  // A deployment's watchers run as a board on http()'s do: registered with the API, woken by their
  // path when one matches, and pulling on their own where nothing can wake them.
  const runner = registrant({
    remote: "Vercel's API",
    registry: {
      register: (where) =>
        registerAs(deployment, where, tails, bound().sync, true).catch((error: unknown) => {
          // These aren't a deployment's own credentials after all (a board token in a fetch): they run here from now on.
          if (error instanceof HttpError && error.code === 'watchers_need_project') {
            refused = true
            runner.close()
            runHere()
          }
          throw error
        }),
      matches: ({ signal, ...query }) => pullAs(deployment, query, signal, tails),
      ack: (id, body) => ackAs(deployment, id, body),
    },
    // The API wakes a path on this project, through its Deployment Protection, from every deployment
    // on Vercel, and nothing at a URL: off Vercel, it pulls.
    wakeAt: async (here) => wakePath(here) ?? { url: null },
    binding: bound,
    hash: () => tagOf(tails, bound().sync),
    hasWork: () => Object.keys(tails).length > 0 || bound().sync.length > 0,
    rethrow: (error) => {
      throw error
    },
    registerFor: async (caller, request) => json(await methods.register(caller, RegisterBody.parse(await request.json()), request.signal)),
  })

  let deployed: Promise<boolean> | null = null
  /** Whether Vercel's API refused to register this board's watchers: its credentials aren't a deployment's own. */
  let refused = false
  /**
   * Whether this board's own credentials are a deployment's own: a project's, and no board token. A
   * board token you set says so; one in a `fetch` passed in says so when the API refuses it.
   */
  const isDeployment = async () => {
    if (refused || (!options.fetch && environment?.boardToken())) return false
    return (deployed ??= self(deployment).then((found) => found.actor.principal.type === 'project')).catch((error: unknown) => {
      deployed = null
      throw error
    })
  }

  let here: ReturnType<typeof tailWatchers> | null = null
  let deployedElse = false
  /** Anyone else's watchers run in this process, as tails: nothing wakes a person. */
  function runHere() {
    if (here || deployedElse) return
    // A deployment's function doesn't outlive its request, so a tail there would stop with it.
    if (deployedOnVercel()) {
      deployedElse = true
      console.error("[board] watchers on a deployment need its own OIDC token: with a board token or another Vercel token, none run here")
      return
    }
    const { sync, run } = bound()
    if (sync.length > 0) console.error("[board] sync doesn't run on Vercel's board as anyone but a deployment: run it from the project's deployment")
    const watchers: Parameters<typeof tailWatchers>[0]['watchers'] = {}
    for (const [id, spec] of Object.entries(tails)) {
      try {
        watchers[id] = checkedTail(id, spec, true)
      } catch (error) {
        console.error(`[board] watcher ${id} doesn't run:`, (error as Error).message)
      }
    }
    here = tailWatchers({
      watchers,
      events: (query, signal) => eventsAs(deployment, query, signal),
      actorOf: (id) => actorOf({ profile: { name: id }, session: null }),
      run,
    })
    here.start()
  }

  let failedAt = 0
  /** On first use, a deployment registers its watchers with the API, and anyone else runs them here. */
  async function start() {
    if (here || (Object.keys(tails).length === 0 && bound().sync.length === 0) || Date.now() - failedAt < WHO_AGAIN_MS) return
    let project: boolean
    try {
      project = await isDeployment()
    } catch (error) {
      failedAt = Date.now()
      console.error("[board] couldn't tell whether this board runs as a deployment:", error instanceof Error ? error.message : String(error))
      return
    }
    if (project) await runner.start()
    else runHere()
  }

  /** The routes to register and wake: only a deployment's board is woken or registers. */
  const routes: BackendRoute[] = runner.routes.map((route) => ({
    ...route,
    async handle(request, context) {
      if (context.caller || (await isDeployment().catch(() => true))) return route.handle(request, context)
      void start()
      if (route.path === '/wake') return json({ ran: 0 })
      throw notADeployment()
    },
  }))

  const platformUser = ({ id, handle, name, avatar, isBot }: ExternalAuthor) => ({ id, handle, name, avatar, isBot })

  /** An import as the API takes it: a channel by its ID, and a reply's `after` as its sequence in the thread. */
  async function importBody(who: Who, body: Protocol['syncImport']['input']): Promise<Record<string, unknown>> {
    if (body.op === 'seen') return { op: 'seen', operationId: operationId(), author: platformUser(body.author) }
    const base = { op: body.op, operationId: operationId(), author: platformUser(body.author), ...(body.from !== undefined ? { from: body.from } : {}) }
    if (body.op === 'post') {
      if (body.attachments?.length) throw notSupported('files on imports')
      let after: number | undefined
      if (body.after !== undefined) {
        const at = locate(body.after)
        const re = body.re === undefined ? null : locate(body.re)
        if (!at || !re || at.threadId !== re.threadId) throw badRequest(`after: ${body.after} isn't in ${body.re ?? 'the thread'}'s thread`, 'invalid_after')
        after = at.sequence
      }
      return {
        ...base,
        origin: body.origin === null ? null : originOf(body.origin),
        ...(body.source ? { source: body.source } : {}),
        ...(body.channel !== undefined ? { channelId: (await channelToPost(who, body.channel)).id } : {}),
        ...(body.re !== undefined ? { re: body.re } : {}),
        text: body.text,
        ...(body.labels && Object.keys(body.labels).length ? { labels: body.labels } : {}),
        ...(body.noSync ? { noSync: true } : {}),
        ...(body.links?.length ? { links: body.links } : {}),
        ...(body.id !== undefined ? { id: body.id } : {}),
        ...(after !== undefined ? { after } : {}),
      }
    }
    const changed = { ...base, ...(body.origin !== undefined ? { origin: body.origin } : {}), ...(body.message !== undefined ? { message: body.message } : {}) }
    if (body.op === 'edit') return { ...changed, text: body.text, ...(body.source ? { source: body.source } : {}), ...(body.revision !== undefined ? { revision: body.revision } : {}) }
    if (body.op === 'delete') return { ...changed, ...(body.revision !== undefined ? { revision: body.revision } : {}) }
    if (body.op === 'react') return { ...changed, emoji: body.emoji, ...(body.remove ? { remove: true } : {}) }
    if (body.op === 'labels')
      return { ...changed, ...(body.set ? { set: body.set } : {}), ...(body.unset ? { unset: body.unset } : {}), ...(body.if && Object.keys(body.if).length ? { if: body.if } : {}) }
    return { ...changed, links: body.links }
  }

  /** A sync key's inbox, under the board. */
  const inboxPath = (who: Who, key: string, rest = '') => onBoard(who, `/sync/inbox/${encodeURIComponent(key)}${rest}`)

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
        sync: (binding?.sync ?? []).map(({ key, platform }) => ({ key, platform })),
        // The API finds a project's deployment for a path, and wakes it through its Deployment Protection.
        wake_by_path: true,
      } satisfies Discovery
    },
    async me(caller) {
      const who = whoOf(caller)
      const found = await api<ApiMe>(who, 'GET', '/me')
      const { view: named } = found
      // The API names you by your account: your username, and an agent's profile under it.
      const shown = named ? { kind: apiKind(named.kind), handle: named.handle, name: named.name ?? named.handle, avatar: named.avatar ?? null } : actorView(found.actor)
      // What these credentials may do, and until when, as the API says; without a word, what any it lets in may.
      return {
        actor: found.actor.id,
        principal: principalId(found.actor.principal),
        kind: shown.kind,
        handle: shown.handle,
        name: shown.name,
        avatar: shown.avatar,
        profile: found.actor.profile?.name ?? null,
        session: found.actor.session ?? null,
        expiresAt: expiryOf(found.expiresAt),
        can: canOf(found.can),
      }
    },
    async channels(caller) {
      const who = whoOf(caller)
      // The API counts neither messages nor threads in a channel, so a view says nothing of them.
      const listed: ChannelView[] = (await channelsFor(who, undefined))
        .map((channel) => ({ path: channel.name }))
        .sort((a, b) => a.path.localeCompare(b.path))
      return { channels: listed, cursor: cursorOf({ t: Date.now(), feeds: {} }) }
    },
    async createChannel(caller, { path }) {
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
      return { actors: listed, cursor: cursorOf({ t: Date.now(), feeds: {} }) }
    },
    async messages(caller, query, signal) {
      const who = whoOf(caller)
      const channel = query.before === undefined ? await oneChannel(who, query) : null
      if (channel) {
        const page = await channelMessages(who, channel, query, signal)
        return { messages: await Promise.all(page.messages.map((message) => view(who, message, channel.name))), cursor: page.cursor }
      }
      if (query.after !== undefined && API_CURSOR.test(query.after)) throw new HttpError(400, 'invalid_request', `after: ${query.after} is one channel's cursor: read that channel`)
      const limit = query.limit ?? 50
      // The latest across channels, as the inspector's first read asks: each channel's page at once.
      if (query.re === undefined && query.after === undefined && query.before === undefined && !filtered(query)) {
        const { messages, feeds, newest } = await latest(who, await channelsFor(who, query.channel), limit, signal)
        return {
          messages: await Promise.all(messages.map(({ message, channel }) => view(who, message, channel.name))),
          cursor: cursorOf({ t: newest, feeds }),
        }
      }
      const { messages, feeds, newest } = await collect(who, query, signal)
      const after = query.after !== undefined ? await timeOf(who, query.after) : undefined
      const before = query.before !== undefined ? await timeOf(who, query.before) : undefined
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
      const byMessage = query.re !== undefined || query.by !== undefined || query.mentions !== undefined || query.text !== undefined || query.from !== undefined
      if (byMessage) {
        const { messages, feeds, newest } = await collect(who, query, signal)
        // Each thread with a matching message, by its latest.
        const latest = new Map<string, { thread: ApiThread; channel: ApiChannel; at: number }>()
        for (const { message, thread, channel } of messages) latest.set(thread.id, { thread, channel, at: Math.max(latest.get(thread.id)?.at ?? 0, message.createdAt) })
        const threads = await Promise.all(pick([...latest.values()]).map(({ thread, channel }) => summary(who, thread, channel, signal)))
        return { threads, cursor: cursorOf({ t: newest, feeds }) }
      }
      // Otherwise the threads say enough: a label is matched on the root, whose labels the API
      // keeps on its thread. A reply's own labels aren't indexed, so they don't find its thread here.
      const listed = await channelsFor(who, query.channel)
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
      const { thread, channel } = await messageIn(who, id, signal)
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
      // What sync uploads is for its imports, which Vercel's API takes no files on: it links each where it lives.
      if ('self' in caller && caller.self === 'sync') throw new HttpError(501, 'no_files', "Vercel's board takes no files from sync yet")
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
      if (sha256 === undefined) throw new HttpError(400, 'invalid_request', "Vercel's API signs a direct upload for its bytes' SHA-256: send `sha256`, as board's client does")
      const started = await api<{ attachment: ApiAttachment; upload: { url: string; headers: Record<string, string>; expiresAt: number } }>(who, 'POST', await onBoard(who, '/attachments'), {
        body: { operationId: operationId(), name: fileName(name ?? null), type: mediaType(type ?? null), size, sha256 },
      })
      return { id: started.attachment.id, url: started.upload.url, headers: started.upload.headers, expiresAt: iso(started.upload.expiresAt) }
    },
    async uploadFinish(caller, { id }) {
      const who = whoOf(caller)
      const { attachment } = await api<{ attachment: ApiAttachment }>(who, 'POST', await onBoard(who, `/attachments/${encodeURIComponent(id)}/complete`))
      return { attachment: fileOf(attachment) }
    },
    async attachment(caller, { id }, signal) {
      const who = whoOf(caller)
      const found = await api<{ attachment: ApiAttachment; url: string }>(who, 'GET', await onBoard(who, `/attachments/${encodeURIComponent(id)}`), signal ? { signal } : {})
      const response = await filesFetch(found.url, { redirect: 'error', ...(signal ? { signal } : {}) })
      if (!response.ok || !response.body) throw new HttpError(502, 'download_failed', `Vercel's storage answered ${response.status}`)
      return { attachment: fileOf(found.attachment), data: response.body }
    },
    async post(caller, input, signal) {
      if (input.sync?.length) throw notSupported('sync')
      const who = whoOf(caller)
      const clientId = input.id !== undefined ? await clientIdOf(input.id) : undefined
      let made: { thread: ApiThread; message: ApiMessage }
      if (input.channel !== undefined) {
        const channel = await channelToPost(who, input.channel)
        made = await api(who, 'POST', await onBoard(who, '/threads'), {
          body: { operationId: operationId(), channelId: channel.id, text: input.text, ...(input.labels && Object.keys(input.labels).length ? { labels: input.labels } : {}), ...(clientId ? { clientId } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.noSync ? { noSync: true } : {}) },
          signal,
        })
      } else {
        const { thread, message: to, channel } = await messageIn(who, input.re!, signal)
        // The API checks it with the post, as a sequence in the thread: an ID's says where it is.
        const after = input.after === undefined ? undefined : locate(input.after)
        if (after !== undefined && after?.threadId !== thread.id) {
          // A retry of one that landed gets it back, as the API gives it, whatever its `after` says now.
          const landed = clientId ? await api<{ thread: ApiThread; message: ApiMessage }>(who, 'GET', await onBoard(who, `/posts/${encodeURIComponent(clientId)}`), { signal }).catch(() => null) : null
          if (landed?.thread.id === thread.id) return { message: await view(who, landed.message, channel.name) }
          throw badRequest(`after: ${input.after} isn't in ${input.re}'s thread`, 'invalid_after')
        }
        made = await api<{ thread: ApiThread; message: ApiMessage }>(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(thread.id)}/messages`), {
          body: { operationId: operationId(), text: input.text, ...(to.sequence > 1 ? { replyTo: to.sequence } : {}), ...(clientId ? { clientId } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(after ? { after: after.sequence } : {}), ...(input.noSync ? { noSync: true } : {}) },
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
      const who = whoOf(caller)
      const found = await api<{ thread: ApiThread; message: ApiMessage }>(who, 'GET', await onBoard(who, `/posts/${encodeURIComponent(await clientIdOf(id))}`), { signal })
      const channel = await channelById(who, found.thread.channelId)
      return { message: await view(who, found.message, channel.name) }
    },
    async edit(caller, { id, text, revision }, signal) {
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      await api(who, 'PATCH', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}`), { body: { operationId: operationId(), text, ...(revision !== undefined ? { revision } : {}) }, signal })
      return { ok: true }
    },
    async delete(caller, { id, revision }, signal) {
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      await api(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}/delete`), { body: { operationId: operationId(), ...(revision !== undefined ? { revision } : {}) }, signal })
      return { ok: true }
    },
    async react(caller, { id, emoji, remove }, signal) {
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      await api(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}/reactions`), {
        body: { operationId: operationId(), emoji, ...(remove ? { remove: true } : {}) },
        signal,
      })
      return { ok: true }
    },
    async label(caller, { id, set, unset, if: expected }, signal) {
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      await api(who, 'POST', await onBoard(who, `/threads/${encodeURIComponent(at.threadId)}/messages/${at.sequence}/labels`), {
        // The API checks `if` against the labels in the same write that changes them.
        body: { operationId: operationId(), ...(set ? { set } : {}), ...(unset ? { unset } : {}), ...(expected && Object.keys(expected).length ? { if: expected } : {}) },
        signal,
      })
      return { ok: true }
    },
    // Grants and tokens are the API's, in the protocol's shapes: what it doesn't keep yet, it answers.
    async grants(caller, _input, signal) {
      const who = whoOf(caller)
      const { grants } = await api<Protocol['grants']['output']>(who, 'GET', await onBoard(who, '/grants'), signal ? { signal } : {})
      return { grants: grants.map(grantFrom) }
    },
    async createGrant(caller, input, signal) {
      const who = whoOf(caller)
      const { grant } = await api<Protocol['createGrant']['output']>(who, 'POST', await onBoard(who, '/grants'), { body: { operationId: operationId(), ...input }, ...(signal ? { signal } : {}) })
      return { grant: grantFrom(grant) }
    },
    async updateGrant(caller, { id, ...change }, signal) {
      const who = whoOf(caller)
      const { grant } = await api<Protocol['updateGrant']['output']>(who, 'PATCH', await onBoard(who, `/grants/${encodeURIComponent(id)}`), { body: { operationId: operationId(), ...change }, ...(signal ? { signal } : {}) })
      return { grant: grantFrom(grant) }
    },
    async explain(caller, { claim, ...query }, signal) {
      const who = whoOf(caller)
      const params = new URLSearchParams()
      for (const [name, value] of Object.entries(query)) if (value !== undefined) params.set(name, value)
      for (const pair of claim ?? []) params.append('claim', pair)
      const explained = await api<Protocol['explain']['output']>(who, 'GET', await onBoard(who, `/grants/explain?${params}`), signal ? { signal } : {})
      return { ...explained, grants: explained.grants.map(grantFrom) }
    },
    async revokeGrant(caller, { id }, signal) {
      const who = whoOf(caller)
      return api<Protocol['revokeGrant']['output']>(who, 'POST', await onBoard(who, `/grants/${encodeURIComponent(id)}/revoke`), { body: { operationId: operationId() }, ...(signal ? { signal } : {}) })
    },
    async tokens(caller, _input, signal) {
      const who = whoOf(caller)
      const { tokens } = await api<Protocol['tokens']['output']>(who, 'GET', await onBoard(who, '/tokens'), signal ? { signal } : {})
      return { tokens: tokens.map(tokenFrom) }
    },
    async createToken(caller, input, signal) {
      const who = whoOf(caller)
      const created = await api<Protocol['createToken']['output']>(who, 'POST', await onBoard(who, '/tokens'), { body: { operationId: operationId(), ...input }, ...(signal ? { signal } : {}) })
      return { ...created, token: tokenFrom(created.token) }
    },
    async revokeToken(caller, { id }, signal) {
      const who = whoOf(caller)
      return api<Protocol['revokeToken']['output']>(who, 'POST', await onBoard(who, `/tokens/${encodeURIComponent(id)}/revoke`), { body: { operationId: operationId() }, ...(signal ? { signal } : {}) })
    },
    async schedule(caller, input, signal) {
      if (input.attachments?.length) throw notSupported('files on scheduled messages')
      const who = whoOf(caller)
      const labels = input.labels && Object.keys(input.labels).length ? input.labels : undefined
      let target: { channelId: string } | { threadId: string }
      if (input.channel !== undefined) {
        target = { channelId: (await channelToPost(who, input.channel)).id }
      } else {
        // The API labels a scheduled thread's root, and posts a scheduled reply with no labels.
        if (labels) throw notSupported('labels on a scheduled reply')
        const { thread } = await messageIn(who, input.re!, signal)
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
          ...(input.noSync ? { noSync: true } : {}),
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
      const filter: Record<string, string | undefined> = { state: query.all ? undefined : 'pending' }
      if (query.re !== undefined) {
        const found = await messageIn(who, query.re, signal).catch((error: unknown) => {
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
      return { schedules: views }
    },
    async cancelSchedule(caller, { id }, signal) {
      const who = whoOf(caller)
      const { schedule, canceled } = await api<{ schedule: ApiSchedule; canceled: boolean }>(who, 'POST', await onBoard(who, `/schedules/${encodeURIComponent(id)}/cancel`), {
        body: { operationId: operationId() },
        signal,
      })
      return { schedule: await scheduleView(who, schedule), canceled }
    },
    events: (caller, query, signal) => eventsAs(whoOf(caller), query, signal),
    // Typing shows where this board's own sync has the thread: Vercel's API keeps no platform's app.
    async typing(caller, { id, status }, signal) {
      if (!binding || binding.sync.length === 0) return { targets: [] }
      const { message, replies } = await methods.message(caller, { id }, signal)
      return { targets: await binding.typing([message, ...replies], status) }
    },
    // A source is read, and joined, with the app of the sync that runs it here.
    async readSource(_caller, { key, target, limit, after }) {
      if (!binding?.sync.some((entry) => entry.key === key)) throw notFound(`this board doesn't run sync entry ${key}: read it where its sync runs`, 'not_synced_here')
      return binding.readSource(key, target, limit ?? 50, after ?? null)
    },
    async joinSource(_caller, { key, target }) {
      if (!binding?.sync.some((entry) => entry.key === key)) throw notFound(`this board doesn't run sync entry ${key}: join it where its sync runs`, 'not_synced_here')
      return binding.joinSource(key, target)
    },
    async syncImport(caller, body, signal) {
      const who = whoOf(caller)
      const found = await syncApi<{ message: string | null }>(who, 'POST', await onBoard(who, '/sync/imports'), { body: await importBody(who, body), signal }).catch((error: unknown) => {
        if (error instanceof HttpError && error.code === 'newer_message' && body.op === 'post') throw new HttpError(409, 'newer_message', `a message came after ${body.after}`)
        throw error
      })
      return { message: found.message }
    },
    async syncReceipt(caller, body, signal) {
      const who = whoOf(caller)
      return syncApi<{ ok: true; attached?: boolean }>(who, 'POST', await onBoard(who, '/sync/receipts'), { body, signal })
    },
    async syncFind(caller, query, signal) {
      const who = whoOf(caller)
      const { thread, message } = await syncApi<Protocol['syncFind']['output']>(who, 'GET', await onBoard(who, '/sync/find'), { query, signal })
      return { thread, message }
    },
    async syncThread(caller, { thread }, signal) {
      const who = whoOf(caller)
      const found = await syncApi<Protocol['syncThread']['output']>(who, 'GET', await onBoard(who, `/sync/threads/${encodeURIComponent(thread)}`), { signal })
      // The API names a channel by its ID, and a board by its name.
      return { ...found, channel: (await channelById(who, found.channel)).name }
    },
    async syncCopies(caller, { message }, signal) {
      const who = whoOf(caller)
      return syncApi<Protocol['syncCopies']['output']>(who, 'GET', await onBoard(who, '/sync/copies'), { query: { message }, signal })
    },
    async synced(caller, { id }, signal) {
      const who = whoOf(caller)
      const at = locate(id)
      if (!at) throw notFound(`message not found: ${id}`, 'message_not_found')
      // The API reads the message as it answers, so one that isn't there is its 404.
      const { targets } = await syncApi<{ targets: Omit<Protocol['synced']['output']['targets'][number], 'url'>[] }>(
        who,
        'GET',
        await onBoard(who, `/messages/${encodeURIComponent(id)}/synced`),
        { signal },
      )
      // The API keeps platform IDs and parses no URLs: the board's own sync knows its platforms' links.
      return {
        targets: await Promise.all(
          targets.map(async (target) => ({ ...target, url: binding && target.thread !== null && target.message !== null ? await binding.linkOf(target.key, target.thread, target.message) : null })),
        ),
      }
    },
    async linked(caller, { url }, signal) {
      const who = whoOf(caller)
      const missing = () => notFound('no message on this board for that link', 'message_not_found')
      // The API never parses a platform's link: the platforms this board syncs read it, and any key of that platform may have synced it.
      for (const { platform, thread, message } of binding?.locate(url) ?? [])
        for (const key of new Set([...(binding?.sync ?? []).filter((entry) => entry.platform === platform).map((entry) => entry.key), platform])) {
          const found = await syncApi<{ thread: string; message: string }>(who, 'GET', await onBoard(who, '/sync/linked'), {
            query: { thread: `${key}:${thread}`, ...(message !== null ? { message } : {}) },
            signal,
          }).catch((error: unknown) => {
            if (error instanceof HttpError && error.status === 404) return null
            throw error
          })
          // A message it finds that the caller can't read is as missing as one it doesn't.
          if (found) {
            return methods.message(caller, { id: found.message }, signal).catch((error: unknown) => {
              if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
                throw missing()
              }
              throw error
            })
          }
        }
      throw missing()
    },
    async inboxPush(caller, { key, events }, signal) {
      const who = whoOf(caller)
      // The API orders by an opaque key and never reads an event: a platform thread's events go on its lane.
      await syncApi(who, 'POST', await inboxPath(who, key), { body: { events: events.map(({ id, event, raw }) => ({ id, thread: event.thread, event, ...(raw !== undefined ? { raw } : {}) })) }, signal })
      return { ok: true }
    },
    async inboxNext(caller, { key, limit }, signal) {
      const who = whoOf(caller)
      const { items } = await syncApi<{ items: (Omit<Protocol['inboxNext']['output']['items'][number], 'raw'> & { raw?: unknown })[] }>(who, 'GET', await inboxPath(who, key, '/next'), {
        query: { limit: limit?.toString() },
        signal,
      })
      return { items: items.map(({ raw, ...item }) => ({ ...item, key, raw: raw ?? null })) }
    },
    async inboxAck(caller, { key, id, lease, error }, signal) {
      const who = whoOf(caller)
      await syncApi(who, 'POST', await inboxPath(who, key, `/${encodeURIComponent(id)}/ack`), { body: { lease, ...(error !== undefined ? { error } : {}) }, signal })
      return { ok: true }
    },
    async inbox(caller, { key, channel, limit }, signal) {
      const who = whoOf(caller)
      const wanted = Math.min(limit ?? 50, INBOX_LIST_MAX)
      // The API reads no event, so it can't filter by channel: this filters the most it lists, so a filtered read may come back short.
      const { events } = await syncApi<{ events: { id: string; thread: string; createdAt: string; event?: InboxEntry['event']; raw?: unknown }[] }>(who, 'GET', await inboxPath(who, key), {
        query: { limit: String(channel === undefined ? wanted : INBOX_LIST_MAX) },
        signal,
      })
      const entries = events.flatMap(({ id, createdAt, event, raw }) =>
        event ? [{ id, channel: typeof event.channel === 'string' ? event.channel : '', createdAt, sync: key, event, raw: raw ?? null }] : [],
      )
      return { events: (channel === undefined ? entries : entries.filter((entry) => entry.channel === channel)).slice(0, wanted) }
    },
    async watchers(caller) {
      const who = whoOf(caller)
      const { watchers } = await watchersApi<{ watchers: ApiRegistration[] }>(who, 'GET', await onBoard(who, '/watchers'))
      return {
        watchers: await Promise.all(
          watchers.map(async (found) => ({
            owner: found.owner,
            ...whereOf(found),
            watch: Object.fromEntries(await Promise.all(Object.entries(found.watch).map(async ([id, spec]) => [id, { tail: await tailOf(who, spec) }] as const))),
            sync: syncOf(found),
            hash: found.hash,
          })),
        ),
      }
    },
    async register(caller, body) {
      if (typeof body.url === 'string')
        throw new HttpError(400, 'invalid_request', "Vercel's API wakes a deployment only by its path.", { hint: 'Register a path, or no url to pull its matches.', origin: 'handle' })
      return registerAs(whoOf(caller), typeof body.path === 'string' ? { path: body.path, ...(body.branch ? { branch: body.branch } : {}) } : { url: body.url ?? null }, body.watch, body.sync ?? [], false)
    },
    async matches(caller, query, signal) {
      return { matches: await pullAs(whoOf(caller), query, signal) }
    },
    async ack(caller, { id, ...body }) {
      await ackAs(whoOf(caller), id, body)
      return { ok: true }
    },
  }

  // Any use of the board is when its watchers can register: its URL is known from a request by then.
  // board() serves no requests here, so every call is this deployment's own code's.
  const starting = Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (caller: Caller, ...args: unknown[]) => {
        if ('identity' in caller) throw servesNone()
        if (binding) void start()
        return (method as (...input: unknown[]) => unknown)(caller, ...args)
      },
    ]),
  ) as unknown as ProtocolMethods

  const backend = {
    ...starting,
    // Its own routes are wake-ups and registering: who may do what on the board is Vercel's API's to say.
    routes,
    // The board is Vercel's: a board here answers only wake-ups and webhooks.
    keeps: false,
    // Vercel's API posts each send, so board()'s middleware screens a schedule when it's made.
    sendsSchedulesHere: false,
    bind(next: BoardBinding) {
      if (binding) throw new Error('vercel: this backend already serves a board: create one vercel() per board()')
      // board({ team }) says whose board it is: a team of vercel()'s own must be the same one.
      if (options.team && next.team && options.team !== next.team)
        throw new Error(`vercel: board() names team ${next.team}, and vercel() team ${options.team}: name the team once`)
      for (const id of Object.keys(next.subscriptions)) own.add(id)
      tails = Object.fromEntries(
        Object.entries(next.subscriptions).flatMap(([id, subscription]) => (subscription.kind === 'tail' ? [[id, { tail: subscription.tail }]] : [])),
      )
      binding = next
    },
    /** Registers this board's watchers with Vercel's API now, as `POST /watchers` does: only a deployment's. */
    async registerWatchers() {
      if (await isDeployment()) return runner.registerNow()
      void start()
      throw notADeployment()
    },
    /** Stops pulling, for a board that pulls on its own, and the tails of one that runs them here. */
    close() {
      runner.close()
      here?.close()
      here = null
    },
  }
  return backend satisfies Backend
}

export type VercelBackend = ReturnType<typeof createVercel>
