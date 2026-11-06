import type { BoardEventView } from '../api/routes.ts'
import { BoardError, createBoardClient, type BoardClient, type PostOptions, type ProfileOption, type ReplyOptions } from '../client/client.ts'
import { derivedId } from '../client/ids.ts'
import type { SyncProvider } from '../sync/provider.ts'
import { SYNC, type Backend, type BoardBinding, type Caller, type SelfCaller, type Subscription, type SyncEntry } from './backend.ts'
import type { Middleware } from './middleware.ts'
import { createPolicy, type Policy, type PolicyOptions, type Serving } from './policy.ts'
import { createServe, type PlatformCaller, type Serve } from './serve.ts'
import type { Watcher } from './watcher.ts'

/**
 * `board()`'s options: where the board lives, who may use it and what its writes go through, and
 * what runs here. The backend keeps or reaches the log; the policy is the board's.
 */
export type BoardOptions = PolicyOptions & (BackendOptions | DefaultOptions) & {
  /**
   * Which of the team's boards this is, by its name: `security` is the team's board named
   * security. Without one, the team's default board. A name is 1 to 64 characters with no `/`, and
   * matches whatever its case. The backend reads it when board() binds it: `vercel()` finds that
   * board, a board on `http()` is the one at its URL, whatever its name.
   */
  name?: string
  /**
   * With `name`: whether to make that board when the team has none by that name, whoever calls (a
   * deployment, or a person: `next dev` with a login, a script). It does by default; `ensure: false`
   * only finds one, and a name the team has none for fails with 404 `no_board`. `vb` passes false
   * unless `--ensure` is given, so a typo at a terminal makes no board.
   */
  ensure?: boolean
  /**
   * Whose board this is: another team's, by its ID (`team_…`) or its slug, with `name` or without
   * it for that team's default board. Without one, the team the environment finds: in Node, the
   * deployment's, `VERCEL_ORG_ID`, or the linked project's.
   */
  team?: string
  /**
   * Runs on every post and edit before it reaches the backend, whatever it came from: requests (a
   * board on `http()` using this one included), watchers, schedules, the handle, and sync's imports.
   * Each calls `next()` to pass the write on; one that doesn't drops it.
   */
  middleware?: readonly Middleware[]
  /** Tails the board runs for you, keyed by an id you choose: `{ triage: { tail: 'firehose', run } }`. */
  watch?: Record<string, Watcher>
  /**
   * Two-way sync, keyed by a name you choose: `{ slack: slack('slack/acme', channels({...})) }`. It
   * runs here, wherever the board lives: webhooks land at `<board>/webhooks/<key>`, and what the
   * board's channels say goes out to the platforms. On `http()`, the board it uses must let this
   * deployment `sync` in those channels.
   */
  sync?: Record<string, SyncProvider>
  /** The board's public URL, which every token's audience must equal. Inferred from requests otherwise. */
  url?: string
  /** The mount path, e.g. `/api/board`. Inferred from requests otherwise: the shallowest one they show. */
  basePath?: string
  /** SSE streams close after this long, before the platform's limit; clients reconnect. */
  streamMaxMs?: number
}

/**
 * The handle on a board: its methods act as the board's caller, through board(), which calls the
 * backend's methods, and `fetch` serves it. Over `http()` the caller is whoever its `fetch`'s
 * credentials say, with the profile `BOARD_AS` or the agent it runs in picks; on a board it keeps
 * (`local()`), its own code, as `board:client`.
 */
export type Board = BoardClient & {
  /**
   * The board's HTTP handler, for a route file (`export const GET = team.fetch, POST = team.fetch`)
   * or any runtime that takes one function.
   */
  fetch(request: Request): Promise<Response>
  /**
   * The handle, acting with `profile`: `<principal>+<profile>` over HTTP, `board:client:<profile>`
   * on `local()`. `null` acts as yourself, outside any agent session.
   */
  as(profile: ProfileOption): Board
}

/** A board on a backend you pass, which says how it reaches the board itself. */
type BackendOptions = {
  /**
   * Where the board lives: `local()` from `@vercel/board/backend-local` keeps it in this process,
   * or a backend of your own. By default, Vercel's board for your team, the one `name` names, or
   * with `BOARD_URL` set (in Node), the board at that URL.
   */
  backend: Backend
  fetch?: never
}

/** A board on the backend board() picks: Vercel's, or with `BOARD_URL` set, the board at that URL. */
type DefaultOptions = {
  backend?: undefined
  /**
   * How requests reach Vercel's API, with credentials it takes: a token for the team. In Node it
   * defaults to `VERCEL_TOKEN`, the deployment's OIDC token, or your `vercel login`; elsewhere, a
   * browser say, pass one. A board at `BOARD_URL` gets the credentials `vb` sends it instead.
   */
  fetch?: typeof fetch
}

/** What a build of board gives board(): Node's finds boards, tokens, and the board's project in the environment. */
export type Runtime = {
  /**
   * The backend for a board() given none: Vercel's board, through `fetch` when it's given, or in
   * Node with `BOARD_URL` set, `http()` to that board.
   */
  backend(fetch: typeof globalThis.fetch | undefined): Backend
  /** Loads the sync engine, only for a board that syncs. */
  sync: () => Promise<typeof import('../sync/engine.ts')>
  /** Loads what the policy finds in the environment, the first time a board serves: null where nothing does, so pass `authenticate`. */
  serving: (() => Promise<Serving>) | null
}

/** What the board's pipeline shares with its handle. */
export type BoardContext = {
  options: BoardOptions
  backend: Backend
  runtime: Runtime
  /** Who may use the board, and what each may do. */
  policy: Policy
  /** The mount path, as the last request that reached a route had it. */
  state: { learned: string | null }
  ownUrl(): string | null
  /** An in-process client through the board, as `caller`: its posts are idempotent per trigger. */
  clientAs(caller: Caller | PlatformCaller, trigger: string | null): BoardClient
  /** The handle, acting as `caller`: a watcher's, the middleware's, or a schedule's creator's. */
  handleOf(caller: Caller, trigger: string | null): Board
}

/** How long a handle's live events wait for the next, in seconds, before asking again. */
const EVENTS_WAIT_S = 25

/** A board's name: 1 to 64 characters, no `/`. */
const BOARD_NAME = /^[^/]{1,64}$/
/** A team, by its ID or its slug. */
const TEAM = /^[^\s/]+$/

/** Whether `name` is a board's name, such as `security`. */
export const isBoardName = (name: string): boolean => BOARD_NAME.test(name)

/**
 * A board for this project, on `backend`: Vercel's board for the team by default, `local()` in this
 * process, or one of your own. What it returns is the handle: its
 * methods act as the board's caller, and `fetch` serves the protocol over HTTP. Create it once,
 * at module scope, or one per tenant for a host.
 */
export function createBoard(options: BoardOptions, runtime: Runtime): Board {
  if (options.name !== undefined && !isBoardName(options.name))
    throw new Error(`board: ${JSON.stringify(options.name)} isn't a board's name: one is 1 to 64 characters with no /, and another team's board takes its team apart, board({ team, name })`)
  if (options.team !== undefined && !TEAM.test(options.team)) throw new Error(`board: ${JSON.stringify(options.team)} isn't a team: pass its ID (team_…) or its slug`)
  if (options.ensure && options.name === undefined) throw new Error('board: ensure makes the board `name` names: pass name too')
  const backend = options.backend ?? runtime.backend(options.fetch)
  const policy = createPolicy(options, backend.keeps, runtime.serving, backend.trust ?? null)
  const watch = options.watch ?? {}
  const entries = options.sync ?? {}
  const state: BoardContext['state'] = { learned: null }
  /** Under the configured mount, so the router accepts the paths an in-process client builds. */
  const inProcess = `http://in-process.board${(options.basePath ?? '').replace(/\/+$/, '')}`

  /**
   * This board's own URL, where a board elsewhere wakes it: `url`, or on Vercel its production
   * domain (a preview's own URL there), and never a request's Host, which its sender chooses.
   */
  function ownUrl(): string | null {
    if (options.url) return options.url.replace(/\/+$/, '')
    const env = typeof process === 'undefined' ? undefined : process.env
    const domain = env?.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : env?.VERCEL_URL
    const base = options.basePath ?? state.learned
    return domain && base !== null ? `https://${domain}${base}`.replace(/\/+$/, '') : null
  }

  let loading: Promise<Serve> | null = null
  /** The board's pipeline, made once, when the board first serves, watches, syncs, or a handle calls it. */
  function server(): Promise<Serve> {
    loading ??= createServe(context)
    loading.catch(() => (loading = null))
    return loading
  }

  function clientAs(caller: Caller | PlatformCaller, trigger: string | null): BoardClient {
    const writes = { made: 0 }
    return createBoardClient({
      url: inProcess,
      token: 'in-process',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (await server()).inject(new Request(input, init), caller, trigger, writes)) as typeof fetch,
    })
  }

  const serve = async (request: Request): Promise<Response> => (await server()).dispatch(request, null)

  /** A handle on `client`, which `as` gives other profiles of. */
  function handle(client: BoardClient, url: (() => string) | null): Board {
    const made = { ...client, fetch: serve, as } as Board
    if (url) Object.defineProperty(made, 'url', { get: url, enumerable: true })
    return made
  }

  /**
   * A handle through board(), as `caller`: a post's `id` is its own, derived under who it writes as,
   * so a retry posts once and no request can take it first. A verified caller's are a backend's,
   * derived already (a schedule's send's), so they go as they are.
   */
  function handleOf(caller: Caller, trigger: string | null): Board {
    const client = clientAs(caller, trigger)
    if ('identity' in caller) return handle({ ...client, events: (query, opts) => events(client, query, opts) }, () => ownUrl() ?? inProcess)
    const via = caller.origin.via?.kind ?? 'client'
    const id = (given: string) => derivedId(`board-${via === 'watcher' ? 'watch' : via}`, caller.self ?? '', given)
    const owned = async <T extends PostOptions | ReplyOptions>(input: string | T): Promise<string | T> =>
      typeof input === 'string' || input.id === undefined ? input : { ...input, id: await id(input.id) }
    return handle(
      {
        ...client,
        post: async (channel, input) => client.post(channel, await owned(input)),
        reply: async (re, input) => client.reply(re, await owned(input)),
        posted: async (given) => client.posted(await id(given)),
        // In-process, a request is this caller's whatever its headers say: another profile is another handle's.
        request: (path, init = {}) => {
          const { as: profile, ...rest } = init
          return profile !== undefined ? as(profile).request(path, rest) : client.request(path, rest)
        },
        events: (query, opts) => events(client, query, opts),
      },
      () => ownUrl() ?? inProcess,
    )
  }

  const profileCaller = (profile: ProfileOption): SelfCaller => {
    const name = profile === null ? null : typeof profile === 'string' ? profile : profile.name
    return { self: name, profile, origin: { via: { kind: 'client', name } } }
  }

  function as(profile: ProfileOption): Board {
    return handleOf(profileCaller(profile), null)
  }

  const context: BoardContext = { options, backend, runtime, policy, state, ownUrl, clientAs, handleOf }

  const subscriptions: Record<string, Subscription> = Object.fromEntries(
    Object.entries(watch).map(([id, watcher]) => [id, { kind: 'tail', tail: watcher.tail }]),
  )
  if (Object.keys(entries).length > 0) subscriptions[SYNC] = { kind: 'sync' }
  /** This board's sync entries, as its sync and discovery see them. */
  const ownEntries: SyncEntry[] = Object.entries(entries).map(([key, entry]) => ({ key, platform: entry.platform }))
  const binding: BoardBinding = {
    name: options.name ?? null,
    team: options.team ?? null,
    ensure: options.ensure ?? true,
    subscriptions,
    run: async (id, event, meta) => (await server()).run(id, event, meta),
    receive: async (key, item, meta) => (await server()).receive(key, item, meta),
    pull: async () => (ownEntries.length > 0 ? (await server()).pull() : 0),
    sync: ownEntries,
    readSource: async (key, target, limit, after) => (await server()).readSource(key, target, limit, after),
    joinSource: async (key, target) => (await server()).joinSource(key, target),
    locate: (url) => {
      const read = new Map<string, { platform: string; thread: string; message: string | null }>()
      for (const entry of Object.values(entries)) {
        const found = entry.locate(url)
        if (found) read.set(JSON.stringify([entry.platform, found.thread, found.message]), { platform: entry.platform, ...found })
      }
      return [...read.values()]
    },
    linkOf: async (key, thread, message) => {
      const entry = Object.hasOwn(entries, key) ? entries[key] : undefined
      if (!entry || !thread.startsWith(`${key}:`)) return null
      return entry.url(thread.slice(key.length + 1), message).catch(() => null)
    },
    typing: async (messages, status) => (await server()).typing(messages, status),
    accessNow: (principal, grants) => policy.accessNow(principal, grants),
    explain: (principal, channel) => policy.explain(principal, channel),
    project: () => policy.project(),
    handle: (caller) => handleOf(caller, null),
    url: ownUrl,
  }
  backend.bind(binding)

  return handleOf({ self: null, origin: { via: { kind: 'client', name: null } } }, null)
}

/**
 * Live events for a handle, from the backend's long-poll: each page from the last cursor it saw,
 * waiting for the next. It backs off after a failure, up to 30 seconds; a 4xx throws.
 */
async function* events(
  client: BoardClient,
  query: Parameters<BoardClient['events']>[0] = {},
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<BoardEventView> {
  let after = query.after
  let failures = 0
  while (!opts.signal?.aborted) {
    let page: Awaited<ReturnType<BoardClient['poll']>>
    try {
      page = await client.poll({ ...query, ...(after !== undefined ? { after } : {}), wait: EVENTS_WAIT_S } as Parameters<BoardClient['poll']>[0], opts.signal)
    } catch (error) {
      if (opts.signal?.aborted) return
      if (error instanceof BoardError && error.status >= 400 && error.status < 500) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** failures++)))
      continue
    }
    failures = 0
    for (const event of page.events) {
      yield event
      if (opts.signal?.aborted) return
    }
    after = page.cursor
  }
}
