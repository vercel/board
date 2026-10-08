import { z } from 'zod'
import {
  AttachmentId,
  ATTACHMENTS_PER_MESSAGE_MAX,
  ChannelPath,
  Emoji,
  LabelKey,
  Labels,
  MESSAGE_TEXT_MAX,
  MessageId,
  MessageText,
} from '../contract/schemas.ts'
import type { BoardEvent } from '../contract/contract.ts'
import type { Actor, Channel, Message } from '../contract/reducers.ts'

const id = z.coerce.number().int().positive()
const repeated = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))

/**
 * `pr` → `['pr', null]` (has the label), `status=open` → `['status', ['open']]`,
 * `state=open|draft` → either value.
 */
const LabelFilter = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*(=.*)?$/, 'label filters look like key, key=value, or key=a|b')
  .transform((value) => {
    const at = value.indexOf('=')
    return at === -1 ? ([value, null] as const) : ([value.slice(0, at), value.slice(at + 1).split('|')] as const)
  })

/** Shared by `/messages` and `/events`. */
export const Filters = z.object({
  channel: z.string().optional(),
  re: id.optional(),
  by: z.string().optional(),
  mentions: z.string().optional(),
  label: repeated.pipe(z.array(LabelFilter)).optional(),
  /** Where messages came from: a sync key such as `slack`, or `board` for the board itself. */
  from: z.string().min(1).max(64).optional(),
  /** Case-insensitive words the text contains. */
  text: z.string().min(1).max(200).optional(),
})

export const MessagesQuery = Filters.extend({
  after: z.coerce.number().int().nonnegative().optional(),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const EventsQuery = Filters.extend({
  after: z.coerce.number().int().nonnegative().optional(),
  wait: z.coerce.number().min(0).max(300).optional(),
  all: z.coerce.boolean().optional(),
})

export const PostBody = z
  .object({
    channel: ChannelPath.optional(),
    re: MessageId.optional(),
    /** May be empty when the message has attachments. */
    text: z.string().max(MESSAGE_TEXT_MAX).default(''),
    labels: Labels.optional(),
    noSync: z.boolean().optional(),
    /** External targets a new thread starts with: `slack:#incidents`, `github:owner/repo:12`. */
    sync: z.array(z.string().min(3).max(300)).max(10).optional(),
    id: z.string().min(1).max(200).optional(),
    /** IDs from `POST /attachments`. */
    attachments: z.array(AttachmentId).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'message text is empty',
    path: ['text'],
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a post needs `channel`; a reply needs `re`',
  })
  .refine((body) => !(body.noSync && body.sync?.length), {
    message: '`noSync` and `sync` contradict each other',
  })

/** `30m`, `1d`: a number and a unit, `s`, `m`, `h`, or `d`. */
const Duration = z.string().regex(/^\d+(\.\d+)?(s|m|h|d)$/, 'durations look like 30s, 30m, 12h, or 1d')
const Instant = z.string().datetime({ offset: true })

/**
 * A message to post later, as the caller: once (`in` or `at`), or repeating
 * (`every`, starting `at` or `in` from now, or one `every` from now), until
 * `until`, `for` after the first send, or `times` sends. A repeat with no stop
 * runs until it's canceled.
 */
export const ScheduleBody = z
  .object({
    channel: ChannelPath.optional(),
    re: MessageId.optional(),
    text: z.string().max(MESSAGE_TEXT_MAX).default(''),
    labels: Labels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
    in: Duration.optional(),
    at: Instant.optional(),
    every: Duration.optional(),
    until: Instant.optional(),
    for: Duration.optional(),
    times: z.number().int().positive().optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'message text is empty',
    path: ['text'],
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a schedule needs `channel` for a new thread, or `re` for a reply',
  })
  .refine((body) => body.in !== undefined || body.at !== undefined || body.every !== undefined, {
    message: 'say when: `in`, `at`, or `every`',
  })
  .refine((body) => !(body.in !== undefined && body.at !== undefined), { message: '`in` and `at` contradict each other' })
  .refine((body) => [body.until, body.for, body.times].filter((v) => v !== undefined).length <= 1, {
    message: 'pick one stop: `until`, `for`, or `times`',
  })
  .refine((body) => body.every !== undefined || (body.until === undefined && body.for === undefined && body.times === undefined), {
    message: '`until`, `for`, and `times` stop a repeat: add `every`',
  })

export const SchedulesQuery = z.object({
  /** Any message in a thread: the schedules that reply in it. */
  re: id.optional(),
  channel: z.string().optional(),
  /** An actor ID or handle: the schedules it created. */
  by: z.string().optional(),
  /** Include done and canceled schedules. */
  all: z.coerce.boolean().optional(),
})

export const SyncBody = z.object({ target: z.string().min(3).max(300) })
export const InboxQuery = z.object({
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
/** A stuck event to retry (with a fresh 10 tries) or skip (so its thread goes on), as `vb stuck` lists it. */
export const RedriveBody = z.object({
  session: z.string().min(1).max(300),
  index: z.number().int().min(1),
  action: z.enum(['retry', 'skip']),
})

/**
 * What to read from a platform without syncing it: a channel (`#name` or an ID),
 * a thread (`C0123:1727000000.123456`), or a message permalink (its thread).
 */
export const SourceReadQuery = z.object({
  target: z.string().min(1).max(4000),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const EditBody = z.object({ text: MessageText })
export const DeleteBody = z.object({}).optional()
/** `status`: what Slack shows in place of "Typing…" (WhatsApp and GitHub ignore it). */
export const TypingBody = z.object({ status: z.string().trim().min(1).max(100).optional() }).optional()
export const ReactBody = z.object({ emoji: Emoji, remove: z.boolean().optional() })
export const LabelBody = z
  .object({ set: Labels.optional(), unset: z.array(LabelKey).optional() })
  .refine((body) => body.set !== undefined || body.unset !== undefined, {
    message: 'nothing to change: pass `set` or `unset`',
  })

export type FiltersInput = z.input<typeof Filters>
export type MessagesQueryInput = z.input<typeof MessagesQuery>
export type EventsQueryInput = z.input<typeof EventsQuery>
export type PostInput = z.input<typeof PostBody>
export type ScheduleInput = z.input<typeof ScheduleBody>
export type ScheduleBodyOutput = z.output<typeof ScheduleBody>
export type SchedulesQueryInput = z.input<typeof SchedulesQuery>
export type SchedulesQueryOutput = z.output<typeof SchedulesQuery>

/** A scheduled message. It posts as `by`, its creator; each message it posts carries `schedule: { id, n }`. */
export type ScheduleView = {
  id: number
  channel: string
  /** The thread it replies in, or null when each send starts a new thread in `channel`. */
  re: number | null
  text: string
  labels: Record<string, string>
  noSync: boolean
  attachments: { id: string; name: string; type: string; size: number }[]
  first: string
  /** Milliseconds between sends, or null for once. */
  every: number | null
  until: string | null
  times: number | null
  /** Sends posted so far. */
  sent: number
  /** When the next send is due; null once it's done or canceled. */
  next: string | null
  /** The last message it posted. */
  last: number | null
  state: 'pending' | 'done' | 'canceled'
  canceled: { by: { actor: string; principal: string; profile: string | null; session: string | null }; reason: 'canceled' | 'thread_deleted' } | null
  by: { actor: string; principal: string; profile: string | null; session: string | null }
  author: ActorView
  createdAt: string
}

/** `kind` says who wrote it: a `person` or a platform user (`external`), an agent (`profile`), or a deployment or workflow. */
export type ActorView = Pick<Actor, 'kind' | 'handle' | 'name' | 'avatar'>
export type MessageView = Message & { author: ActorView | null }

/** A board event as subscribers get it. Checking `type` narrows `payload` to that event's. */
export type BoardEventView = BoardEvent extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? {
        index: number
        type: T
        createdAt: string
        payload: P
        /** The message the event concerns, as it is after the event. */
        message?: MessageView
        /** Who did it, for events with an author: a reaction's reactor, a label's setter. */
        actor?: ActorView & { id: string }
      }
    : never
  : never

export type Discovery = {
  version: string
  url: string
  audience: string
  team_id: string | null
  project_id: string | null
  /** The board's sync entries: `key` names its webhook and inbox, `platform` is e.g. `slack`. */
  sync: { key: string; platform: string }[]
}

export type Me = {
  actor: string
  principal: string
  kind: Actor['kind']
  handle: string
  name: string
  avatar: string | null
  profile: string | null
  session: string | null
  expiresAt: string | null
}

export type ChannelView = Channel
export type MessagesPage = { messages: MessageView[]; cursor: number }
export type ThreadView = {
  message: MessageView
  replies: MessageView[]
  cursor: number
  /** The pending schedules that reply in this thread. Boards older than schedules leave it out. */
  schedules?: ScheduleView[]
}
export type EventsPage = { events: BoardEventView[]; cursor: number }

/** The platform threads that now show typing: those the thread is synced to, minus any that failed. */
export type TypingResult = { targets: string[] }

/** A platform message read on demand: nothing about it is stored on the board. */
export type SourceMessage = {
  /** The platform's message ID (Slack's `ts`). */
  id: string
  /** The thread it's in, as a target `vb sources <key> read` reads: `C0123:1727000000.123456`. */
  thread: string
  author: string
  text: string
  createdAt: string | null
  /** Replies under it, when it starts a thread. */
  replies: number
  files: { name: string; url: string | null }[]
}

/** A channel or thread read from a platform, oldest message first. */
export type SourceRead = {
  /** The channel's ID, and its name when the platform gave one. */
  channel: string
  name: string | null
  /** Set when a thread was read. */
  thread: string | null
  messages: SourceMessage[]
  /** The platform has more than `limit`: older messages in a channel, later replies in a thread. */
  more: boolean
}

export type ApiError = { error: { code: string; message: string } }

/** A raw platform event, as `GET /inbox/:key` returns it. */
export type InboxEntry = {
  id: string
  channel: string
  createdAt: string
  sync: string
  event: { kind: string; thread: string; [field: string]: unknown }
  raw: unknown
}

/**
 * An event that failed 10 times and stopped: A2 dead-lettered it, and nothing after it on its lane
 * (its thread's) runs until it's retried or skipped. As `GET /stuck` returns it.
 */
export type StuckEvent = {
  /** The A2 session it's in: `board`, `inbox:<channel>`, `watch:<watcher>`, or `schedules`. */
  session: string
  index: number
  type: string
  lane: string | null
  /** The board thread it holds up, when there is one, and its root. */
  thread: string | null
  root: number | null
  /** The platform thread, for an inbox event that never reached the board. */
  external: string | null
  attempts: number
  failures: number
  error: string | null
  failedAt: string
}

/** The route table: method, path, and the schemas that validate input. */
export const routes = {
  discovery: { method: 'GET', path: '/' },
  me: { method: 'GET', path: '/me' },
  channels: { method: 'GET', path: '/channels' },
  actors: { method: 'GET', path: '/actors' },
  messages: { method: 'GET', path: '/messages', query: MessagesQuery },
  message: { method: 'GET', path: '/messages/:id' },
  post: { method: 'POST', path: '/messages', body: PostBody },
  edit: { method: 'POST', path: '/messages/:id/edit', body: EditBody },
  delete: { method: 'POST', path: '/messages/:id/delete', body: DeleteBody },
  react: { method: 'POST', path: '/messages/:id/reactions', body: ReactBody },
  label: { method: 'POST', path: '/messages/:id/labels', body: LabelBody },
  sync: { method: 'POST', path: '/messages/:id/sync', body: SyncBody },
  /** Ephemeral: shows typing in the thread's synced platform threads, and writes nothing to the log. */
  typing: { method: 'POST', path: '/messages/:id/typing', body: TypingBody },
  /** Posts a message later, as the caller: needs a scheduler. */
  schedule: { method: 'POST', path: '/schedules', body: ScheduleBody },
  schedules: { method: 'GET', path: '/schedules', query: SchedulesQuery },
  /** Anyone may cancel a schedule. Canceling one that's done is a no-op. */
  cancelSchedule: { method: 'POST', path: '/schedules/:id/cancel' },
  inbox: { method: 'GET', path: '/inbox/:key', query: InboxQuery },
  /** Events that stopped their thread: full access only. */
  stuck: { method: 'GET', path: '/stuck' },
  /** Retries or skips one of them: full access only. */
  redrive: { method: 'POST', path: '/stuck/redrive', body: RedriveBody },
  /** Reads a platform channel or thread on demand, without syncing or storing it. Full access only. */
  sourceRead: { method: 'GET', path: '/sources/:key/read', query: SourceReadQuery },
  webhook: { method: 'POST', path: '/webhooks/:key' },
  events: { method: 'GET', path: '/events', query: EventsQuery },
  avatar: { method: 'GET', path: '/avatars/:name' },
  /** The file is the body; `content-type` is its type and `x-board-filename` its name, URI-encoded. */
  upload: { method: 'POST', path: '/attachments' },
  attachment: { method: 'GET', path: '/attachments/:id' },
  openapi: { method: 'GET', path: '/openapi.json' },
} as const

export type RouteName = keyof typeof routes
