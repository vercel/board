import { RegisterBody, routes, type Discovery } from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import { BoardError, createBoardClient, type BoardClient, type ProfileOption } from '../client/client.ts'
import { DERIVED_ID, keyId, sha256 } from '../client/ids.ts'
import { ATTACHMENT_BYTES_MAX, type Attachment } from '../contract/schemas.ts'
import { SYNC, type Backend, type BoardBinding, type Caller, type ProtocolMethods, type SelfCaller } from './backend.ts'
import { HttpError, json } from './errors.ts'
import { METHODS } from './routing.ts'
import { compileWatcher } from './watch-spec.ts'
import { registrant, wakePath, type WakeAt } from './registrant.ts'
import { canonicalWatchers, type SyncEntrySpec, type WatcherSpec } from './watchers-hash.ts'

export type HttpOptions = {
  /**
   * How requests reach the board, with the credentials it recognizes. In Node it defaults to what
   * `vb` uses: a token from `BOARD_TOKEN`, `vb serve`'s, GitHub Actions, Vercel, or `vercel login`,
   * through Deployment Protection. In a browser, `fetch`, sending the page's own session (a cookie,
   * say), which the board's `authenticate` recognizes.
   */
  fetch?: typeof fetch
}

/**
 * What finds a board and reaches it, in the Node build: the environment, its files, and
 * `vercel login`. A browser has none.
 */
export type Environment = {
  /** The board the environment points at. Throws `no_board` when it points at none. */
  url(): string
  /** The fetch for the board at `url` when none is given: the credentials `vb` uses, through Deployment Protection. */
  fetch(url: string): typeof fetch
  /** The profile the environment picks (`BOARD_AS`, or the coding agent it runs in), and that agent's session. */
  profile(): { profile: ProfileOption; session: string | null }
}

/** A watcher's or client's name is the profile its writes are by. */
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const PROFILE_RULE = 'ids start with a letter and use up to 32 letters, numbers, and hyphens'

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

/** The SDK's error, as the board answers it: the remote's own status and code, or 502 when it never answered. */
const rethrow = (error: unknown): never => {
  if (error instanceof BoardError)
    throw new HttpError(error.status >= 400 ? error.status : 502, error.code, error.message, { ...(error.hint !== undefined ? { hint: error.hint } : {}), origin: error.origin })
  if (error instanceof HttpError || (error instanceof Error && error.name === 'AbortError')) throw error
  throw new HttpError(502, 'unreachable', `the board didn't answer: ${describe(error)}`)
}

/** A parsed input, back on the wire as a query string. */
function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    // A flag left off is false: `all=false` would read as true.
    if (value === undefined || value === null || value === false) continue
    // Label filters parse to `[key, values | null]`.
    if (key === 'label' && Array.isArray(value))
      for (const [name, values] of value as [string, string[] | null][]) params.append('label', values === null ? name : `${name}=${values.join('|')}`)
    else if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** A file the remote served, as the board stored it: its headers say what it is. */
function attachmentOf(id: string, response: Response): Protocol['attachment']['output'] {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  let name = 'file'
  try {
    if (encoded) name = decodeURIComponent(encoded)
  } catch {}
  const attachment: Attachment = {
    id,
    name,
    type: response.headers.get('content-type') ?? 'application/octet-stream',
    size: Number(response.headers.get('content-length') ?? 0),
  }
  return { attachment, data: response.body ?? new Uint8Array() }
}

/**
 * Another board that speaks the protocol, at `url` (in Node, the one the environment points at
 * by default): this board keeps nothing, and this deployment reads and writes that one as itself.
 * Its watchers' tails are registered there. The remote wakes it when one matches, with nothing in
 * the wake-up but a hash, and it pulls what matched with its own credentials, runs it, and acks
 * it. When it can't be woken (no https URL of its own: a dev server, say), it pulls on its own.
 */
export function createHttp(url: string | undefined, options: HttpOptions, environment: Environment | null) {
  if (url !== undefined && !/^https?:\/\/[^/]/.test(url)) throw new Error(`http: ${url} isn't a URL: pass the board's, like https://board.example.com/api/board`)
  if (url === undefined && !environment) throw new Error("http: pass the board's URL: outside Node there's no environment to find it in")
  const remote = (url ?? environment!.url()).replace(/\/+$/, '')
  const doFetch: typeof fetch = options.fetch ?? environment?.fetch(remote) ?? ((input, init) => globalThis.fetch(input, init))
  let binding: BoardBinding | null = null
  const specs: Record<string, WatcherSpec> = {}
  /** This board's sync entries, registered there when it syncs. */
  let sync: SyncEntrySpec[] = []
  let hash: Promise<string> | null = null
  /** What every wake-up carries, so the board it uses can tell it's stale. */
  const watchersHash = () => (hash ??= sha256(canonicalWatchers(specs, sync)).then((hex) => hex.slice(0, 32)))
  const bound = () => {
    if (!binding) throw new Error("http: this backend isn't serving a board yet: pass it to board({ backend })")
    return binding
  }

  /**
   * The SDK against the remote, as this deployment with `profile`. `quiet` names no session: this
   * deployment's own code. Otherwise a profile chosen in code keeps the environment's session, and
   * yourself (`null`) has none. Who the token's holder is, `fetch` says.
   */
  const sdk = (profile: ProfileOption | undefined, quiet: boolean) =>
    createBoardClient({
      url: remote,
      fetch: doFetch,
      profile: profile !== undefined ? profile : () => environment?.profile().profile ?? null,
      session: quiet || profile === null ? null : () => environment?.profile().session ?? null,
    })

  const own = sdk(null, true)
  const profiles = new Map<string, BoardClient>()
  /** This deployment as `profile`: a watcher's ID, or the middleware. */
  function asProfile(profile: string): BoardClient {
    if (!PROFILE.test(profile)) throw new HttpError(400, 'invalid_request', `as: ${profile}: profiles start with a letter and use up to 32 letters, numbers, and hyphens`)
    let client = profiles.get(profile)
    if (!client) profiles.set(profile, (client = sdk(profile, true)))
    return client
  }
  const holders = new Map<string, BoardClient>()
  /** The token's holder, with `profile` (`undefined`: the environment's). */
  function holder(profile: ProfileOption | undefined): BoardClient {
    const key = JSON.stringify(profile ?? (profile === null ? null : '\u0000'))
    let client = holders.get(key)
    if (!client) holders.set(key, (client = sdk(profile, false)))
    return client
  }

  /**
   * The client a call of this deployment's own code goes through: a handle's, as the token's holder
   * with its profile; a watcher's or the middleware's, as this deployment with theirs; and sync's,
   * as the deployment itself.
   */
  function clientOf(caller: SelfCaller): BoardClient {
    if (caller.origin.via?.kind === 'engine') return own
    if (caller.origin.via?.kind === 'client') {
      if (caller.self !== null) asProfile(caller.self)
      // The handle itself is whoever the environment picks; `as()` names its own, or none.
      return holder('profile' in caller ? caller.profile : caller.self ?? undefined)
    }
    return asProfile(caller.self ?? 'client')
  }

  let discovered: Promise<Discovery> | null = null
  /** The board it uses' discovery, for a handle here: who it is, and the sync entries it lists. */
  const discovery = () =>
    (discovered ??= doFetch(remote).then(async (response) => {
      // This handle's own finding about the URL it was given, not the remote's words.
      if (!response.ok)
        throw new HttpError(response.status >= 400 ? response.status : 502, 'no_board', `There's no board at ${remote}: it answered ${response.status}.`, { origin: 'handle' })
      return (await response.json()) as Discovery
    }, rethrow)).catch((error: unknown) => {
      discovered = null
      throw error
    })

  let principal: Promise<string> | null = null
  /** This deployment's principal on the remote, asked once. */
  const self = () =>
    (principal ??= own
      .me()
      .then((me) => me.principal)
      .catch((error) => {
        principal = null
        throw error
      }))
  /**
   * A post's ID, from the one board() derived for it, under this deployment's own principal: the
   * remote takes a `key:<principal>:` ID only from that principal, so no one can post with it first.
   */
  const ownKey = async (derived: string) => keyId(await self(), derived)

  /** One protocol call on the remote, as `client`: the same route, with the input back on the wire. */
  async function call(client: BoardClient, method: Method, input: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const route = routes[method]
    // Each `:name` in the path is the input's field of that name; the rest are the query or the body.
    const fields = { ...input }
    const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
      const value = fields[name]
      delete fields[name]
      return encodeURIComponent(String(value))
    })
    let response: Response
    if (method === 'upload') {
      const { data, name, type } = input as Protocol['upload']['input']
      // Too big for one request (a platform file sync imports): straight to the board's blob store,
      // where it signs uploads. Elsewhere, refused here, so no body goes over the wire to be refused.
      if (data.byteLength > ATTACHMENT_BYTES_MAX) {
        const attachment = await client.upload({ data: data as Uint8Array<ArrayBuffer>, name: name ?? 'file', ...(type ? { type } : {}) }).catch(rethrow)
        return Response.json({ attachment })
      }
      response = await client
        .request(path, {
          method: 'POST',
          body: data as Uint8Array<ArrayBuffer>,
          headers: { ...(type ? { 'content-type': type } : {}), ...(name !== null ? { 'x-board-filename': encodeURIComponent(name) } : {}) },
          signal,
        })
        .catch(rethrow)
    } else if (route.method === 'GET') response = await client.request(`${path}${queryString(fields)}`, { signal }).catch(rethrow)
    else
      response = await client
        .request(path, { method: route.method, body: new TextEncoder().encode(JSON.stringify(fields)), headers: { 'content-type': 'application/json' }, signal })
        .catch(rethrow)
    if (response.ok) return response
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string; hint?: unknown } }
      if (body.error?.message)
        throw new HttpError(response.status, body.error.code ?? 'error', body.error.message, typeof body.error.hint === 'string' ? { hint: body.error.hint } : {})
    } catch (error) {
      if (error instanceof HttpError) throw error
    }
    throw new HttpError(502, 'remote_error', `${remote} answered ${response.status}`)
  }

  /** A protocol method, called on the board it uses, as `caller`. */
  async function remoteCall(method: Method, caller: Caller, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const registering = start()
    // board() serves no requests for a board that uses another's: only its own code calls here.
    if ('identity' in caller) throw new HttpError(404, 'not_found', `this board uses ${remote}, and answers only wake-ups and webhooks`)
    const client = clientOf(caller)
    // Sync's records name its entries, which the board it uses knows from its registration.
    if ('self' in caller && caller.origin.via?.kind === 'engine') await registering
    // A post board() gave an ID derived from a trigger: the remote takes it as this deployment's key,
    // and a retry's lookup asks for the same.
    if ((method === 'post' || method === 'posted') && 'self' in caller && typeof input.id === 'string' && DERIVED_ID.test(input.id))
      input = { ...input, id: await ownKey(input.id).catch(rethrow) }
    const response = await call(client, method, input, signal)
    return method === 'attachment' ? attachmentOf(String(input.id), response) : response.json()
  }

  const methods: ProtocolMethods = {
    ...(Object.fromEntries(METHODS.map((method) => [method, (caller: Caller, input: Record<string, unknown>, signal: AbortSignal) => remoteCall(method, caller, input, signal)])) as unknown as ProtocolMethods),
    // The board it uses is what a handle here asks about. board() answers a request's itself.
    async discovery() {
      return discovery()
    },
    // A source this board's own sync reads is read here; any other is the board it uses' to read.
    async readSource(caller, input, signal) {
      if ('self' in caller && bound().sync.some((entry) => entry.key === input.key)) return bound().readSource(input.key, input.target, input.limit ?? 50, input.after ?? null)
      return remoteCall('readSource', caller, input, signal) as Promise<Protocol['readSource']['output']>
    },
    async joinSource(caller, input, signal) {
      if ('self' in caller && bound().sync.some((entry) => entry.key === input.key)) return bound().joinSource(input.key, input.target)
      return remoteCall('joinSource', caller, input, signal) as Promise<Protocol['joinSource']['output']>
    },
    // The board it uses has the records; this board's own sync links what it synced there.
    async synced(caller, input, signal) {
      const { targets } = (await remoteCall('synced', caller, input, signal)) as Protocol['synced']['output']
      return {
        targets: await Promise.all(
          targets.map(async (row) => ({
            ...row,
            url: row.url ?? (row.thread !== null && row.message !== null ? await bound().linkOf(row.key, row.thread, row.message) : null),
          })),
        ),
      }
    },
    // A link to what this board's own sync synced is found in its records there, as this deployment;
    // any other is the board it uses' to find. Either way the caller reads it as itself.
    async linked(caller, input, signal) {
      const missing = () => new HttpError(404, 'message_not_found', 'no message on this board for that link')
      // Each of this board's own entries of the link's platform, under its own key there; then the
      // board it uses, whose own sync may have synced it.
      const first = async (): Promise<string | null> => {
        for (const { platform, thread, message } of bound().locate(input.url))
          for (const entry of bound().sync.filter((candidate) => candidate.platform === platform)) {
            const at = await own.syncFind({ thread: `${entry.key}:${thread}`, ...(message !== null ? { message } : {}) }, { signal }).catch(rethrow)
            const found = message !== null ? at.message : at.thread === null ? null : (await own.syncThread(at.thread).catch(rethrow)).root
            if (found !== null) return found
          }
        return null
      }
      const id = await first()
      if (id === null) return remoteCall('linked', caller, input, signal) as Promise<Protocol['linked']['output']>
      try {
        return (await methods.message(caller, { id }, signal)) as Protocol['linked']['output']
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw missing()
        throw error
      }
    },
    // Typing shows where the board it uses syncs the thread, and where this board's own sync does.
    async typing(caller, input, signal) {
      const { targets } = (await remoteCall('typing', caller, input, signal)) as Protocol['typing']['output']
      if (!('self' in caller) || bound().sync.length === 0) return { targets }
      const { message, replies } = await methods.message(caller, { id: input.id }, signal)
      const here = await bound().typing([message, ...replies], input.status).catch((error: unknown) => {
        console.warn('[board] skipped typing where this board syncs:', describe(error))
        return [] as string[]
      })
      return { targets: [...targets, ...here] }
    },
  }

  /**
   * Where the remote wakes this board: on a board that wakes by path, the path on this project,
   * which gets through its Deployment Protection (`wakePath`); anywhere else, its URL.
   */
  async function wakeAt(here: string | null): Promise<WakeAt> {
    const path = wakePath(here)
    return path && (await discovery()).wake_by_path ? path : { url: here }
  }

  const runner = registrant({
    remote,
    registry: {
      register: (where) => own.register({ ...where, watch: specs, ...(sync.length > 0 ? { sync } : {}) }),
      matches: (query) => own.matches(query),
      ack: (id, body) => own.ack(id, body),
    },
    wakeAt,
    binding: bound,
    hash: watchersHash,
    hasWork: () => Object.keys(specs).length > 0 || sync.length > 0,
    rethrow,
    registerFor: async (caller, request) => json(await methods.register(caller, RegisterBody.parse(await request.json()), request.signal)),
  })
  const start = runner.start

  const backend = {
    ...methods,
    // Its own routes are wake-ups: who may do what on the board it uses is that board's to say.
    routes: runner.routes,
    // The log is the board it uses': a board here answers only wake-ups and webhooks.
    keeps: false,
    bind(next: BoardBinding) {
      if (binding) throw new Error('http: this backend already serves a board: create one http() per board()')
      for (const [id, spec] of Object.entries(next.subscriptions)) {
        // Sync subscribes as itself, beside the watchers: the remote sends it what it may sync.
        if (spec.kind === 'sync') {
          if (id === SYNC) sync = next.sync.map((entry) => ({ ...entry }))
          continue
        }
        if (!PROFILE.test(id)) throw new Error(`watch ${id}: ${PROFILE_RULE}`)
        compileWatcher(id, spec)
        specs[id] = { tail: spec.tail }
      }
      hash = null
      binding = next
    },
    /** Registers this board's watchers with the board it uses now, as `POST /watchers` does. */
    registerWatchers: runner.registerNow,
    /** Stops pulling, for a board that pulls on its own. */
    close: runner.close,
  }
  return backend satisfies Backend
}

export type HttpBackend = ReturnType<typeof createHttp>
