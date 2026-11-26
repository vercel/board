import { idempotentId, reducer } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import type { Protocol } from '../api/protocol.ts'
import { INBOX_LIMIT_DEFAULT, type FollowView, type InboxEventView, type InboxItemView, type InboxReason } from '../api/routes.ts'
import { arrivingSession, boardContract, FOLLOWS_SESSION, readersContract, readerSession, type ReaderEvent } from '../contract/contract.ts'
import { BOARD_SESSION, type BoardEvent, type BoardEvents } from '../contract/events.ts'
import type { Message } from '../contract/folds.ts'
import { extractMentions, isEmail } from '../contract/mentions.ts'
import { own, setOwn } from '../contract/own.ts'
import { actorParts } from '../contract/profiles.ts'
import { ActorId, storable } from '../contract/schemas.ts'
import { actorsReducer, channelsReducer } from '../contract/reducers.ts'
import type { ThreadPosition } from '../store/types.ts'
import type { Access } from './access.ts'
import { authenticates, type Known } from './auth.ts'
import type { BoardSession } from './a2.ts'
import type { Identity } from './backend.ts'
import { badRequest, notFound } from './errors.ts'
import { indexOf, readableFilter, ref, view } from './feed.ts'
import type { BoardReads } from './reads.ts'

/** How many channels and subtrees one reader follows at most on this board. */
export const CHANNEL_FOLLOWS_MAX = 200
/** How many messages an item keeps as unread: one with more says this many. */
const UNREAD_MAX = 1000
/** How many of a reader session's events one read of what changed looks at. */
const PAGE = 200
/** How long an inbox read waits for the messages already on the board to reach it, before it answers with what it has. */
const ARRIVED_WAIT_MS = 10_000

/** A follow asked for or ended, at a board index: it holds for what's written after `at`. `when` is its time. */
type Toggle = { at: number; on: boolean; when: number }

/**
 * What readers asked to follow, by what it is, then by reader: each one's toggles, oldest first. A
 * message goes by the last one before it, so one that's handled late still finds who followed then.
 */
type FollowsState = {
  /** By channel, or `www/` for it and its subtree. */
  channels: Record<string, Record<string, Toggle[]>>
  /** By the thread's root. */
  threads: Record<string, Record<string, Toggle[]>>
}

const followsReducer = reducer({
  contract: readersContract,
  name: 'board.follows.v1',
  initialState: { channels: {}, threads: {} } as FollowsState,
}).fold((state, event) => {
  const when = new Date(event.createdAt).getTime()
  const toggle = (map: Record<string, Record<string, Toggle[]>>, key: string, reader: string, at: number, on: boolean) => {
    const readers = own(map, key) ?? setOwn(map, key, {})
    ;(own(readers, reader) ?? setOwn(readers, reader, [])).push({ at, on, when })
  }
  switch (event.type) {
    case 'channel.followed':
    case 'channel.unfollowed':
      toggle(state.channels, event.payload.channel, event.payload.reader, event.payload.at, event.type === 'channel.followed')
      break
    case 'thread.followed':
    case 'thread.unfollowed':
      toggle(state.threads, String(event.payload.thread), event.payload.reader, event.payload.at, event.type === 'thread.followed')
      break
  }
  return state
})

/** An item as the fold keeps it. */
type Item = {
  reader: string
  thread: number
  message: number | null
  channel: string
  reasons: InboxReason[]
  /** Read through this message: what arrived up to it isn't unread. */
  read: number
  /** The messages that arrived after `read`, oldest first. */
  unread: number[]
  /** Until when it's snoozed, in epoch milliseconds. */
  snoozed: number | null
  /** When something last arrived in it, or it was added, in epoch milliseconds. */
  at: number
  /** The index, in its reader's session, of what put it where it is in the list: the higher, the newer. */
  order: number
}

/** A principal's inboxes: its own and each of its profiles', by reader, then by item. */
type ReaderState = { items: Record<string, Record<string, Item>> }

/** An item's key in its reader's inbox: a thread's, or a message's own. */
const keyOf = (item: { thread: number; message: number | null }) => (item.message === null ? `t${item.thread}` : `m${item.message}`)

const REASONS: readonly InboxReason[] = ['mention', 'thread', 'channel', 'added']

/** `reasons` with `more`, each once, in one order. */
const withReasons = (reasons: readonly InboxReason[], more: readonly InboxReason[]) => REASONS.filter((reason) => reasons.includes(reason) || more.includes(reason))

const readerReducer = reducer({
  contract: readersContract,
  name: 'board.reader.v1',
  initialState: { items: {} } as ReaderState,
}).fold((state, event) => {
  if (!event.type.startsWith('item.')) return state
  const { payload } = event as Extract<ReaderEvent, { type: `item.${string}` }>
  const items = own(state.items, payload.reader) ?? setOwn(state.items, payload.reader, {})
  const key = keyOf(payload)
  const found = own(items, key)
  const at = new Date(event.createdAt).getTime()
  switch (event.type) {
    case 'item.arrived': {
      const { arrived } = event.payload
      // When it was written: an arrival passed on later says so itself.
      const at = event.payload.at ?? new Date(event.createdAt).getTime()
      const item = found ?? setOwn(items, key, { reader: payload.reader, thread: payload.thread, message: null, channel: event.payload.channel, reasons: [], read: arrived - 1, unread: [], snoozed: null, at, order: event.index })
      if (arrived > item.read && !item.unread.includes(arrived)) item.unread = [...item.unread, arrived].slice(-UNREAD_MAX)
      item.reasons = withReasons(item.reasons, event.payload.reasons)
      item.snoozed = null
      item.at = at
      item.order = event.index
      break
    }
    case 'item.added': {
      // One that's there stays as it is: adding it says only that its reader put it there too.
      if (found) found.reasons = withReasons(found.reasons, ['added'])
      else {
        const { last } = event.payload
        setOwn(items, key, { reader: payload.reader, thread: payload.thread, message: payload.message, channel: event.payload.channel, reasons: ['added'], read: last - 1, unread: [last], snoozed: null, at, order: event.index })
      }
      break
    }
    case 'item.removed':
      delete items[key]
      break
    case 'item.read':
      if (found && event.payload.through > found.read) {
        found.read = event.payload.through
        found.unread = found.unread.filter((id) => id > found.read)
      }
      break
    case 'item.unread':
      if (found) {
        found.read = event.payload.from - 1
        found.unread = event.payload.unread
      }
      break
    case 'item.snoozed':
      if (found) found.snoozed = event.payload.until
      break
    case 'item.woke':
      // Only the snooze it was for: one set since, or ended by what arrived, is another's.
      if (found && found.snoozed === event.payload.until) {
        found.snoozed = null
        found.at = at
        found.order = event.index
      }
      break
  }
  return state
})

/** An arrival that waits to be passed on to its reader's inbox: where it is in its session, when it was written, and what it says. */
type Arriving = { index: number; at: number; arrival: Extract<ReaderEvent, { type: 'item.arrived' }>['payload'] }

/** What reached a principal's readers and hasn't been passed on yet, oldest first. */
const arrivingReducer = reducer({
  contract: readersContract,
  name: 'board.arriving.v1',
  initialState: { waiting: [] as Arriving[] },
}).fold((state, event) => {
  if (event.type === 'item.arrived') state.waiting.push({ index: event.index, at: new Date(event.createdAt).getTime(), arrival: event.payload })
  else if (event.type === 'arrivals.admitted') state.waiting = state.waiting.filter((arriving) => arriving.index > event.payload.through)
  return state
})

/**
 * Whether a mention's ID could be an actor's: as long as one may be, and nothing a session or a
 * log can't hold. Message text holds anything, so what it names is checked before it's a reader.
 */
const nameable = (id: string) => ActorId.safeParse(id).success && storable(id) && !/[\u0000-\u001f\u007f]/.test(id)

/** Whether the last of `toggles` before board index `at` is a follow. */
const onAt = (toggles: readonly Toggle[] | undefined, at: number): Toggle | null => {
  const last = toggles?.findLast((toggle) => toggle.at < at)
  return last?.on ? last : null
}

/**
 * How a reader follows a thread for a message at board index `at`, or null when they don't: they
 * posted in it (`posted` is their newest post before then), or asked to, whichever came last, with
 * no unfollow since.
 */
function followsThread(posted: number | undefined, toggles: readonly Toggle[] | undefined, at: number): 'posted' | 'asked' | null {
  const last = toggles?.findLast((toggle) => toggle.at < at)
  if (posted !== undefined && (!last || posted > last.at)) return 'posted'
  return last?.on ? 'asked' : null
}

/** Whether a followed channel, or `www/` for it and its subtree, covers `channel`. */
const covers = (followed: string, channel: string) => (followed.endsWith('/') ? channel === followed.slice(0, -1) || channel.startsWith(followed) : channel === followed)

/** An append that holds an event ID already in the log: a retry's, which lands nothing more. */
const duplicate = (error: unknown) => ['PARTIAL_DUPLICATE_BATCH', 'DUPLICATE_EVENT_ID'].includes((error as { code?: string } | null)?.code ?? '')

/** Resolves after `ms`, or when `signal` aborts. */
const paused = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/** The longest a timer waits here: Node fires one set further out at once. */
const TIMER_MAX_MS = 2 ** 31 - 1

/** A `/me/inbox/follows` page's `older` on this board: where its last thread stands, as a page of threads says it. */
const olderRef = (position: ThreadPosition) => `${position.at}.${position.id}`

function olderAt(value: string): ThreadPosition {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(value)
  if (!match) throw badRequest(`${value} isn't a page of follows on this board`, 'invalid_cursor')
  return { at: Number(match[1]), id: Number(match[2]) }
}

/**
 * Inboxes on a local board, in sessions of their own beside the board's log: what each actor
 * follows, and what reached them. A consumer of the board's log works out, for each post, who it
 * reaches (who it mentions, who follows its thread, who follows its channel) and adds it to their
 * inboxes; what a reader does to their own (add, remove, read, snooze) they append themselves.
 */
export function createInbox(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  let bound: { session: BoardSession; reads: BoardReads; accessNow: (principal: Known) => Promise<Access | null> } | null = null
  const board = () => {
    if (!bound) throw new Error('inboxes used before the board bound them')
    return bound
  }

  const server = createServer({
    contract: readersContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })
  const follows = server.session(FOLLOWS_SESSION)
  /** The session that holds `reader`'s inbox: its principal's. */
  const sessionOf = (reader: string) => server.session(readerSession(actorParts(reader).principal))

  /** The session that holds what has reached `reader` and hasn't been passed on to its inbox: its principal's. */
  const arrivingOf = (reader: string) => server.session(arrivingSession(actorParts(reader).principal))

  /** Appends to a session an event whose ID says what it's for: a retry's lands nothing more. */
  async function once(session: ReturnType<typeof sessionOf>, event: Parameters<ReturnType<typeof sessionOf>['append']>[0]) {
    await session.append(event).catch((error: unknown) => {
      if (!duplicate(error)) throw error
    })
  }

  /**
   * A post reaches the inboxes of whoever it's for: who it mentions, who follows its thread, and who
   * follows its channel, but never its author's, whose own item for the thread it reads up to here.
   * No platform user: they're told on their platform. A message kept on the board (`noSync`) reaches
   * profiles only: it's what one agent leaves another.
   */
  async function arrive(ctx: ConsumerContext<BoardEvents>) {
    // Only the board's own log: another session of its contract is no board's messages.
    if (ctx.session.id !== BOARD_SESSION) return
    const event = ctx.event as BoardEvent<'message.posted'>
    const { session, reads } = board()
    const { payload, index: at } = event
    const author = payload.by.actor
    const root = payload.re ?? at
    // Who posted in the thread before it, each with their newest post there.
    const posted = new Map<string, number>()
    if (payload.re !== null) {
      await reads.ensure(at, ctx.signal)
      for (const message of await reads.tables.thread(root)) if (message.id < at) posted.set(message.by.actor, message.id)
    }
    const [{ state: followed }, { state: actors }] = await Promise.all([follows.state(followsReducer), session.state(actorsReducer, { through: at })])
    const reached = new Map<string, InboxReason[]>()
    const reach = (reader: string, reason: InboxReason) => reached.set(reader, withReasons(reached.get(reader) ?? [], [reason]))
    for (const token of extractMentions(payload.text)) if (token.kind === 'actor' && !isEmail(token.actor) && nameable(token.actor)) reach(token.actor, 'mention')
    const asked = own(followed.threads, String(root)) ?? {}
    for (const reader of new Set([...posted.keys(), ...Object.keys(asked)])) if (followsThread(posted.get(reader), own(asked, reader), at)) reach(reader, 'thread')
    for (const [channel, readers] of Object.entries(followed.channels)) {
      if (!covers(channel, payload.channel)) continue
      for (const [reader, toggles] of Object.entries(readers)) if (onAt(toggles, at)) reach(reader, 'channel')
    }
    reached.delete(author)
    for (const [reader, reasons] of reached) {
      const known = own(actors.byId, reader)
      // No platform user. A mention of someone the board never met reaches them only as a principal it signs in, by its own ID: any
      // other names no one it knows of, a profile nobody has written as included, so no post makes up a reader under someone.
      if (known?.kind === 'external' || (!known && reasons.every((reason) => reason === 'mention') && !(actorParts(reader).profile === null && authenticates(reader)))) continue
      if (payload.noSync && actorParts(reader).profile === null) continue
      try {
        // Whoever may read it: it's passed on to the reader's inbox when the board next answers them, if they may read it then.
        await once(arrivingOf(reader), {
          type: 'item.arrived',
          id: await idempotentId('board-arrival', reader, event.id),
          payload: { reader, thread: root, message: null, channel: payload.channel, arrived: at, reasons },
        })
      } catch (error) {
        // What a log won't hold is no reader's: one post must never stop every inbox behind it.
        if ((error as { code?: string } | null)?.code !== 'INVALID_PAYLOAD' && !(error instanceof TypeError)) throw error
        console.error(`[board] left #${at} out of an inbox it can't be written to:`, (error as Error).message)
      }
    }
    // Its author has read their thread up to what they just wrote.
    const mine = own(own((await sessionOf(author).state(readerReducer)).state.items, author) ?? {}, keyOf({ thread: root, message: null }))
    if (mine && mine.read < at)
      await once(sessionOf(author), { type: 'item.read', id: await idempotentId('board-arrival-read', author, event.id), payload: { reader: author, thread: root, message: null, through: at } })
  }

  /** One lane, so each reader's items arrive in the board's order, and a read can wait for it by index. */
  const boardConsumer = consumer({ contract: boardContract, name: 'board-arrivals', types: ['message.posted'], lane: 'arrivals' }).run(arrive)

  /** Waits for every message on the board to have reached the inboxes it's for, so a read right after a post has it. */
  async function arrived(signal: AbortSignal) {
    const { session } = board()
    try {
      await session.consume(boardConsumer, { signal: AbortSignal.any([signal, AbortSignal.timeout(ARRIVED_WAIT_MS)]) })
    } catch (error) {
      if (signal.aborted) throw error
      console.warn("[board] an inbox read didn't wait for the newest messages to arrive:", (error as Error).message)
    }
  }

  /**
   * Passes on to the caller's principal's inboxes what has reached them since they last asked: each
   * arrival from a channel the principal may read now, in the order it came, and none of the rest.
   * A thread its reader posted in since is read up to that post. Whoever asks is the principal,
   * whatever narrows this request: a narrowed caller's own reads hide what it can't read.
   */
  async function admit(identity: Identity) {
    const { accessNow } = board()
    const me = identity.actor.id
    const waiting = arrivingOf(me)
    const { state } = await waiting.state(arrivingReducer)
    if (state.waiting.length === 0) return
    const { id, kind, handle, facts } = identity.principal
    const access = identity.principal.scope === undefined ? identity.principal.access : ((await accessNow({ id, kind, handle, ...(facts ? { facts } : {}) })) ?? identity.principal.access)
    const principal = actorParts(me).principal
    /** Each reader's threads that something was passed on in, with the first message of it. */
    const threads = new Map<string, { reader: string; thread: number; first: number }>()
    for (const { index, at, arrival } of state.waiting) {
      if (!access.readable(arrival.channel)) continue
      await once(sessionOf(me), { type: 'item.arrived', id: await idempotentId('board-admitted', principal, String(index)), payload: { ...arrival, at } })
      const key = `${arrival.reader}\u001f${arrival.thread}`
      if (!threads.has(key)) threads.set(key, { reader: arrival.reader, thread: arrival.thread, first: arrival.arrived })
    }
    // What its reader wrote after it arrived read it: their newest post in the thread says up to where.
    for (const { reader, thread, first } of threads.values()) {
      const posted = await newestPost(reader, thread)
      if (posted && posted.id > first)
        await once(sessionOf(me), { type: 'item.read', id: await idempotentId('board-admitted-read', reader, String(thread), String(posted.id)), payload: { reader, thread, message: null, through: posted.id } })
    }
    await waiting.append({ type: 'arrivals.admitted', payload: { through: state.waiting.at(-1)!.index } })
  }

  /** What every inbox request does first: waits for the board's messages to have reached who they're for, and passes the caller's on. */
  async function current(identity: Identity, signal: AbortSignal) {
    await arrived(signal)
    await admit(identity)
  }

  /** Whose inboxes a read is of: the caller's own, or with `under`, every reader's under it too. */
  const scopeOf = (identity: Identity, under: boolean | undefined) => {
    const me = identity.actor.id
    // A principal's profiles are under it; under a profile are the profiles its name leads.
    const below = actorParts(me).profile === null ? `${me}+` : `${me}/`
    return (reader: string) => reader === me || (under === true && reader.startsWith(below))
  }

  /** The caller's principal's inboxes as they are, and the index that reflects. */
  const stateOf = (identity: Identity) => sessionOf(identity.actor.id).state(readerReducer)

  /** The items in scope that the caller may read, the newest first. */
  const itemsOf = (state: ReaderState, scope: (reader: string) => boolean, access: Access): Item[] =>
    Object.entries(state.items)
      .filter(([reader]) => scope(reader))
      .flatMap(([, items]) => Object.values(items))
      .filter((item) => access.readable(item.channel))
      .sort((a, b) => b.order - a.order)

  /** Ends every snooze in scope that has run out: nothing times one, so whoever looks next says it's over. */
  async function wake(identity: Identity, scope: (reader: string) => boolean) {
    const { state } = await stateOf(identity)
    const now = Date.now()
    for (const [reader, items] of Object.entries(state.items)) {
      if (!scope(reader)) continue
      for (const item of Object.values(items)) {
        if (item.snoozed === null || item.snoozed > now) continue
        const { thread, message, snoozed: until } = item
        await once(sessionOf(reader), { type: 'item.woke', id: await idempotentId('board-woke', reader, keyOf(item), String(until)), payload: { reader, thread, message, until } })
      }
    }
  }

  /** `item` as its reader sees it now, or null for one whose thread the tables don't have. */
  async function shown(identity: Identity, item: Item): Promise<{ view: InboxItemView; root: Message } | null> {
    const { session, reads } = board()
    // What arrived is on the board, and the tables may be a moment behind it.
    await reads.ensure(item.unread.at(-1) ?? item.message ?? item.thread)
    const [{ threads }, alone, { state: actors }] = await Promise.all([
      reads.tables.threads({ re: item.thread }, { limit: 1 }),
      item.message === null ? null : reads.message(item.message),
      session.state(actorsReducer),
    ])
    const summary = threads[0]
    if (!summary) return null
    const last = item.message === null ? (summary.last ?? summary.root) : alone
    if (!last) return null
    const reader = await reads.reader(identity.principal.access, [summary.root, last])
    return {
      root: summary.root,
      view: {
        thread: ref(item.thread),
        message: item.message === null ? null : ref(item.message),
        reader: item.reader,
        first: view(summary.root, actors, reader),
        last: view(last, actors, reader),
        unread: item.unread.length,
        reasons: [...item.reasons],
        snoozed: item.snoozed === null ? null : new Date(item.snoozed).toISOString(),
        at: new Date(item.at).toISOString(),
      },
    }
  }

  /** A message the caller may read, by a ref in a request: a 404 otherwise, as if it weren't there. */
  async function readable(identity: Identity, id: string, signal?: AbortSignal): Promise<Message> {
    const at = indexOf(id)
    const message = at === null || at === 0 ? null : await board().reads.message(at, signal)
    if (!message || !identity.principal.access.readable(message.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
    return message
  }

  /** The caller's item a message names: the message's own, when it was added by itself, and its thread's otherwise. */
  async function itemOf(identity: Identity, message: Message): Promise<Item | undefined> {
    const items = own((await stateOf(identity)).state.items, identity.actor.id) ?? {}
    const thread = message.re ?? message.id
    return own(items, keyOf({ thread, message: message.id })) ?? own(items, keyOf({ thread, message: null }))
  }

  const notInInbox = (id: string) => notFound(`#${id} isn't in your inbox`, 'not_in_inbox')

  /** The caller's item `message` names, as it is after what was just appended. */
  async function after(identity: Identity, message: Message, id: string): Promise<InboxItemView> {
    const item = await itemOf(identity, message)
    const found = item ? await shown(identity, item) : null
    if (!found) throw notInInbox(id)
    return found.view
  }

  /** Where the board's log is now: what's written after it is what a follow holds for. */
  const head = async () => (await board().session.state(channelsReducer)).index

  /** The caller's newest post in a thread, or undefined when they wrote none. */
  async function newestPost(reader: string, root: number): Promise<Message | undefined> {
    const { messages } = await board().reads.tables.messages({ re: root, by: { actors: [reader], principals: [] } }, { limit: 1 })
    return messages[0]
  }

  /** What one read of a reader session's events after `after` answers: each item that changed, once, as it is now. */
  async function changes(identity: Identity, scope: (reader: string) => boolean, from: number): Promise<{ events: InboxEventView[]; cursor: number; full: boolean }> {
    const session = sessionOf(identity.actor.id)
    const backlog = (await session.history({ gte: from + 1, lte: from + PAGE })) as ReaderEvent[]
    const cursor = backlog.at(-1)?.index ?? from
    // The last change to each item is the one that says how it is.
    const changed = new Map<string, Extract<ReaderEvent, { type: `item.${string}` }>>()
    for (const event of backlog) {
      if (!event.type.startsWith('item.')) continue
      const item = event as Extract<ReaderEvent, { type: `item.${string}` }>
      if (!scope(item.payload.reader)) continue
      const key = `${item.payload.reader}\u001f${keyOf(item.payload)}`
      changed.delete(key)
      changed.set(key, item)
    }
    const { state } = await stateOf(identity)
    const { access } = identity.principal
    const events: InboxEventView[] = []
    for (const event of changed.values()) {
      const { reader, thread, message } = event.payload
      const item = own(own(state.items, reader) ?? {}, keyOf(event.payload))
      if (!item) {
        // Gone, and only its reader takes one out. One that was never there says nothing.
        if (event.type === 'item.removed') events.push({ type: 'inbox.removed', cursor: ref(event.index), thread: ref(thread), message: message === null ? null : ref(message), reader })
        continue
      }
      if (!access.readable(item.channel)) continue
      const found = await shown(identity, item)
      if (found) events.push({ type: 'inbox.item', cursor: ref(event.index), item: found.view })
    }
    return { events, cursor, full: backlog.length === PAGE }
  }

  return {
    server,
    boardConsumer,
    bind(binding: { session: BoardSession; reads: BoardReads; accessNow: (principal: Known) => Promise<Access | null> }) {
      bound = binding
    },

    async items(identity: Identity, query: Protocol['inboxItems']['input'], signal: AbortSignal): Promise<Protocol['inboxItems']['output']> {
      const scope = scopeOf(identity, query.under)
      await current(identity, signal)
      await wake(identity, scope)
      const { state, index } = await stateOf(identity)
      const before = query.before === undefined ? undefined : indexOf(query.before)
      if (before === null) throw badRequest(`${query.before} isn't a page of this inbox`, 'invalid_cursor')
      const limit = query.limit ?? INBOX_LIMIT_DEFAULT
      const labels = query.label ?? []
      const listed = itemsOf(state, scope, identity.principal.access).filter(
        (item) =>
          (query.snoozed === true) === (item.snoozed !== null) &&
          (query.unread !== true || item.unread.length > 0) &&
          (query.read !== true || item.unread.length === 0) &&
          (before === undefined || item.order < before),
      )
      const items: InboxItemView[] = []
      /** Where the page ends, once there's an item past it. */
      let last: Item | undefined
      let older: string | null = null
      for (const item of listed) {
        const found = await shown(identity, item)
        // A label is its thread's root's, where a task's state and a pull request's are.
        if (!found || !labels.every(([key, values]) => Object.hasOwn(found.root.labels, key) && (values === null || values.includes(found.root.labels[key]!)))) continue
        if (items.length === limit) {
          older = ref(last!.order)
          break
        }
        items.push(found.view)
        last = item
      }
      return { items, cursor: ref(index), older }
    },

    async events(identity: Identity, query: Protocol['inboxEvents']['input'], signal: AbortSignal): Promise<Protocol['inboxEvents']['output']> {
      const scope = scopeOf(identity, query.under)
      await current(identity, signal)
      await wake(identity, scope)
      const session = sessionOf(identity.actor.id)
      const { index: end } = await stateOf(identity)
      const asked = query.after === undefined ? undefined : indexOf(query.after)
      if (asked === null) throw badRequest(`${query.after} isn't a cursor of this inbox`, 'invalid_cursor')
      let cursor = asked === undefined || asked > end ? end : asked
      const deadline = Date.now() + (query.wait ?? 0) * 1000
      const page = async () => {
        const read = await changes(identity, scope, cursor)
        cursor = read.cursor
        return read
      }
      const first = await page()
      if (first.events.length > 0 || first.full || Date.now() >= deadline) return { events: first.events, cursor: ref(cursor) }
      // Held for the first change: an event in the session, something reaching the caller's readers, or a snooze of theirs running out.
      const waiting = arrivingOf(identity.actor.id)
      const changed = session.stream({ startAfter: cursor })[Symbol.asyncIterator]()
      const reached = waiting.stream({ startAfter: (await waiting.state(arrivingReducer)).index })[Symbol.asyncIterator]()
      let next: Promise<unknown> | null = null
      let arriving: Promise<unknown> | null = null
      try {
        // What reached them between the first look and now is passed on before the wait, which only hears what comes after.
        await admit(identity)
        const since = await page()
        if (since.events.length > 0 || since.full) return { events: since.events, cursor: ref(cursor) }
        for (;;) {
          const { state } = await stateOf(identity)
          const due = Math.min(...itemsOf(state, scope, identity.principal.access).flatMap((item) => (item.snoozed === null ? [] : [item.snoozed])))
          const wait = Math.min(deadline, due) - Date.now()
          next ??= changed.next()
          arriving ??= reached.next()
          const timer = new AbortController()
          const woken = await Promise.race([
            next.then(() => 'changed' as const),
            arriving.then(() => 'reached' as const),
            paused(Math.max(0, Math.min(wait, TIMER_MAX_MS)), AbortSignal.any([signal, timer.signal])).then(() => 'timer' as const),
          ])
          timer.abort()
          if (woken === 'changed') next = null
          else if (woken === 'reached') {
            arriving = null
            await admit(identity)
          } else await wake(identity, scope)
          const read = await page()
          if (read.events.length > 0 || read.full || signal.aborted || Date.now() >= deadline) return { events: read.events, cursor: ref(cursor) }
        }
      } finally {
        void changed.return?.()
        void reached.return?.()
      }
    },

    async add(identity: Identity, { id, message: alone }: Protocol['addInboxItem']['input'], signal: AbortSignal): Promise<Protocol['addInboxItem']['output']> {
      const { reads } = board()
      await current(identity, signal)
      const found = await readable(identity, id, signal)
      const reader = identity.actor.id
      const root = found.re ?? found.id
      // A thread by its root, or one message by its own ID: a reply is itself, and a root is with `message`.
      const message = alone === true || found.re !== null ? found.id : null
      if (message !== null && found.deleted) throw notFound(`message not found: #${id}`, 'message_not_found')
      const last = message ?? (await reads.tables.threads({ re: root }, { limit: 1 })).threads[0]?.last?.id ?? root
      await sessionOf(reader).append({ type: 'item.added', payload: { reader, thread: root, message, channel: found.channel, last } })
      const item = own(own((await stateOf(identity)).state.items, reader) ?? {}, keyOf({ thread: root, message }))
      const made = item ? await shown(identity, item) : null
      if (!made) throw new Error('an item was added but its inbox has no record of it')
      return { item: made.view }
    },

    async remove(identity: Identity, { id }: Protocol['removeInboxItem']['input'], signal: AbortSignal): Promise<Protocol['removeInboxItem']['output']> {
      await current(identity, signal)
      const found = await readable(identity, id, signal)
      const item = await itemOf(identity, found)
      if (!item) return { removed: false }
      const { reader, thread, message } = item
      await sessionOf(reader).append({ type: 'item.removed', payload: { reader, thread, message } })
      return { removed: true }
    },

    async mark(identity: Identity, { id, unread }: Protocol['markInboxItem']['input'], signal: AbortSignal): Promise<Protocol['markInboxItem']['output']> {
      const { reads } = board()
      // Where the board is before the inboxes catch up to it: what's read is what had arrived by then, and nothing written since.
      const end = await head()
      await current(identity, signal)
      const found = await readable(identity, id, signal)
      const item = await itemOf(identity, found)
      if (!item) throw notInInbox(id)
      const { reader, thread, message } = item
      if (unread !== true) {
        // A thread's root reads all of it, as far as the board has got; any other message, up to itself.
        const through = message === null && found.id === thread ? Math.max(end, found.id) : found.id
        await sessionOf(reader).append({ type: 'item.read', payload: { reader, thread, message, through } })
      } else {
        // Unread from it on: what others wrote from there, as far as an item keeps, and the message itself when that's nothing.
        const notes = actorParts(reader).profile !== null
        const since = message !== null ? [] : (await reads.tables.thread(thread)).filter((each) => each.id >= found.id && !each.deleted && each.by.actor !== reader && (notes || !each.noSync)).map((each) => each.id)
        await sessionOf(reader).append({ type: 'item.unread', payload: { reader, thread, message, from: found.id, unread: since.length > 0 ? since.slice(-UNREAD_MAX) : [found.id] } })
      }
      return { item: await after(identity, found, id) }
    },

    async snooze(identity: Identity, { id, until }: Protocol['snoozeInboxItem']['input'], signal: AbortSignal): Promise<Protocol['snoozeInboxItem']['output']> {
      await current(identity, signal)
      const found = await readable(identity, id, signal)
      const item = await itemOf(identity, found)
      if (!item) throw notInInbox(id)
      const at = until === null ? null : Date.parse(until)
      if (at !== null && at <= Date.now()) throw badRequest('until: a snooze ends later than now')
      const { reader, thread, message } = item
      await sessionOf(reader).append({ type: 'item.snoozed', payload: { reader, thread, message, until: at } })
      return { item: await after(identity, found, id) }
    },

    async follow(identity: Identity, body: Protocol['follow']['input'], signal: AbortSignal): Promise<Protocol['follow']['output']> {
      const reader = identity.actor.id
      const { state } = await follows.state(followsReducer)
      const now = () => new Date().toISOString()
      if ('channel' in body) {
        const { channel } = body
        const on = onAt(own(own(state.channels, channel) ?? {}, reader), Number.POSITIVE_INFINITY)
        if (on) return { follow: { channel, by: 'asked', at: new Date(on.when).toISOString() } }
        const following = Object.values(state.channels).filter((readers) => onAt(own(readers, reader), Number.POSITIVE_INFINITY)).length
        if (following >= CHANNEL_FOLLOWS_MAX) throw badRequest(`an inbox follows at most ${CHANNEL_FOLLOWS_MAX} channels and subtrees: unfollow one, or follow a subtree that covers several`, 'too_many_follows')
        await follows.append({ type: 'channel.followed', payload: { reader, channel, at: await head() } })
        return { follow: { channel, by: 'asked', at: now() } }
      }
      const found = await readable(identity, body.thread, signal)
      const root = found.re ?? found.id
      const posted = await newestPost(reader, root)
      const toggles = own(own(state.threads, String(root)) ?? {}, reader)
      const by = followsThread(posted?.id, toggles, Number.POSITIVE_INFINITY)
      if (by === 'posted') return { follow: { thread: ref(root), by, at: posted!.createdAt } }
      if (by === 'asked') return { follow: { thread: ref(root), by, at: new Date(toggles!.at(-1)!.when).toISOString() } }
      await follows.append({ type: 'thread.followed', payload: { reader, thread: root, at: await head() } })
      return { follow: { thread: ref(root), by: 'asked', at: now() } }
    },

    async unfollow(identity: Identity, body: Protocol['unfollow']['input'], signal: AbortSignal): Promise<Protocol['unfollow']['output']> {
      const reader = identity.actor.id
      const { state } = await follows.state(followsReducer)
      if ('channel' in body) {
        const { channel } = body
        if (!onAt(own(own(state.channels, channel) ?? {}, reader), Number.POSITIVE_INFINITY)) return { unfollowed: false }
        await follows.append({ type: 'channel.unfollowed', payload: { reader, channel, at: await head() } })
        return { unfollowed: true }
      }
      const found = await readable(identity, body.thread, signal)
      const root = found.re ?? found.id
      const posted = await newestPost(reader, root)
      if (!followsThread(posted?.id, own(own(state.threads, String(root)) ?? {}, reader), Number.POSITIVE_INFINITY)) return { unfollowed: false }
      await follows.append({ type: 'thread.unfollowed', payload: { reader, thread: root, at: await head() } })
      return { unfollowed: true }
    },

    async follows(identity: Identity, query: Protocol['follows']['input']): Promise<Protocol['follows']['output']> {
      const { session, reads } = board()
      const reader = identity.actor.id
      const { access } = identity.principal
      const { state } = await follows.state(followsReducer)
      const listed: FollowView[] = []
      const asked = (root: number) => own(own(state.threads, String(root)) ?? {}, reader)
      if (query.before === undefined) {
        // Every channel, by name, then the threads asked for and never posted in: the rest are among the threads posted in.
        for (const channel of Object.keys(state.channels).sort()) {
          const on = onAt(own(own(state.channels, channel) ?? {}, reader), Number.POSITIVE_INFINITY)
          if (on) listed.push({ channel, by: 'asked', at: new Date(on.when).toISOString() })
        }
        const only: { thread: number; when: number }[] = []
        for (const [thread, readers] of Object.entries(state.threads)) {
          const on = onAt(own(readers, reader), Number.POSITIVE_INFINITY)
          if (!on) continue
          const root = await reads.message(Number(thread))
          if (!root || !access.readable(root.channel) || (await newestPost(reader, root.id))) continue
          only.push({ thread: root.id, when: on.when })
        }
        for (const { thread, when } of only.sort((a, b) => b.when - a.when)) listed.push({ thread: ref(thread), by: 'asked', at: new Date(when).toISOString() })
      }
      // The threads the reader posted in, the one last active first, less the ones they left since.
      const filter = access.readsAll
        ? { by: { actors: [reader], principals: [] } }
        : readableFilter({ by: { actors: [reader], principals: [] } }, Object.keys((await session.state(channelsReducer)).state), access)
      const { threads, older } = await reads.threads(filter, { limit: query.limit ?? INBOX_LIMIT_DEFAULT, ...(query.before !== undefined ? { before: olderAt(query.before) } : {}) })
      for (const { root } of [...threads].reverse()) {
        const posted = await newestPost(reader, root.id)
        const toggles = asked(root.id)
        const by = followsThread(posted?.id, toggles, Number.POSITIVE_INFINITY)
        if (by === 'posted') listed.push({ thread: ref(root.id), by, at: posted!.createdAt })
        else if (by === 'asked') listed.push({ thread: ref(root.id), by, at: new Date(toggles!.at(-1)!.when).toISOString() })
      }
      return { follows: listed, older: older ? olderRef(older) : null }
    },
  }
}

export type Inbox = ReturnType<typeof createInbox>
