import { contract, type ContractEvent } from 'experimental-a2'
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
  SCOPE_MAX,
} from './schemas.ts'

/**
 * An external thread or channel, prefixed with its sync key:
 * `slack:C0123ABC` (a channel), `slack:C0123ABC:1727.1234` (a thread),
 * `github:basehub-ai/www:12` (a PR thread).
 */
export const ExternalTarget = z.string().min(3).max(300)

/** Where a message came from on a platform. `thread` is grouped (GitHub review threads fold into their PR). */
export const Origin = z.object({
  channel: ExternalTarget.optional(),
  thread: ExternalTarget,
  /** The exact platform thread, when it differs from `thread`. */
  subthread: ExternalTarget.nullable(),
  message: z.string().min(1).max(300),
  context: z.string().max(300).nullable(),
})

/** What a linked message said, as the board saw it when the link arrived. */
export const LinkSnapshot = z.object({
  author: z.string().min(1).max(256),
  text: z.string().max(MESSAGE_TEXT_MAX),
  /** When it was written, if the platform said. */
  createdAt: z.string().max(64).nullable(),
  /** Its files, linked rather than copied. */
  files: z.array(z.object({ name: z.string().min(1).max(1000), url: z.string().max(4000).nullable() })).max(20),
})

/**
 * A platform message linked from a message (a Slack permalink): the board message
 * it was synced to, if any, and a snapshot of it, or why the board couldn't read it.
 */
export const Link = z.object({
  url: z.string().min(1).max(4000),
  message: MessageId.nullable(),
  snapshot: LinkSnapshot.nullable(),
  /** Why there's no snapshot: `not_in_channel`, `channel_not_found`. */
  unavailable: z.string().max(300).nullable(),
})
export type Link = z.infer<typeof Link>
export const LINKS_PER_MESSAGE_MAX = 10

/** The sync key a write came from, or null when it was written on the board. */
const From = z.string().nullable()

/** The thread key: the event ID of the thread's root. Lanes and sync state are keyed by it. */
const ThreadKey = z.string().min(1).max(200)

/** The board's one log. Every board fact is an event in session `board`. */
export const boardContract = contract({
  name: 'vboard',
  events: {
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
    }),
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
        /** Posted with its author's own platform token, so it shows as them. Older receipts have none. */
        asUser: z.literal(true).optional(),
      }),
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
      name: z.string().min(1).max(128),
      avatar: z.string().url().nullable(),
    }),
    /**
     * A platform actor (`slack:user:U0456`) is the same person as a principal
     * (`vercel:user:…`): for display, `--by`, and mentions, never for permissions.
     * `method` says how it was proved: a one-time code posted from that account,
     * or the account's own sign-in (`consent`).
     */
    'actor.linked': z.object({
      actor: ActorId,
      to: ActorId,
      method: z.enum(['code', 'consent']),
      by: Author,
    }),
    'actor.unlinked': z.object({ actor: ActorId, by: Author }),
  },
})

export const BOARD_SESSION = 'board'

export type BoardEvents = typeof boardContract.events
export type BoardEvent = ContractEvent<BoardEvents>
export type Origin = z.infer<typeof Origin>

const ExternalAuthor = z.object({
  /** The platform principal, e.g. `slack:user:U0456`. */
  id: z.string().min(1),
  handle: z.string().min(1),
  name: z.string().min(1),
  avatar: z.string().nullable(),
  isBot: z.boolean(),
})

/**
 * A file on a platform message, as Chat SDK describes it: enough for the
 * platform's adapter to fetch it later (`rehydrateAttachment`), never the bytes.
 */
export const ExternalFile = z.object({
  type: z.enum(['image', 'file', 'video', 'audio']),
  name: z.string().max(1000).optional(),
  mimeType: z.string().max(255).optional(),
  size: z.number().int().nonnegative().optional(),
  url: z.string().max(4000).optional(),
  fetchMetadata: z.record(z.string(), z.string().max(4000)).optional(),
})
export type ExternalFile = z.infer<typeof ExternalFile>

/**
 * A platform message a platform message links to, at intake: where it lives
 * (`thread`, with the sync key prefix, and `message`), and what it said when the
 * platform sent that along (Slack's unfurl).
 */
export const ExternalLink = z.object({
  url: z.string().min(1).max(4000),
  thread: ExternalTarget,
  message: z.string().min(1).max(300),
  snapshot: LinkSnapshot.nullable(),
})
export type ExternalLink = z.infer<typeof ExternalLink>

export const ExternalLocation = z.object({ channel: ExternalTarget, thread: ExternalTarget, subthread: ExternalTarget.nullable() })

/** A platform event, normalized at intake. Thread IDs are external IDs with the sync key prefix. */
export const ExternalEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    ...ExternalLocation.shape,
    message: z.string(),
    isRoot: z.boolean(),
    text: z.string(),
    context: z.string().nullable(),
    author: ExternalAuthor,
    /** Files on the message, fetched when it lands on the board. Older events have none. */
    files: z.array(ExternalFile).max(20).optional(),
    /** Platform messages it links to. Older events have none. */
    links: z.array(ExternalLink).max(LINKS_PER_MESSAGE_MAX).optional(),
  }),
  z.object({
    kind: z.literal('edited'),
    ...ExternalLocation.shape,
    message: z.string(),
    text: z.string(),
    author: ExternalAuthor,
    links: z.array(ExternalLink).max(LINKS_PER_MESSAGE_MAX).optional(),
    /** Only the links changed (the platform sent what they say), so `text` isn't news. */
    linksOnly: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('deleted'),
    ...ExternalLocation.shape,
    message: z.string(),
  }),
  z.object({
    kind: z.literal('reaction'),
    ...ExternalLocation.shape,
    message: z.string(),
    emoji: z.string(),
    added: z.boolean(),
    author: ExternalAuthor,
  }),
  z.object({
    /** A platform lifecycle event: a PR opening, closing, being reviewed. */
    kind: z.literal('lifecycle'),
    ...ExternalLocation.omit({ subthread: true }).shape,
    type: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    labels: z.record(z.string(), z.string()),
    unset: z.array(z.string()),
    /** Key prefixes the platform owns on the root, e.g. `tag.`: keys under them that aren't in `labels` are unset. */
    owns: z.array(z.string()).optional(),
    /** A reply to add to the thread, e.g. "merged by julian". */
    reply: z.string().nullable(),
    /** Create the root if the board hasn't seen this thread. */
    createRoot: z.boolean(),
    author: ExternalAuthor,
  }),
])

export type ExternalEvent = z.infer<typeof ExternalEvent>
export type ExternalAuthor = z.infer<typeof ExternalAuthor>

/** Raw platform events live outside the board log, one session per external channel. */
export const inboxContract = contract({
  name: 'vboard-inbox',
  events: {
    'external.received': z.object({
      sync: z.string().min(1),
      event: ExternalEvent,
      raw: z.unknown(),
    }),
  },
})

export type InboxEvents = typeof inboxContract.events
export type InboxEvent = ContractEvent<InboxEvents>

/** `inbox:slack:C0123ABC`: the inbox session for one external channel. */
export const inboxSession = (channel: string) => `inbox:${channel}`

/** What watchers matched, outside the board log: one session per watcher, so each fails on its own. */
export const watchContract = contract({
  name: 'vboard-watch',
  events: {
    'watch.matched': z.object({
      thread: ThreadKey,
      /** The board event, as `vb tail --json` prints it. */
      event: z.unknown(),
    }),
    /** The watcher gave up on one match: `run` kept failing, and the thread's later events go on without it. */
    'watch.failed': z.object({
      /** The `watch.matched` event's ID. */
      matched: z.string().min(1).max(200),
      thread: ThreadKey,
      error: z.string().min(1).max(500),
    }),
  },
})

export type WatchEvents = typeof watchContract.events

/** `watch:triage`: the session for one watcher. */
export const watchSession = (id: string) => `watch:${id}`

/** Epoch milliseconds. */
const Millis = z.number().int().nonnegative()

/**
 * Who a schedule posts as: the identity that created it, as the board resolved
 * it then. A token's verified claims (`facts`) and the scope it was narrowed by
 * let each send work out its access again, under the rules as they are then.
 * Schedules from before they were kept have neither.
 */
export const ScheduleIdentity = z.object({
  author: Author,
  principal: z.object({
    id: z.string().min(1),
    kind: z.enum(['person', 'deployment', 'workflow', 'external']),
    handle: Handle,
    facts: z
      .object({
        issuer: z.enum(['vercel', 'github', 'oidc']),
        iss: z.string().max(1000),
        claims: z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean()])),
        /** The board's own Vercel team, as the board knew it when it verified the token. */
        team: z.string().max(200).optional(),
      })
      .optional(),
    scope: z.string().max(SCOPE_MAX).optional(),
  }),
  actor: z.object({ id: ActorId, kind: SeenActorKind, handle: Handle, name: z.string().min(1).max(128), avatar: z.string().nullable() }),
})

/**
 * Scheduled messages, outside the board log: one session, `schedules`. A schedule's ID is
 * its `schedule.created` index. Each send is an A2 timer carrying `schedule.due`; timers
 * can't be revoked, so a canceled or superseded one fires into a no-op.
 */
export const schedulesContract = contract({
  name: 'vboard-schedules',
  events: {
    'schedule.created': z.object({
      /** A new root in `channel`, or a reply in the thread rooted at `re`. */
      channel: ChannelPath,
      re: MessageId.nullable(),
      text: z.union([MessageText, z.literal('')]),
      labels: Labels,
      noSync: z.boolean(),
      attachments: z.array(Attachment).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
      /** The first send. */
      first: Millis,
      /** Repeats this often after the first send, or null for once. */
      every: Millis.nullable(),
      /** Stops repeating after this time, or after this many sends. Null: never. */
      until: Millis.nullable(),
      times: z.number().int().positive().nullable(),
      as: ScheduleIdentity,
      /**
       * (server) Its creator couldn't read its channel. Where a caller can't
       * read, it sees and cancels only these of its own. Schedules from before
       * channel access have none.
       */
      blind: z.literal(true).optional(),
    }),
    'schedule.canceled': z.object({
      id: z.number().int().positive(),
      by: Author,
      /**
       * `canceled`: someone canceled it; `thread_deleted`: the thread it replies in is gone;
       * `dropped`: the board's middleware dropped a send, so it would drop the rest;
       * `revoked`: its creator can no longer post there.
       */
      reason: z.enum(['canceled', 'thread_deleted', 'dropped', 'revoked']),
    }),
    /** (server) A timer: send `n` is due at `at`. */
    'schedule.due': z.object({ id: z.number().int().positive(), n: z.number().int().nonnegative(), at: Millis }),
    /** (server) Send `n` was posted as `message`; the next is due at `next`, or never. */
    'schedule.fired': z.object({
      id: z.number().int().positive(),
      n: z.number().int().nonnegative(),
      message: MessageId,
      next: Millis.nullable(),
    }),
  },
})

export type ScheduleEvents = typeof schedulesContract.events
export type ScheduleEvent = ContractEvent<ScheduleEvents>
export const SCHEDULES_SESSION = 'schedules'

/**
 * One-time codes for linking accounts, outside the board log: a code is a secret
 * until it's used, and only its hash is kept. Session `identity`.
 */
export const identityContract = contract({
  name: 'vboard-identity',
  events: {
    'identity.code_issued': z.object({
      hash: z.string().min(1).max(128),
      /** Who the account it's posted from links to. */
      principal: ActorId,
      /** The sync entry it must be posted through. */
      sync: z.string().min(1).max(64),
      expiresAt: z.string().max(64),
    }),
    /** The first account to post it wins; any later post is just a message. */
    'identity.code_used': z.object({
      hash: z.string().min(1).max(128),
      actor: ActorId,
      /** The message that used it (`externalMessageKey`): only a retry of that one claims it again. */
      message: z.string().max(1024).optional(),
    }),
  },
})

export const IDENTITY_SESSION = 'identity'
