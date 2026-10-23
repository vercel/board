import {
  AckBody,
  EditBody,
  EventsQuery,
  IdentityUnlinkBody,
  InboxAckBody,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LabelBody,
  MatchesQuery,
  MessagesQuery,
  PostBody,
  ReactBody,
  Ref,
  RegisterBody,
  ScheduleBody,
  SchedulesQuery,
  SignInQuery,
  SourceReadQuery,
  SyncAccountBody,
  SyncBody,
  SyncCodeBody,
  SyncCopiesQuery,
  SyncFindQuery,
  SyncImportBody,
  UploadStartBody,
  SyncReceiptBody,
  SyncRootsQuery,
  SyncUnlinkBody,
  ThreadsQuery,
  TypingBody,
  type MessageView,
} from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import type { ExternalAuthor } from '../contract/contract.ts'
import type { Actor } from '../contract/reducers.ts'
import { ATTACHMENT_BYTES_MAX, type Attachment } from '../contract/schemas.ts'
import type { SyncEvent } from '../sync/engine.ts'
import { SYNC, type Caller, type InboxDelivery, type ProtocolMethods, type SelfCaller, type VerifiedCaller } from './backend.ts'
import type { Board, BoardContext } from './board.ts'
import { derivedId } from '../client/ids.ts'
import { claimsOf, KNOWN_AGENTS } from './actors.ts'
import type { CallerRequest } from './auth.ts'
import { avatarSvg } from './avatars.ts'
import { badRequest, forbidden, HttpError, json, notFound, toErrorResponse } from './errors.ts'
import { DroppedError, runMiddleware, type Write, type WriteSource } from './middleware.ts'
import { createRouter, METHODS, openapi, queryObject, readCapped, readJson, type BoardRoute } from './routing.ts'
import type { Access } from './access.ts'
import { mentionsEmails, syncTarget, withEmailMentions, type SyncTarget } from './targets.ts'
import type { WriteOrigin } from './writes.ts'
import type { WatcherContext } from './watch.ts'
import { VERSION } from '../version.ts'

/** The methods whose answer is something new. */
const CREATED = new Set<Method>(['post', 'schedule', 'upload', 'uploadFinish'])

/** Shown inline only when a browser can't run it: everything else downloads. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|text\/plain)$/

/**
 * The file, sandboxed: it can't run as a page on the board's origin, and only
 * types a browser can't execute display inline.
 */
function attachmentResponse({ attachment, data }: Protocol['attachment']['output']): Response {
  const disposition = INLINE.test(attachment.type) ? 'inline' : 'attachment'
  const body = data instanceof Uint8Array ? new Blob([data as Uint8Array<ArrayBuffer>]) : data
  return new Response(body, {
    headers: {
      'content-type': attachment.type,
      'content-length': String(attachment.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      // An ID's bytes never change.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}

/** A method's input, from the request: its path's `:id` or `:key`, its query, or its body, validated. */
async function inputOf(name: Method, request: Request, url: URL, params: Record<string, string>): Promise<unknown> {
  const id = params.id ?? ''
  const key = params.key ?? ''
  const body = () => readJson(request)
  switch (name) {
    case 'discovery':
    case 'me':
    case 'channels':
    case 'actors':
    case 'identity':
    case 'watchers':
      return {}
    case 'message':
    case 'posted':
    case 'delete':
    case 'cancelSchedule':
    case 'attachment':
    case 'uploadFinish':
      return { id }
    case 'messages':
      return MessagesQuery.parse(queryObject(url))
    case 'threads':
      return ThreadsQuery.parse(queryObject(url))
    case 'schedules':
      return SchedulesQuery.parse(queryObject(url))
    case 'matches':
      return MatchesQuery.parse(queryObject(url))
    case 'events': {
      const query = EventsQuery.parse(queryObject(url))
      // SSE's own resume header, when the client reconnects by itself.
      const last = request.headers.get('last-event-id')
      if (query.after === undefined && last && Ref.safeParse(last).success) query.after = last
      return query
    }
    case 'post':
      return PostBody.parse(await body())
    case 'schedule':
      return ScheduleBody.parse(await body())
    case 'register':
      return RegisterBody.parse(await body())
    case 'edit':
      return { id, ...EditBody.parse(await body()) }
    case 'react':
      return { id, ...ReactBody.parse(await body()) }
    case 'label':
      return { id, ...LabelBody.parse(await body()) }
    case 'ack':
      return { id, ...AckBody.parse(await body()) }
    case 'upload': {
      const header = request.headers.get('x-board-filename')
      let name: string | null = null
      try {
        name = header === null ? null : decodeURIComponent(header)
      } catch {
        throw badRequest('`x-board-filename` is not URI-encoded')
      }
      return { data: await readCapped(request, ATTACHMENT_BYTES_MAX), name, type: request.headers.get('content-type') }
    }
    case 'uploadStart':
      return UploadStartBody.parse(await body())
    case 'syncImport':
      return SyncImportBody.parse(await body())
    case 'syncReceipt':
      return SyncReceiptBody.parse(await body())
    case 'syncThread':
      return { thread: params.thread ?? '' }
    case 'syncFind':
      return SyncFindQuery.parse(queryObject(url))
    case 'syncCopies':
      return SyncCopiesQuery.parse(queryObject(url))
    case 'syncRoots':
      return SyncRootsQuery.parse(queryObject(url))
    case 'inboxPush':
      return { key, ...InboxPushBody.parse(await body()) }
    case 'inboxNext':
      return { key, ...InboxNextQuery.parse(queryObject(url)) }
    case 'inboxAck':
      return { key, id, ...InboxAckBody.parse(await body()) }
    case 'inbox':
      return { key, ...InboxQuery.parse(queryObject(url)) }
    case 'syncCode':
      return SyncCodeBody.parse(await body())
    case 'syncAccount':
      return SyncAccountBody.parse(await body())
    case 'syncUnlink':
      return SyncUnlinkBody.parse(await body())
    case 'typing':
      return { id, ...(TypingBody.parse(await body()) ?? {}) }
    case 'readSource':
      return { key, ...SourceReadQuery.parse(queryObject(url)) }
  }
}

/**
 * A sync callback's caller: the platform user its event came from, on sync entry `key`, and how to
 * answer them in the event's platform thread. Its client's writes are imports as that user, and the
 * rest it does as sync.
 */
export type PlatformCaller = {
  platform: { author: ExternalAuthor; key: string; respond: (text: string) => Promise<void> }
  origin: WriteOrigin & { via: Extract<WriteSource, { kind: 'sync' }> }
}

/** A platform user, as the middleware is told who's writing. */
const externalActor = (author: ExternalAuthor): Actor => ({ id: author.id, kind: 'external', handle: author.handle, name: author.name, avatar: author.avatar })

/** A write's caller, as the middleware is told: where it came from. The middleware's own handle and sync's lookups skip it. */
function sourceOf(caller: Caller): WriteSource | null {
  const via = caller.origin.via
  if (via?.kind === 'middleware' || via?.kind === 'engine') return null
  return via ?? { kind: 'api' }
}

/** The middleware's own handle: its writes skip the middleware. */
const MIDDLEWARE: SelfCaller = { self: 'middleware', origin: { via: { kind: 'middleware' } } }
/** board()'s own code, for what it looks up itself. */
const OWN: SelfCaller = { self: null, origin: { via: { kind: 'client', name: null } } }

/** board()'s server half, for its handle: what serving, watching, and syncing need, loaded on first use. */
export type Serve = {
  /** Serves a request, or one of this deployment's own calls as `injected`. */
  dispatch(request: Request, injected: Caller | PlatformCaller | null): Promise<Response>
  /** An in-process client's call, as `caller`: its posts get IDs derived from `trigger`, counting `writes`. */
  inject(request: Request, caller: Caller | PlatformCaller, trigger: string | null, writes: { made: number }): Promise<Response>
  run(id: string, event: WatcherContext['event'], meta: { trigger: string; attempt: number }): Promise<void>
  receive(key: string, item: InboxDelivery, meta: { id: string; attempt: number; signal: AbortSignal }): Promise<void>
  pull(): Promise<number>
  /** What `readSource` reads with: sync entry `key`'s app, a 404 `not_synced_here` for one this board doesn't run. */
  readSource(key: string, target: string, limit: number): Promise<Protocol['readSource']['output']>
  /** What `typing` shows typing with: the platforms this board syncs. */
  typing(messages: readonly MessageView[], status: string | undefined): Promise<string[]>
}

/**
 * The board, serving the protocol over HTTP on its backend: it routes and validates each request,
 * verifies its caller, applies `access`, runs the middleware, and calls the backend's method of the
 * same name with the caller it verified. Sync runs here too, for requests and for its own code.
 */
export async function createServe(context: BoardContext): Promise<Serve> {
  const { options, backend, runtime, policy } = context
  const entries = options.sync ?? {}
  // The sync engine, and the adapters it drives, only for a board that syncs.
  const engine = Object.keys(entries).length > 0 ? (await runtime.sync()).createSyncEngine(entries) : null
  const streamMaxMs = options.streamMaxMs ?? 280_000
  const route = createRouter(backend.routes, options.basePath)
  const { state, ownUrl, clientAs, handleOf } = context
  const watch = options.watch ?? {}
  const middleware = options.middleware ?? []

  /** What a request says about who it is, none of it verified yet: its bearer token, its claims, and the board's URL. */
  function requestOf(request: Request, audience: string): CallerRequest {
    const header = request.headers.get('authorization') ?? ''
    const credential = header.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
    return { credential, claims: claimsOf(request.headers), audience, headers: request.headers }
  }

  /** A request's caller, verified: who it is, and what `access` lets it do now. */
  async function callerOf(request: CallerRequest): Promise<VerifiedCaller> {
    return { identity: await policy.identify(request), origin: { via: { kind: 'api' } } }
  }

  /** What a board that serves no requests answers them: a board on `http()` with no `access` of its own. */
  const servesOnly = () => new HttpError(404, 'not_found', `${ownUrl() ?? 'this board'} answers only wake-ups and webhooks`)

  /**
   * `@[ada@vercel.com]`: an email a synced platform knows becomes that user's mention, and the
   * board learns who they are; the rest stay plain text.
   */
  async function withEmails(text: string): Promise<string> {
    // Each one sync finds, the board must know before a post can mention them; one it can't learn stays an email.
    const find = engine
      ? async (email: string) => {
          const actor = await engine.findByEmail(email)
          if (actor) await backend.syncImport(engine.caller, { op: 'seen', author: { ...actor, isBot: false } }, new AbortController().signal)
          return actor
        }
      : undefined
    return (await withEmailMentions(text, find)).text
  }

  /**
   * A sync target as the board that syncs it resolves it. One for an entry this board doesn't
   * have goes on as it is, for the sync that does, unless this board syncs: then it's a mistake.
   */
  async function resolveTarget(target: string | SyncTarget): Promise<SyncTarget> {
    if (typeof target !== 'string') return target
    const at = target.indexOf(':')
    if (at <= 0) throw badRequest(`sync targets look like <key>:<channel or thread>, got: ${target}`)
    const key = target.slice(0, at)
    if (engine && entries[key]) return engine.normalizeTarget(target)
    if (engine) throw badRequest(`no sync entry named ${key}`)
    return syncTarget(target)
  }

  /**
   * What a verified caller may do, as board()'s `access` said when it verified them: board() checks
   * it before it does anything for them past calling the backend (a platform call, an email lookup,
   * sync's own write, reading an upload, the middleware), so a caller it won't let in starts none of
   * it. Null for this deployment's own code, which may do everything.
   */
  const accessOf = (caller: Caller): Access | null => ('identity' in caller ? caller.identity.principal.access : null)

  /**
   * Whether board() may work for a write of `caller`'s that lands in `channel`, or in the thread of
   * message `re`, which it must read: `post` there. One it may not goes to the backend as it came,
   * for the backend to say why.
   */
  async function mayPost(caller: Caller, where: { channel?: string | undefined; re?: string | undefined }, signal: AbortSignal): Promise<{ access: Access | null; channel: string } | null> {
    const access = accessOf(caller)
    // This deployment's own code needs no lookup: it may.
    if (access === null) return { access: null, channel: where.channel ?? '' }
    const channel = where.channel ?? (where.re === undefined ? undefined : (await lookup(caller, where.re, signal))?.channel)
    if (channel === undefined) return null
    return access.can('post', channel) ? { access, channel } : null
  }

  /** Who this deployment's own code is on its backend, asked once each: the middleware is told who's writing. */
  const selves = new Map<string, Promise<{ principal: string; actor: Actor }>>()
  async function whoIs(caller: Caller, signal: AbortSignal): Promise<{ principal: string; actor: Actor }> {
    if ('identity' in caller) return { principal: caller.identity.principal.id, actor: caller.identity.actor }
    const key = JSON.stringify([caller.origin.via?.kind ?? '', caller.self, caller.profile ?? null])
    let found = selves.get(key)
    if (!found) {
      selves.set(
        key,
        (found = backend.me(caller, {}, signal).then((me) => ({
          principal: me.principal,
          actor: { id: me.actor, kind: me.kind, handle: me.handle, name: me.name, avatar: me.avatar },
        }))),
      )
      found.catch(() => selves.delete(key))
    }
    return found
  }

  let middlewareBoard: Board | null = null
  /** Runs the middleware on a write, then `commit`s what it passed on: a `DroppedError` when it drops it. */
  const screen = <W extends Write, T>(write: W, author: Actor, source: WriteSource, commit: (write: W) => Promise<T>): Promise<T> =>
    runMiddleware(middleware, { write, author, source, board: () => (middlewareBoard ??= handleOf(MIDDLEWARE, null)) }, commit)

  /** Whether a lookup found what it looked for: a 404 says it didn't. */
  async function found(lookup: () => Promise<unknown>): Promise<boolean> {
    try {
      await lookup()
      return true
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false
      throw error
    }
  }

  /** Files a write carries, as the board stored them: each one `caller` may have, or the backend's 404. */
  async function attachmentsOf(caller: Caller, ids: readonly string[] | undefined, signal: AbortSignal): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    for (const id of new Set(ids ?? [])) {
      const { attachment, data } = await backend.attachment(caller, { id }, signal)
      if (data instanceof ReadableStream) await data.cancel().catch(() => {})
      attachments.push(attachment)
    }
    return attachments
  }

  /**
   * A post through the middleware, then `send`: once board() knows it would land (a reply's root is
   * there, and the caller may post, label, and sync where it does), with the files it may have. A
   * retry of one that landed stands, whatever the middleware would say now; one that wouldn't land
   * goes as it came, for the backend to say why.
   */
  async function screenPost(
    caller: Caller,
    input: Protocol['post']['input'],
    signal: AbortSignal,
    send: (input: Protocol['post']['input']) => Promise<Protocol['post']['output']>,
  ): Promise<Protocol['post']['output']> {
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(input)
    if (input.id !== undefined && (await found(() => backend.posted(caller, { id: input.id! }, signal)))) return send(input)
    let channel = input.channel
    let re: string | null = null
    if (input.re !== undefined) {
      const root = await lookup(caller, input.re, signal)
      if (!root) return send(input)
      channel = root.channel
      re = root.re ?? root.id
    }
    const access = accessOf(caller)
    const labels = Object.keys(input.labels ?? {}).length > 0
    const syncs = input.re === undefined && (input.sync?.length ?? 0) > 0
    if (channel === undefined || (access && (!access.can('post', channel) || (labels && !access.can('label', channel)) || (syncs && !access.can('sync', channel)))))
      return send(input)
    const attachments = await attachmentsOf(caller, input.attachments, signal)
    const { actor } = await whoIs(caller, signal)
    return screen({ kind: 'post', channel, re, text: input.text, labels: input.labels ?? {}, attachments }, actor, source, (write) =>
      send({ ...input, text: write.text, labels: write.labels }),
    )
  }

  /**
   * The caller's own message, still there, where it may post: what an edit of it changes. One it
   * can't read may still be its own, as board()'s own code finds it, only if it was written there
   * without reading too: one its principal wrote where it reads (a repo's workflows share one) is
   * as missing to it as one that isn't there.
   */
  async function ownMessage(caller: Caller, id: string, signal: AbortSignal): Promise<MessageView | null> {
    const access = accessOf(caller)
    const readable = await lookup(caller, id, signal)
    const message = readable ?? (access !== null ? await lookup(OWN, id, signal) : null)
    if (!message || message.deleted || (access && !access.can('post', message.channel))) return null
    if (!readable && !message.blind) return null
    return message.by.principal === (await whoIs(caller, signal)).principal ? message : null
  }

  /** An edit through the middleware, then `send`: only the author's own, of a message that's still there, reaches it. */
  async function screenEdit(
    caller: Caller,
    input: Protocol['edit']['input'],
    signal: AbortSignal,
    send: (input: Protocol['edit']['input']) => Promise<Protocol['edit']['output']>,
  ): Promise<Protocol['edit']['output']> {
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(input)
    const message = await ownMessage(caller, input.id, signal)
    if (!message) return send(input)
    const { actor } = await whoIs(caller, signal)
    return screen({ kind: 'edit', id: message.id, channel: message.channel, re: message.re, text: input.text }, actor, source, (write) => send({ ...input, text: write.text }))
  }

  /**
   * Where an import came from, as the middleware is told: the platform event sync says it's from,
   * or what its entry and origin say. Null when it names an entry its caller doesn't sync, which
   * the backend refuses.
   */
  async function importSource(
    caller: Caller,
    body: Extract<Protocol['syncImport']['input'], { op: 'post' | 'edit' }>,
    found: MessageView | null,
    signal: AbortSignal,
  ): Promise<Extract<WriteSource, { kind: 'sync' }> | null> {
    const key = body.source?.key ?? body.from
    if (body.source) {
      const known =
        'identity' in caller
          ? (await backend.watchers(caller, {}, signal)).watchers.some((registration) => registration.owner === caller.identity.principal.id && registration.sync.some((entry) => entry.key === key))
          : entries[body.source.key] !== undefined
      if (!known) return null
    }
    const origin = (body.op === 'post' ? body.origin : null) ?? found?.origin ?? null
    return {
      kind: 'sync',
      key: key ?? '',
      platform: body.author.id.slice(0, Math.max(0, body.author.id.indexOf(':'))),
      channel: body.source?.channel ?? found?.origin?.channel ?? origin?.channel ?? '',
      thread: body.source?.thread ?? (origin ? (origin.subthread ?? origin.thread) : ''),
    }
  }

  /** The board message an import changes: the one it names, or the one its platform IDs are on the board as. */
  async function importTarget(caller: Caller, body: Extract<Protocol['syncImport']['input'], { op: 'edit' }>, signal: AbortSignal): Promise<MessageView | null> {
    let id = body.message ?? null
    if (body.origin !== undefined) {
      const { thread, message } = await backend.syncFind(caller, { thread: body.origin.thread, ...(body.origin.message !== undefined ? { message: body.origin.message } : {}) }, signal)
      id = body.origin.message !== undefined ? message : thread === null ? null : (await backend.syncThread(caller, { thread }, signal)).root
    }
    return id === null ? null : lookup(caller, id, signal)
  }

  /**
   * An import, through the middleware when it's a post or an edit that would land: what the
   * middleware passed on, or what it responded when it dropped it, for sync to tell the author on
   * the platform. A retry of one that landed stands.
   */
  async function syncImport(caller: Caller, body: Protocol['syncImport']['input'], signal: AbortSignal): Promise<Protocol['syncImport']['output']> {
    const send = (patched: Protocol['syncImport']['input']) => backend.syncImport(caller, patched, signal)
    if (middleware.length === 0 || caller.origin.via?.kind === 'middleware' || (body.op !== 'post' && body.op !== 'edit')) return send(body)
    const access = accessOf(caller)
    // One that can't import goes as it came, for the backend to say why: no sync, or narrowed with x-board-scope.
    if (access && (!access.anywhere('sync') || ('identity' in caller && caller.identity.principal.scope !== undefined))) return send(body)
    const dropped = async (commit: () => Promise<Protocol['syncImport']['output']>) => {
      try {
        return await commit()
      } catch (error) {
        if (!(error instanceof DroppedError)) throw error
        return { message: null, dropped: [...error.responses] }
      }
    }
    if (body.op === 'post') {
      if (body.id !== undefined && (await backend.syncFind(caller, { post: body.id }, signal)).message !== null) return send(body)
      let channel = body.channel
      let re: string | null = null
      if (body.re !== undefined) {
        const root = await lookup(caller, body.re, signal)
        if (!root) return send(body)
        channel = root.channel
        re = root.re ?? root.id
      }
      if (channel === undefined || (access && !access.can('sync', channel))) return send(body)
      const source = await importSource(caller, body, null, signal)
      if (!source) return send(body)
      const attachments = await attachmentsOf(caller, body.attachments, signal)
      return dropped(async () =>
        screen({ kind: 'post', channel: channel!, re, text: body.text, labels: body.labels ?? {}, attachments }, externalActor(body.author), source, async (write) =>
          send({ ...body, text: write.text, labels: write.labels }),
        ),
      )
    }
    if ((body.origin === undefined) === (body.message === undefined)) return send(body)
    const found = await importTarget(caller, body, signal)
    // Only an edit that would land reaches the middleware: the author's own, when it's named by board ID.
    if (!found || found.deleted || (access && !access.can('sync', found.channel)) || (body.message !== undefined && found.by.principal !== body.author.id)) return send(body)
    const source = await importSource(caller, body, found, signal)
    if (!source) return send(body)
    return dropped(async () =>
      screen({ kind: 'edit', id: found.id, channel: found.channel, re: found.re, text: body.text }, externalActor(body.author), source, async (write) => send({ ...body, text: write.text })),
    )
  }

  /** A message as `caller` may read it, or null. */
  async function lookup(caller: Caller, id: string, signal: AbortSignal): Promise<MessageView | null> {
    try {
      const { message, replies } = await backend.message(caller, { id }, signal)
      return [message, ...replies].find((candidate) => candidate.id === id) ?? null
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    }
  }

  /**
   * A post, with the emails it mentions resolved and the targets its channel syncs with landing
   * beside it, once the caller may post there (and sync, for targets it names), through the
   * middleware.
   */
  async function post(caller: Caller, input: Protocol['post']['input'], signal: AbortSignal): Promise<Protocol['post']['output']> {
    const send = (poster: Caller, body: Protocol['post']['input']) => screenPost(poster, body, signal, (patched) => backend.post(poster, patched, signal))
    // Without sync, nothing here calls a platform: its targets only take their shape.
    if (!engine) return send(caller, input.sync?.length ? { ...input, sync: await Promise.all(input.sync.map(resolveTarget)) } : input)
    const work = (input.sync?.length ?? 0) > 0 || mentionsEmails(input.text) || (input.channel !== undefined && !input.noSync)
    const allowed = work ? await mayPost(caller, input, signal) : null
    if (!allowed) return send(caller, input)
    const { access, channel } = allowed
    // A reply's targets are a mistake the backend names: only a new thread's go to the platform.
    const syncs = input.re === undefined && (input.sync?.length ?? 0) > 0 && (access === null || access.can('sync', channel))
    const body = syncs ? { ...input, sync: await Promise.all(input.sync!.map(resolveTarget)) } : input
    let poster = caller
    if (body.channel !== undefined && !body.noSync) {
      const config = await engine.configTargets(body.channel)
      if (config.length > 0) poster = { ...caller, origin: { ...caller.origin, config } } as Caller
    }
    const text = await withEmails(body.text)
    const answer = await send(poster, { ...body, text })
    // One that can't read where it posted gets back what it sent: who its emails are isn't its to see.
    return text !== input.text && access !== null && !access.readable(answer.message.channel) ? { ...answer, message: { ...answer.message, text: input.text } } : answer
  }

  /**
   * An import's answer, as a sync callback's client gets it: the message it wrote or changed, or the
   * middleware's responses in the event's platform thread and a `DroppedError` when it dropped it.
   */
  async function landed(caller: PlatformCaller, answer: Protocol['syncImport']['output']): Promise<string | null> {
    if (!answer.dropped) return answer.message
    for (const text of answer.dropped) await caller.platform.respond(text)
    throw new DroppedError(answer.dropped)
  }

  /**
   * What a sync callback's client does, on any backend. Its own writes are imports, as the platform
   * user the event came from, which the middleware sees as any import; everything else, its reads
   * included, it does as sync. A change it names by ID is an import that names it so.
   */
  async function asPlatform(name: Method, caller: PlatformCaller, input: unknown, signal: AbortSignal): Promise<unknown> {
    const sync = engine!
    const me = sync.caller
    const { author, key } = caller.platform
    const { via } = caller.origin
    const source = { key, channel: via.channel, thread: via.thread }
    const change = async (body: Protocol['syncImport']['input']) => {
      const message = await landed(caller, await syncImport(me, body, signal))
      if (message === null) throw notFound(`message not found: #${(body as { message?: string }).message}`, 'message_not_found')
      return { ok: true as const }
    }
    switch (name) {
      case 'post':
        return importPost(caller, input as Protocol['post']['input'], signal)
      case 'edit': {
        const { id, text } = input as Protocol['edit']['input']
        return change({ op: 'edit', author, from: null, message: id, text: await withEmails(text), source })
      }
      case 'delete':
        return change({ op: 'delete', author, from: null, message: (input as Protocol['delete']['input']).id })
      case 'react': {
        const { id, emoji, remove } = input as Protocol['react']['input']
        return change({ op: 'react', author, from: null, message: id, emoji, ...(remove !== undefined ? { remove } : {}) })
      }
      case 'label': {
        const { id, set, unset } = input as Protocol['label']['input']
        return change({ op: 'labels', author, from: null, message: id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) })
      }
      default:
        return invoke(name, me, input, signal)
    }
  }

  /** A sync callback's post, as an import by its platform user: once per client ID, which the backend sees to. */
  async function importPost(caller: PlatformCaller, input: Protocol['post']['input'], signal: AbortSignal): Promise<Protocol['post']['output']> {
    const sync = engine!
    const me = sync.caller
    const { author, key } = caller.platform
    const { via } = caller.origin
    const read = async (id: string) => {
      const message = await lookup(me, id, signal)
      if (!message) throw notFound(`message not found: #${id}`, 'message_not_found')
      return message
    }
    // A retry of one that landed: it stands, and its targets were recorded with it.
    if (input.id !== undefined) {
      const found = (await backend.syncFind(me, { post: input.id }, signal)).message
      if (found !== null) return { message: await read(found) }
    }
    const targets = await Promise.all((input.sync ?? []).map(resolveTarget))
    // A new root lands with the targets its channel syncs with, as any post through board() does.
    const config = input.channel !== undefined && !input.noSync ? await sync.configTargets(input.channel) : []
    const importer: Caller = config.length > 0 ? { ...me, origin: { ...me.origin, config } } : me
    const message = await landed(
      caller,
      await syncImport(importer, {
        op: 'post',
        author,
        from: null,
        origin: null,
        source: { key, channel: via.channel, thread: via.thread },
        ...(input.channel !== undefined ? { channel: input.channel } : { re: input.re! }),
        text: await withEmails(input.text),
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.noSync ? { noSync: true } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.id !== undefined ? { id: input.id } : {}),
      }, signal),
    )
    // The targets it asked for, as sync records a thread's.
    for (const target of targets)
      await backend.syncReceipt(me, { kind: 'thread', message: message!, target: target.target, targetKind: target.kind, cause: 'request' }, signal)
    return { message: await read(message!) }
  }

  /** The protocol method `name`, as board() serves it: what it posts and edits with the emails they mention resolved. */
  async function invoke(name: Method, caller: Caller, input: unknown, signal: AbortSignal): Promise<unknown> {
    switch (name) {
      case 'post':
        return post(caller, input as Protocol['post']['input'], signal)
      case 'edit': {
        // Its emails resolve once the caller may post where the message is, and read it.
        const { id, text } = input as Protocol['edit']['input']
        const send = (body: Protocol['edit']['input']) => screenEdit(caller, body, signal, (patched) => backend.edit(caller, patched, signal))
        if (!engine || !mentionsEmails(text) || !(await mayPost(caller, { re: id }, signal))) return send({ id, text })
        return send({ id, text: await withEmails(text) })
      }
      case 'syncImport':
        return syncImport(caller, input as Protocol['syncImport']['input'], signal)
      case 'schedule': {
        const body = input as Protocol['schedule']['input']
        const allowed = engine && mentionsEmails(body.text) ? await mayPost(caller, body, signal) : null
        if (!allowed) return backend.schedule(caller, body, signal)
        const text = await withEmails(body.text)
        const answer = await backend.schedule(caller, { ...body, text }, signal)
        // As for a post: one that can't read where it lands gets back what it sent.
        const { access } = allowed
        return text !== body.text && access !== null && !access.readable(answer.schedule.channel) ? { ...answer, schedule: { ...answer.schedule, text: body.text } } : answer
      }
      case 'inbox': {
        const query = input as Protocol['inbox']['input']
        // A channel by name, for an entry this board has: its platform ID, for a caller that may sync.
        if (engine && entries[query.key] && query.channel !== undefined) {
          const access = accessOf(caller)
          if (access === null || access.anywhere('sync')) return backend.inbox(caller, { ...query, channel: await engine.inboxChannel(query.key, query.channel) }, signal)
        }
        return backend.inbox(caller, query, signal)
      }
      default: {
        const method = backend[name] as unknown
        if (typeof method !== 'function') throw notFound(`no route: ${name}`)
        return (method as (caller: Caller, input: unknown, signal: AbortSignal) => Promise<unknown>).call(backend, caller, input, signal)
      }
    }
  }

  /**
   * A sign-in that carries a code, where the entry's sync runs: a browser opens it with no token,
   * so the code is all it has. `signIn` sends the person to the platform as whoever the code was
   * issued to; `signedIn`, where the platform sends them back, links the account they approved.
   */
  async function signingIn(name: 'signIn' | 'signedIn', url: URL, signal: AbortSignal): Promise<Response> {
    const { sync: key, code } = SignInQuery.parse(queryObject(url))
    if (!engine || !entries[key]) throw notFound(`no sync entry named ${key}`)
    const page = (status: number, text: string) => new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    const { holder } = await backend.syncFind(engine.caller, { code }, signal)
    if (holder === null) return page(404, "That link has expired or been used. Run `vb identity link` again for a new one.")
    if (name === 'signIn') {
      const back = ownUrl()
      const at = await engine.signIn(key, holder, back ? `${back}/identity/signed-in?${new URLSearchParams({ sync: key, code })}` : undefined)
      return new Response(null, { status: 302, headers: { location: at } })
    }
    const linked = await engine.redeemSignIn(key, holder, code)
    if (!linked) return page(409, `${entries[key]!.platform} hasn't said you approved yet: finish signing in, then open this page again.`)
    return page(200, `Linked ${linked.handle ? `@${linked.handle}` : linked.actor}. You can close this tab.`)
  }

  /** board()'s own routes for a caller: sync's, which run where board() does. */
  async function serve(name: BoardRoute, caller: Caller, request: Request, url: URL, params: Record<string, string>): Promise<Response> {
    const signal = request.signal
    switch (name) {
      case 'sync': {
        // Attaching a thread is a `thread` receipt, recorded as the caller: it needs `sync` where the thread is,
        // which a request's caller shows before its target goes to the platform to resolve.
        const body = SyncBody.parse(await readJson(request))
        const id = params.id ?? ''
        const access = accessOf(caller)
        if (access && engine) {
          const message = await lookup(caller, id, signal)
          if (!message) throw notFound(`message not found: #${id}`, 'message_not_found')
          if (!access.can('sync', message.channel)) throw forbidden(`this token can't sync in ${message.channel}`)
        }
        const target = await resolveTarget(body.target)
        const { attached } = await backend.syncReceipt(caller, { kind: 'thread', message: id, target: target.target, targetKind: target.kind, cause: 'request' }, signal)
        return json({ target: target.target, attached: attached ?? true })
      }
      case 'identityUnlink': {
        // Who may unlink what is the backend's: it answers for the caller's own links.
        const body = IdentityUnlinkBody.parse(await readJson(request))
        const { links } = await backend.identity(caller, {}, signal)
        const wanted = body.actor.replace(/^@/, '').toLowerCase()
        const found = links.filter((link) => link.actor === body.actor || link.handle?.toLowerCase() === wanted).map((link) => link.actor)
        if (found.length === 0) throw notFound(`${body.actor} isn't linked to you`, 'not_linked')
        if (found.length > 1) throw badRequest(`${body.actor} names several of your accounts: use ${found.join(' or ')}`, 'ambiguous_actor')
        await backend.syncUnlink(caller, { account: found[0]! }, signal)
        return json({ ok: true, actor: found[0]! })
      }
      default:
        throw notFound(`no route: ${request.method} ${url.pathname}`)
    }
  }

  // Sync reads and writes through the backend's methods, its imports through the middleware first.
  const synced = Object.fromEntries(
    METHODS.map((name) => [name, name === 'syncImport' ? syncImport : (caller: Caller, input: never, signal: AbortSignal) => (backend[name] as (...args: unknown[]) => unknown).call(backend, caller, input, signal)]),
  ) as unknown as ProtocolMethods
  engine?.bind({
    backend: synced,
    client: (platform, trigger) => clientAs({ platform: { author: platform.author, key: platform.key, respond: platform.respond }, origin: { via: platform.via } }, trigger),
  })

  /**
   * Server-sent events, from the backend's long-poll: each event's `id` is its cursor, so
   * `Last-Event-ID` resumes exactly. A request's caller is worked out again for each page, so what
   * `access` says now holds, and a token that runs out ends it.
   */
  async function sse(caller: Caller, query: Protocol['events']['input'], request: Request, identify: (() => Promise<Caller>) | null): Promise<Response> {
    // The first page now, so a bad cursor or a refusal answers as an error instead of a stream.
    const first = await backend.events(caller, { ...query, wait: 0 }, request.signal)
    const encoder = new TextEncoder()
    const controller = new AbortController()
    const deadline = Date.now() + streamMaxMs
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(streamMaxMs)])
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        const send = (text: string) => {
          try {
            stream.enqueue(encoder.encode(text))
          } catch {}
        }
        const ping = setInterval(() => send(': ping\n\n'), 15_000)
        try {
          send(': connected\n\n')
          let page = first
          let after: string | undefined
          for (;;) {
            for (const event of page.events) send(`id: ${event.cursor}\nevent: board\ndata: ${JSON.stringify(event)}\n\n`)
            // Filtered-out events still advance the client's cursor with a bare `id:`, the first page's included.
            if (page.cursor !== (page.events.at(-1)?.cursor ?? after)) send(`id: ${page.cursor}\n\n`)
            after = page.cursor
            const left = deadline - Date.now()
            if (signal.aborted || left <= 0) break
            page = await backend.events(identify ? await identify() : caller, { ...query, after, wait: Math.min(300, left / 1000) }, signal)
          }
        } catch (error) {
          if (!signal.aborted) console.error('[vboard] feed failed', error)
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

  /**
   * Discovery, as a request reaches the board: who the board is to it (the URL a token must be minted
   * for, and the project people mint them with), which is board()'s to say, and the sync entries
   * accounts link on. Those are the backend's, where it keeps the board; a board on `http()` lists its own.
   */
  async function discovery(request: Request, url: string, signal: AbortSignal): Promise<Protocol['discovery']['output']> {
    const { projectId, teamId } = await policy.discoveryIdentity(request.headers)
    const sync = backend.keeps
      ? (await backend.discovery(OWN, {}, signal)).sync
      : Object.entries(entries).map(([key, entry]) => ({ key, platform: entry.platform }))
    return { version: VERSION, url, audience: url, team_id: teamId, project_id: projectId, sync }
  }

  async function dispatch(request: Request, injected: Caller | PlatformCaller | null): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = route(request.method, url.pathname)
      if (!match) throw notFound(`no route: ${request.method} ${url.pathname}`)
      const { target } = match
      // The mount, as requests show it. Every request reaches the handler under it, so one can only make it
      // look deeper (`/api/board/x/messages/1`): a mount replaces the one learned only when it's above it.
      if (!injected && !match.root && (state.learned === null || state.learned.startsWith(`${match.base}/`))) state.learned = match.base
      const boardUrl = (options.url ?? `${url.origin}${match.base}`).replace(/\/+$/, '')

      if (target.kind === 'board' && target.name === 'webhook') {
        // A platform can't send a board token: its adapter verifies the request.
        if (!engine || !entries[match.params.key ?? '']) throw notFound(`no sync entry named ${match.params.key}`)
        return await engine.handleWebhook(match.params.key!, request)
      }
      if (target.kind === 'board' && (target.name === 'signIn' || target.name === 'signedIn')) return await signingIn(target.name, url, request.signal)
      if (target.kind === 'board' && target.name === 'avatar') {
        const name = match.param ?? ''
        if (!(KNOWN_AGENTS as readonly string[]).includes(name)) throw notFound(`no avatar: ${name}`)
        return new Response(avatarSvg(name), {
          headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
        })
      }
      if (target.kind === 'board' && target.name === 'openapi') return json(openapi())
      // A backend's own routes check what they need: a wake-up carries no board token.
      if (target.kind === 'backend') return await target.route.handle(request, { caller: injected && 'platform' in injected ? engine!.caller : injected, param: match.param })

      // Everything else is for a caller: this deployment's own code, or a request, which a board on
      // http() with no access of its own doesn't serve. Nothing runs for one before that.
      if (!injected && !policy.open) throw servesOnly()
      if (!injected && target.kind === 'protocol' && target.name === 'discovery') return json(await discovery(request, boardUrl, request.signal))
      if (target.kind === 'protocol' && typeof (backend[target.name] as unknown) !== 'function') throw notFound(`no route: ${request.method} ${url.pathname}`)
      // A sync callback's client does everything but its own writes as sync.
      const own = injected && 'platform' in injected ? engine!.caller : injected
      const asked = own ? null : requestOf(request, boardUrl)
      const caller: Caller = own ?? (await callerOf(asked!))
      if (target.kind === 'board') return await serve(target.name, caller, request, url, match.params)

      const input = await inputOf(target.name, request, url, match.params)
      if (target.name === 'events' && (request.headers.get('accept') ?? '').includes('text/event-stream'))
        return await sse(caller, input as Protocol['events']['input'], request, asked ? () => callerOf(asked) : null)
      const output = injected && 'platform' in injected ? await asPlatform(target.name, injected, input, request.signal) : await invoke(target.name, caller, input, request.signal)
      if (target.name === 'attachment') return attachmentResponse(output as Protocol['attachment']['output'])
      return json(output, CREATED.has(target.name) ? 201 : 200)
    } catch (error) {
      return toErrorResponse(error)
    }
  }

  return {
    dispatch,
    async inject(request, caller, trigger, writes) {
      if (trigger !== null && request.method === 'POST' && new URL(request.url).pathname.endsWith('/messages')) {
        const body = ((await request.json()) ?? {}) as Record<string, unknown>
        body.id ??= await derivedId('vboard-inbound', trigger, 'client', String(writes.made++))
        request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
      }
      return dispatch(request, caller)
    },
    async run(id, event, { trigger, attempt }) {
      if (id === SYNC && engine) return engine.deliver(event as SyncEvent, { attempt })
      const watcher = watch[id]
      if (!watcher) throw new Error(`this board has no watcher ${id}`)
      await watcher.run({ event, board: handleOf({ self: id, origin: { via: { kind: 'watcher', id } } }, trigger) })
    },
    async receive(key, item, { id, attempt }) {
      if (!engine) throw new Error(`this board has no sync, so nothing reads ${key}'s inbox`)
      await engine.receive(key, item, { id, attempt })
    },
    pull: () => (engine ? engine.pull() : Promise.resolve(0)),
    async readSource(key, target, limit) {
      if (!engine || !entries[key]) throw notFound(`this board doesn't run sync entry ${key}: read it where its sync runs`, 'not_synced_here')
      return engine.readSource(key, target, limit)
    },
    typing: async (messages, status) => (engine ? engine.typing(messages, status) : []),
  }
}
