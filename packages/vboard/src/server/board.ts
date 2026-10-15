import { z } from 'zod'
import { idempotentId } from 'experimental-a2'
import { createServer, type A2Store, type A2Scheduler, type ServerOptions } from 'experimental-a2/server'
import { boardContract, BOARD_SESSION, inboxSession, SCHEDULES_SESSION, watchSession, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, channelsReducer, linkedTo, messagesReducer, syncReducer } from '../contract/reducers.ts'
import { ATTACHMENT_BYTES_MAX } from '../contract/schemas.ts'
import {
  EditBody,
  EventsQuery,
  IdentityCheckBody,
  IdentityLinkBody,
  IdentityUnlinkBody,
  InboxQuery,
  SourceReadQuery,
  LabelBody,
  MessagesQuery,
  ThreadsQuery,
  PostBody,
  ReactBody,
  RedriveBody,
  routes,
  ScheduleBody,
  SchedulesQuery,
  SyncBody,
  TypingBody,
  type Discovery,
  type IdentityView,
  type StuckEvent,
  type TypingResult,
  type Me,
  type RouteName,
} from '../api/routes.ts'
import { createBoardClient, type BoardClient } from '../client/client.ts'
import { createSyncEngine } from '../sync/engine.ts'
import type { SyncProvider } from '../sync/provider.ts'
import { VERSION } from '../version.ts'
import { createVerifier, type AccessRule, type AuthOptions, type Principal } from './auth.ts'
import { authorize, parseScope, type Permission } from './access.ts'
import { KNOWN_AGENTS, resolveActor } from './actors.ts'
import { avatarSvg } from './avatars.ts'
import { attachmentResponse, defaultBlob, readAttachment, writeUpload, type BlobStore } from './blob.ts'
import { badRequest, forbidden, HttpError, json, notFound, toErrorResponse, unauthorized } from './errors.ts'
import { compileFilter, liveFeed, personView, pollFeed, view } from './feed.ts'
import { discoveryIdentity, ownProjectId, ownTeamId } from './identity.ts'
import { createSchedules } from './schedules.ts'
import { createWatchers, ID, type Watcher } from './watch.ts'
import {
  writeAttach,
  writeDelete,
  writeEdit,
  writeLabels,
  writePost,
  writeReaction,
  deploymentIdentity,
  type Identity,
  type WriteContext,
  type WriteOrigin,
} from './writes.ts'
import { MIDDLEWARE_ACTOR, type Middleware } from './middleware.ts'

export type BoardOptions = {
  /** Any A2 store. Omitted: SQLite in development, memory in tests, an error in production. */
  store?: A2Store
  /** Required for sync in production, and for scheduled messages. Mount the board's `scheduler` as `POST` in its own route. */
  scheduler?: A2Scheduler
  /**
   * Who may call the board besides its people and its own production, and what
   * they may do in each channel: `vercelProject()`, `githubActions()`, `oidc()`.
   * The first rule that matches a token decides.
   */
  access?: readonly AccessRule[]
  /** Two-way sync, keyed by a name you choose: `{ slack: slack({...}), github: github({...}) }`. */
  sync?: Record<string, SyncProvider>
  /**
   * Runs on every post and edit before it lands, whatever it came from: the API, sync,
   * watchers, schedules. Each calls `next()` to pass the write on; one that doesn't drops it.
   */
  middleware?: readonly Middleware[]
  /** Tails the board runs for you, keyed by an id you choose: `{ triage: { tail: 'firehose', run } }`. */
  watch?: Record<string, Watcher>
  /** The board's Vercel project. Defaults to `VERCEL_PROJECT_ID` or `.vercel/project.json`. */
  project?: { id: string; teamId?: string }
  /** The board's public URL, which every token's audience must equal. Inferred from requests otherwise. */
  url?: string
  /** The mount path, e.g. `/api/board`. Inferred from requests otherwise. */
  basePath?: string
  /** Test issuers. Production uses Vercel's and GitHub's. */
  auth?: AuthOptions
  /** SSE streams close after this long, before the platform's limit; clients reconnect. */
  streamMaxMs?: number
  /**
   * Where attachments live: `vercelBlob()` from `vboard/adapter-vercel-blob`. Omitted: memory
   * in tests, `.a2/attachments` in development, and no uploads in production.
   */
  blob?: BlobStore
}

const boardServer = (options: BoardOptions) =>
  createServer({
    contract: boardContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })

export type BoardSession = ReturnType<ReturnType<typeof boardServer>['session']>

type Match = { name: RouteName; base: string; id?: number; param?: string }

// Most specific first; each route is matched as a suffix of the request path.
const PATTERNS: { method: string; name: RouteName; pattern: RegExp }[] = [
  { method: 'POST', name: 'identityLink', pattern: /\/identity\/link$/ },
  { method: 'POST', name: 'identityCheck', pattern: /\/identity\/check$/ },
  { method: 'POST', name: 'identityUnlink', pattern: /\/identity\/unlink$/ },
  { method: 'GET', name: 'identity', pattern: /\/identity$/ },
  { method: 'POST', name: 'edit', pattern: /\/messages\/(\d+)\/edit$/ },
  { method: 'POST', name: 'delete', pattern: /\/messages\/(\d+)\/delete$/ },
  { method: 'POST', name: 'react', pattern: /\/messages\/(\d+)\/reactions$/ },
  { method: 'POST', name: 'label', pattern: /\/messages\/(\d+)\/labels$/ },
  { method: 'POST', name: 'sync', pattern: /\/messages\/(\d+)\/sync$/ },
  { method: 'POST', name: 'typing', pattern: /\/messages\/(\d+)\/typing$/ },
  { method: 'GET', name: 'message', pattern: /\/messages\/(\d+)$/ },
  { method: 'GET', name: 'messages', pattern: /\/messages$/ },
  { method: 'POST', name: 'post', pattern: /\/messages$/ },
  { method: 'GET', name: 'threads', pattern: /\/threads$/ },
  { method: 'POST', name: 'cancelSchedule', pattern: /\/schedules\/s?(\d+)\/cancel$/ },
  { method: 'GET', name: 'schedules', pattern: /\/schedules$/ },
  { method: 'POST', name: 'schedule', pattern: /\/schedules$/ },
  { method: 'GET', name: 'channels', pattern: /\/channels$/ },
  { method: 'GET', name: 'actors', pattern: /\/actors$/ },
  { method: 'GET', name: 'events', pattern: /\/events$/ },
  { method: 'GET', name: 'me', pattern: /\/me$/ },
  { method: 'GET', name: 'inbox', pattern: /\/inbox\/([A-Za-z0-9_-]+)$/ },
  { method: 'POST', name: 'redrive', pattern: /\/stuck\/redrive$/ },
  { method: 'GET', name: 'stuck', pattern: /\/stuck$/ },
  { method: 'GET', name: 'sourceRead', pattern: /\/sources\/([A-Za-z0-9_-]+)\/read$/ },
  { method: 'POST', name: 'webhook', pattern: /\/webhooks\/([A-Za-z0-9_-]+)$/ },
  { method: 'GET', name: 'avatar', pattern: /\/avatars\/([a-z0-9-]+)$/ },
  { method: 'GET', name: 'openapi', pattern: /\/openapi\.json$/ },
  { method: 'POST', name: 'upload', pattern: /\/attachments$/ },
  { method: 'GET', name: 'attachment', pattern: /\/attachments\/([A-Za-z0-9_-]+)$/ },
]

type BoardHandlers = NonNullable<ServerOptions<BoardEvents>['handlers']>
/** What `vb stuck` needs of an A2 session, whatever its contract. */
type Redrivable = {
  deadLetters(): Promise<{ index: number; type: string; lane: string | null; attemptCount: number; failureCount: number; lastError: string | null; failedAt: Date }[]>
  redrive(index: number, options: { action: 'retry' | 'skip' }): Promise<{ redriven: boolean }>
}
type BoardHandler = { lane?: unknown; handler: (ctx: never) => Promise<unknown> }

/** A2 takes one handler per event type, so watchers and sync share it, on the same lanes: watchers first. */
function combineHandlers(...sets: BoardHandlers[]): BoardHandlers {
  const combined: Record<string, BoardHandler> = {}
  for (const set of sets)
    for (const [type, entry] of Object.entries(set) as [string, BoardHandler][]) {
      const first = combined[type]
      combined[type] = first
        ? {
            lane: first.lane,
            handler: async (ctx: never) => {
              await first.handler(ctx)
              await entry.handler(ctx)
            },
          }
        : entry
    }
  return combined as BoardHandlers
}

const MIDDLEWARE_IDENTITY = deploymentIdentity(MIDDLEWARE_ACTOR, 'middleware')

/**
 * `idempotentId`'s shape, a UUIDv8: the IDs the board derives for its own writes (schedule
 * sends, watchers, sync). They're guessable, so an API caller can't post with one and take it first.
 */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const NUMERIC = new Set<RouteName>(['edit', 'delete', 'react', 'label', 'sync', 'typing', 'message', 'cancelSchedule'])

function route(method: string, pathname: string, basePath?: string): Match | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (basePath !== undefined) {
    const base = basePath.replace(/\/+$/, '')
    if (path !== base && !path.startsWith(`${base}/`)) return null
    const rest = path.slice(base.length) || '/'
    if (rest === '/') return method === 'GET' ? { name: 'discovery', base } : null
    for (const candidate of PATTERNS) {
      const found = rest.match(new RegExp(`^${candidate.pattern.source}`))
      if (candidate.method === method && found) return withParam(candidate.name, base, found[1])
    }
    return null
  }
  for (const candidate of PATTERNS) {
    if (candidate.method !== method) continue
    const found = path.match(candidate.pattern)
    if (found) return withParam(candidate.name, path.slice(0, found.index), found[1])
  }
  return method === 'GET' ? { name: 'discovery', base: path === '/' ? '' : path } : null
}

const withParam = (name: RouteName, base: string, param: string | undefined): Match =>
  param === undefined ? { name, base } : NUMERIC.has(name) ? { name, base, id: Number(param) } : { name, base, param }

function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    out[key] = values.length > 1 ? values : values[0]!
  }
  return out
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest('request body is not valid JSON')
  }
}

const tooLarge = () => new HttpError(413, 'too_large', `attachments are at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`)

/** The body, refused as soon as it's past `max`: with or without a `content-length`, it never reads more. */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > max) throw tooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > max) throw tooLarge()
    chunks.push(chunk)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/** Mounts a board: one log in one route. Create it once, at module scope. */
export function board(options: BoardOptions = {}) {
  const blob = options.blob ?? defaultBlob()
  const engine =
    options.sync && Object.keys(options.sync).length > 0
      ? createSyncEngine({ entries: options.sync, store: options.store, scheduler: options.scheduler, blob })
      : null
  const watchers =
    options.watch && Object.keys(options.watch).length > 0
      ? createWatchers({ watch: options.watch, store: options.store, scheduler: options.scheduler })
      : null
  const schedules = createSchedules({ store: options.store, scheduler: options.scheduler })
  const handlers = [watchers?.boardHandlers, engine?.outboundHandlers].filter((set) => set !== undefined)
  const server = createServer({
    contract: boardContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(handlers.length > 0 ? { handlers: combineHandlers(...handlers) } : {}),
  })
  const session = server.session(BOARD_SESSION)
  const writes: WriteContext = {
    session,
    configTargets: engine ? engine.configTargets : async () => [],
    ...(engine ? { findByEmail: engine.findByEmail } : {}),
    normalizeTarget: engine
      ? engine.normalizeTarget
      : async () => {
          throw badRequest('this board has no sync configured')
        },
    middleware: options.middleware ?? [],
    middlewareClient: () => clientAs(MIDDLEWARE_IDENTITY, null, { via: { kind: 'middleware' } }),
  }
  const verify = createVerifier({
    projectId: () => ownProjectId(options.project),
    teamId: () => ownTeamId(options.project),
    access: options.access ?? [],
    ...(options.auth ? { auth: options.auth } : {}),
  })
  const streamMaxMs = options.streamMaxMs ?? 280_000

  async function authenticate(request: Request, boardUrl: string): Promise<Principal> {
    const header = request.headers.get('authorization') ?? ''
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) throw unauthorized('missing bearer token')
    const principal = await verify(token, boardUrl, request.headers.get('x-vercel-oidc-token') ?? undefined)
    // Set by a proxy that holds the credential (Pi's sandbox); it only narrows.
    const scope = request.headers.get('x-board-scope')
    if (scope === null) return principal
    try {
      return { ...principal, access: principal.access.narrow(parseScope(scope)) }
    } catch (error) {
      throw badRequest((error as Error).message, 'invalid_scope')
    }
  }

  /** The sessions whose handlers run on lanes, so a dead letter there stops the rest of its lane. */
  async function lanedSessions(): Promise<{ id: string; session: Redrivable }[]> {
    const ids: [string, { session(id: string): Redrivable }][] = [
      [BOARD_SESSION, server],
      [SCHEDULES_SESSION, schedules.server],
      ...(watchers ? watchers.ids.map((id): [string, typeof watchers.server] => [watchSession(id), watchers.server]) : []),
      ...(engine ? (await engine.inboxChannels()).map((channel): [string, typeof engine.inboxServer] => [inboxSession(channel), engine.inboxServer]) : []),
    ]
    return ids.map(([id, owner]) => ({ id, session: owner.session(id) }))
  }

  async function stuck(): Promise<StuckEvent[]> {
    const found = (await Promise.all((await lanedSessions()).map(async ({ id, session }) => (await session.deadLetters()).map((dead) => ({ id, dead }))))).flat()
    if (found.length === 0) return []
    const [{ state: messages }, { state: sync }] = await Promise.all([session.state(messagesReducer), session.state(syncReducer)])
    const roots = new Map<string, number>()
    for (const message of Object.values(messages.byId)) if (message.re === null) roots.set(message.thread, message.id)
    return found.map(({ id, dead }) => {
      const laneThread = dead.lane?.startsWith('thread:') ? dead.lane.slice('thread:'.length) : null
      // An inbox's lanes are platform threads; everywhere else they're the board's.
      const inbox = id.startsWith('inbox:')
      const thread = inbox ? (laneThread && (sync.byExternalThread[laneThread] ?? null)) : laneThread
      return {
        session: id,
        index: dead.index,
        type: dead.type,
        lane: dead.lane,
        thread,
        root: thread === null ? null : (roots.get(thread) ?? null),
        external: inbox ? laneThread : null,
        attempts: dead.attemptCount,
        failures: dead.failureCount,
        error: dead.lastError,
        failedAt: dead.failedAt.toISOString(),
      }
    })
  }

  async function redrive(body: z.infer<typeof RedriveBody>, by: string) {
    const target = (await lanedSessions()).find(({ id }) => id === body.session)
    if (!target) throw notFound(`no session ${body.session} on this board`)
    const { redriven } = await target.session.redrive(body.index, { action: body.action })
    if (redriven) console.info(`[vboard] ${by} ${body.action === 'retry' ? 'retried' : 'skipped'} stuck event ${body.session}#${body.index}`)
    return { redriven }
  }

  /**
   * `permission` in `channel` when the route knows it (a root post's is its own),
   * and otherwise in some channel: a reply's or a target's channel is only known
   * once the write looks it up.
   */
  const require = (principal: Principal, permission: Permission, channel?: string) => {
    if (channel !== undefined) authorize(principal.access, permission, channel)
    else if (!principal.access.anywhere(permission)) throw forbidden(`this token can't ${permission} anywhere`)
  }

  /** The board's own bookkeeping spans every channel, so it needs `manage` in all of them. */
  const requireManage = (principal: Principal, what: string) => {
    if (!principal.access.everywhere('manage')) throw forbidden(`${what} needs manage on every channel`)
  }

  /**
   * A client for inbound functions: in-process, writing as `identity`, its posts idempotent
   * per trigger. Its posts and edits reach the middleware from `origin`.
   */
  function clientAs(identity: Identity, trigger: string | null, origin: WriteOrigin): BoardClient {
    let writesMade = 0
    return createBoardClient({
      // Under the configured mount, so `route()` accepts the paths it builds.
      url: `http://in-process.board${(options.basePath ?? '').replace(/\/+$/, '')}`,
      token: 'in-process',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init)
        if (trigger !== null && request.method === 'POST' && new URL(request.url).pathname.endsWith('/messages')) {
          const body = ((await request.json()) ?? {}) as Record<string, unknown>
          body.id ??= await idempotentId('vboard-inbound', trigger, 'client', String(writesMade++))
          request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
        }
        return dispatch(request, identity, origin)
      }) as typeof fetch,
    })
  }

  engine?.bind({ session, writes, clientAs })
  schedules.bind({ writes })
  watchers?.bind({ clientAs })

  async function dispatch(request: Request, injected: Identity | null, origin: WriteOrigin = { via: { kind: 'api' } }): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = route(request.method, url.pathname, options.basePath)
      if (!match) throw notFound(`no route: ${request.method} ${url.pathname}`)
      const boardUrl = (options.url ?? `${url.origin}${match.base}`).replace(/\/+$/, '')

      switch (match.name) {
        case 'discovery': {
          const identity = await discoveryIdentity(request, options.project)
          const body: Discovery = {
            version: VERSION,
            url: boardUrl,
            audience: boardUrl,
            team_id: identity.teamId,
            project_id: identity.projectId,
            sync: Object.entries(options.sync ?? {}).map(([key, entry]) => ({ key, platform: entry.platform })),
          }
          return json(body)
        }
        case 'avatar': {
          const name = match.param ?? ''
          if (!(KNOWN_AGENTS as readonly string[]).includes(name)) throw notFound(`no avatar: ${name}`)
          return new Response(avatarSvg(name), {
            headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
          })
        }
        case 'openapi':
          return json(openapi())
        case 'webhook':
          // Platforms can't send a board token: the adapter verifies the request.
          if (!engine) throw notFound('this board has no sync configured')
          return await engine.handleWebhook(match.param!, request)
      }

      const principal = injected?.principal ?? (await authenticate(request, boardUrl))
      const { author, actor } = injected ?? resolveActor(principal, request.headers, boardUrl)
      const identity: Identity = { principal, author, actor }

      switch (match.name) {
        case 'me': {
          const body: Me = {
            actor: actor.id,
            principal: principal.id,
            kind: actor.kind,
            handle: actor.handle,
            name: actor.name,
            avatar: actor.avatar,
            profile: author.profile,
            session: author.session,
            expiresAt: principal.expiresAt?.toISOString() ?? null,
            access: principal.access.summary(),
          }
          return json(body)
        }
        case 'channels': {
          const { state, index } = await session.state(channelsReducer)
          const channels = Object.values(state).sort((a, b) => a.path.localeCompare(b.path))
          return json({ channels, cursor: index })
        }
        case 'actors': {
          const { state, index } = await session.state(actorsReducer)
          const actors = Object.values(state.byId)
            .sort((a, b) => a.handle.localeCompare(b.handle))
            .map((a) => {
              const person = personView(state, a.id)
              return person ? { ...a, person } : a
            })
          return json({ actors, cursor: index })
        }
        case 'identity': {
          const { state, index } = await session.state(actorsReducer)
          const links = linkedTo(state, principal.id).map((id) => ({
            actor: id,
            handle: state.byId[id]?.handle ?? null,
            name: state.byId[id]?.name ?? null,
            method: state.links[id]!.method,
            at: state.links[id]!.at,
          }))
          const unlinked = Object.entries(options.sync ?? {})
            .filter(([, entry]) => !links.some((link) => link.actor.startsWith(`${entry.platform}:user:`)))
            .map(([key]) => key)
          const body: IdentityView = { principal: principal.id, links, unlinked, cursor: index }
          return json(body)
        }
        case 'identityLink': {
          if (!engine) throw notFound('this board has no sync configured')
          const body = IdentityLinkBody.parse(await readJson(request))
          return json(await engine.startLink(identity, body.sync, body.method))
        }
        case 'identityCheck': {
          if (!engine) throw notFound('this board has no sync configured')
          const body = IdentityCheckBody.parse(await readJson(request))
          return json({ linked: await engine.checkLink(identity, body.sync) })
        }
        case 'identityUnlink': {
          if (principal.kind !== 'person') throw forbidden('only people link platform accounts')
          const body = IdentityUnlinkBody.parse(await readJson(request))
          const { state } = await session.state(actorsReducer)
          const mine = linkedTo(state, principal.id)
          const wanted = body.actor.replace(/^@/, '').toLowerCase()
          const found = mine.filter((id) => id === body.actor || state.byId[id]?.handle.toLowerCase() === wanted)
          if (found.length === 0) throw notFound(`${body.actor} isn't linked to you`, 'not_linked')
          if (found.length > 1) throw badRequest(`${body.actor} names several of your accounts: use ${found.join(' or ')}`, 'ambiguous_actor')
          await session.append({ type: 'actor.unlinked', payload: { actor: found[0]!, by: author } })
          return json({ ok: true, actor: found[0]! })
        }
        case 'messages': {
          const query = MessagesQuery.parse(queryObject(url))
          const [{ state, index }, { state: actors }] = await Promise.all([
            session.state(messagesReducer),
            session.state(actorsReducer),
          ])
          const matches = compileFilter(query, { me: actor.id, actors, messages: state })
          let found = Object.values(state.byId)
            .filter(matches)
            .sort((a, b) => a.id - b.id)
          if (query.before !== undefined) found = found.filter((m) => m.id < query.before!)
          const limit = query.limit ?? 50
          found =
            query.after !== undefined
              ? found.filter((m) => m.id > query.after!).slice(0, limit)
              : found.slice(-limit)
          return json({ messages: found.map((m) => view(m, actors)), cursor: index })
        }
        case 'threads': {
          const query = ThreadsQuery.parse(queryObject(url))
          const [{ state, index }, { state: actors }] = await Promise.all([
            session.state(messagesReducer),
            session.state(actorsReducer),
          ])
          const matches = compileFilter(query, { me: actor.id, actors, messages: state })
          const roots = new Set<number>()
          for (const message of Object.values(state.byId)) if (matches(message)) roots.add(message.re ?? message.id)
          let found = [...roots].map((id) => {
            const replies = (state.replies[id] ?? []).map((reply) => state.byId[reply]!).filter((reply) => !reply.deleted)
            const last = replies.at(-1) ?? null
            return { root: state.byId[id]!, replies: replies.length, last, at: last?.id ?? id }
          })
          found.sort((a, b) => a.at - b.at)
          const limit = query.limit ?? 50
          found = query.after !== undefined ? found.filter((t) => t.at > query.after!).slice(0, limit) : found.slice(-limit)
          return json({
            threads: found.map((t) => ({ message: view(t.root, actors), replies: t.replies, last: t.last && view(t.last, actors) })),
            cursor: index,
          })
        }
        case 'message': {
          const [{ state, index }, { state: actors }] = await Promise.all([
            session.state(messagesReducer),
            session.state(actorsReducer),
          ])
          const message = state.byId[match.id!]
          if (!message) throw notFound(`message not found: #${match.id}`, 'message_not_found')
          const root = message.re === null ? message : state.byId[message.re]!
          const replies = (state.replies[root.id] ?? []).map((id) => view(state.byId[id]!, actors))
          return json({ message: view(root, actors), replies, cursor: index, schedules: await schedules.forThread(root.id) })
        }
        case 'post': {
          const body = PostBody.parse(await readJson(request))
          require(principal, 'post', body.channel)
          if (body.sync?.length) require(principal, 'sync', body.channel)
          if (!injected && body.id !== undefined && DERIVED_ID.test(body.id))
            throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
          const attachments = await Promise.all([...new Set(body.attachments ?? [])].map((id) => readAttachment(blob, id)))
          const message = await writePost(writes, {
            attachments,
            identity,
            channel: body.channel,
            re: body.re,
            text: body.text,
            labels: body.labels,
            noSync: body.noSync,
            id: body.id,
            sync: body.sync,
            ...origin,
          })
          return json({ message }, 201)
        }
        case 'schedule': {
          const body = ScheduleBody.parse(await readJson(request))
          require(principal, 'post', body.channel)
          const attachments = await Promise.all([...new Set(body.attachments ?? [])].map((id) => readAttachment(blob, id)))
          return json({ schedule: await schedules.create(identity, body, attachments) }, 201)
        }
        case 'schedules': {
          const query = SchedulesQuery.parse(queryObject(url))
          let root: number | undefined
          if (query.re !== undefined) {
            const { state } = await session.state(messagesReducer)
            const message = state.byId[query.re]
            if (!message) throw notFound(`message not found: #${query.re}`, 'message_not_found')
            root = message.re ?? message.id
          }
          return json({ schedules: await schedules.list({ ...query, ...(root !== undefined ? { root } : {}) }) })
        }
        case 'cancelSchedule': {
          require(principal, 'post')
          return json(await schedules.cancel(identity, match.id!))
        }
        case 'edit': {
          require(principal, 'post')
          const body = EditBody.parse(await readJson(request))
          await writeEdit(writes, { identity, id: match.id!, text: body.text, ...origin })
          return json({ ok: true })
        }
        case 'delete': {
          require(principal, 'post')
          await writeDelete(writes, { identity, id: match.id! })
          return json({ ok: true })
        }
        case 'react': {
          require(principal, 'react')
          const body = ReactBody.parse(await readJson(request))
          await writeReaction(writes, { identity, id: match.id!, emoji: body.emoji, remove: body.remove })
          return json({ ok: true })
        }
        case 'label': {
          require(principal, 'label')
          const body = LabelBody.parse(await readJson(request))
          await writeLabels(writes, { identity, id: match.id!, set: body.set, unset: body.unset })
          return json({ ok: true })
        }
        case 'upload': {
          require(principal, 'post')
          const name = request.headers.get('x-board-filename')
          let decoded: string | null = null
          try {
            decoded = name === null ? null : decodeURIComponent(name)
          } catch {
            throw badRequest('`x-board-filename` is not URI-encoded')
          }
          const attachment = await writeUpload(blob, {
            data: await readCapped(request, ATTACHMENT_BYTES_MAX),
            name: decoded,
            type: request.headers.get('content-type'),
          })
          return json({ attachment }, 201)
        }
        case 'attachment':
          return await attachmentResponse(blob, match.param!)
        case 'sync': {
          require(principal, 'sync')
          const body = SyncBody.parse(await readJson(request))
          return json(await writeAttach(writes, { identity, id: match.id!, target: body.target }))
        }
        case 'typing': {
          require(principal, 'post')
          const { state } = await session.state(messagesReducer)
          const message = state.byId[match.id!]
          if (!message || message.deleted) throw notFound(`message not found: #${match.id}`, 'message_not_found')
          const { status } = TypingBody.parse(await readJson(request)) ?? {}
          const body: TypingResult = { targets: engine ? await engine.typing(message.thread, status) : [] }
          return json(body)
        }
        case 'inbox': {
          // Raw platform payloads, from every channel.
          requireManage(principal, 'reading the inbox')
          if (!engine) throw notFound('this board has no sync configured')
          const query = InboxQuery.parse(queryObject(url))
          return json({ events: await engine.readInbox(match.param!, query.channel, query.limit ?? 50) })
        }
        case 'stuck': {
          // What failed, with its errors, like the inbox.
          requireManage(principal, 'reading stuck events')
          return json({ stuck: await stuck() })
        }
        case 'redrive': {
          requireManage(principal, 'retrying or skipping stuck events')
          return json(await redrive(RedriveBody.parse(await readJson(request)), actor.id))
        }
        case 'sourceRead': {
          // The app's token reads what the app can, not what the caller can.
          requireManage(principal, 'reading a source')
          if (!engine) throw notFound('this board has no sync configured')
          const query = SourceReadQuery.parse(queryObject(url))
          return json(await engine.readSource(match.param!, query.target, query.limit ?? 50))
        }
        case 'events': {
          const query = EventsQuery.parse(queryObject(url))
          const lastEventId = Number(request.headers.get('last-event-id'))
          const after =
            query.after ?? (Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : undefined)
          const { state: actors } = await session.state(actorsReducer)
          const feedOptions = { session, after, filters: query, all: query.all ?? false, me: actor.id, actors }
          if ((request.headers.get('accept') ?? '').includes('text/event-stream'))
            return sse(feedOptions, request.signal, streamMaxMs)
          return json(await pollFeed(feedOptions, (query.wait ?? 0) * 1000, request.signal))
        }
      }
      throw notFound(`no route: ${request.method} ${url.pathname}`)
    } catch (error) {
      return toErrorResponse(error)
    }
  }

  const handle = (request: Request) => dispatch(request, null)
  const servers = [
    server,
    ...(engine ? [engine.inboxServer] : []),
    schedules.server,
    ...(watchers ? [watchers.server] : []),
  ]
  return {
    GET: handle,
    POST: handle,
    fetch: handle,
    /** The scheduler's callback: `export { scheduler as POST }` from a route of its own. */
    scheduler: options.scheduler
      ? options.scheduler.handler(...servers)
      : async () => toErrorResponse(notFound('this board has no scheduler')),
    /** The A2 servers behind this board, to share one scheduler with other A2 servers. */
    servers,
    /**
     * An in-process client for your own server code, writing as `vboard:client:<name>`. With a
     * `key` (a webhook delivery's ID, say), its posts are idempotent: the same key and order
     * never post twice. Its writes wake watchers and sync like any other.
     */
    client(name: string, clientOptions: { key?: string } = {}): BoardClient {
      if (!ID.test(name)) throw new Error(`client: names use lowercase letters, numbers, - and _, got: ${name}`)
      const key = clientOptions.key === undefined ? null : `client:${name}:${clientOptions.key}`
      return clientAs(deploymentIdentity(`vboard:client:${name}`, name), key, { via: { kind: 'client', name } })
    },
    /** For tests and tools. */
    engine,
    session,
  }
}

/** Server-sent events: `id` is the log index, so `Last-Event-ID` resumes exactly. */
function sse(options: Parameters<typeof liveFeed>[0], requestSignal: AbortSignal, maxMs: number): Response {
  const encoder = new TextEncoder()
  const controller = new AbortController()
  const signal = AbortSignal.any([requestSignal, controller.signal, AbortSignal.timeout(maxMs)])
  const body = new ReadableStream<Uint8Array>({
    async start(stream) {
      const ping = setInterval(() => {
        try {
          stream.enqueue(encoder.encode(': ping\n\n'))
        } catch {}
      }, 15_000)
      try {
        stream.enqueue(encoder.encode(': connected\n\n'))
        // Filtered-out events still advance the client's cursor with a bare `id:`.
        for await (const item of liveFeed(options, signal)) {
          stream.enqueue(
            encoder.encode(
              item.view
                ? `id: ${item.index}\nevent: board\ndata: ${JSON.stringify(item.view)}\n\n`
                : `id: ${item.index}\n\n`,
            ),
          )
        }
      } catch (error) {
        console.error('[vboard] feed failed', error)
      } finally {
        clearInterval(ping)
        try {
          stream.close()
        } catch {}
      }
    },
    cancel() {
      controller.abort()
    },
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

function openapi() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [name, definition] of Object.entries(routes)) {
    const path = definition.path.replace(/:(\w+)/g, '{$1}')
    const operation: Record<string, unknown> = { operationId: name }
    if ('query' in definition) operation['x-query-schema'] = z.toJSONSchema(definition.query, { io: 'input' })
    if ('body' in definition)
      operation.requestBody = {
        content: { 'application/json': { schema: z.toJSONSchema(definition.body, { io: 'input' }) } },
      }
    ;(paths[path] ??= {})[definition.method.toLowerCase()] = operation
  }
  return { openapi: '3.1.0', info: { title: 'vboard', version: VERSION }, paths }
}
