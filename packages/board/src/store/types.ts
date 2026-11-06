import type { A2Store } from 'experimental-a2/server'
import type { BoardEvent } from '../contract/events.ts'
import type { ExternalCopy, Message, SyncedThread } from '../contract/folds.ts'

/**
 * What a query matches, resolved by the board: handles are already actor and
 * principal sets, so a backend never needs the actors.
 */
export type MessageFilter = {
  /** One channel, or with `subtree` it and every channel under it. */
  channel?: { path: string; subtree: boolean }
  /** In one of these channels: those a reader may read. None matches nothing. */
  channels?: readonly string[]
  /** A thread: its root and its replies. */
  re?: number
  /** Written by one of these actors, or by an agent of one of these people. */
  by?: { actors: readonly string[]; principals: readonly string[] }
  /** Mentions one of these actors. */
  mentions?: readonly string[]
  /** The sync key it came from, or `board`. */
  from?: string
  /** Lowercased: a substring of the lowercased text. */
  text?: string
  /** Each on the message or its thread's root; `values: null` is any value. */
  labels?: readonly { key: string; values: readonly string[] | null }[]
}

/** By message ID: `after` takes the first `limit` after it; otherwise the last `limit`. */
export type Page = { before?: number; after?: number; limit: number }

/** A thread as `/threads` lists it: its root, how many replies aren't deleted, and the latest. */
export type ThreadSummary = { root: Message; replies: number; last: Message | null }

/**
 * The board's messages, kept from its log. Each read says which log index it
 * reflects (`position`), so a reader knows what it has seen.
 */
export interface MessageTables {
  /** The last log index applied. */
  position(): Promise<number>
  /** Applies one board event, exactly once: an event at or below the position changes nothing. */
  apply(event: BoardEvent): Promise<void>
  /**
   * Applies `event` only if it's the very next one, and says whether it did: a
   * writer catching the tables up on its own write, without waiting on the consumer.
   */
  applyNext(event: BoardEvent): Promise<boolean>
  message(id: number): Promise<Message | null>
  /** The message a post with this event ID created. A root's thread key is one. */
  byEventId(eventId: string): Promise<Message | null>
  /** Each of `ids` as it was right after event `index`; one not posted by then is absent. */
  messagesAt(ids: readonly number[], index: number): Promise<Map<number, Message>>
  /** A thread's root and every reply, deleted ones included, by ID. */
  thread(root: number): Promise<Message[]>
  messages(filter: MessageFilter, page: Page): Promise<{ messages: Message[]; position: number }>
  /** Threads with a message that matches, by their latest reply. */
  threads(filter: MessageFilter, page: Page): Promise<{ threads: ThreadSummary[]; position: number }>
  /** A thread's sync: its targets, and the platform thread it lives in on each. */
  syncOf(thread: string): Promise<SyncedThread | null>
  /** The board thread a platform thread belongs to. */
  threadOf(externalThread: string): Promise<string | null>
  /** Each message's copies, by target: where it went, or came from, on each platform. */
  copiesOf(ids: readonly number[]): Promise<Map<number, Record<string, ExternalCopy>>>
  /** The board message a platform message is a copy of, or came in as. */
  messageOf(externalThread: string, platformMessage: string): Promise<number | null>
  /** Every platform thread a board thread lives in. */
  externalThreads(): Promise<string[]>
  /** The messages that carry an attachment, by ID. A deleted message carries none. */
  withAttachment(attachment: string): Promise<Message[]>
  close(): Promise<void>
}

/**
 * Where a local board keeps everything: its log, and the tables it reads from. `sqlite()` and
 * `memory()` (`store/sqlite.ts`, `store/memory.ts`) make one.
 */
export type BoardStore = {
  /** The board's A2 store. */
  readonly log: A2Store
  readonly tables: MessageTables
  close(): Promise<void>
}
