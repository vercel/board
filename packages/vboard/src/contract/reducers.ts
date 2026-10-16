import { reducer } from 'experimental-a2'
import { canonicalEmoji } from './emoji.ts'
import { actorKind, type ActorKind, type Attachment, type Author, type Labels } from './schemas.ts'
import { boardContract, identityContract, type BoardEvent, type Link, type Origin } from './contract.ts'

// A2 clones state at every read and snapshot boundary, so these folds mutate
// in place: an event costs O(1) instead of a copy of every message.

export type Message = {
  id: number
  channel: string
  text: string
  re: number | null
  replyTo: number | null
  /** The thread key: the root's event ID. */
  thread: string
  labels: Labels
  reactions: Record<string, string[]>
  mentions: string[]
  by: Author
  noSync: boolean
  /** Where it came from on a platform, if it did. */
  origin: Origin | null
  /** The sync key it came from, or null when written on the board. */
  from: string | null
  createdAt: string
  editedAt: string | null
  deleted: boolean
  /** Sync targets this message didn't reach, with why. A later delivery clears its entry. */
  undelivered: Record<string, string>
  attachments: Attachment[]
  /** Platform messages it links to (Slack permalinks), each with what it said. */
  links: Link[]
  /** Set when a schedule posted it: the schedule's ID and which send this was, from 0. */
  schedule?: { id: number; n: number }
  /** Set when its author couldn't read its channel, as `authorizeOwn` checks. Views leave it out. */
  blind?: true
}

export type MessagesState = {
  byId: Record<string, Message>
  /** Thread root → reply IDs, in log order. */
  replies: Record<string, number[]>
}

export const iso = (date: Date | string): string =>
  typeof date === 'string' ? date : date.toISOString()

export function foldMessages(
  state: MessagesState,
  event: BoardEvent,
): MessagesState {
  switch (event.type) {
    case 'message.posted': {
      const { payload } = event
      state.byId[event.index] = {
        id: event.index,
        channel: payload.channel,
        text: payload.text,
        re: payload.re,
        replyTo: payload.replyTo,
        thread: payload.thread,
        labels: { ...payload.labels },
        reactions: {},
        mentions: payload.mentions,
        by: payload.by,
        noSync: payload.noSync,
        origin: payload.origin,
        from: payload.from,
        createdAt: iso(event.createdAt),
        editedAt: null,
        deleted: false,
        undelivered: {},
        attachments: payload.attachments ?? [],
        links: payload.links ?? [],
        ...(payload.schedule ? { schedule: { ...payload.schedule } } : {}),
        ...(payload.blind ? { blind: true as const } : {}),
      }
      if (payload.re !== null) (state.replies[payload.re] ??= []).push(event.index)
      return state
    }
    case 'message.edited': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return state
      message.text = event.payload.text
      message.mentions = event.payload.mentions
      message.editedAt = iso(event.createdAt)
      return state
    }
    case 'message.deleted': {
      const message = state.byId[event.payload.id]
      if (!message) return state
      message.deleted = true
      message.text = ''
      message.reactions = {}
      message.mentions = []
      message.attachments = []
      message.links = []
      return state
    }
    case 'reaction.added': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return state
      // Older events may use Slack's names (`+1`); they group with Chat SDK's (`thumbs_up`).
      const actors = (message.reactions[canonicalEmoji(event.payload.emoji)] ??= [])
      if (!actors.includes(event.payload.by.actor)) actors.push(event.payload.by.actor)
      return state
    }
    case 'reaction.removed': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return state
      const { by } = event.payload
      const emoji = canonicalEmoji(event.payload.emoji)
      const actors = (message.reactions[emoji] ?? []).filter((a) => a !== by.actor)
      if (actors.length > 0) message.reactions[emoji] = actors
      else delete message.reactions[emoji]
      return state
    }
    case 'labels.changed': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return state
      Object.assign(message.labels, event.payload.set)
      for (const key of event.payload.unset) delete message.labels[key]
      return state
    }
    case 'message.linked': {
      const message = state.byId[event.payload.id]
      if (message && !message.deleted) message.links = event.payload.links
      return state
    }
    case 'message.sync_failed': {
      const message = state.byId[event.payload.id]
      if (message) message.undelivered[event.payload.target] = event.payload.error
      return state
    }
    case 'message.synced': {
      const message = state.byId[event.payload.id]
      if (message) delete message.undelivered[event.payload.target]
      return state
    }
    default:
      return state
  }
}

export const messagesReducer = reducer({
  contract: boardContract,
  name: 'vboard.messages.v4',
  initialState: { byId: {}, replies: {} } as MessagesState,
}).fold(foldMessages)

/**
 * Each post's event ID → its message: a retried write with the same ID is already on
 * the board, and doesn't go through the middleware again.
 */
export const postedReducer = reducer({
  contract: boardContract,
  name: 'vboard.posted.v1',
  initialState: {} as Record<string, number>,
}).fold((state, event) => {
  if (event.type === 'message.posted') state[event.id] = event.index
  return state
})

export type Channel = {
  path: string
  lastIndex: number
  messages: number
  threads: number
}

export type ChannelsState = Record<string, Channel>

export const channelsReducer = reducer({
  contract: boardContract,
  name: 'vboard.channels.v1',
  initialState: {} as ChannelsState,
}).fold((state, event) => {
  if (event.type !== 'message.posted') return state
  const { channel, re } = event.payload
  const entry = (state[channel] ??= {
    path: channel,
    lastIndex: 0,
    messages: 0,
    threads: 0,
  })
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return state
})

export type Actor = {
  id: string
  kind: ActorKind
  handle: string
  name: string
  avatar: string | null
}

/** A platform actor proved to be a principal (`actor.linked`). */
export type ActorLink = { to: string; method: 'code' | 'consent'; at: string }

export type ActorsState = {
  byId: Record<string, Actor>
  /** Lowercased handle → actor IDs. Handles aren't reserved, so several can share one. */
  byHandle: Record<string, string[]>
  /** Platform actor → the principal it's linked to. Display and filtering only, never permissions. */
  links: Record<string, ActorLink>
}

/** The principal an actor belongs to: its link, its own principal for a profile (`…+claude`), or itself. */
export function personOf(actors: ActorsState, actor: string): string {
  const linked = actors.links[actor]?.to
  if (linked) return linked
  const plus = actor.indexOf('+')
  return plus === -1 ? actor : actor.slice(0, plus)
}

/** The platform actors linked to `principal`. */
export const linkedTo = (actors: ActorsState, principal: string): string[] =>
  Object.entries(actors.links).filter(([, link]) => link.to === principal).map(([actor]) => actor)

export function foldActors(state: ActorsState, event: BoardEvent): ActorsState {
  if (event.type === 'actor.linked') {
    state.links[event.payload.actor] = { to: event.payload.to, method: event.payload.method, at: iso(event.createdAt) }
    return state
  }
  if (event.type === 'actor.unlinked') {
    delete state.links[event.payload.actor]
    return state
  }
  if (event.type !== 'actor.seen') return state
  const { actor, kind, handle, name, avatar } = event.payload
  const previous = state.byId[actor]
  if (previous) {
    const key = previous.handle.toLowerCase()
    const remaining = (state.byHandle[key] ?? []).filter((id) => id !== actor)
    if (remaining.length > 0) state.byHandle[key] = remaining
    else delete state.byHandle[key]
  }
  state.byId[actor] = { id: actor, kind: actorKind(kind), handle, name, avatar }
  const key = handle.toLowerCase()
  const ids = (state.byHandle[key] ??= [])
  if (!ids.includes(actor)) ids.push(actor)
  return state
}

export const actorsReducer = reducer({
  contract: boardContract,
  name: 'vboard.actors.v2',
  initialState: { byId: {}, byHandle: {}, links: {} } as ActorsState,
}).fold(foldActors)

/** A copy of a board message on a platform. */
/** `files`: the platform's IDs for the message's files, or null when it refused them; unset until they're sent. */
/** `asUser`: posted with its author's own token, so editing or deleting it needs that token too. */
export type ExternalCopy = { thread: string; message: string; files?: string[] | null; asUser?: true }

export type SyncedThread = {
  root: number
  channel: string
  kinds?: Record<string, 'channel' | 'thread'>
  /** External channels (start a thread there) and threads (joined), in sync order. */
  targets: string[]
  /** Target → the external thread it resolved to. A thread target resolves to itself. */
  external: Record<string, string>
}

export type SyncState = {
  /** Thread key → its sync. */
  threads: Record<string, SyncedThread>
  /** External thread (grouped) → thread key. */
  byExternalThread: Record<string, string>
  /** Board message → target → its copy there. Includes the copy it came from. */
  copies: Record<string, Record<string, ExternalCopy>>
  /** `${external thread}|${platform message ID}` → board message. */
  byExternalMessage: Record<string, number>
}

/** `slack:C0123ABC:1727.1234` is a thread; `slack:C0123ABC` and `github:owner/repo` are channels. */
export const isThreadTarget = (target: string) => target.slice(target.indexOf(':') + 1).includes(':')

export const externalMessageKey = (thread: string, message: string) => `${thread}|${message}`

const addTarget = (thread: SyncedThread, target: string) => {
  if (!thread.targets.includes(target)) thread.targets.push(target)
}

export function foldSync(state: SyncState, event: BoardEvent): SyncState {
  switch (event.type) {
    case 'message.posted': {
      const { payload } = event
      if (payload.re === null)
        state.threads[payload.thread] = { root: event.index, channel: payload.channel, targets: [], external: {} }
      const origin = payload.origin
      if (!origin) return state
      const thread = state.threads[payload.thread]
      if (thread && payload.re === null) {
        addTarget(thread, origin.thread)
        ;(thread.kinds ??= {})[origin.thread] = 'thread'
        thread.external[origin.thread] = origin.thread
        state.byExternalThread[origin.thread] = payload.thread
      }
      const precise = origin.subthread ?? origin.thread
      ;(state.copies[event.index] ??= {})[origin.thread] = { thread: precise, message: origin.message }
      state.byExternalMessage[externalMessageKey(precise, origin.message)] = event.index
      return state
    }
    case 'thread.synced': {
      const thread = state.threads[event.payload.thread]
      if (!thread) return state
      addTarget(thread, event.payload.target)
      if (event.payload.kind) (thread.kinds ??= {})[event.payload.target] = event.payload.kind
      if ((event.payload.kind ?? (isThreadTarget(event.payload.target) ? 'thread' : 'channel')) === 'thread') {
        thread.external[event.payload.target] = event.payload.target
        state.byExternalThread[event.payload.target] = event.payload.thread
      }
      return state
    }
    case 'message.files_synced': {
      const copy = state.copies[event.payload.id]?.[event.payload.target]
      if (copy) copy.files = event.payload.files
      return state
    }
    case 'message.synced': {
      const { id, target, external } = event.payload
      ;(state.copies[id] ??= {})[target] = { ...external }
      state.byExternalMessage[externalMessageKey(external.thread, external.message)] = id
      const thread = state.threads[event.payload.thread]
      if (thread && thread.root === id && (thread.kinds?.[target] ?? (isThreadTarget(target) ? 'thread' : 'channel')) === 'channel') {
        thread.external[target] = external.thread
        state.byExternalThread[external.thread] = event.payload.thread
      }
      return state
    }
    default:
      return state
  }
}

export const syncReducer = reducer({
  contract: boardContract,
  name: 'vboard.sync.v1',
  initialState: { threads: {}, byExternalThread: {}, copies: {}, byExternalMessage: {} } as SyncState,
}).fold(foldSync)

export type IdentityCode = { principal: string; sync: string; expiresAt: string; usedBy: string | null; usedIn: string | null }
/** Code hash → its code. */
export type IdentityCodesState = Record<string, IdentityCode>

export const identityCodesReducer = reducer({
  contract: identityContract,
  name: 'vboard.identity-codes.v1',
  initialState: {} as IdentityCodesState,
}).fold((state, event) => {
  if (event.type === 'identity.code_issued') {
    const { hash, principal, sync, expiresAt } = event.payload
    state[hash] ??= { principal, sync, expiresAt, usedBy: null, usedIn: null }
  } else if (event.type === 'identity.code_used') {
    const code = state[event.payload.hash]
    if (code && code.usedBy === null) {
      code.usedBy = event.payload.actor
      code.usedIn = event.payload.message ?? null
    }
  }
  return state
})
