import { createHash, randomBytes } from 'node:crypto'
import { canonicalEmoji } from '../contract/emoji.ts'
import { idempotentId } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { BoardClient } from '../client/client.ts'
import {
  IDENTITY_SESSION,
  identityContract,
  inboxContract,
  inboxSession,
  type ExternalAuthor,
  type BoardEvents,
  type ExternalEvent,
  type ExternalFile,
  Link,
  type ExternalLink,
  type InboxEvent,
} from '../contract/contract.ts'
import {
  actorsReducer,
  externalMessageKey,
  identityCodesReducer,
  isThreadTarget,
  linkedTo,
  messagesReducer,
  syncReducer,
  type Actor,
  type ActorsState,
  type ExternalCopy,
  type IdentityCode,
  type Message,
} from '../contract/reducers.ts'
import { fileSize, typeOf } from '../contract/files.ts'
import { ATTACHMENT_BYTES_MAX, ATTACHMENTS_PER_MESSAGE_MAX, MESSAGE_TEXT_MAX, type Attachment, type Author } from '../contract/schemas.ts'
import type { IdentityChallenge, LinkedAccount } from '../api/routes.ts'
import { actorSeen } from '../server/actors.ts'
import { readAttachmentData, writeUpload, type BlobStore } from '../server/blob.ts'
import type { Principal } from '../server/auth.ts'
import { FULL_ACCESS } from '../server/access.ts'
import type { BoardSession } from '../server/board.ts'
import { badRequest, forbidden, HttpError, notFound } from '../server/errors.ts'
import {
  writeDelete,
  writeEdit,
  writeLabels,
  writeLinks,
  writePost,
  writeReaction,
  type Identity,
  type WriteContext,
  type WriteOrigin,
} from '../server/writes.ts'
import { DroppedError } from '../server/middleware.ts'
import type { SyncProvider } from './provider.ts'
import { replaceMentions } from '../contract/mentions.ts'
import { SyncOverrides, immutable, type SyncRoot, type ProviderEvent, type SyncResult } from './events.ts'
import { ReceivedEvent, ResolvedTarget, UnreadableError, type ProviderMapping, type ProviderSender, type SyncClient, type SyncContext } from './provider.ts'
import { ChannelPath } from '../contract/schemas.ts'
import { displayText } from '../contract/bots.ts'

export type BoardBinding = {
  session: BoardSession
  writes: WriteContext
  /** A vboard client writing as `identity`, with write IDs derived from `trigger`. */
  clientAs(identity: Identity, trigger: string, origin: WriteOrigin): BoardClient
}

/** `files`: a message with files may have no text. */
const clampText = (text: string, files = false) => {
  const trimmed = text.trim() === '' ? (files ? '' : '(no text)') : text
  return trimmed.length > MESSAGE_TEXT_MAX ? `${trimmed.slice(0, MESSAGE_TEXT_MAX - 1)}…` : trimmed
}

/** A platform file the board couldn't bring over gets a line in the text instead. */
const fileNote = (file: ExternalFile, why: string) =>
  `📎 ${file.name ?? 'a file'}${file.size !== undefined ? ` (${fileSize(file.size)})` : ''} didn't come over: ${why}`

/** A platform message's text with its file notes after it. */
const withNotes = (text: string, notes: string[]) =>
  notes.length ? `${text.trim() ? `${text}\n\n` : ''}${notes.join('\n')}` : text

/** The file notes in a message's text, so a platform edit (which only knows the text it shows) keeps them. */
const notesIn = (text: string) => text.split('\n').filter((line) => /^📎 .* didn't come over: /u.test(line))

/** Whether two link lists say the same, whatever order their keys were written in. */
const sameLinks = (a: Link[], b: Link[]) => JSON.stringify(a.map((link) => Link.parse(link))) === JSON.stringify(b.map((link) => Link.parse(link)))

/**
 * A one-time code for linking an account: `vb-` and eight letters and digits that
 * can't be misread. A platform message that is only a live code is claimed, not imported.
 */
const CODE = /^\s*`?(vb-[a-z0-9]{4}-[a-z0-9]{4})`?\s*$/i
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 10 * 60_000
const newCode = () => {
  const letters = [...randomBytes(8)].map((byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('')
  return `vb-${letters.slice(0, 4)}-${letters.slice(4)}`
}
const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase()).digest('base64url')

/**
 * How long a board message written by someone who posts as themselves may still be
 * on its way out: their copy comes back through the webhook looking like any of
 * their messages, and until its receipt lands, it's held back rather than imported twice.
 */
const ECHO_WINDOW_MS = 60_000
const ECHO_ATTEMPTS = 6

/** Tries per file before it's noted instead: a retry repeats the whole message, so keep it short. */
const FILE_ATTEMPTS = 3

const jsonSafe = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

/** Durable two-way sync between the board and its providers. */
export function createSyncEngine(options: {
  entries: Record<string, SyncProvider>
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
  /** Where attachments' bytes are, for platforms that take uploads. */
  blob?: BlobStore | null
}) {
  const entries = options.entries
  let binding: BoardBinding | null = null
  const bound = () => {
    if (!binding) throw new Error('sync engine used before the board bound it')
    return binding
  }

  const platformOf = (key: string): SyncProvider => {
    const platform = entries[key]
    if (!platform) throw badRequest(`no sync entry named ${key}`)
    return platform
  }
  const keyOf = (target: string) => target.slice(0, target.indexOf(':'))
  const native = (external: string) => external.slice(external.indexOf(':') + 1)

  // --- mappings ---------------------------------------------------------------

  type Mapping = ProviderMapping
  /** How long a key that didn't resolve (say, a Slack channel that doesn't exist yet) waits before another try. */
  const RETRY_MS = 60_000
  const resolved = new Map<string, { map: Promise<Map<string, Mapping>>; complete: boolean; at: number }>()
  /**
   * External channel → board channel or inbound function, for one entry. Each key
   * resolves on its own: one that can't is logged and skipped, and the rest sync.
   */
  const mappings = (key: string) => {
    const cached = resolved.get(key)
    if (cached && (cached.complete || Date.now() - cached.at < RETRY_MS)) return cached.map
    const platform = platformOf(key)
    const pairs = Object.entries(platform.mappings)
    const entry = { complete: true, at: Date.now(), map: Promise.resolve(new Map<string, Mapping>()) }
    entry.map = Promise.allSettled(pairs.map(([raw]) => platform.resolveChannel(raw))).then((results) => {
      const map = new Map<string, Mapping>()
      results.forEach((result, i) => {
        const [raw, target] = pairs[i]!
        if (result.status === 'fulfilled') map.set(`${key}:${result.value}`, target)
        else {
          entry.complete = false
          console.warn(`[vboard] sync ${key}: skipping ${raw}: ${(result.reason as Error).message}`)
        }
      })
      return map
    })
    resolved.set(key, entry)
    return entry.map
  }

  async function findByEmail(email: string): Promise<Actor | null> {
    for (const platform of Object.values(entries)) {
      const author = await platform.findByEmail(email).catch(() => null)
      if (author) return { id: author.id, kind: 'external', handle: author.handle, name: author.name, avatar: author.avatar }
    }
    return null
  }

  async function configTargets(channel: string): Promise<ResolvedTarget[]> {
    const targets: ResolvedTarget[] = []
    for (const [key, platform] of Object.entries(entries)) {
      if (!platform.canStartThreads) continue
      for (const [external, target] of await mappings(key)) if (target.channel === channel) targets.push({ target: external, channel: external, kind: 'channel' })
    }
    return targets
  }

  async function normalizeTarget(target: string): Promise<ResolvedTarget> {
    const at = target.indexOf(':')
    if (at <= 0) throw badRequest(`sync targets look like <key>:<channel or thread>, got: ${target}`)
    const key = target.slice(0, at)
    const platform = platformOf(key)
    try {
      const resolved = ResolvedTarget.parse(await platform.resolveTarget(target.slice(at + 1)))
      if (resolved.kind === 'channel' && !platform.canStartThreads) throw new Error(`${platform.platform} cannot start threads; use an existing thread`)
      return { target: `${key}:${resolved.target}`, channel: `${key}:${resolved.channel}`, kind: resolved.kind }
    } catch (error) {
      throw badRequest(`can't sync to ${target}: ${(error as Error).message}`)
    }
  }

  // --- inbound: platform → inbox --------------------------------------------------

  async function intake(key: string, received: ReceivedEvent) {
    const { event, raw, dedupe } = ReceivedEvent.parse(received)
    for (const location of [event.channel, event.thread, 'subthread' in event ? event.subthread : null])
      if (location !== null && !location.startsWith(`${key}:`)) throw badRequest(`provider locations must belong to sync entry ${key}`)
    const map = await mappings(key)
    const { state: sync } = await bound().session.state(syncReducer)
    if (!map.has(event.channel) && !sync.byExternalThread[event.thread]) return
    const id = await idempotentId('vboard-inbox', key, dedupe)
    await inboxServer.session(inboxSession(event.channel)).append({
      type: 'external.received', id, payload: { sync: key, event, raw: jsonSafe(raw) },
    })
  }

  async function handleWebhook(key: string, request: Request): Promise<Response> {
    const platform = entries[key]
    if (!platform) throw notFound(`no sync entry named ${key}`)
    try {
      return await platform.receive(key, request, (received) => intake(key, received))
    } catch (error) {
      console.error('[vboard] intake failed', error)
      return new Response('intake failed', { status: 500 })
    }
  }

  // --- inbound: inbox → board -------------------------------------------------------

  const externalIdentity = (author: { id: string; handle: string; name: string; avatar: string | null }): Identity => {
    const principal: Principal = { id: author.id, kind: 'external', handle: author.handle, access: FULL_ACCESS, expiresAt: null }
    return {
      principal,
      author: { actor: author.id, principal: author.id, profile: null, session: null },
      actor: { id: author.id, kind: 'external', handle: author.handle, name: author.name, avatar: author.avatar },
    }
  }

  /**
   * What a platform message's links point to. A linked message the board has
   * (it was synced) is that board message; otherwise it's what the platform sent
   * about it (Slack's unfurl), what an earlier version of this message had, or
   * what the platform says when asked. A link nobody can read says why.
   */
  async function resolveLinks(platform: SyncProvider, links: ExternalLink[], previous: Link[] = []): Promise<Link[]> {
    if (links.length === 0) return []
    const { session } = bound()
    const [{ state: sync }, { state: messages }, { state: actors }] = await Promise.all([
      session.state(syncReducer), session.state(messagesReducer), session.state(actorsReducer),
    ])
    const resolved: Link[] = []
    for (const link of links) {
      if (resolved.some((done) => done.url === link.url)) continue
      const id = sync.byExternalMessage[externalMessageKey(link.thread, link.message)]
      const copy = id === undefined ? undefined : messages.byId[id]
      if (copy && !copy.deleted) {
        resolved.push({ url: link.url, message: copy.id, unavailable: null, snapshot: {
          author: actors.byId[copy.by.actor]?.name ?? copy.by.actor,
          text: copy.text, createdAt: copy.createdAt,
          files: copy.attachments.map((file) => ({ name: file.name, url: null })),
        } })
        continue
      }
      if (link.snapshot) {
        resolved.push({ url: link.url, message: null, snapshot: link.snapshot, unavailable: null })
        continue
      }
      const kept = previous.find((earlier) => earlier.url === link.url && earlier.snapshot)
      if (kept) {
        resolved.push(kept)
        continue
      }
      const fetched = await platform.fetchLink(link).catch((error: unknown) => ({ snapshot: null, unavailable: describe(error) }))
      resolved.push({ url: link.url, message: null, snapshot: fetched.snapshot, unavailable: fetched.snapshot ? null : (fetched.unavailable ?? 'unknown').slice(0, 300) })
    }
    return resolved
  }

  /**
   * A platform message's files, onto the board: each is fetched through its
   * adapter (Chat SDK's `rehydrateAttachment`, so any platform that has it works)
   * and stored. A file that can't come over (too big, no blob store, the
   * platform refused) becomes a line in the text; a failed fetch retries the
   * message a few times first.
   */
  async function importFiles(platform: SyncProvider, files: ExternalFile[], attempt: number) {
    const attachments: Attachment[] = []
    const notes: string[] = []
    const blob = options.blob
    for (const file of files.slice(0, ATTACHMENTS_PER_MESSAGE_MAX)) {
      if (!blob) {
        notes.push(fileNote(file, 'this board has no blob store'))
        continue
      }
      if (file.size !== undefined && file.size > ATTACHMENT_BYTES_MAX) {
        notes.push(fileNote(file, `over ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`))
        continue
      }
      let data: Uint8Array
      try {
        const fetched = await platform.fetchFile(file)
        if (fetched === null) {
          notes.push(fileNote(file, `${platform.platform} can't hand it over`))
          continue
        }
        data = fetched
      } catch (error) {
        if (attempt < FILE_ATTEMPTS) throw error
        console.warn(`[vboard] couldn't fetch ${file.name ?? 'a file'} from ${platform.platform}:`, describe(error))
        notes.push(fileNote(file, `${platform.platform} wouldn't hand it over`))
        continue
      }
      if (data.byteLength > ATTACHMENT_BYTES_MAX) {
        notes.push(fileNote(file, `over ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`))
        continue
      }
      if (data.byteLength === 0) {
        notes.push(fileNote(file, 'it was empty'))
        continue
      }
      const name = file.name ?? `${file.type}`
      attachments.push(await writeUpload(blob, { data, name, type: file.mimeType || typeOf(name) }))
    }
    for (const file of files.slice(ATTACHMENTS_PER_MESSAGE_MAX))
      notes.push(fileNote(file, `a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`))
    return { attachments, notes }
  }

  async function inbound(trigger: InboxEvent, attempt = 1) {
    const { session, clientAs } = bound()
    const { sync: key, event, raw } = trigger.payload
    const platform = platformOf(key)
    const mapping = (await mappings(key)).get(event.channel)
    const { state: sync } = await session.state(syncReducer)
    const linked = sync.byExternalThread[event.thread]
    if (event.kind === 'message') {
      const copied = sync.byExternalMessage[externalMessageKey(event.subthread ?? event.thread, event.message)]
      if (copied !== undefined) {
        const { state: messages } = await session.state(messagesReducer)
        const origin = messages.byId[copied]?.origin
        if (!origin || origin.message !== event.message || (origin.subthread ?? origin.thread) !== (event.subthread ?? event.thread)) return
      } else if (platform.users && attempt < ECHO_ATTEMPTS && (await deliveringAsPerson(linked, event)))
        throw new Error(`holding ${event.message} until ${event.author.id}'s board message there has its receipt`)
      const code = event.author.isBot ? undefined : CODE.exec(event.text)?.[1]
      if (code && (await claimCode(key, event, code))) return
    }
    const author = 'author' in event ? event.author : { id: `${platform.platform}:system`, handle: platform.platform, name: platform.platform, avatar: null }
    const board = clientAs(externalIdentity(author), trigger.id, originOf(trigger))
    let applied: Promise<SyncResult> | undefined
    let active = true
    const context: SyncContext = {
      id: trigger.id, key, event, raw, board,
      apply(channel, overrides = {}) {
        if (!active) throw badRequest('the sync callback has finished')
        if (applied) throw badRequest('an event can only be imported once per callback')
        applied = applyIncoming(trigger, attempt, ChannelPath.parse(channel), SyncOverrides.parse(overrides)).catch(async (error: unknown) => {
          if (!(error instanceof DroppedError)) throw error
          // Dropped: nothing of it is on the board, though a root fetched for it may be.
          const { state } = await session.state(syncReducer)
          const thread = state.byExternalThread[event.thread]
          const root = thread === undefined ? undefined : state.threads[thread]?.root
          return { root: root ?? null, message: null }
        })
        return applied
      },
      client<E extends ProviderEvent>(publicEvent: E) {
        function sync(id: number, target: string): ReturnType<BoardClient['sync']>
        function sync(channel: string, event: E, overrides?: SyncOverrides): Promise<SyncResult>
        async function sync(first: string | number, second: string | E, overrides?: SyncOverrides) {
          if (!active) throw badRequest('the sync callback has finished')
          if (typeof first === 'number' && typeof second === 'string') return board.sync(first, second)
          if (typeof first !== 'string' || second !== publicEvent) throw badRequest('sync only accepts the current verified event')
          return platform.sync(context, first, overrides)
        }
        return { ...board, sync }
      },
    }
    try {
      if (mapping?.run) {
        await mapping.run(context)
        return
      }
      const channel = mapping?.channel ?? (linked ? sync.threads[linked]?.channel : undefined)
      if (channel) await platform.sync(context, channel)
    } finally {
      active = false
    }
  }

  /**
   * Where a platform event's writes come from, for the middleware, and how it answers
   * there: a reply in the event's own platform thread.
   */
  function originOf(trigger: InboxEvent): Required<WriteOrigin> {
    const { sync: key, event } = trigger.payload
    const platform = platformOf(key)
    const thread = ('subthread' in event ? event.subthread : null) ?? event.thread
    return {
      via: { kind: 'sync', key, platform: platform.platform, channel: event.channel, thread },
      respond: async (text) => {
        await platform.post(native(thread), 'thread', { markdown: text })
      },
    }
  }

  /**
   * Whether a board message by the person behind `event`'s author (an account they
   * signed in with) may be on its way there as them, without a receipt yet: then
   * `event` could be that very copy. In a thread the board knows (`thread`), that's
   * any of the person's messages still going to it; anywhere else, a new thread of
   * theirs still going to `event`'s channel, whose platform thread the board learns
   * only from the receipt.
   */
  async function deliveringAsPerson(thread: string | undefined, event: Extract<ExternalEvent, { kind: 'message' }>) {
    const { session } = bound()
    const [{ state: actors }, { state: sync }, { state: messages }] = await Promise.all([
      session.state(actorsReducer), session.state(syncReducer), session.state(messagesReducer),
    ])
    const link = actors.links[event.author.id]
    if (!link || link.method !== 'consent') return false
    const now = Date.now()
    const pending = (id: number, target: string) => {
      const message = messages.byId[id]
      return !!message && message.by.principal === link.to && message.by.profile === null && message.from === null &&
        !message.deleted && !message.noSync && now - Date.parse(message.createdAt) < ECHO_WINDOW_MS &&
        !sync.copies[id]?.[target] && !message.undelivered[target]
    }
    if (thread !== undefined) {
      const synced = sync.threads[thread]
      if (!synced) return false
      const targets = synced.targets.filter((target) => synced.external[target] === event.thread)
      return [synced.root, ...(messages.replies[synced.root] ?? [])].some((id) => targets.some((target) => pending(id, target)))
    }
    return Object.values(sync.threads).some((synced) =>
      synced.targets.includes(event.channel) && !synced.external[event.channel] && pending(synced.root, event.channel))
  }

  const codes = () => identityServer.session(IDENTITY_SESSION)

  /** Records that `account` is `to`, unless it already is. `id` makes a retry a no-op. */
  async function link(account: ExternalAuthor, to: string, method: 'code' | 'consent', by: Author, id?: string): Promise<LinkedAccount> {
    const { session } = bound()
    const { state: actors } = await session.state(actorsReducer)
    const seen = actorSeen({ id: account.id, kind: 'external', handle: account.handle, name: account.name, avatar: account.avatar }, actors)
    const existing = actors.links[account.id]
    // A code is news even for an account already linked (`id` keeps its retries single); a sign-in check isn't.
    if (existing?.to === to && !id) {
      if (seen) await session.append(seen)
      return { actor: account.id, handle: account.handle, name: account.name, method: existing.method, at: existing.at }
    }
    await session.append(
      ...(seen ? [{ ...seen, ...(id ? { id: `${id}:seen` } : {}) }] : []),
      { type: 'actor.linked' as const, ...(id ? { id } : {}), payload: { actor: account.id, to, method, by } },
    )
    return { actor: account.id, handle: account.handle, name: account.name, method, at: new Date().toISOString() }
  }

  /** A live code, posted from `event`'s account through the entry it was issued for: link them. */
  async function claimCode(key: string, event: Extract<ExternalEvent, { kind: 'message' }>, code: string) {
    const hash = hashCode(code)
    const issued = (await codes().state(identityCodesReducer)).state[hash]
    if (!issued || issued.sync !== key) return false
    const message = externalMessageKey(event.subthread ?? event.thread, event.message)
    // A used code claims again only for a retry of the message that used it.
    const usedHere = (used: IdentityCode | undefined) => used?.usedBy === event.author.id && used.usedIn === message
    if (issued.usedBy === null ? Date.parse(issued.expiresAt) < Date.now() : !usedHere(issued)) return false
    await codes().append({ type: 'identity.code_used', id: `used:${hash}`, payload: { hash, actor: event.author.id, message } })
    // Two posts of it at once: the one the log took first wins.
    if (!usedHere((await codes().state(identityCodesReducer)).state[hash])) return false
    await link(event.author, issued.principal, 'code', externalIdentity(event.author).author, `link:${hash}`)
    await platformOf(key).react(native(event.subthread ?? event.thread), event.message, 'check', true).catch((error: unknown) =>
      console.warn(`[vboard] couldn't confirm a linking code on ${key}:`, describe(error)),
    )
    return true
  }

  function requirePerson(identity: Identity) {
    if (identity.principal.kind !== 'person') throw forbidden('only people link platform accounts')
  }

  /** How `identity` proves an account on `key` is theirs: its sign-in, or a code to post from it. */
  async function startLink(identity: Identity, key: string, method?: 'code' | 'consent'): Promise<IdentityChallenge> {
    requirePerson(identity)
    const platform = platformOf(key)
    if (method !== 'code' && platform.users)
      return { method: 'consent', sync: key, platform: platform.platform, url: await platform.users.authorize(identity.principal.id) }
    if (method === 'consent') throw badRequest(`${key} can't sign people in: link it with a code`)
    const code = newCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()
    await codes().append({ type: 'identity.code_issued', payload: { hash: hashCode(code), principal: identity.principal.id, sync: key, expiresAt } })
    return { method: 'code', sync: key, platform: platform.platform, code, expiresAt }
  }

  /** After a sign-in: the account the person's token belongs to, linked to them. */
  async function checkLink(identity: Identity, key: string): Promise<LinkedAccount | null> {
    requirePerson(identity)
    const platform = platformOf(key)
    if (!platform.users) throw badRequest(`${key} can't sign people in: link it with a code`)
    const token = await platform.users.token(identity.principal.id)
    if (!token) return null
    const account = await platform.whoAmI(token)
    if (!account.id.startsWith(`${platform.platform}:user:`)) throw badRequest(`${key} named an account that isn't a ${platform.platform} user`)
    return link(account, identity.principal.id, 'consent', identity.author)
  }

  async function applyIncoming(trigger: InboxEvent, attempt: number, channel: string, overrides: SyncOverrides): Promise<SyncResult> {
    const { writes, session } = bound()
    const source = originOf(trigger)
    const { sync: key, event } = trigger.payload
    const platform = platformOf(key)
    const { state: sync } = await session.state(syncReducer)
    const threadKey = sync.byExternalThread[event.thread]
    const rootId = threadKey ? sync.threads[threadKey]?.root : undefined
    const writeId = (n: number) => idempotentId('vboard-inbound', trigger.id, String(n))
    const result = (message: { id: number; re: number | null }): SyncResult => ({ root: message.re ?? message.id, message: message.id })
    const labels = (defaults: Record<string, string> = {}) => {
      const merged = { ...defaults, ...overrides.labels }
      for (const key of overrides.unset ?? []) delete merged[key]
      return merged
    }
    const rootDraft = (draft: SyncRoot) => {
      if (!overrides.root) return draft
      const patch = overrides.root(immutable(structuredClone(draft)))
      if (patch && typeof patch === 'object' && 'then' in patch) throw badRequest('root overrides must be synchronous')
      const checked = SyncOverrides.pick({ text: true, labels: true }).parse(patch)
      return { ...draft, text: checked.text ?? draft.text, labels: { ...draft.labels, ...checked.labels } }
    }
    const setExtraLabels = async (identity: Identity, id: number) => {
      if (!overrides.labels && !overrides.unset) return
      const { state: messages } = await session.state(messagesReducer)
      const root = messages.byId[id]
      const set = Object.fromEntries(Object.entries(overrides.labels ?? {}).filter(([key, value]) => root?.labels[key] !== value))
      const unset = (overrides.unset ?? []).filter((key) => root?.labels[key] !== undefined)
      if (Object.keys(set).length || unset.length) await writeLabels(writes, { identity, id, set, unset })
    }

    switch (event.kind) {
      case 'message': {
        const existing = sync.byExternalMessage[externalMessageKey(event.subthread ?? event.thread, event.message)]
        if (existing !== undefined) return { root: rootId ?? existing, message: existing }
        const identity = externalIdentity(event.author)
        const { attachments, notes } = event.files?.length ? await importFiles(platform, event.files, attempt) : { attachments: [], notes: [] }
        const links = await resolveLinks(platform, event.links ?? [])
        const base = {
          ...source,
          ...(links.length ? { links } : {}),
          identity,
          text: clampText(withNotes(overrides.text ?? event.text, notes), attachments.length > 0),
          ...(attachments.length ? { attachments } : {}),
          origin: { channel: event.channel, thread: event.thread, subthread: event.subthread, message: event.message, context: event.context },
          from: key,
          lenientMentions: true,
          id: await writeId(0),
        }
        // A reply kept on the board: no other platform gets it. A root always syncs, so its thread can.
        const reply = { ...base, ...(overrides.noSync ? { noSync: true } : {}) }
        if (rootId !== undefined) {
          await setExtraLabels(identity, rootId)
          return result(await writePost(writes, { ...reply, re: rootId }))
        }
        const fetched = await platform.fetchRoot(native(event.thread))
        if (fetched === null) {
          const draft = rootDraft({ text: event.text, labels: {}, author: event.author, raw: trigger.payload.raw })
          return result(await writePost(writes, { ...base, channel, text: clampText(withNotes(overrides.text ?? draft.text, notes), attachments.length > 0), labels: labels(draft.labels) }))
        }
        const draft = rootDraft({ ...fetched, raw: fetched.raw ?? null })
        const root = await writePost(writes, {
          ...source,
          identity: externalIdentity(fetched.author), channel,
          text: clampText(draft.text), labels: labels(draft.labels),
          origin: { channel: event.channel, thread: event.thread, subthread: null, message: `root:${trigger.id}`, context: null },
          from: key, lenientMentions: true, id: await writeId(1),
        })
        return result(await writePost(writes, { ...reply, re: root.id }))
      }
      case 'edited':
      case 'deleted':
      case 'reaction': {
        const id = sync.byExternalMessage[externalMessageKey(event.subthread ?? event.thread, event.message)]
        if (id === undefined) return { root: rootId ?? null, message: null }
        const author = 'author' in event ? event.author : { id: `${platform.platform}:system`, handle: platform.platform, name: platform.platform, avatar: null }
        const identity = externalIdentity(author)
        if (rootId !== undefined) await setExtraLabels(identity, rootId)
        if (event.kind === 'deleted') await writeDelete(writes, { identity, id, from: key, asAuthor: false })
        else if (event.kind === 'edited') {
          const { state: messages } = await session.state(messagesReducer)
          const stored = messages.byId[id]
          const text = clampText(withNotes(overrides.text ?? event.text, stored ? notesIn(stored.text) : []), (stored?.attachments.length ?? 0) > 0)
          if (stored && !event.linksOnly && stored.text !== text) await writeEdit(writes, { ...source, identity, id, text, from: key, asAuthor: false })
          const links = stored ? await resolveLinks(platform, event.links ?? [], stored.links) : []
          if (stored && !sameLinks(links, stored.links)) await writeLinks(writes, { identity, id, links, from: key })
        } else {
          if (platform.singleReaction) {
            const { state: messages } = await session.state(messagesReducer)
            const emoji = canonicalEmoji(event.emoji)
            for (const [held, actors] of Object.entries(messages.byId[id]?.reactions ?? {}))
              if (actors.includes(identity.actor.id) && !(event.added && held === emoji))
                await writeReaction(writes, { identity, id, emoji: held, remove: true, from: key })
          }
          if (!platform.singleReaction || event.added) await writeReaction(writes, { identity, id, emoji: event.emoji, remove: !event.added, from: key })
        }
        return { root: rootId ?? null, message: id }
      }
      case 'lifecycle': {
        const identity = externalIdentity(event.author)
        if (rootId !== undefined) {
          const { state: messages } = await session.state(messagesReducer)
          const root = messages.byId[rootId]
          const createdHere = root?.origin?.message === `lifecycle:${trigger.id}`
          const draft = createdHere ? rootDraft({ text: event.url ? `${event.title}\n${event.url}` : event.title, labels: event.labels, author: event.author, raw: trigger.payload.raw }) : null
          const desired = labels(draft?.labels ?? event.labels)
          const owned = (key: string) => event.owns?.some((prefix) => key.startsWith(prefix)) ?? false
          const set = Object.fromEntries(Object.entries(desired).filter(([key, value]) => root?.labels[key] !== value))
          const unset = Object.keys(root?.labels ?? {}).filter((key) => !(key in desired) && (event.unset.includes(key) || overrides.unset?.includes(key) || owned(key)))
          if (root && !root.deleted && (Object.keys(set).length || unset.length)) await writeLabels(writes, { identity, id: rootId, set, unset })
          if (event.reply) return result(await writePost(writes, { ...source, identity, re: rootId, text: clampText(overrides.text ?? event.reply!), from: key, lenientMentions: true, ...(overrides.noSync ? { noSync: true } : {}), id: await writeId(1) }))
          return { root: rootId, message: createdHere ? rootId : null }
        }
        if (!event.createRoot) return { root: null, message: null }
        const draft = rootDraft({ text: event.url ? `${event.title}\n${event.url}` : event.title, labels: event.labels, author: event.author, raw: trigger.payload.raw })
        const root = await writePost(writes, {
          ...source,
          identity, channel, text: clampText(event.reply ? draft.text : overrides.text ?? draft.text), labels: labels(draft.labels),
          origin: { channel: event.channel, thread: event.thread, subthread: null, message: `lifecycle:${trigger.id}`, context: null },
          from: key, lenientMentions: true, id: await writeId(0),
        })
        if (event.reply) return result(await writePost(writes, { ...source, identity, re: root.id, text: clampText(overrides.text ?? event.reply), from: key, lenientMentions: true, ...(overrides.noSync ? { noSync: true } : {}), id: await writeId(1) }))
        return result(root)
      }
    }
  }

  const identityServer = createServer({
    contract: identityContract,
    ...(options.store ? { store: options.store } : {}),
  })

  const inboxServer = createServer({
    contract: inboxContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      'external.received': {
        lane: ({ event }) => `thread:${event.payload.event.thread}`,
        handler: async (ctx) => {
          await inbound(ctx.event as InboxEvent, ctx.attempt)
        },
      },
    },
  })

  // --- outbound: board → platforms --------------------------------------------------

  /**
   * A message's text for a platform: each mention it resolved reads natively where the
   * actor is the platform's own, and as their plain name anywhere else.
   */
  function textFor(platform: SyncProvider, message: Message, actors: ActorsState, text = message.text): string {
    const mentioned = message.mentions.map((id) => actors.byId[id]).filter((actor) => actor !== undefined)
    return replaceMentions(text, (token) => {
      const actor =
        token.kind === 'actor'
          ? mentioned.find((candidate) => candidate.id === token.actor)
          : mentioned.find((candidate) => candidate.handle.toLowerCase() === token.handle)
      return actor ? (nativeMention(platform, actor.id, actors) ?? actor.name) : null
    })
  }

  /**
   * How `platform` mentions an actor: its own account, its person's, or any account
   * its person linked there. An agent is just itself.
   */
  function nativeMention(platform: SyncProvider, actor: string, actors: ActorsState): string | null {
    const native = (id: string) => {
      const account = actors.byId[id]
      return account ? platform.mention(account) : null
    }
    const person = actors.links[actor]?.to ?? actor
    const direct = native(actor) ?? (person === actor ? null : native(person))
    if (direct) return direct
    for (const id of linkedTo(actors, person)) {
      const linked = native(id)
      if (linked) return linked
    }
    return null
  }

  /**
   * A person's own token on `platform`, to post `message` as them: only for what they
   * wrote on the board themselves, not their agents, and null when they haven't
   * signed in. A token that can't be had is the bot's turn, never a failed delivery.
   */
  async function personToken(platform: SyncProvider, message: Message, actors: ActorsState | null): Promise<string | null> {
    if (!platform.users || message.from !== null || message.by.profile !== null || !message.by.principal.startsWith('vercel:user:')) return null
    // A new post goes as them only once they've linked the account they signed in with, so
    // its echo is recognized as theirs and `vb identity unlink` stops it. Their copies
    // already out there (`actors` null) stay theirs to change.
    if (actors && !Object.entries(actors.links).some(([actor, link]) =>
      link.to === message.by.principal && link.method === 'consent' && actor.startsWith(`${platform.platform}:user:`))) return null
    try {
      return await platform.users.token(message.by.principal)
    } catch (error) {
      console.warn(`[vboard] no ${platform.platform} token for ${message.by.principal}; posting #${message.id} as the app:`, describe(error))
      return null
    }
  }

  /** What a message says as its author: no name in front, since it's theirs. */
  function renderAsPerson(target: string, message: Message, actors: ActorsState) {
    const platform = platformOf(keyOf(target))
    const markdown = textFor(platform, message, actors, displayText(message.text, message.by.actor))
    const lines = message.attachments.length > 0 && (!platform.uploadsFiles || !options.blob)
    return { markdown: lines ? `${markdown}\n${attachmentNotes(message)}` : markdown }
  }

  /** Posts as the message's author when they've signed in; null to post as the app. */
  async function postAsPerson(target: string, place: string, kind: ResolvedTarget['kind'], message: Message, actors: ActorsState) {
    const platform = platformOf(keyOf(target))
    if (!message.text.trim()) return null
    const token = await personToken(platform, message, actors)
    if (!token) return null
    try {
      return await platform.postAs(token, native(place), kind, renderAsPerson(target, message, actors))
    } catch (error) {
      console.warn(`[vboard] couldn't post #${message.id} to ${target} as its author; posting as the app:`, describe(error))
      return null
    }
  }

  /** A board message as markdown for a platform, which converts it to its own format. */
  function render(key: string, target: string, message: Message, actors: ActorsState): { markdown: string; as?: ProviderSender } {
    const actor = actors.byId[message.by.actor]
    let name = actor?.name ?? message.by.actor
    if (message.by.profile && actor?.handle.includes('/')) name = `${actor.name} via ${actor.handle.split('/')[0]}`
    if (message.from) name = `${name} (${platformOf(message.from).platform})`
    const platform = platformOf(key)
    const body = platform.render(immutable({
      message: { ...structuredClone(message), text: displayText(message.text, message.by.actor) },
      author: actor ? { ...actor } : null,
      mentionOf: (id: string) => nativeMention(platform, id, actors),
      label: name,
      target,
    }))
    if (typeof body !== 'string') throw badRequest('a provider renderer must return markdown')
    const markdown = textFor(platform, message, actors, body)
    // An agent's message can carry its own name and picture where the platform shows a sender per message.
    return message.by.profile && !message.from ? { markdown, as: { name, avatar: senderAvatar(message, actor, actors) } } : { markdown }
  }

  /** An agent's own picture, or for the board's built-in one, its person's Vercel avatar: `claude via julian` shows Julian. */
  function senderAvatar(message: Message, actor: Actor | undefined, actors: ActorsState): string | null {
    const builtIn = (avatar: string | null | undefined) => !avatar || /\/avatars\/[a-z0-9-]+$/.test(avatar)
    const own = actor?.avatar ?? null
    if (!builtIn(own)) return own
    // The person's own picture, which their CLI sends from Vercel, when they've posted as themselves.
    const person = actors.byId[message.by.principal]?.avatar
    if (!builtIn(person)) return person!
    // Otherwise their handle, which is their Vercel username unless they changed it or the board made one up.
    const username = actor?.handle.split('/')[0] ?? ''
    if (!message.by.principal.startsWith('vercel:user:') || !username || /^user-/.test(username)) return own
    return `https://vercel.com/api/www/avatar?u=${encodeURIComponent(username)}&s=64&format=png`
  }

  /** What a platform shows for files it didn't get: one line each, so a reader knows they're on the board. */
  const attachmentNotes = (message: Message) =>
    message.attachments.map((a) => `\n📎 ${a.name} (${fileSize(a.size)}, on the board: #${message.id})`).join('')

  /**
   * `render`, with a line per file where the files won't follow: on a platform
   * that takes no uploads, or one that refused them (`noted`).
   */
  const renderFor = (target: string, message: Message, actors: ActorsState, noted = false) => {
    const key = keyOf(target)
    const { markdown, as } = render(key, target, message, actors)
    const lines = message.attachments.length > 0 && (noted || !platformOf(key).uploadsFiles || !options.blob)
    return { markdown: lines ? `${markdown}\n${attachmentNotes(message)}` : markdown, ...(as ? { as } : {}) }
  }

  type Ctx<K extends keyof BoardEvents> = HandlerContext<BoardEvents, K>

  async function latest(ctx: Ctx<keyof BoardEvents>) {
    const [sync, messages, actors] = await Promise.all([
      ctx.session.state(syncReducer, { through: 'latest' }),
      ctx.session.state(messagesReducer, { through: 'latest' }),
      ctx.session.state(actorsReducer, { through: 'latest' }),
    ])
    return { sync: sync.state, messages: messages.state, actors: actors.state }
  }

  async function postReply(
    ctx: Ctx<keyof BoardEvents>,
    state: Awaited<ReturnType<typeof latest>>,
    message: Message,
    target: string,
    externalThread: string,
  ) {
    const replyCopy = message.replyTo === null ? undefined : state.sync.copies[message.replyTo]?.[target]
    // A reply to a message in a platform sub-thread goes into that sub-thread; elsewhere into the main thread, as written.
    const inSubthread = replyCopy !== undefined && replyCopy.thread !== externalThread
    const place = inSubthread ? replyCopy.thread : externalThread
    const platform = platformOf(keyOf(target))
    let body = renderFor(target, message, state.actors)
    let files: string[] | null | undefined
    let sentId: string
    if (!body.markdown.trim() && message.attachments.length && options.blob && platformOf(keyOf(target)).uploadsFiles) {
      try {
        const sent = await uploadMessageFiles(message, target, place)
        sentId = sent.message
        files = sent.files
      } catch (error) {
        if (!platformOf(keyOf(target)).refusesFiles(error)) throw error
        body = renderFor(target, message, state.actors, true)
        sentId = (await platform.post(native(place), 'thread', body)).message
        files = null
      }
    } else {
      const asPerson = await postAsPerson(target, place, 'thread', message, state.actors)
      if (asPerson) {
        const external: ExternalCopy = { thread: place, message: asPerson.message, asUser: true }
        await recordDelivery(ctx, message, target, external)
        return external
      }
      if (!body.markdown.trim()) throw badRequest('a renderer must return text unless the message has media')
      sentId = (await platform.post(native(place), 'thread', body)).message
    }
    const external = { thread: place, message: sentId, ...(files !== undefined ? { files } : {}) }
    await recordDelivery(ctx, message, target, external)
    return external
  }

  async function recordDelivery(ctx: Ctx<keyof BoardEvents>, message: Message, target: string, copy: ExternalCopy) {
    await ctx.session.append(`receipt:${message.id}:${target}`,
      { type: 'message.synced' as const, payload: { id: message.id, thread: message.thread, target, external: { thread: copy.thread, message: copy.message, ...(copy.asUser ? { asUser: true as const } : {}) } } },
      ...(copy.files !== undefined ? [{ type: 'message.files_synced' as const, payload: { id: message.id, thread: message.thread, target, files: copy.files } }] : []),
    )
  }

  /**
   * A message's files, into the thread its text went to, once. The text's
   * receipt comes first, so a retry sends only what's missing. If the platform
   * refuses files, the text gets a line for each; any other failure retries.
   */
  async function messageFiles(message: Message) {
    return Promise.all(message.attachments.map(async (a) => ({
      data: Buffer.from(await readAttachmentData(options.blob!, a.id)), filename: a.name, mimeType: a.type,
    })))
  }

  async function uploadMessageFiles(message: Message, target: string, thread: string) {
    return platformOf(keyOf(target)).uploadFiles(native(thread), await messageFiles(message))
  }

  async function deliverFiles(ctx: Ctx<keyof BoardEvents>, message: Message, target: string, copy: ExternalCopy, actors: ActorsState) {
    const platform = platformOf(keyOf(target))
    const blob = options.blob
    if (!platform.uploadsFiles || !blob || message.attachments.length === 0 || copy.files !== undefined) return
    let ids: string[] | null
    try {
      ids = (await uploadMessageFiles(message, target, copy.thread)).files
    } catch (error) {
      // Retried, and if it gives up, `message.sync_failed` says it was the files: the text is there.
      if (!platform.refusesFiles(error)) throw Object.assign(new Error(`files: ${describe(error)}`), { cause: error, data: { error: `files: ${describe(error)}` } })
      console.warn(`[vboard] ${target} won't take #${message.id}'s files (${describe(error)}); noting them in its text`)
      ids = null
      await platform.edit(native(copy.thread), copy.message, renderFor(target, message, actors, true)).catch((edit: unknown) =>
        console.warn(`[vboard] couldn't note #${message.id}'s files on ${target}:`, describe(edit)),
      )
    }
    // If this append fails after an upload, the retry uploads again: rare, and a duplicate beats a loss.
    await ctx.session.append(`files:${message.id}:${target}`, {
      type: 'message.files_synced',
      payload: { id: message.id, thread: message.thread, target, files: ids },
    })
  }

  /**
   * A2 dead-letters a handler after 10 failures, and a dead letter stops its lane,
   * which is the thread's: nothing after it would sync. So a delivery retries a
   * few times, then records `message.sync_failed` and lets the thread move on.
   */
  const DELIVERY_ATTEMPTS = 5

  type Failure = { id: number; target: string; error: unknown }

  /** A platform error's code (`not_in_channel`) when it has one, else its message. */
  const describe = (error: unknown): string => {
    const code = (error as { data?: { error?: unknown } } | null)?.data?.error
    const text = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error)
    return text.slice(0, 500) || 'unknown error'
  }

  async function settle(ctx: Ctx<'thread.synced' | 'message.posted'>, thread: string, failures: Failure[]) {
    if (failures.length === 0) return
    if (ctx.attempt < DELIVERY_ATTEMPTS) throw failures[0]!.error
    for (const { id, target, error } of failures) {
      console.error(`[vboard] gave up delivering #${id} to ${target}:`, describe(error))
      await ctx.session.append(`failed:${id}:${target}`, {
        type: 'message.sync_failed',
        payload: { id, thread, target, error: describe(error) },
      })
    }
  }

  async function deliverThread(ctx: Ctx<'thread.synced'>) {
    const { thread, target } = ctx.event.payload
    if ((ctx.event.payload.kind ?? (isThreadTarget(target) ? 'thread' : 'channel')) === 'thread') return // joining: only messages written after the join are delivered
    const state = await latest(ctx)
    const synced = state.sync.threads[thread]
    const root = synced ? state.messages.byId[synced.root] : undefined
    if (!synced || !root || root.deleted) return
    let externalThread = synced.external[target]
    if (!externalThread) {
      try {
        const platform = platformOf(keyOf(target))
        const body = renderFor(target, root, state.actors)
        const mediaOnly = !body.markdown.trim() && root.attachments.length > 0 && options.blob && platformOf(keyOf(target)).uploadsFiles
        if (!body.markdown.trim() && !mediaOnly) throw badRequest('a renderer must return text unless the message has media')
        let uploaded: string[] | null | undefined
        let postedAsPerson = false
        const post = async () => {
          if (!mediaOnly) {
            const asPerson = await postAsPerson(target, target, 'channel', root, state.actors)
            if (asPerson) {
              postedAsPerson = true
              return asPerson
            }
            return platform.post(native(target), 'channel', body)
          }
          const files = await messageFiles(root)
          try {
            const sent = await platform.post(native(target), 'channel', { ...body, files })
            uploaded = sent.files ?? []
            return sent
          } catch (error) {
            if (!platformOf(keyOf(target)).refusesFiles(error)) throw error
            uploaded = null
            return platform.post(native(target), 'channel', renderFor(target, root, state.actors, true))
          }
        }
        const sent = await post()
        externalThread = `${keyOf(target)}:${sent.thread}`
        const external: ExternalCopy = { thread: externalThread, message: sent.message, ...(uploaded !== undefined ? { files: uploaded } : {}), ...(postedAsPerson ? { asUser: true as const } : {}) }
        await recordDelivery(ctx, root, target, external)
        await deliverFiles(ctx, root, target, external, state.actors)
      } catch (error) {
        return settle(ctx, thread, [{ id: root.id, target, error }])
      }
    } else {
      const copy = state.sync.copies[root.id]?.[target]
      if (copy)
        try {
          await deliverFiles(ctx, root, target, copy, state.actors)
        } catch (error) {
          return settle(ctx, thread, [{ id: root.id, target, error }])
        }
    }
    const failures: Failure[] = []
    for (const replyId of state.messages.replies[root.id] ?? []) {
      const reply = state.messages.byId[replyId]
      if (!reply || reply.deleted || reply.noSync || cameFrom(reply, target)) continue
      try {
        const copy = state.sync.copies[replyId]?.[target] ?? (await postReply(ctx, state, reply, target, externalThread))
        await deliverFiles(ctx, reply, target, copy, state.actors)
      } catch (error) {
        failures.push({ id: replyId, target, error })
      }
    }
    await settle(ctx, thread, failures)
  }

  /** Never deliver a message back to the platform it came from. */
  const cameFrom = (message: Message, target: string) =>
    message.origin?.thread === target || (message.from !== null && keyOf(target) === message.from)

  async function deliverPost(ctx: Ctx<'message.posted'>) {
    const { payload } = ctx.event
    if (payload.re === null || payload.noSync) return
    const state = await latest(ctx)
    const synced = state.sync.threads[payload.thread]
    const message = state.messages.byId[ctx.event.index]
    if (!synced || !message || synced.targets.length === 0) return
    const failures: Failure[] = []
    for (const target of synced.targets) {
      const externalThread = synced.external[target]
      if (!externalThread) continue // the root isn't there yet; its thread.synced handler backfills
      if (cameFrom(message, target)) continue
      try {
        const copy = state.sync.copies[message.id]?.[target] ?? (await postReply(ctx, state, message, target, externalThread))
        await deliverFiles(ctx, message, target, copy, state.actors)
      } catch (error) {
        failures.push({ id: message.id, target, error })
      }
    }
    await settle(ctx, payload.thread, failures)
  }

  /** Edits, deletes, and reactions are best-effort: a platform that can't do one skips it. */
  async function deliverChange(
    ctx: Ctx<'message.edited' | 'message.deleted' | 'reaction.added' | 'reaction.removed'>,
  ) {
    const event = ctx.event
    const state = await latest(ctx)
    const copies = state.sync.copies[event.payload.id] ?? {}
    const message = state.messages.byId[event.payload.id]
    for (const [target, copy] of Object.entries(copies)) {
      if (event.payload.from !== null && keyOf(target) === event.payload.from) continue
      try {
        const platform = platformOf(keyOf(target))
        const thread = native(copy.thread)
        // A copy posted as its author is theirs to change: only their token can.
        const token = copy.asUser && message && (event.type === 'message.edited' || event.type === 'message.deleted') ? await personToken(platform, message, null) : null
        if (copy.asUser && message && (event.type === 'message.edited' || event.type === 'message.deleted') && !token) {
          console.warn(`[vboard] skipped ${event.type} on ${target}: #${message.id} was posted as its author, and their token is gone`)
          continue
        }
        if (event.type === 'message.edited' && message)
          if (token) await platform.editAs(token, thread, copy.message, renderAsPerson(target, message, state.actors))
          else await platform.edit(thread, copy.message, renderFor(target, message, state.actors, copy.files === null))
        else if (event.type === 'message.deleted') {
          if (token) await platform.deleteAs(token, thread, copy.message)
          else await platform.delete(thread, copy.message)
          // The files went as a message of their own.
          if (copy.files?.length) await platform.deleteFiles(copy.files)
        }
        else if (event.type === 'reaction.added') await platform.react(thread, copy.message, canonicalEmoji(event.payload.emoji), true)
        else if (event.type === 'reaction.removed') await platform.react(thread, copy.message, canonicalEmoji(event.payload.emoji), false)
      } catch (error) {
        console.warn(`[vboard] skipped ${event.type} on ${target}:`, (error as Error).message)
      }
    }
  }

  /**
   * A renderer can read labels (a PR root showing its state), so a label change edits
   * each copy whose rendering it changes. The default renderer doesn't, so this never edits.
   */
  async function deliverLabels(ctx: Ctx<'labels.changed'>) {
    const { id } = ctx.event.payload
    const state = await latest(ctx)
    const message = state.messages.byId[id]
    const copies = state.sync.copies[id] ?? {}
    if (!message || message.deleted || Object.keys(copies).length === 0) return
    const { state: before } = await ctx.session.state(messagesReducer, { through: ctx.event.index - 1 })
    const previous = { ...message, labels: before.byId[id]?.labels ?? {} }
    for (const [target, copy] of Object.entries(copies)) {
      try {
        const body = renderFor(target, message, state.actors, copy.files === null)
        if (body.markdown === renderFor(target, previous, state.actors, copy.files === null).markdown) continue
        await platformOf(keyOf(target)).edit(native(copy.thread), copy.message, body)
      } catch (error) {
        console.warn(`[vboard] skipped labels.changed on ${target}:`, describe(error))
      }
    }
  }

  /**
   * Shows typing in every platform thread a board thread is synced to. It's
   * ephemeral and best-effort: nothing goes in the log, and a platform that
   * fails is skipped. Answers the external threads that took it. `status`
   * replaces "Typing…" where the platform shows text (Slack).
   */
  async function typing(thread: string, status?: string): Promise<string[]> {
    const { session } = bound()
    const [{ state: sync }, { state: messages }] = await Promise.all([session.state(syncReducer), session.state(messagesReducer)])
    const synced = sync.threads[thread]
    if (!synced) return []
    const ids = [synced.root, ...(messages.replies[synced.root] ?? [])]
    const externals = [...new Set(Object.values(synced.external))]
    const done = await Promise.all(
      externals.map(async (external) => {
        const key = keyOf(external)
        try {
          const platform = platformOf(key)
          let latest: string | null = null
          for (let i = ids.length - 1; i >= 0 && latest === null; i--) {
            const origin = messages.byId[ids[i]!]
            if (origin && !origin.deleted && origin.origin?.thread === external) latest = origin.origin.message
          }
          await platform.startTyping(native(external), latest, status)
          return external
        } catch (error) {
          console.warn(`[vboard] skipped typing on ${external}:`, describe(error))
          return null
        }
      }),
    )
    return done.filter((external) => external !== null)
  }

  const lane = ({ event }: { event: { payload: unknown } }) => `thread:${(event.payload as { thread: string }).thread}`

  /** Board-contract handlers for outbound delivery, one lane per thread. */
  const outboundHandlers = {
    'thread.synced': { lane, handler: async (ctx: Ctx<'thread.synced'>) => void (await deliverThread(ctx)) },
    'message.posted': { lane, handler: async (ctx: Ctx<'message.posted'>) => void (await deliverPost(ctx)) },
    'message.edited': { lane, handler: async (ctx: Ctx<'message.edited'>) => void (await deliverChange(ctx)) },
    'message.deleted': { lane, handler: async (ctx: Ctx<'message.deleted'>) => void (await deliverChange(ctx)) },
    'reaction.added': { lane, handler: async (ctx: Ctx<'reaction.added'>) => void (await deliverChange(ctx)) },
    'reaction.removed': { lane, handler: async (ctx: Ctx<'reaction.removed'>) => void (await deliverChange(ctx)) },
    'labels.changed': { lane, handler: async (ctx: Ctx<'labels.changed'>) => void (await deliverLabels(ctx)) },
  }

  async function readInbox(key: string, channel: string | undefined, limit: number) {
    platformOf(key)
    let channels: string[]
    try {
      channels = channel ? [`${key}:${await platformOf(key).resolveChannel(channel)}`] : [...(await mappings(key)).keys()]
    } catch (error) {
      throw badRequest(`can't resolve inbox channel: ${(error as Error).message}`)
    }
    const events = (
      await Promise.all(channels.map((c) => inboxServer.session(inboxSession(c)).history()))
    ).flat()
    return events
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        channel: event.sessionId.replace(/^inbox:/, ''),
        createdAt: new Date(event.createdAt).toISOString(),
        ...(event.payload as object),
      }))
  }

  /** Every inbox that can hold events: the mapped channels', and those of threads synced anywhere else. */
  async function inboxChannels(): Promise<string[]> {
    const channels = new Set<string>()
    for (const key of Object.keys(entries)) for (const channel of (await mappings(key)).keys()) channels.add(channel)
    const { state: sync } = await bound().session.state(syncReducer)
    for (const thread of Object.keys(sync.byExternalThread)) {
      const key = thread.slice(0, thread.indexOf(':'))
      const channel = entries[key]?.inboxChannel(key, thread)
      if (channel) channels.add(channel)
    }
    return [...channels]
  }

  /** The status for what a platform wouldn't read: the caller's mistake, missing, refused, or the platform failing. */
  const unreadableStatus = (code: string) => {
    if (code === 'unsupported' || code === 'invalid_target') return 400
    if (code === 'channel_not_found') return 404
    if (code === 'ratelimited') return 429
    if (['no_client', 'list_failed', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].includes(code)) return 502
    return 403
  }

  /** A platform channel or thread, read for the caller: nothing is synced, stored, or joined. */
  async function readSource(key: string, target: string, limit: number) {
    const platform = platformOf(key)
    try {
      return await platform.read(target, { limit })
    } catch (error) {
      if (error instanceof UnreadableError) throw new HttpError(unreadableStatus(error.code), error.code, error.message)
      throw badRequest(`can't read ${target} from ${key}: ${describe(error)}`, 'platform_error')
    }
  }

  return {
    inboxServer,
    identityServer,
    readSource,
    outboundHandlers,
    startLink,
    checkLink,
    bind: (b: BoardBinding) => {
      binding = b
    },
    configTargets,
    normalizeTarget,
    findByEmail,
    handleWebhook,
    readInbox,
    inboxChannels,
    typing,
  }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>
