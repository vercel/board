import { z } from 'zod'
import {
  ActorId,
  AttachmentId,
  ATTACHMENTS_PER_MESSAGE_MAX,
  ChannelPath,
  DIRECT_UPLOAD_BYTES_MAX,
  Emoji,
  LabelKey,
  Labels,
  MESSAGE_TEXT_MAX,
  MessageText,
  platformAvatar,
  storable,
} from '../contract/schemas.ts'
import { ExternalAuthor, ExternalEvent, ExternalTarget, Link as LinkSchema, LINKS_PER_MESSAGE_MAX, Origin } from '../contract/external.ts'
import type { BoardEvent } from '../contract/events.ts'
import type { Link } from '../contract/external.ts'
import type { Actor, Channel, ExternalCopy, Message } from '../contract/folds.ts'
import type { AccessSummary } from '../server/access.ts'

/**
 * A message's, schedule's, or cursor's ID: a string clients pass back as they got it, and never
 * parse, compare, or count with. Each backend picks its own; a board on `a2()` writes decimals.
 */
export const Ref = z.string().min(1).max(128)
const id = Ref
/** A boolean query parameter: `true` or `1`, `false` or `0`. */
const flag = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1')
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

/** A sync target as the board that syncs it resolved it: a platform channel to start a thread in, or a thread to join. */
export const ResolvedSyncTarget = z.object({ target: ExternalTarget, kind: z.enum(['channel', 'thread']) })

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
/** The filters a query asks for, as the board parsed them. */
export type ParsedFilters = z.output<typeof Filters>

export const MessagesQuery = Filters.extend({
  after: Ref.optional(),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

/** `limit` counts threads: each thread with a matching message, by its latest reply. */
export const ThreadsQuery = Filters.extend({
  after: Ref.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const EventsQuery = Filters.extend({
  after: Ref.optional(),
  wait: z.coerce.number().min(0).max(300).optional(),
  all: flag.optional(),
})

export const PostBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    /** May be empty when the message has attachments. */
    text: z.string().max(MESSAGE_TEXT_MAX).default(''),
    labels: Labels.optional(),
    noSync: z.boolean().optional(),
    /**
     * External targets a new thread starts with: `slack:#incidents`, `github:owner/repo:12`. The
     * board that syncs a target resolves it to `{ target, kind }`, which a board elsewhere takes as is.
     */
    sync: z.array(z.union([z.string().min(3).max(300), ResolvedSyncTarget])).max(10).optional(),
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
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
    re: Ref.optional(),
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
  all: flag.optional(),
})

export const SyncBody = z.object({ target: z.string().min(3).max(300) })
export const InboxQuery = z.object({
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
/** How many watchers one registration holds: the board matches every event against every tail. */
export const REGISTERED_WATCHERS_MAX = 32

/** What every registration carries: its watchers' tails, and its sync entries. */
const Registering = z.object({
  // The IDs are checked one by one, so a bad one fails with what a misconfigured boot would.
  watch: z
    .record(z.string().max(100), z.object({ tail: z.string().max(1000), when: z.enum(['matches', 'enters']).default('matches') }))
    .refine((watch) => Object.keys(watch).length <= REGISTERED_WATCHERS_MAX, `a board registers at most ${REGISTERED_WATCHERS_MAX} watchers`),
  /**
   * Its sync entries: its sync subscribes too, to every post, change, and thread sync in the channels
   * where it may sync, and the board lists the entries and links accounts on them.
   */
  sync: z.array(z.object({ key: z.string().min(1).max(64), platform: z.string().min(1).max(64), signIn: z.boolean().default(false) })).max(32).optional(),
})

/**
 * What a board on `http()` registers with the board it uses: its watchers, and where to wake it,
 * at a URL or at a path on its own project, never both.
 */
export const RegisterBody = z.union([
  Registering.extend({
    /** Without one, the board pulls on its own instead of being woken. */
    url: z
      .string()
      .url()
      .max(500)
      .refine((url) => /^https:\/\//.test(url), 'wake-ups go over https')
      .transform((url) => url.replace(/\/+$/, ''))
      .nullable()
      .optional(),
    path: z.null({ error: 'register a url or a path, not both' }).optional(),
    branch: z.null({ error: 'a branch goes with a path' }).optional(),
  }),
  Registering.extend({
    url: z.null({ error: 'register a url or a path, not both' }).optional(),
    /**
     * Where to wake the caller on its own Vercel project, on a board whose discovery says
     * `wake_by_path`. The board takes the project and environment from the caller's token and
     * finds the deployment, so a project can only register itself, and anyone else gets 403
     * `not_a_project`.
     */
    path: z
      .string()
      .max(300)
      .regex(/^\/[^?#]*$/, 'a path starts with / and has no query or fragment')
      .transform((path) => path.replace(/(.)\/+$/, '$1')),
    /**
     * From a preview: the branch whose latest ready preview is woken, since a token says which
     * project and environment called but not which deployment. Production names none.
     */
    branch: z.string().min(1).max(255).nullable().optional(),
  }),
])
/** A registration as a board on `http()` sends it: `{ url?, watch, sync? }` or `{ path, branch?, watch, sync? }`. */
export type RegisterInput = z.input<typeof RegisterBody>

/** A pull of the caller's matches: at most `limit`, waiting up to `wait` seconds for one. */
export const MatchesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  wait: z.coerce.number().min(0).max(25).optional(),
})

/** How a pulled match went: its lease, and an error to try again, or `skip` to drop it. */
export const AckBody = z.object({
  lease: z.string().min(1).max(64),
  error: z.string().min(1).max(500).optional(),
  skip: z.boolean().optional(),
})

/**
 * What to read from a platform without syncing it: a channel (`#name` or an ID),
 * a thread (`C0123:1727000000.123456`), or a message permalink (its thread).
 */
export const SourceReadQuery = z.object({
  target: z.string().min(1).max(4000),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** A channel to add the board's app to, so it can be read on demand: `#name`, an ID, or a link into it. */
export const SourceJoinBody = z.object({ target: z.string().min(1).max(4000) })

/** A platform's link to a message or thread, such as a Slack permalink or a GitHub comment's URL. */
export const LinkedQuery = z.object({ url: z.string().url().max(4000) })

export const IdentityUnlinkBody = z.object({ actor: z.string().min(1).max(256) })

/** A sync entry's key: `slack`, `github`. */
const SyncKey = z.string().min(1).max(64)

/** A platform message an import changes, by its platform thread and ID; without a message, the root of the board thread the platform thread belongs to. */
const ImportOrigin = z.object({ thread: ExternalTarget, message: z.string().min(1).max(300).optional() })

/** A link as an import carries it: a board message it names is a ref. */
const ImportLink = LinkSchema.extend({ message: Ref.nullable() })

/**
 * A platform user, as sync names them to the board. Their avatar shows wherever they do, so one
 * that isn't an https URL is dropped, never refused: the write lands without it.
 */
const PlatformUser = ExternalAuthor.extend({ avatar: z.string().nullable().transform(platformAvatar) })

/**
 * Who wrote it on the platform, and the sync key it came through: null for a write a sync callback
 * makes as that user, which syncs out to every platform like one written on the board.
 */
const Imported = { author: PlatformUser, from: SyncKey.nullable() }

/**
 * Where the platform event an import comes from is: its sync entry, platform channel, and thread.
 * The middleware is told, and answers there when it drops the write.
 */
const ImportSource = z.object({ key: SyncKey, channel: ExternalTarget, thread: ExternalTarget })

/** The message a change is about: by its platform IDs (`origin`), or by its board ID (`message`), one or the other. */
const Changed = { origin: ImportOrigin.optional(), message: Ref.optional() }

/**
 * A platform's write, as its platform author, with where it came from: only a caller with `sync` in
 * the channel it lands in may make one. Posts are idempotent by `id`, derived from the platform
 * event; every other op finds the message it changes from its `origin`.
 */
export const SyncImportBody = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('post'),
    ...Imported,
    /** Where it is on the platform. Null for a write a sync callback makes itself. */
    origin: Origin.nullable().default(null),
    source: ImportSource.optional(),
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().max(MESSAGE_TEXT_MAX).default(''),
    labels: Labels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
    links: z.array(ImportLink).max(LINKS_PER_MESSAGE_MAX).optional(),
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
  }),
  z.object({ op: z.literal('edit'), ...Imported, ...Changed, text: MessageText, source: ImportSource.optional() }),
  z.object({ op: z.literal('delete'), ...Imported, ...Changed }),
  z.object({ op: z.literal('react'), ...Imported, ...Changed, emoji: Emoji, remove: z.boolean().optional() }),
  z.object({ op: z.literal('labels'), ...Imported, ...Changed, set: Labels.optional(), unset: z.array(LabelKey).optional() }),
  z.object({ op: z.literal('links'), ...Imported, ...Changed, links: z.array(ImportLink).max(LINKS_PER_MESSAGE_MAX) }),
  /** A platform user the board should know, for a mention of them: `@[ada@vercel.com]` found on Slack. */
  z.object({ op: z.literal('seen'), author: PlatformUser }),
])

const PlatformFiles = z.array(z.string().min(1).max(300)).max(ATTACHMENTS_PER_MESSAGE_MAX).nullable()

/** What sync did on a platform, about a board message: it landed, its files did, it gave up, or its thread syncs with a target. */
export const SyncReceiptBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    message: Ref,
    target: ExternalTarget,
    external: z.object({ thread: ExternalTarget, message: z.string().min(1).max(300), asUser: z.literal(true).optional() }),
    /** Its files, when they went with it: the platform's IDs, or null when it refused them. */
    files: PlatformFiles.optional(),
  }),
  z.object({ kind: z.literal('files'), message: Ref, target: ExternalTarget, files: PlatformFiles }),
  z.object({ kind: z.literal('failed'), message: Ref, target: ExternalTarget, error: z.string().min(1).max(500) }),
  z.object({
    kind: z.literal('thread'),
    /** Any message in the thread. */
    message: Ref,
    target: ExternalTarget,
    /** A channel to start a thread in, or a thread to join. */
    targetKind: z.enum(['channel', 'thread']),
    cause: z.enum(['config', 'request']),
  }),
])

/** What sync looks up by platform ID: a thread or message, who an account is, and a person's accounts. */
export const SyncFindQuery = z.object({
  /** A live one-time code: who it was issued to, for a sign-in that carries it. */
  code: z.string().min(1).max(64).optional(),
  /** The post the caller's sync imported with this client ID. */
  post: z.string().min(1).max(200).optional(),
  thread: ExternalTarget.optional(),
  /** With `thread`: the platform message in it. */
  message: z.string().min(1).max(300).optional(),
  account: ActorId.optional(),
  person: ActorId.optional(),
})
export const SyncCopiesQuery = z.object({ message: repeated.pipe(z.array(Ref).min(1).max(100)) })
/** A person's own roots since `since`, in epoch milliseconds. */
export const SyncRootsQuery = z.object({ by: ActorId, since: z.coerce.number().int().nonnegative() })

/** Platform events for a sync key's inbox, each with the platform's own ID for it, which dedupes it. */
export const InboxPushBody = z.object({
  events: z.array(z.object({ id: z.string().min(1).max(300), event: ExternalEvent, raw: z.unknown() })).min(1).max(50),
})
export const InboxNextQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() })
export const InboxAckBody = z.object({ lease: z.string().min(1).max(64), error: z.string().min(1).max(500).optional() })

/** A one-time code for linking an account on sync entry `sync`: a person's own, for themselves. */
export const SyncCodeBody = z.object({ sync: SyncKey })
/**
 * A platform account, linked to whoever a code was issued to: one posted from the account, or
 * carried through its sign-in. `message` is the platform message that posted it.
 */
export const SyncAccountBody = z.object({
  sync: SyncKey,
  account: PlatformUser,
  code: z.string().min(1).max(64),
  message: z.string().max(1024).optional(),
  /** `consent` when the code came through the account's own sign-in, so the board posts as them. */
  method: z.enum(['code', 'consent']).optional(),
})
/** A sign-in that carries a code, on the board whose sync runs the entry. */
export const SignInQuery = z.object({ sync: SyncKey, code: z.string().min(1).max(64) })
export const SyncUnlinkBody = z.object({ account: ActorId })

/** A direct upload, before its bytes: what the file will be called, its type, and its exact size. */
export const UploadStartBody = z.object({
  name: z.string().max(1024).nullable().optional(),
  type: z.string().max(1024).nullable().optional(),
  size: z.number().int().positive().max(DIRECT_UPLOAD_BYTES_MAX, `direct uploads are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`),
})

/** Where to send a direct upload's bytes: `PUT` the file to `url` with `headers` (its `content-type` included), before `expiresAt`, then finish it. */
export type UploadTicket = { id: string; url: string; headers: Record<string, string>; expiresAt: string }

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
export type SyncImportInput = z.input<typeof SyncImportBody>
export type SyncReceiptInput = z.input<typeof SyncReceiptBody>
export type SyncFindInput = z.input<typeof SyncFindQuery>
export type SyncAccountInput = z.input<typeof SyncAccountBody>
export type MessagesQueryInput = z.input<typeof MessagesQuery>
export type ThreadsQueryInput = z.input<typeof ThreadsQuery>
export type EventsQueryInput = z.input<typeof EventsQuery>
export type PostInput = z.input<typeof PostBody>
export type ScheduleInput = z.input<typeof ScheduleBody>
export type ScheduleBodyOutput = z.output<typeof ScheduleBody>
export type SchedulesQueryInput = z.input<typeof SchedulesQuery>
export type SchedulesQueryOutput = z.output<typeof SchedulesQuery>

/** A scheduled message. It posts as `by`, its creator; each message it posts carries `schedule: { id, n }`. */
export type ScheduleView = {
  id: string
  channel: string
  /** The thread it replies in, or null when each send starts a new thread in `channel`. */
  re: string | null
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
  last: string | null
  state: 'pending' | 'done' | 'canceled'
  canceled: { by: { actor: string; principal: string; profile: string | null; session: string | null }; reason: 'canceled' | 'thread_deleted' | 'dropped' | 'revoked' } | null
  by: { actor: string; principal: string; profile: string | null; session: string | null }
  author: ActorView
  createdAt: string
}

/** The person a platform account is linked to (`actor.linked`). */
export type PersonView = { id: string; handle: string; name: string; avatar: string | null }

/**
 * `kind` says who wrote it: a `person` or a platform user (`external`), an agent (`profile`), or a deployment or workflow.
 * `person` is who a linked platform account belongs to.
 */
export type ActorView = Pick<Actor, 'kind' | 'handle' | 'name' | 'avatar'> & { person?: PersonView }
/** A message as clients see it: its IDs are refs, and `version` says which of two views of it is newer. */
export type MessageView = Omit<Message, 'id' | 're' | 'replyTo' | 'links' | 'schedule' | 'version'> & {
  id: string
  /** The thread's root, or null for a root. */
  re: string | null
  /** The exact message replied to, when it isn't the root. */
  replyTo: string | null
  /** Grows with each change to this message: of two views of it, the one with the higher version is newer. */
  version: number
  links: LinkView[]
  /** Set when a schedule posted it: the schedule's ID and which send this was, from 0. */
  schedule?: { id: string; n: number }
  author: ActorView | null
}

/** A link in a message: a board message it names is a ref. */
export type LinkView = Omit<Link, 'message'> & { message: string | null }

/** An event's payload as clients see it: message IDs are refs. */
type PayloadView<P> = {
  [K in keyof P]: K extends 'id' | 're' | 'replyTo'
    ? P[K] extends number ? string : P[K] extends number | null ? string | null : P[K]
    : K extends 'links'
      ? LinkView[]
      : K extends 'schedule'
        ? P[K] extends undefined ? undefined : { id: string; n: number } | Exclude<P[K], object>
        : P[K]
}

/** A board event as subscribers get it. Checking `type` narrows `payload` to that event's. */
export type BoardEventView = BoardEvent extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? {
        /** Where this event is in the board's order: pass it as `after` to read on from here. */
        cursor: string
        type: T
        createdAt: string
        payload: PayloadView<P>
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
  /**
   * Whether `POST /watchers` takes a `path`: the board wakes the caller's own Vercel project there,
   * through its Deployment Protection. A board that can't find a project's deployments leaves it out.
   */
  wake_by_path?: boolean
}

/**
 * Watchers a board on `http()` registered here: one registration per principal, woken at a URL
 * or at a path on its own project, never both.
 */
export type RegistrationView = {
  /** The principal that registered. Its watchers write as it, with their IDs as profiles. */
  owner: string
  watch: Record<string, { tail: string; when: 'matches' | 'enters' }>
  /** Its sync entries. With any, its sync gets every event it delivers to platforms, as matches of watcher `@sync`. */
  sync: { key: string; platform: string; signIn: boolean }[]
  /** Every wake-up carries it, so the board can tell its registration is stale. */
  hash: string
} & (
  | {
      /** Where it's woken: `<url>/wake`. `null` when it pulls on its own. */
      url: string | null
      path?: undefined
      branch?: undefined
    }
  | {
      url: null
      /** Where it's woken on its own Vercel project, on a board with `wake_by_path`. */
      path: string
      /** The branch whose latest ready preview a preview's `path` wakes. */
      branch?: string
    }
)

/** One match, leased to the registrant that pulled it. */
export type MatchView = {
  /** The match's ID, which its watcher's writes derive their IDs from. */
  id: string
  watcher: string
  thread: string
  /** Acks name it. A lease that ran out is someone else's next try. */
  lease: string
  /** How many tries came before this one. */
  attempt: number
  /** The event, as `vb tail --json` prints it, as the registrant may see it. */
  event: BoardEventView
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
  /** What you may do in each channel pattern, implications included: `{ '*': [...every permission] }` is full access. */
  can: AccessSummary
}

/** A platform account linked to you, as `GET /identity` lists it. */
export type LinkedAccount = { actor: string; handle: string | null; name: string | null; method: 'code' | 'consent'; at: string }
export type IdentityView = {
  principal: string
  links: LinkedAccount[]
  /** The sync entries you haven't linked an account on. Boards older than it leave it out. */
  unlinked?: string[]
  cursor: string
}
/**
 * How to prove an account is yours: post `code` from it anywhere the board syncs before
 * `expiresAt`, or, when the entry signs people in, open `signIn` and approve: it carries the code.
 */
export type SyncCodeView = { code: string; expiresAt: string; signIn?: string }

/** A thread's sync: its root, where it lives, its targets, and the platform thread it is on each. */
export type SyncThreadView = { thread: string; root: string; channel: string; targets: string[]; external: Record<string, string> }
/** What a platform ID is on the board. Each answers only when it was asked. */
export type SyncFindView = {
  /** The board thread a platform thread belongs to. */
  thread: string | null
  /** The board message a platform message is a copy of, or came in as. */
  message: string | null
  /** Who a platform account is linked to, and how. */
  person: { id: string; method: 'code' | 'consent' } | null
  /** The platform accounts linked to a person, and how. */
  accounts: { id: string; method: 'code' | 'consent' }[]
  /** Who a live code was issued to. */
  holder: string | null
}
/** A message's copies, by target: where it went, or came from, on each platform. */
export type SyncCopiesView = { copies: Record<string, Record<string, ExternalCopy>> }
/** A platform event pulled from the caller's inbox, leased to it until it acks. */
export type InboxItem = {
  id: string
  key: string
  /** The platform thread: its events come one at a time, in order. */
  thread: string
  lease: string
  /** How many tries came before this one. */
  attempt: number
  event: z.infer<typeof ExternalEvent>
  raw: unknown
}

export type ChannelView = Channel
export type MessagesPage = { messages: MessageView[]; cursor: string }
/**
 * Where a message's thread is synced: each target, the platform thread it is there, and this
 * message's copy, with the platform's link to it when the sync that knows the platform runs here.
 */
export type SyncedView = {
  targets: {
    /** As the thread's sync records it: `slack:C0123ABC`, `github:acme/www:12`. */
    target: string
    /** The sync entry it belongs to: `slack`. */
    key: string
    /** The platform thread this message's copy is in, or the one the target is, once it has one. */
    thread: string | null
    /** This message's copy there, by the platform's ID: null when it has none. */
    message: string | null
    url: string | null
    /** Why the message didn't reach it, when it didn't. */
    undelivered: string | null
  }[]
}

export type ThreadView = {
  message: MessageView
  replies: MessageView[]
  cursor: string
  /** The pending schedules that reply in this thread. Boards older than schedules leave it out. */
  schedules?: ScheduleView[]
}
/** A thread at a glance: its root, how many replies it has, and the latest one (null when none). Deleted replies don't count. */
export type ThreadSummaryView = { message: MessageView; replies: number; last: MessageView | null }
export type ThreadsPage = { threads: ThreadSummaryView[]; cursor: string }
export type EventsPage = { events: BoardEventView[]; cursor: string }

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

/** A channel the board's app joined, or was already in (`joined: false`). */
export type SourceJoin = {
  channel: string
  name: string | null
  joined: boolean
}

/** A failure: `code` to branch on, `message` to read, and `hint`, when the board knows one, for what fixes it. */
export type ApiError = { error: { code: string; message: string; hint?: string } }

/** A raw platform event, as `GET /inbox/:key` returns it. */
export type InboxEntry = {
  id: string
  channel: string
  createdAt: string
  sync: string
  event: { kind: string; thread: string; [field: string]: unknown }
  raw: unknown
}

/** The route table: method, path, and the schemas that validate input. */
export const routes = {
  /** Where the board is, its project, and the sync entries it links accounts on. No token. */
  discovery: { method: 'GET', path: '/' },
  me: { method: 'GET', path: '/me' },
  channels: { method: 'GET', path: '/channels' },
  actors: { method: 'GET', path: '/actors' },
  messages: { method: 'GET', path: '/messages', query: MessagesQuery },
  message: { method: 'GET', path: '/messages/:id' },
  /** Threads with a matching message, one summary each, by latest activity. */
  threads: { method: 'GET', path: '/threads', query: ThreadsQuery },
  post: { method: 'POST', path: '/messages', body: PostBody },
  edit: { method: 'POST', path: '/messages/:id/edit', body: EditBody },
  delete: { method: 'POST', path: '/messages/:id/delete', body: DeleteBody },
  react: { method: 'POST', path: '/messages/:id/reactions', body: ReactBody },
  label: { method: 'POST', path: '/messages/:id/labels', body: LabelBody },
  /** Attaches the thread to a sync target, recording a `thread` receipt: needs `sync` where the thread is. */
  sync: { method: 'POST', path: '/messages/:id/sync', body: SyncBody },
  /** Where the message's thread is synced, and its copy on each target: needs `read` where it is. */
  synced: { method: 'GET', path: '/messages/:id/sync' },
  /** The board message a platform link names, from what the board synced: 404 `message_not_found` for one it didn't, or that the caller can't read. */
  linked: { method: 'GET', path: '/links', query: LinkedQuery },
  /** Ephemeral: shows typing in the thread's synced platform threads, and writes nothing to the log. Needs `post` where the thread is. */
  typing: { method: 'POST', path: '/messages/:id/typing', body: TypingBody },
  /** Posts a message later, as the caller: needs a scheduler. */
  schedule: { method: 'POST', path: '/schedules', body: ScheduleBody },
  schedules: { method: 'GET', path: '/schedules', query: SchedulesQuery },
  /** Its creator, or manage in its channel, may cancel a schedule. Canceling one that's done is a no-op. */
  cancelSchedule: { method: 'POST', path: '/schedules/:id/cancel' },
  /** The caller's own post with the client ID it gave: what `POST /messages` answered, for telling a retry before posting. */
  posted: { method: 'GET', path: '/posts/:id' },
  /** Raw platform events in a sync key's inbox, newest first: the caller's own, and the board's with `sync` everywhere. */
  inbox: { method: 'GET', path: '/inbox/:key', query: InboxQuery },
  /** Pushes platform events into the caller's inbox for a sync key, deduplicated by their platform IDs. */
  inboxPush: { method: 'POST', path: '/inbox/:key', body: InboxPushBody },
  /** The caller's next inbox events, leased to it, one platform thread at a time and in order. */
  inboxNext: { method: 'GET', path: '/inbox/:key/next', query: InboxNextQuery },
  /** How one went: done, or an error to try it again. */
  inboxAck: { method: 'POST', path: '/inbox/:key/:id/ack', body: InboxAckBody },
  /** A platform's write, as its platform author: `sync` where it lands. */
  syncImport: { method: 'POST', path: '/sync/imports', body: SyncImportBody },
  /** What sync did on a platform: a delivery, its files, a failure, or a thread's new target. */
  syncReceipt: { method: 'POST', path: '/sync/receipts', body: SyncReceiptBody },
  /** A board thread's sync, by its key. */
  syncThread: { method: 'GET', path: '/sync/threads/:thread' },
  /** What platform IDs are on the board. */
  syncFind: { method: 'GET', path: '/sync/find', query: SyncFindQuery },
  /** Messages' copies on platforms. */
  syncCopies: { method: 'GET', path: '/sync/copies', query: SyncCopiesQuery },
  /** A person's recent roots, for telling their own platform copies from new messages. */
  syncRoots: { method: 'GET', path: '/sync/roots', query: SyncRootsQuery },
  /** A one-time code for linking a platform account. */
  syncCode: { method: 'POST', path: '/sync/codes', body: SyncCodeBody },
  /** Links a platform account, by a code or for a person. */
  syncAccount: { method: 'POST', path: '/sync/accounts', body: SyncAccountBody },
  /** Unlinks a platform account. */
  syncUnlink: { method: 'POST', path: '/sync/accounts/unlink', body: SyncUnlinkBody },
  /** Reads a platform channel or thread on demand, where that sync runs, without syncing or storing it. Full access only. */
  readSource: { method: 'GET', path: '/sources/:key/read', query: SourceReadQuery },
  /** Adds the app to a public channel so it can be read, where that sync runs and opted in with `join`. Full access only. */
  joinSource: { method: 'POST', path: '/sources/:key/join', body: SourceJoinBody },
  webhook: { method: 'POST', path: '/webhooks/:key' },
  events: { method: 'GET', path: '/events', query: EventsQuery },
  avatar: { method: 'GET', path: '/avatars/:name' },
  /** The file is the body; `content-type` is its type and `x-board-filename` its name, URI-encoded. */
  upload: { method: 'POST', path: '/attachments' },
  attachment: { method: 'GET', path: '/attachments/:id' },
  /** A file too big for one request: the board answers where to `PUT` it in its blob store. Needs a store with `uploadUrl`. */
  uploadStart: { method: 'POST', path: '/attachments/uploads', body: UploadStartBody },
  /** After the `PUT`: the board checks what landed in the store and records the attachment. */
  uploadFinish: { method: 'POST', path: '/attachments/uploads/:id' },
  openapi: { method: 'GET', path: '/openapi.json' },
  /** Your linked platform accounts. */
  identity: { method: 'GET', path: '/identity' },
  /** Starts a sign-in that carries a code (no token), on the board that runs the entry's sync. */
  signIn: { method: 'GET', path: '/identity/sign-in', query: SignInQuery },
  /** Where a sign-in comes back (no token): links the account it authorized to the code's person. */
  signedIn: { method: 'GET', path: '/identity/signed-in', query: SignInQuery },
  identityUnlink: { method: 'POST', path: '/identity/unlink', body: IdentityUnlinkBody },
  /** Watchers registered by boards on `http()`: every one to `manage` everywhere, the caller's own to anyone else. */
  watchers: { method: 'GET', path: '/watchers' },
  /** Registers the caller's watchers, replacing its last registration. On a board on `http()`, registers its own, with no body or token. */
  register: { method: 'POST', path: '/watchers', body: RegisterBody },
  /** The caller's matches it can run now, each leased to it until it acks. */
  matches: { method: 'GET', path: '/watchers/matches', query: MatchesQuery },
  ack: { method: 'POST', path: '/watchers/matches/:id/ack', body: AckBody },
  /** On a board on `http()`: something matched. No body, no token: the board pulls what. */
  wake: { method: 'POST', path: '/wake' },
} as const

export type RouteName = keyof typeof routes
