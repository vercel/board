import type {
  ActorView,
  BoardEventView,
  ChannelView,
  Discovery,
  EventsPage,
  EventsQueryInput,
  FiltersInput,
  IdentityChallenge,
  IdentityCheck,
  IdentityView,
  InboxEntry,
  StuckEvent,
  SourceRead,
  Me,
  MessagesPage,
  MessagesQueryInput,
  MessageView,
  ScheduleView,
  SchedulesQueryInput,
  ThreadsPage,
  ThreadsQueryInput,
  ThreadSummaryView,
  ThreadView,
  TypingResult,
} from '../api/routes.ts'
import type { Actor } from '../contract/reducers.ts'
import { typeOf } from '../contract/files.ts'
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

type Resolvable<T> = T | (() => T | Promise<T>)
const resolve = async <T>(value: Resolvable<T>): Promise<T> =>
  typeof value === 'function' ? await (value as () => T | Promise<T>)() : value

/** A profile name, `{ name, avatar }`, or null for no profile. */
export type ProfileOption = string | { name: string; avatar?: string } | null

export type ClientOptions = {
  /** The board's URL, e.g. `https://www.example.com/api/board`. */
  url: string
  /** An OIDC token whose audience is the board's URL, or a function returning one. */
  token: Resolvable<string>
  profile?: Resolvable<ProfileOption>
  /** Runtime session, recorded on writes and used to scope read cursors. */
  session?: Resolvable<string | null>
  /** A person's handle; the board falls back to one derived from their user ID. */
  handle?: Resolvable<string | null>
  /** Your display name and avatar, shown when you write as yourself (not as a profile). */
  person?: Resolvable<{ name?: string | null; avatar?: string | null } | null>
  /** Where the token comes from, in words (`vercel login`, `GitHub Actions OIDC`), for `vb whoami`. */
  source?: Resolvable<string | null>
  /** Extra headers on every request. */
  headers?: Resolvable<Record<string, string>>
  fetch?: typeof fetch
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

export function createBoardClient(options: ClientOptions) {
  const base = options.url.replace(/\/+$/, '')
  // Browsers reject a bare `fetch` detached from `window` ("Illegal invocation").
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))

  async function headers(auth: boolean, as?: ProfileOption): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...(options.headers ? await resolve(options.headers) : {}) }
    if (!auth) return out
    out.authorization = `Bearer ${await resolve(options.token)}`
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
    query: Filters & { after?: number; wait?: number; all?: boolean } = {},
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
    /** Which credential this client sends, in words, or null when it was handed a token. It makes no request of its own. */
    source: async () => (options.source === undefined ? null : await resolve(options.source)),
    channels: async () => (await call<{ channels: ChannelView[] }>('GET', '/channels')).channels,
    actors: async () => (await call<{ actors: (Actor & { person?: ActorView['person'] })[] }>('GET', '/actors')).actors,

    /** Your linked platform accounts, and the sync entries you haven't linked (`unlinked`). */
    identity: () => call<IdentityView>('GET', '/identity'),
    /**
     * Starts linking your account on sync entry `sync`: a sign-in URL to open
     * (only you), or a one-time code to post from that account where the board syncs.
     */
    linkAccount: (sync: string, opts: { method?: 'code' | 'consent' } = {}) =>
      call<IdentityChallenge>('POST', '/identity/link', { body: { sync, ...opts } }),
    /** After a sign-in: the account it linked, or null until you've approved. */
    checkAccount: async (sync: string) => (await call<IdentityCheck>('POST', '/identity/check', { body: { sync } })).linked,
    /** Unlinks one of your accounts, by actor ID or handle. History keeps its messages as they were. */
    unlinkAccount: (account: string) => call<{ ok: true; actor: string }>('POST', '/identity/unlink', { body: { actor: account } }),

    messages: (query: Filters & Omit<MessagesQueryInput, keyof FiltersInput> = {}) =>
      call<MessagesPage>('GET', `/messages${queryString(query)}`),
    thread: (id: number) => call<ThreadView>('GET', `/messages/${id}`),
    /** Threads with a matching message, one summary each (root, reply count, latest reply), by latest activity. `limit` counts threads. */
    threads: (query: Filters & Omit<ThreadsQueryInput, keyof FiltersInput> = {}) =>
      call<ThreadsPage>('GET', `/threads${queryString(query)}`),

    async post(channel: string, input: string | PostOptions): Promise<MessageView> {
      return (await call<{ message: MessageView }>('POST', '/messages', { body: { channel, ...messageBody(input) } })).message
    },
    async reply(id: number, input: string | ReplyOptions): Promise<MessageView> {
      return (await call<{ message: MessageView }>('POST', '/messages', { body: { re: id, ...messageBody(input) } })).message
    },
    /**
     * Posts later, as you: a reply when `target` is a message ID (any message in the
     * thread), a new thread when it's a channel. Each message it posts carries
     * `schedule: { id, n }`. Needs a board with a scheduler.
     */
    async schedule(target: number | string, input: ScheduleOptions): Promise<ScheduleView> {
      const where = typeof target === 'number' ? { re: target } : { channel: target }
      return (await call<{ schedule: ScheduleView }>('POST', '/schedules', { body: { ...where, ...scheduleBody(input) } })).schedule
    },
    /** Pending schedules (`all` for done and canceled too), oldest first. `re` is any message in a thread. */
    schedules: async (query: SchedulesQueryInput = {}) =>
      (await call<{ schedules: ScheduleView[] }>('GET', `/schedules${queryString(query)}`)).schedules,
    /** Stops a schedule; anyone may. `canceled` is false when it was already done or canceled. */
    cancelSchedule: (id: number) =>
      call<{ schedule: ScheduleView; canceled: boolean }>('POST', `/schedules/${id}/cancel`, { body: {} }),
    /** Stores a file on the board, for a post or reply's `attachments`. At most 4 MB. */
    async upload(input: UploadInput): Promise<Attachment> {
      const type = input.type || (input.data instanceof Blob ? input.data.type : '') || typeOf(input.name)
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
    edit: (id: number, text: string) =>
      call<{ ok: true }>('POST', `/messages/${id}/edit`, { body: { text } }),
    delete: (id: number) => call<{ ok: true }>('POST', `/messages/${id}/delete`, { body: {} }),
    /** `emoji` is a short name, `:name:`, or the character itself. */
    react: (id: number, emoji: string, opts: { remove?: boolean } = {}) =>
      call<{ ok: true }>('POST', `/messages/${id}/reactions`, {
        body: { emoji: normalizeEmoji(emoji), ...opts },
      }),
    label: (id: number, change: { set?: Record<string, string>; unset?: string[] }) =>
      call<{ ok: true }>('POST', `/messages/${id}/labels`, { body: change }),
    /**
     * Shows typing in the platform threads the message's thread is synced to
     * (on WhatsApp, also marking the latest inbound message read). Ephemeral:
     * nothing goes in the log. Answers the external threads that took it.
     * `status` replaces "Typing…" on Slack ("running tests…").
     */
    typing: async (id: number, status?: string) =>
      (await call<TypingResult>('POST', `/messages/${id}/typing`, { body: status ? { status } : {} })).targets,
    /** Attaches the message's thread to an external target, backfilling it. Attaching twice is a no-op. */
    sync: (id: number, target: string) =>
      call<{ target: string; attached: boolean }>('POST', `/messages/${id}/sync`, { body: { target } }),
    /** Raw platform events for a sync entry, newest first. */
    inbox: async (key: string, opts: { channel?: string; limit?: number } = {}) =>
      (await call<{ events: InboxEntry[] }>('GET', `/inbox/${key}${queryString(opts)}`)).events,
    /** Events that failed 10 times and stopped their thread, oldest first. Full access only. */
    stuck: async () => (await call<{ stuck: StuckEvent[] }>('GET', '/stuck')).stuck,
    /**
     * Retries a stuck event with a fresh 10 tries, or skips it so its thread goes on. `redriven` is
     * false when it wasn't stuck (anymore). Full access only.
     */
    redrive: (session: string, index: number, action: 'retry' | 'skip') =>
      call<{ redriven: boolean }>('POST', '/stuck/redrive', { body: { session, index, action } }),
    /**
     * Reads a platform channel (`#name`, an ID), thread (`C0123:1727000000.123456`),
     * or message permalink on demand, without syncing or storing it. Full access only.
     */
    readSource: (key: string, target: string, opts: { limit?: number } = {}) =>
      call<SourceRead>('GET', `/sources/${key}/read${queryString({ target, ...opts })}`),

    poll,

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
            if (message.id !== undefined) after = Number(message.id)
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
      query: Filters & { after?: number } = {},
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

export type { ActorView, BoardEventView, ChannelView, Discovery, EventsPage, IdentityChallenge, IdentityView, Me, MessagesPage, MessageView, ScheduleView, ThreadsPage, ThreadSummaryView, ThreadView }

async function toError(response: Response): Promise<BoardError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message)
      return new BoardError(body.error.code ?? 'error', body.error.message, response.status)
  } catch {}
  return new BoardError('http_error', `${response.status} ${response.statusText}`, response.status)
}
