// The board log's events, as plain zod: what a handle reads and the folds take, on any
// backend. `contract.ts` hands them to A2 as the board's contract.
import { z } from 'zod'
import {
  ActorId,
  Attachment,
  ATTACHMENTS_PER_MESSAGE_MAX,
  SeenActorKind,
  Author,
  ChannelPath,
  Emoji,
  Handle,
  LabelKey,
  Labels,
  MessageId,
  MessageText,
  MESSAGE_TEXT_MAX,
  RemoteWatcherId,
  SCOPE_MAX,
  storable,
} from './schemas.ts'
import { ExternalEvent, ExternalTarget, Link, LINKS_PER_MESSAGE_MAX, Origin } from './external.ts'

/** The sync key a write came from, or null when it was written on the board. */
const From = z.string().nullable()

/** The thread key: the event ID of the thread's root. Lanes and sync state are keyed by it. */
const ThreadKey = z.string().min(1).max(200).refine(storable, 'thread key has a NUL character or a lone surrogate')

/** The board's one log. Every board fact is an event in session `board`. */
export const boardEvents = {
    'message.posted': z.object({
      channel: ChannelPath,
      /** Empty only when the message has attachments. */
      text: z.union([MessageText, z.literal('')]),
      /** The thread root, or null for a root. */
      re: MessageId.nullable(),
      /** The exact message replied to, when it isn't the root. */
      replyTo: MessageId.nullable(),
      thread: ThreadKey,
      labels: Labels,
      noSync: z.boolean(),
      mentions: z.array(ActorId),
      by: Author,
      origin: Origin.nullable(),
      from: From,
      /** Files on the message. Events written before attachments have none. */
      attachments: z.array(Attachment).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
      /** Platform messages it links to. Events written before links have none. */
      links: z.array(Link).max(LINKS_PER_MESSAGE_MAX).optional(),
      /** (server) Posted by a schedule: its ID and which send this is, from 0. Other messages have none. */
      schedule: z.object({ id: z.number().int().positive(), n: z.number().int().nonnegative() }).optional(),
      /**
       * (server) Its author couldn't read the channel it posted in. Where a
       * caller can't read, it edits and deletes only these of its own. Events
       * from before channel access have none: everyone read everything then.
       */
      blind: z.literal(true).optional(),
      /**
       * (server) The principal of the sync elsewhere that imported it, whose copy `origin` names:
       * that sync's to act on. None for the board's own sync, or a write on the board.
       */
      importedBy: ActorId.optional(),
    }),
    /**
     * A channel made before anything posted to it. A post makes one too, with no event of its own:
     * this is only for one that's empty. It names no message, so it carries no `id`.
     */
    'channel.created': z.object({ channel: ChannelPath, by: Author }),
    /** A message's links changed: an edit linked something new, or the platform sent what a link says. */
    'message.linked': z.object({ id: MessageId, thread: ThreadKey, links: z.array(Link).max(LINKS_PER_MESSAGE_MAX), by: Author, from: From }),
    'message.edited': z.object({
      id: MessageId,
      thread: ThreadKey,
      text: MessageText,
      mentions: z.array(ActorId),
      by: Author,
      from: From,
    }),
    'message.deleted': z.object({ id: MessageId, thread: ThreadKey, by: Author, from: From }),
    'reaction.added': z.object({ id: MessageId, thread: ThreadKey, emoji: Emoji, by: Author, from: From }),
    'reaction.removed': z.object({ id: MessageId, thread: ThreadKey, emoji: Emoji, by: Author, from: From }),
    'labels.changed': z.object({
      id: MessageId,
      thread: ThreadKey,
      set: Labels,
      unset: z.array(LabelKey),
      by: Author,
    }),
    /** A thread is synced with an external channel (start a thread there) or thread (join it). */
    'thread.synced': z.object({
      thread: ThreadKey,
      target: ExternalTarget,
      cause: z.enum(['config', 'request']),
      kind: z.enum(['channel', 'thread']).optional(),
      by: Author,
    }),
    /** An outbound delivery receipt: board message `id` exists on the platform as `external`. */
    'message.synced': z.object({
      id: MessageId,
      thread: ThreadKey,
      target: ExternalTarget,
      external: z.object({
        thread: ExternalTarget,
        message: z.string().min(1).max(300),
      }),
      /**
       * (server) The principal of the sync elsewhere that recorded it: its copy is that sync's to
       * change. None for the board's own sync.
       */
      syncedBy: ActorId.optional(),
    }),
    /**
     * Board message `id`'s files reached `target` after its text: `files` are the
     * platform's IDs for them, or null when the platform refused files and the
     * text got a line for each instead.
     */
    'message.files_synced': z.object({
      id: MessageId,
      thread: ThreadKey,
      target: ExternalTarget,
      files: z.array(z.string().min(1).max(300)).max(ATTACHMENTS_PER_MESSAGE_MAX).nullable(),
      /** (server) As on `message.synced`: only the sync that recorded the copy sets its files. */
      syncedBy: ActorId.optional(),
    }),
    /** A delivery that gave up: board message `id` didn't reach `target`, and `error` says why. */
    'message.sync_failed': z.object({
      id: MessageId,
      thread: ThreadKey,
      target: ExternalTarget,
      error: z.string().min(1).max(500),
    }),
    'actor.seen': z.object({
      actor: ActorId,
      kind: SeenActorKind,
      handle: Handle,
      name: z.string().min(1).max(128).refine(storable, 'name has a NUL character or a lone surrogate'),
      avatar: z.string().url().nullable(),
      /**
       * (server) A principal a host's `authenticate` made, or one of its profiles: someone the board
       * signs in, whatever its ID or kind, so sync never writes as it. Others have none.
       */
      host: z.literal(true).optional(),
    }),
}

export const BOARD_SESSION = 'board'

export type BoardEvents = typeof boardEvents
/** One event of the board log, of type `K`, in the shape its log stores it. */
export type BoardEvent<K extends keyof BoardEvents & string = keyof BoardEvents & string> = {
  [T in keyof BoardEvents & string]: {
    id: string
    type: T
    payload: z.output<BoardEvents[T]>
    index: number
    sessionId: string
    createdAt: Date
  }
}[K]
