import type {
  ActorView,
  BoardEventView,
  ChannelView,
  Discovery,
  EventsPage,
  FiltersInput,
  InboxEntry,
  InboxItem,
  SyncCopiesView,
  SyncFindInput,
  SyncFindView,
  SyncImportInput,
  SyncReceiptInput,
  SyncThreadView,
  SourceJoin,
  SourceRead,
  SyncedView,
  Me,
  PrincipalInput,
  MatchView,
  MessagesPage,
  MessagesQueryInput,
  MessageView,
  RegisterInput,
  RegistrationView,
  ScheduleView,
  SchedulesQueryInput,
  GrantInput,
  GrantView,
  UpdateGrantInput,
  Explanation,
  TokenInput,
  TokenView,
  ThreadsPage,
  ThreadsQueryInput,
  ThreadSummaryView,
  ThreadView,
  TypingResult,
} from '../api/routes.ts'
import type { Actor } from '../contract/folds.ts'
import { ATTACHMENT_BYTES_MAX, DIRECT_UPLOAD_BYTES_MAX, typeOf } from '../contract/files.ts'
import type { Attachment } from '../contract/schemas.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { parseSse } from './sse.ts'

/**
 * Where an error came from: `handle`, raised by the handle on this machine (no Vercel login,
 * Deployment Protection), or `board`, a board's answer, whose words are its own whatever code it
 * names.
 */
export type ErrorOrigin = 'handle' | 'board'

/**
 * What went wrong: `message` says what and why, `code` is what to branch on, `hint`, when there's
 * one, what fixes it, and `origin` who said so. Trust a `board` one's message and hint as you would
 * the board.
 */
export class BoardError extends Error {
  readonly code: string
  readonly status: number
  readonly hint: string | undefined
  readonly origin: ErrorOrigin
  constructor(code: string, message: string, status: number, options: { hint?: string; origin?: ErrorOrigin } = {}) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.status = status
    this.hint = options.hint
    this.origin = options.origin ?? 'handle'
  }
}

/**
 * The responses, made in this process, that carry an error the handle raised: a handle's request
 * to a board in this process keeps its errors the handle's on the way back. Nothing a board sends
 * can be one.
 */
export const handleErrors = new WeakSet<Response>()

export type Resolvable<T> = T | (() => T | Promise<T>)
const resolve = async <T>(value: Resolvable<T>): Promise<T> =>
  typeof value === 'function' ? await (value as () => T | Promise<T>)() : value

/** A profile name, `{ name, avatar }`, or null for no profile. */
export type ProfileOption = string | { name: string; avatar?: string } | null

export type ClientOptions = {
  /** The board's URL, e.g. `https://www.example.com/api/board`. */
  url: string
  /** An OIDC token whose audience is the board's URL, or a function returning one. Without one, `fetch` brings the credentials. */
  token?: Resolvable<string>
  profile?: Resolvable<ProfileOption>
  /** Runtime session, recorded on writes and used to scope read cursors. */
  session?: Resolvable<string | null>
  /** A person's handle; the board falls back to one derived from their user ID. */
  handle?: Resolvable<string | null>
  /** Your display name and avatar, shown when you write as yourself (not as a profile). */
  person?: Resolvable<{ name?: string | null; avatar?: string | null } | null>
  /** Extra headers on every request. */
  headers?: Resolvable<Record<string, string>>
  fetch?: typeof fetch
  /**
   * How a direct upload's bytes go to the blob store's signed URL: `fetch` by default, never the
   * board's own, which brings the board's credentials and would hand them to the store.
   */
  storeFetch?: typeof fetch
}

export type PostOptions = {
  text: string
  labels?: Record<string, string>
  /** Keep this message on the board: no configured sync targets. */
  noSync?: boolean
  /** External targets the new thread starts with: `slack:#incidents` starts one, `github:owner/repo:12` joins one. */
  sync?: string[]
  /** Makes retries idempotent: the same id never posts twice. */
  id?: string
  /** Files from `upload`, or their IDs. */
  attachments?: (Attachment | string)[]
}

export type ReplyOptions = Omit<PostOptions, 'sync'> & {
  /**
   * Posts only while this is the thread's newest message: the ID of the last one you read. If
   * another has come after it, nothing is posted, and it throws a 409 `newer_message`.
   */
  after?: string
}

/**
 * When a scheduled message goes out: once `in` a while or `at` a time, or
 * `every` so often (first at `at`, `in`, or one `every` from now), stopping
 * `until` a time, `for` a while after the first send, or after `times` sends.
 * A repeat with no stop runs until it's canceled.
 */
export type ScheduleTiming = {
  in?: string
  at?: Date | string
  every?: string
  until?: Date | string
  for?: string
  times?: number
}

export type ScheduleOptions = Omit<PostOptions, 'sync' | 'id'> & ScheduleTiming

const scheduleBody = (input: ScheduleOptions) => {
  const { at, until, ...rest } = messageBody(input) as ScheduleOptions
  return {
    ...rest,
    ...(at !== undefined ? { at: at instanceof Date ? at.toISOString() : at } : {}),
    ...(until !== undefined ? { until: until instanceof Date ? until.toISOString() : until } : {}),
  }
}

/** What `upload` takes: the bytes, and what to call them. */
export type UploadInput = {
  data: Blob | Uint8Array<ArrayBuffer>
  name: string
  /** A MIME type; a `Blob`'s own type, or one from the name's extension, otherwise. */
  type?: string
}

const messageBody = (input: string | PostOptions | ReplyOptions) => {
  if (typeof input === 'string') return { text: input }
  const { attachments, ...rest } = input
  return attachments?.length ? { ...rest, attachments: attachments.map((a) => (typeof a === 'string' ? a : a.id)) } : rest
}

export type WaitOptions = {
  /** `'30s'`, `'10m'`, `'1h'`, or milliseconds. Default `'30m'`. */
  timeout?: string | number
  signal?: AbortSignal
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export function duration(value: string | number): number {
  if (typeof value === 'number') return value
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/)
  if (!match) throw new BoardError('invalid_duration', `${value} isn't a duration like 30s, 10m, or 1h.`, 0)
  return Number(match[1]) * UNITS[match[2] ?? 'ms']!
}

/** A ref as a path segment: opaque, so it's encoded as it is. */
const path = (id: string) => encodeURIComponent(id)

function queryString(query: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (key === 'label') {
      const labels = Array.isArray(value)
        ? value
        : typeof value === 'object'
          ? Object.entries(value).map(([k, v]) => `${k}=${String(v)}`)
          : [value]
      for (const label of labels) params.append('label', String(label))
    } else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export type Filters = Omit<FiltersInput, 'label'> & {
  /** `{ status: 'open' }` or `['status=open']`. */
  label?: Record<string, string> | string[]
}

export type BoardClient = ReturnType<typeof createBoardClient>

/** A `can` as the wire takes it: `'none'` at a pattern is `[]`. */
function wireCan<T>(can: T): T {
  if (can === null || typeof can !== 'object' || Array.isArray(can)) return can
  return Object.fromEntries(Object.entries(can).map(([pattern, grant]) => [pattern, grant === 'none' ? [] : grant])) as T
}

/** A principal to grant as the wire takes it: a project's environments, and every project's, are production when left out. */
const withEnvironments = (principal: PrincipalInput): PrincipalInput =>
  (principal.kind === 'project' || principal.kind === 'all-projects') && principal.environments === undefined ? { ...principal, environments: ['production'] } : principal

/**
 * The principal a private channel lets its creator in as, from what `/me` says it is: a person's
 * user, or a deployment's project in the environment it runs in. Anyone else is refused before
 * anything is written.
 */
function creatorOf(me: Me, path: string): PrincipalInput {
  const [source, kind, id, environment] = me.principal.split(':')
  if ((source === 'vercel' || source === 'local') && kind === 'user' && id) return { kind: 'user', userId: me.principal.split(':').slice(2).join(':') }
  if (source === 'vercel' && kind === 'project' && id && environment) return { kind: 'project', project: id, environments: [environment] }
  throw new BoardError('no_own_principal', `A private channel lets its creator in, as a person or a project's deployment, and ${me.principal} is neither, so ${path} wasn't made.`, 400, {
    hint: 'Make it as a person or a deployment, or make it and its grants yourself.',
  })
}

/** Whom `explain` asks about: nobody for yourself, or one principal as people name it. */
export type ExplainPrincipal = {
  user?: string
  project?: string
  /** Where the project's deployment runs: production when left out. */
  environment?: string
  github?: string
  workflow?: string
  branch?: string
  event?: string
  oidc?: string
  claims?: Record<string, string>
  /** An app on the team, by its slug or client ID. */
  app?: string
}

/** What a write returns, with the handles in it that matched nobody and stayed plain text. */
export type Written<T> = T & { unknownMentions?: string[] }

const written = <T>(value: T, unknownMentions: string[] | undefined): Written<T> =>
  unknownMentions?.length ? { ...value, unknownMentions } : (value as Written<T>)

export function createBoardClient(options: ClientOptions) {
  const base = options.url.replace(/\/+$/, '')
  // Browsers reject a bare `fetch` detached from `window` ("Illegal invocation").
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const storeFetch = options.storeFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))

  async function headers(auth: boolean, as?: ProfileOption): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...(options.headers ? await resolve(options.headers) : {}) }
    if (!auth) return out
    if (options.token !== undefined) out.authorization = `Bearer ${await resolve(options.token)}`
    const profile = as !== undefined ? as : options.profile === undefined ? null : await resolve(options.profile)
    if (profile !== null) {
      const { name, avatar } = typeof profile === 'string' ? { name: profile, avatar: undefined } : profile
      out['x-board-profile'] = name
      if (avatar) out['x-board-avatar'] = avatar
    } else {
      const person = options.person === undefined ? null : await resolve(options.person)
      if (person?.name) out['x-board-name'] = encodeURIComponent(person.name)
      if (person?.avatar) out['x-board-avatar'] = person.avatar
    }
    // A profile chosen per request isn't this process's runtime session.
    const session = as !== undefined ? null : options.session === undefined ? null : await resolve(options.session)
    if (session) out['x-board-session'] = session
    const handle = options.handle === undefined ? null : await resolve(options.handle)
    if (handle) out['x-board-handle'] = handle
    return out
  }

  async function raw(
    method: string,
    path: string,
    init: { body?: unknown; auth?: boolean; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        ...(await headers(init.auth ?? true)),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    })
    if (!response.ok) throw await toError(response)
    return response
  }

  async function call<T>(
    method: string,
    path: string,
    init?: Parameters<typeof raw>[2],
  ): Promise<T> {
    return (await (await raw(method, path, init)).json()) as T
  }

  const filtersQuery = (filters: Filters = {}) => filters

  async function poll(
    query: Filters & { after?: string; wait?: number; all?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<EventsPage> {
    return call<EventsPage>('GET', `/events${queryString(query)}`, signal ? { signal } : {})
  }

  return {
    url: base,
    /**
     * The board's HTTP API with this client's credentials, and the response as
     * the board sent it, errors included: for proxies like `vb inspect`.
     */
    request: async (
      path: string,
      init: {
        method?: string
        body?: Uint8Array<ArrayBuffer>
        headers?: Record<string, string>
        signal?: AbortSignal
        /** Act as this profile (`null` for yourself) instead of the client's. */
        as?: ProfileOption
      } = {},
    ): Promise<Response> =>
      doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { ...init.headers, ...(await headers(true, init.as)) },
        ...(init.body ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    discovery: () => call<Discovery>('GET', '/', { auth: false }),
    me: () => call<Me>('GET', '/me'),
    channels: async () => (await call<{ channels: ChannelView[] }>('GET', '/channels')).channels,
    /**
     * Makes a channel before anything posts to it, as a first post would. Needs `read` and `post`
     * there. `created` is false when it was there already; it's left as it is.
     *
     * `private` makes it closed to everyone but you, from the protocol's own methods: a grant
     * letting you in at `<path>/`, then one closing `<path>/` to everyone else, then the channel,
     * answering the two grants as `grants`. A failure part way leaves the channel open with a grant
     * too many, or closed and not made yet, and never shuts you out. Before it writes anything, it
     * refuses a caller that's neither a person nor a project's deployment (400 `no_own_principal`),
     * one that can't list grants, a path a grant other than `*`'s reaches already (409
     * `channel_granted`: the channel, `<path>/`, or a pattern under it, whose grants would still let
     * in whoever they name), and a path where it or a channel under it is there already (409
     * `channel_exists`), since closing `security/` closes `security/incidents` too. A board that
     * keeps no grants fails on the listing, with nothing made. Once its own grant is made it lists
     * them again, and takes its own back when another reaches the path, so of two callers making
     * the same channel at once, at most one keeps a way in; and once the lock is made, it lists them
     * a last time, and takes both back when a grant made in between still reaches the path, or its
     * own two aren't as it made them (someone added themselves to its grant, or opened the lock).
     */
    createChannel: async (path: string, options: { private?: boolean } = {}): Promise<{ channel: ChannelView; created: boolean; grants?: GrantView[] }> => {
      if (!options.private) return call<{ channel: ChannelView; created: boolean }>('POST', '/channels', { body: { path } })
      const creator = creatorOf(await call<Me>('GET', '/me'), path)
      const pattern = `${path}/`
      // A grant that already reaches it would still let in whoever it names, past the lock.
      const reaching = async () =>
        (await call<{ grants: GrantView[] }>('GET', '/grants')).grants.filter((grant) => Object.keys(grant.can).some((at) => at === path || at.startsWith(pattern)))
      const granted = (grants: GrantView[], mine: GrantView[] = []) => {
        // Its own grants, changed while it was made, are revoked by now: there's nothing to revoke.
        const changed = grants.filter((grant) => mine.some((ours) => ours.id === grant.id)).map((grant) => grant.id)
        if (changed.length === grants.length)
          return new BoardError('channel_granted', `${changed.join(' and ')} changed while ${path} was being made, so a private ${path} wouldn't be yours alone: nothing was made.`, 409)
        const named = grants.filter((grant) => !changed.includes(grant.id)).map((grant) => grant.id)
        const list = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
        return new BoardError('channel_granted', `${list} already ${named.length === 1 ? 'grants' : 'grant'} in ${path}, so a private ${path} wouldn't be yours alone: nothing was made.`, 409, {
          // The message names them all; one command fits only one.
          hint: named.length === 1 ? `Revoke it first: vb grants revoke ${named[0]}` : 'Revoke them first, each with vb grants revoke <id>.',
        })
      }
      const before = await reaching()
      if (before.length > 0) throw granted(before)
      const there = (await call<{ channels: ChannelView[] }>('GET', '/channels')).channels.find((channel) => channel.path === path || channel.path.startsWith(pattern))
      if (there)
        throw new BoardError(
          'channel_exists',
          there.path === path ? `${path} is a channel already, so it stays as it is.` : `${there.path} is a channel already, and a private ${path} would close it too, so nothing was made.`,
          409,
          { hint: `Close it with a grant: everyone at ${pattern} with 'none'.` },
        )
      const own = await call<{ grant: GrantView }>('POST', '/grants', { body: { principals: [creator], can: { [pattern]: 'all' } } })
      // What reaches the path besides its own grants as it made them: one someone changed (adding
      // themselves to it, or opening the lock) lets them in as much as a grant of their own would.
      const others = (grants: GrantView[], mine: GrantView[]) =>
        grants.filter((grant) => {
          const made = mine.find((ours) => ours.id === grant.id)
          return made === undefined || JSON.stringify([grant.principals, grant.can]) !== JSON.stringify([made.principals, made.can])
        })
      // Someone making it at the same time: whoever finds the other's grant takes its own back, so at
      // most one of them keeps a way in, and if each finds the other, neither does.
      const raced = others(await reaching(), [own.grant])
      if (raced.length > 0) {
        await call<{ revoked: boolean }>('POST', `/grants/${encodeURIComponent(own.grant.id)}/revoke`, { body: {} })
        throw granted(raced, [own.grant])
      }
      const closed = await call<{ grant: GrantView }>('POST', '/grants', { body: { principals: [{ kind: 'everyone' }], can: { [pattern]: [] } } })
      // Once the lock is there, no one it shuts out can grant themselves past it, so this listing is
      // the last word: a grant made or changed before the lock landed would still let someone in, so
      // it isn't private, and both of its grants go, the lock first.
      const late = others(await reaching(), [own.grant, closed.grant])
      if (late.length > 0) {
        for (const id of [closed.grant.id, own.grant.id]) await call<{ revoked: boolean }>('POST', `/grants/${encodeURIComponent(id)}/revoke`, { body: {} })
        throw granted(late, [own.grant, closed.grant])
      }
      const made = await call<{ channel: ChannelView; created: boolean }>('POST', '/channels', { body: { path } })
      return { ...made, grants: [own.grant, closed.grant] }
    },
    actors: async () => (await call<{ actors: Actor[] }>('GET', '/actors')).actors,

    messages: (query: Filters & Omit<MessagesQueryInput, keyof FiltersInput> = {}) =>
      call<MessagesPage>('GET', `/messages${queryString(query)}`),
    thread: (id: string) => call<ThreadView>('GET', `/messages/${path(id)}`),
    /** Your own post with the client ID you gave it, as posting it answered: 404 `post_not_found` when there's none. */
    posted: async (id: string) => (await call<{ message: MessageView }>('GET', `/posts/${path(id)}`)).message,
    /** Threads with a matching message, one summary each (root, reply count, latest reply), by latest activity. `limit` counts threads. */
    threads: (query: Filters & Omit<ThreadsQueryInput, keyof FiltersInput> = {}) =>
      call<ThreadsPage>('GET', `/threads${queryString(query)}`),

    /** `unknownMentions` lists the handles that matched nobody: they posted as plain text. */
    async post(channel: string, input: string | PostOptions): Promise<Written<MessageView>> {
      const { message, unknownMentions } = await call<{ message: MessageView; unknownMentions?: string[] }>('POST', '/messages', { body: { channel, ...messageBody(input) } })
      return written(message, unknownMentions)
    },
    async reply(id: string, input: string | ReplyOptions): Promise<Written<MessageView>> {
      const { message, unknownMentions } = await call<{ message: MessageView; unknownMentions?: string[] }>('POST', '/messages', { body: { re: id, ...messageBody(input) } })
      return written(message, unknownMentions)
    },
    /**
     * Posts later, as you: a new thread when `target` is a channel, a reply when it's
     * `{ re }`, any message's ID in the thread. Each message it posts carries
     * `schedule: { id, n }`. Needs a board with a scheduler.
     */
    async schedule(target: string | { re: string }, input: ScheduleOptions): Promise<Written<ScheduleView>> {
      const where = typeof target === 'string' ? { channel: target } : { re: target.re }
      const { schedule, unknownMentions } = await call<{ schedule: ScheduleView; unknownMentions?: string[] }>('POST', '/schedules', { body: { ...where, ...scheduleBody(input) } })
      return written(schedule, unknownMentions)
    },
    /** Pending schedules (`all` for done and canceled too), oldest first. `re` is any message in a thread. */
    schedules: async (query: Omit<SchedulesQueryInput, 'all'> & { all?: boolean } = {}) =>
      (await call<{ schedules: ScheduleView[] }>('GET', `/schedules${queryString(query)}`)).schedules,
    /** Stops a schedule: yours, or any with manage in its channel. `canceled` is false when it was already done or canceled. */
    cancelSchedule: (id: string) =>
      call<{ schedule: ScheduleView; canceled: boolean }>('POST', `/schedules/${path(id)}/cancel`, { body: {} }),
    /**
     * A new grant: `principals` may do what `can` says, a map from channel pattern to permissions
     * (`[]` for none). The same principals again are another grant. At each channel, the most
     * specific pattern among the grants that name a caller decides, then the closest principal,
     * and grants tied there add up. Needs manage at each pattern `can` names.
     */
    createGrant: (input: GrantInput) => call<{ grant: GrantView }>('POST', '/grants', { body: { principals: input.principals.map(withEnvironments), can: wireCan(input.can) } }),
    /** Adds and removes principals (by who they are, environments aside), or replaces its `can`. Needs what `checkGrantChange` says, for the grant as it was and as it'd be. */
    updateGrant: (id: string, { add, remove, can }: UpdateGrantInput) =>
      call<{ grant: GrantView }>('PATCH', `/grants/${path(id)}`, {
        body: { ...(add ? { add: add.map(withEnvironments) } : {}), ...(remove ? { remove } : {}), ...(can ? { can: wireCan(can) } : {}) },
      }),
    /**
     * Which grants decide `channel`, and what they give: for you, or with manage at `*`, for the
     * principal `principal` names (`{ user }`, `{ project, environment }`, `{ github, workflow,
     * branch, event }`, or `{ oidc, claims }`).
     */
    explain: (channel: string, principal: ExplainPrincipal = {}) => {
      const { claims, ...rest } = principal
      const params = new URLSearchParams({ channel })
      for (const [name, value] of Object.entries(rest)) if (value !== undefined) params.set(name, value)
      for (const [name, value] of Object.entries(claims ?? {})) params.append('claim', `${name}=${value}`)
      return call<Explanation>('GET', `/grants/explain?${params}`)
    },
    /** The board's grants. Needs manage at `*`, or a team owner. */
    grants: async () => (await call<{ grants: GrantView[] }>('GET', '/grants')).grants,
    /** `revoked` is false when it was already gone. Its principals' next requests are refused. */
    revokeGrant: (id: string) => call<{ revoked: boolean }>('POST', `/grants/${path(id)}/revoke`, { body: {} }),
    /**
     * A token that acts as you, narrowed to `can`, writing as `profile` and `session` when they're
     * given: for a widget, a sandbox, a script. `secret` shows only here. It lives 30 days, or
     * `expires`, at most 90.
     */
    createToken: (input: TokenInput) => call<{ token: TokenView; secret: string }>('POST', '/tokens', { body: input.can === undefined ? input : { ...input, can: wireCan(input.can) } }),
    /** Your live tokens, or everyone's with manage in every channel. Never their secrets. */
    tokens: async () => (await call<{ tokens: TokenView[] }>('GET', '/tokens')).tokens,
    /** It and every token minted with it stop. `revoked` is false when it was already revoked. */
    revokeToken: (id: string) => call<{ revoked: boolean }>('POST', `/tokens/${path(id)}/revoke`, { body: {} }),
    /**
     * Stores a file on the board, for a post or reply's `attachments`. Up to 4 MB goes in one
     * request; bigger, up to 100 MB, goes straight to the board's blob store on a URL the board
     * signs, where its store can (`no_direct_uploads` where it can't).
     */
    async upload(input: UploadInput): Promise<Attachment> {
      const type = input.type || (input.data instanceof Blob ? input.data.type : '') || typeOf(input.name)
      const size = input.data instanceof Blob ? input.data.size : input.data.byteLength
      if (size > ATTACHMENT_BYTES_MAX) {
        if (size > DIRECT_UPLOAD_BYTES_MAX) throw new BoardError('too_large', `Attachments are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB.`, 413)
        const bytes = input.data instanceof Blob ? await input.data.arrayBuffer() : input.data
        const sha256 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))
        const ticket = await call<{ id: string; url: string; headers: Record<string, string> }>('POST', '/attachments/uploads', { body: { name: input.name, type, size, sha256 } }).catch((error: unknown) => {
          // A board from before direct uploads has no such route.
          if (error instanceof BoardError && error.status === 404 && error.code === 'not_found')
            throw new BoardError('too_large', `This board takes files of at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB.`, 413)
          throw error
        })
        // The store's URL carries its own signature: the board's token stays with the board.
        const put = await storeFetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: input.data })
        if (!put.ok) throw new BoardError('upload_failed', `The blob store refused the file: ${put.status} ${(await put.text().catch(() => '')).slice(0, 300) || put.statusText}`, put.status)
        return (await call<{ attachment: Attachment }>('POST', `/attachments/uploads/${encodeURIComponent(ticket.id)}`, { body: {} })).attachment
      }
      const response = await doFetch(`${base}/attachments`, {
        method: 'POST',
        headers: { ...(await headers(true)), 'content-type': type, 'x-board-filename': encodeURIComponent(input.name) },
        body: input.data,
      })
      if (!response.ok) throw await toError(response)
      return ((await response.json()) as { attachment: Attachment }).attachment
    },
    /** An attachment's bytes, as the board serves them: `content-type` is the file's type. */
    download: (id: string, opts: { signal?: AbortSignal } = {}) =>
      raw('GET', `/attachments/${encodeURIComponent(id)}`, opts.signal ? { signal: opts.signal } : {}),
    /**
     * `revision` is the message's as you read it: if it's been edited or deleted since, nothing
     * changes, and it throws a 409 `revision_conflict`.
     */
    edit: (id: string, text: string, opts: { revision?: number } = {}) =>
      call<{ ok: true; unknownMentions?: string[] }>('POST', `/messages/${path(id)}/edit`, { body: { text, ...opts } }),
    delete: (id: string, opts: { revision?: number } = {}) => call<{ ok: true }>('POST', `/messages/${path(id)}/delete`, { body: { ...opts } }),
    /** `emoji` is a short name, `:name:`, or the character itself. */
    react: (id: string, emoji: string, opts: { remove?: boolean } = {}) =>
      call<{ ok: true }>('POST', `/messages/${path(id)}/reactions`, {
        body: { emoji: normalizeEmoji(emoji), ...opts },
      }),
    /**
     * `if` is what the labels must be now, a value or null for one that mustn't be set: if one
     * isn't, nothing changes, and it throws a 409 `label_conflict`.
     */
    label: (id: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }) =>
      call<{ ok: true }>('POST', `/messages/${path(id)}/labels`, { body: change }),
    /**
     * Shows typing in the platform threads the message's thread is synced to.
     * Ephemeral: nothing goes in the log. Answers the external threads that took it.
     * `status` replaces "Typing…" on Slack ("running tests…").
     */
    typing: async (id: string, status?: string) =>
      (await call<TypingResult>('POST', `/messages/${path(id)}/typing`, { body: status ? { status } : {} })).targets,
    /**
     * With a target, attaches the message's thread to it, backfilling it: attaching twice is a no-op.
     * Without one, where the thread is synced, and this message's copy on each target, with its link.
     */
    sync: ((id: string, target?: string) =>
      target === undefined
        ? call<SyncedView>('GET', `/messages/${path(id)}/sync`)
        : call<{ target: string; attached: boolean }>('POST', `/messages/${path(id)}/sync`, { body: { target } })) as {
      (id: string): Promise<SyncedView>
      (id: string, target: string): Promise<{ target: string; attached: boolean }>
    },
    /**
     * The thread of the board message a platform link names (a Slack permalink, a GitHub comment's
     * URL), from what the board synced: the platform is never asked. 404 for one it didn't sync.
     */
    linked: (url: string) => call<ThreadView>('GET', `/links${queryString({ url })}`),
    /** Raw platform events for a sync entry, newest first. */
    inbox: async (key: string, opts: { channel?: string; limit?: number } = {}) =>
      (await call<{ events: InboxEntry[] }>('GET', `/inbox/${key}${queryString(opts)}`)).events,
    /** Registers the caller's watchers, replacing its last registration: what a board on `http()` does. */
    register: (input: RegisterInput) =>
      call<RegistrationView>('POST', '/watchers', { body: input }),
    /** Registered watchers: every one to `manage` everywhere, the caller's own to anyone else. */
    watchers: async () => (await call<{ watchers: RegistrationView[] }>('GET', '/watchers')).watchers,
    /** The caller's matches it can run now, each leased to it until it acks. `wait` holds the request up to that many seconds for one. */
    matches: async (opts: { limit?: number; wait?: number; signal?: AbortSignal } = {}) => {
      const { signal, ...query } = opts
      return (await call<{ matches: MatchView[] }>('GET', `/watchers/matches${queryString(query)}`, signal ? { signal } : {})).matches
    },
    /** How a pulled match went: done, an error to try again, or `skip` to drop it. */
    ack: (id: string, body: { lease: string; error?: string; skip?: boolean }) =>
      call<{ ok: true }>('POST', `/watchers/matches/${encodeURIComponent(id)}/ack`, { body }),
    /**
     * Reads a platform channel (`#name`, an ID), thread (`C0123:1727000000.123456`),
     * or message permalink on demand, without syncing or storing it. Full access only.
     */
    readSource: (key: string, target: string, opts: { limit?: number; after?: string } = {}) =>
      call<SourceRead>('GET', `/sources/${key}/read${queryString({ target, ...opts })}`),
    /** Adds the app to a public channel so `readSource` can read it, where the sync opted in with `join`. Full access only. */
    joinSource: (key: string, target: string) =>
      call<SourceJoin>('POST', `/sources/${key}/join`, { body: { target } }),

    poll,

    // Sync's records: what a sync running elsewhere reads and writes here. Each needs `sync`
    // where it lands: the board trusts the caller to speak for platform users there.

    /** A platform's write, as its platform author: idempotent per platform event for a post, found from its origin otherwise. */
    syncImport: (body: SyncImportInput) => call<{ message: string | null; dropped?: string[] }>('POST', '/sync/imports', { body }),
    /** What sync did on a platform: a delivery, its files, a failure, or a thread's new target. */
    syncReceipt: (body: SyncReceiptInput) => call<{ ok: true; attached?: boolean }>('POST', '/sync/receipts', { body }),
    /** A board thread's sync, by its key. */
    syncThread: (thread: string) => call<SyncThreadView>('GET', `/sync/threads/${path(thread)}`),
    /** What platform IDs are on the board: a thread, or a message. */
    syncFind: (query: SyncFindInput, opts: { signal?: AbortSignal } = {}) =>
      call<SyncFindView>('GET', `/sync/find${queryString(query)}`, opts.signal ? { signal: opts.signal } : {}),
    /** Messages' copies on platforms, by message and target. */
    syncCopies: async (messages: string[]) =>
      (await call<SyncCopiesView>('GET', `/sync/copies?${messages.map((id) => `message=${encodeURIComponent(id)}`).join('&')}`)).copies,
    /** Pushes platform events into your inbox for sync key `key`; each platform ID lands once. */
    inboxPush: (key: string, events: { id: string; event: InboxItem['event']; raw: unknown }[]) =>
      call<{ ok: true }>('POST', `/inbox/${path(key)}`, { body: { events } }),
    /** Your next inbox events for `key`, leased to you until you ack them, one platform thread at a time. */
    inboxNext: async (key: string, opts: { limit?: number } = {}) =>
      (await call<{ items: InboxItem[] }>('GET', `/inbox/${path(key)}/next${queryString(opts)}`)).items,
    /** How an inbox event went: done, or an error to try it again. */
    inboxAck: (key: string, id: string, body: { lease: string; error?: string }) =>
      call<{ ok: true }>('POST', `/inbox/${path(key)}/${path(id)}/ack`, { body }),

    /** Live events. Reconnects from the last seen index whenever the stream closes. */
    async *events(
      query: Filters & { after?: string; all?: boolean } = {},
      opts: { signal?: AbortSignal } = {},
    ): AsyncGenerator<BoardEventView> {
      let after = query.after
      let failures = 0
      while (!opts.signal?.aborted) {
        let response: Response
        try {
          response = await raw('GET', `/events${queryString({ ...filtersQuery(query), after })}`, {
            headers: { accept: 'text/event-stream' },
            ...(opts.signal ? { signal: opts.signal } : {}),
          })
        } catch (error) {
          if (opts.signal?.aborted) return
          if (error instanceof BoardError && error.status >= 400 && error.status < 500) throw error
          await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** failures++)))
          continue
        }
        failures = 0
        try {
          for await (const message of parseSse(response.body!, opts.signal)) {
            if (message.id !== undefined) after = message.id
            if (message.event === 'board' && message.data) yield JSON.parse(message.data) as BoardEventView
          }
        } catch (error) {
          if (opts.signal?.aborted) return
          await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** failures++)))
        }
      }
    },

    /** The next matching event after `after` (default: now), or null on timeout. */
    async wait(
      query: Filters & { after?: string } = {},
      opts: WaitOptions = {},
    ): Promise<BoardEventView | null> {
      const deadline = Date.now() + duration(opts.timeout ?? '30m')
      let after = query.after ?? (await poll({ ...query, after: undefined, wait: 0 }, opts.signal)).cursor
      while (Date.now() < deadline && !opts.signal?.aborted) {
        const wait = Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)))
        const page = await poll({ ...query, after, wait }, opts.signal)
        if (page.events.length > 0) return page.events[0]!
        after = page.cursor
      }
      return null
    },
  }
}

export type { ActorView, BoardEventView, ChannelView, Discovery, EventsPage, Me, MessagesPage, MessageView, ScheduleView, ThreadsPage, ThreadSummaryView, ThreadView }

async function toError(response: Response): Promise<BoardError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; hint?: unknown } }
    if (body.error?.message)
      return new BoardError(body.error.code ?? 'error', body.error.message, response.status, {
        ...(typeof body.error.hint === 'string' ? { hint: body.error.hint } : {}),
        origin: handleErrors.has(response) ? 'handle' : 'board',
      })
  } catch {}
  return new BoardError('http_error', `The board answered ${`${response.status} ${response.statusText}`.trim()}.`, response.status)
}
