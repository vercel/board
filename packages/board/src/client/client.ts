import type {
  ActorView,
  BoardEventView,
  ChannelView,
  Discovery,
  EventsPage,
  EventsQueryInput,
  FiltersInput,
  IdentityView,
  InboxEntry,
  InboxItem,
  LinkedAccount,
  SyncAccountInput,
  SyncCodeView,
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
  MatchView,
  MessagesPage,
  MessagesQueryInput,
  MessageView,
  RegistrationView,
  ScheduleView,
  SchedulesQueryInput,
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

export class BoardError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.status = status
  }
}

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

export type ReplyOptions = Omit<PostOptions, 'sync'>

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
  if (!match) throw new BoardError('invalid_duration', `invalid duration: ${value}`, 0)
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
    actors: async () => (await call<{ actors: (Actor & { person?: ActorView['person'] })[] }>('GET', '/actors')).actors,

    /** Your linked platform accounts, and the sync entries you haven't linked (`unlinked`). */
    identity: () => call<IdentityView>('GET', '/identity'),
    /** Unlinks one of your accounts, by actor ID or handle. History keeps its messages as they were. */
    unlinkAccount: (account: string) => call<{ ok: true; actor: string }>('POST', '/identity/unlink', { body: { actor: account } }),

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
    schedules: async (query: SchedulesQueryInput = {}) =>
      (await call<{ schedules: ScheduleView[] }>('GET', `/schedules${queryString(query)}`)).schedules,
    /** Stops a schedule: yours, or any with manage in its channel. `canceled` is false when it was already done or canceled. */
    cancelSchedule: (id: string) =>
      call<{ schedule: ScheduleView; canceled: boolean }>('POST', `/schedules/${path(id)}/cancel`, { body: {} }),
    /**
     * Stores a file on the board, for a post or reply's `attachments`. Up to 4 MB goes in one
     * request; bigger, up to 100 MB, goes straight to the board's blob store on a URL the board
     * signs, where its store can (`no_direct_uploads` where it can't).
     */
    async upload(input: UploadInput): Promise<Attachment> {
      const type = input.type || (input.data instanceof Blob ? input.data.type : '') || typeOf(input.name)
      const size = input.data instanceof Blob ? input.data.size : input.data.byteLength
      if (size > ATTACHMENT_BYTES_MAX) {
        if (size > DIRECT_UPLOAD_BYTES_MAX) throw new BoardError('too_large', `attachments are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`, 413)
        const ticket = await call<{ id: string; url: string; headers: Record<string, string> }>('POST', '/attachments/uploads', { body: { name: input.name, type, size } }).catch((error: unknown) => {
          // A board from before direct uploads has no such route.
          if (error instanceof BoardError && error.status === 404 && error.code === 'not_found')
            throw new BoardError('too_large', `this board takes files of at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`, 413)
          throw error
        })
        // The store's URL carries its own signature: the board's token stays with the board.
        const put = await storeFetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: input.data })
        if (!put.ok) throw new BoardError('upload_failed', `the blob store refused the file: ${put.status} ${(await put.text().catch(() => '')).slice(0, 300) || put.statusText}`, put.status)
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
    edit: (id: string, text: string) =>
      call<{ ok: true; unknownMentions?: string[] }>('POST', `/messages/${path(id)}/edit`, { body: { text } }),
    delete: (id: string) => call<{ ok: true }>('POST', `/messages/${path(id)}/delete`, { body: {} }),
    /** `emoji` is a short name, `:name:`, or the character itself. */
    react: (id: string, emoji: string, opts: { remove?: boolean } = {}) =>
      call<{ ok: true }>('POST', `/messages/${path(id)}/reactions`, {
        body: { emoji: normalizeEmoji(emoji), ...opts },
      }),
    label: (id: string, change: { set?: Record<string, string>; unset?: string[] }) =>
      call<{ ok: true }>('POST', `/messages/${path(id)}/labels`, { body: change }),
    /**
     * Shows typing in the platform threads the message's thread is synced to
     * (on WhatsApp, also marking the latest inbound message read). Ephemeral:
     * nothing goes in the log. Answers the external threads that took it.
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
    register: (input: { url?: string | null; path?: string | null; branch?: string | null; watch: Record<string, { tail: string; when?: 'matches' | 'enters' }>; sync?: { key: string; platform: string; signIn?: boolean }[] }) =>
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
    readSource: (key: string, target: string, opts: { limit?: number } = {}) =>
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
    /** What platform IDs are on the board: a thread, a message, who an account is, a person's accounts. */
    syncFind: (query: SyncFindInput, opts: { signal?: AbortSignal } = {}) =>
      call<SyncFindView>('GET', `/sync/find${queryString(query)}`, opts.signal ? { signal: opts.signal } : {}),
    /** Messages' copies on platforms, by message and target. */
    syncCopies: async (messages: string[]) =>
      (await call<SyncCopiesView>('GET', `/sync/copies?${messages.map((id) => `message=${encodeURIComponent(id)}`).join('&')}`)).copies,
    /** A person's roots since `since`. */
    syncRoots: async (by: string, since: Date | number) =>
      (await call<{ roots: MessageView[] }>('GET', `/sync/roots${queryString({ by, since: since instanceof Date ? since.getTime() : since })}`)).roots,
    /** Pushes platform events into your inbox for sync key `key`; each platform ID lands once. */
    inboxPush: (key: string, events: { id: string; event: InboxItem['event']; raw: unknown }[]) =>
      call<{ ok: true }>('POST', `/inbox/${path(key)}`, { body: { events } }),
    /** Your next inbox events for `key`, leased to you until you ack them, one platform thread at a time. */
    inboxNext: async (key: string, opts: { limit?: number } = {}) =>
      (await call<{ items: InboxItem[] }>('GET', `/inbox/${path(key)}/next${queryString(opts)}`)).items,
    /** How an inbox event went: done, or an error to try it again. */
    inboxAck: (key: string, id: string, body: { lease: string; error?: string }) =>
      call<{ ok: true }>('POST', `/inbox/${path(key)}/${path(id)}/ack`, { body }),
    /**
     * A one-time code for linking your account on sync entry `sync`, to post from that account where
     * the board syncs, and `signIn` when the entry signs people in: open it (only you) and approve.
     * Only people get one, each for themselves. `identity()` shows the link once it's made.
     */
    syncCode: (sync: string) => call<SyncCodeView>('POST', '/sync/codes', { body: { sync } }),
    /** Links a platform account to whoever a code was issued to: one posted from it, or carried through its sign-in. */
    syncAccount: (body: SyncAccountInput) => call<{ person: string; link: LinkedAccount }>('POST', '/sync/accounts', { body }),
    /** Unlinks a platform account: your own, or anyone's with `sync`. */
    syncUnlink: (account: string) => call<{ ok: true }>('POST', '/sync/accounts/unlink', { body: { account } }),

    /** Live events. Reconnects from the last seen index whenever the stream closes. */
    async *events(
      query: Filters & Pick<EventsQueryInput, 'after' | 'all'> = {},
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

export type { ActorView, BoardEventView, ChannelView, Discovery, EventsPage, IdentityView, Me, MessagesPage, MessageView, ScheduleView, ThreadsPage, ThreadSummaryView, ThreadView }

async function toError(response: Response): Promise<BoardError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message)
      return new BoardError(body.error.code ?? 'error', body.error.message, response.status)
  } catch {}
  return new BoardError('http_error', `${response.status} ${response.statusText}`, response.status)
}
