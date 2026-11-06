import type { z } from 'zod'
import type { Actor } from '../contract/folds.ts'
import type { Attachment } from '../contract/schemas.ts'
import type {
  AckBody,
  ChannelView,
  CreateChannelBody,
  Discovery,
  DeleteBody,
  EditBody,
  EventsPage,
  GrantBody,
  GrantView,
  UpdateGrantBody,
  ExplainQuery,
  Explanation,
  EventsQuery,
  InboxAckBody,
  InboxEntry,
  InboxItem,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LinkedQuery,
  LabelBody,
  MatchesQuery,
  MatchView,
  Me,
  MessagesPage,
  MessagesQuery,
  MessageView,
  PostBody,
  ReactBody,
  RegisterBody,
  RegistrationView,
  ScheduleBody,
  SchedulesQuery,
  ScheduleView,
  SourceJoin,
  SourceJoinBody,
  SourceRead,
  SourceReadQuery,
  ThreadsPage,
  SyncCopiesQuery,
  SyncCopiesView,
  SyncFindQuery,
  SyncFindView,
  SyncImportBody,
  SyncReceiptBody,
  SyncThreadView,
  SyncedView,
  ThreadsQuery,
  ThreadView,
  TokenBody,
  TokenView,
  TypingBody,
  UploadStartBody,
  UploadTicket,
} from './routes.ts'

type Input<S extends z.ZodType> = NonNullable<z.output<S>>
type Id = { id: string }
type Key = { key: string }
type Nothing = Record<string, never>

/**
 * The protocol, method by method: what each takes and what it answers, as the wire carries them.
 * board() serves each at its route in `routes` and calls the backend's method of the same name.
 */
export type Protocol = {
  /** Where the board is and what it syncs, for a client to mint a token from: it needs none itself. */
  discovery: { input: Nothing; output: Discovery }
  me: { input: Nothing; output: Me }
  channels: { input: Nothing; output: { channels: ChannelView[]; cursor: string } }
  /** `created` is false for a channel that was there already, made by a post or another create. */
  createChannel: { input: Input<typeof CreateChannelBody>; output: { channel: ChannelView; created: boolean } }
  actors: { input: Nothing; output: { actors: Actor[]; cursor: string } }
  messages: { input: Input<typeof MessagesQuery>; output: MessagesPage }
  threads: { input: Input<typeof ThreadsQuery>; output: ThreadsPage }
  message: { input: Id; output: ThreadView }
  post: { input: Input<typeof PostBody>; output: { message: MessageView; unknownMentions?: string[] } }
  /** The caller's own post with client ID `id`, as it landed: 404 `post_not_found` when there's none. */
  posted: { input: Id; output: { message: MessageView } }
  edit: { input: Id & Input<typeof EditBody>; output: { ok: true; unknownMentions?: string[] } }
  delete: { input: Id & Input<typeof DeleteBody>; output: { ok: true } }
  react: { input: Id & Input<typeof ReactBody>; output: { ok: true } }
  label: { input: Id & Input<typeof LabelBody>; output: { ok: true } }
  schedule: { input: Input<typeof ScheduleBody>; output: { schedule: ScheduleView; unknownMentions?: string[] } }
  schedules: { input: Input<typeof SchedulesQuery>; output: { schedules: ScheduleView[] } }
  cancelSchedule: { input: Id; output: { schedule: ScheduleView; canceled: boolean } }
  /** The board's grants: needs `manage` at `*`, or a team owner. 501 `no_grants` where the board keeps none. */
  grants: { input: Nothing; output: { grants: GrantView[] } }
  /** A new grant, always: the same principals again are another. Needs `manage` at each pattern its `can` names. */
  createGrant: { input: Input<typeof GrantBody>; output: { grant: GrantView } }
  /** Adds and removes principals, or replaces its `can`: needs what `checkGrantChange` says, for the grant as it was and as it'd be. 404 `grant_not_found`. */
  updateGrant: { input: Id & Input<typeof UpdateGrantBody>; output: { grant: GrantView } }
  /** Which grant decides `channel` for the caller, or with `manage` at `*` (or a team owner), the principal it names. */
  explain: { input: Input<typeof ExplainQuery>; output: Explanation }
  /** `revoked` is false when it was already gone. */
  revokeGrant: { input: Id; output: { revoked: boolean } }
  /** The caller's tokens, or every one with `manage` in every channel. 501 `no_tokens` where the board issues none. */
  tokens: { input: Nothing; output: { tokens: TokenView[] } }
  /** A token acting as the caller, narrowed: the only time its secret shows. */
  createToken: { input: Input<typeof TokenBody>; output: { token: TokenView; secret: string } }
  /** It and every token minted with it stop. `revoked` is false when it was already gone. */
  revokeToken: { input: Id; output: { revoked: boolean } }
  upload: { input: { data: Uint8Array; name: string | null; type: string | null }; output: { attachment: Attachment } }
  attachment: { input: Id; output: { attachment: Attachment; data: Uint8Array | ReadableStream<Uint8Array> } }
  /** A direct upload's ticket: where to `PUT` a file too big for `upload`. 501 `no_direct_uploads` when the blob store can't sign one. */
  uploadStart: { input: Input<typeof UploadStartBody>; output: UploadTicket }
  /** The attachment, once the bytes are in the store: 409 `not_uploaded` before. Finishing one twice answers the same. */
  uploadFinish: { input: Id; output: { attachment: Attachment } }
  watchers: { input: Nothing; output: { watchers: RegistrationView[] } }
  register: { input: Input<typeof RegisterBody>; output: RegistrationView }
  matches: { input: Input<typeof MatchesQuery>; output: { matches: MatchView[] } }
  ack: { input: Id & Input<typeof AckBody>; output: { ok: true } }
  /** Long-polls with `wait`. board() serves SSE from it, so a backend has one way to read events. */
  events: { input: Input<typeof EventsQuery>; output: EventsPage }
  /** Typing in the platform threads the message's thread is synced to: needs `post` there. Answers the threads that took it. */
  typing: { input: Id & Input<typeof TypingBody>; output: { targets: string[] } }
  /** A platform channel or thread, read with sync entry `key`'s app where that sync runs: needs `manage` everywhere. */
  readSource: { input: Key & Input<typeof SourceReadQuery>; output: SourceRead }
  /** Adds sync entry `key`'s app to a public channel, where that sync runs and opted in: needs `manage` everywhere. */
  joinSource: { input: Key & Input<typeof SourceJoinBody>; output: SourceJoin }
  /** Where a message's thread is synced, and its copy on each target, from sync's records: needs `read` where it is. */
  synced: { input: Id; output: SyncedView }
  /**
   * The thread of the board message a platform link names, from sync's records: the platform is
   * never asked. 404 `message_not_found` for a link the board didn't sync, or one the caller can't read.
   */
  linked: { input: Input<typeof LinkedQuery>; output: ThreadView }

  // Sync's records, which sync in board() keeps through these wherever the board lives. Each needs `sync`.
  /**
   * A platform's write as its platform author, idempotent per platform event. `dropped`: the
   * middleware kept a post or an edit off the board, and what it responded, for sync to tell the
   * author on the platform.
   */
  syncImport: { input: Input<typeof SyncImportBody>; output: { message: string | null; dropped?: string[] } }
  /** A delivery, its files, a failure, or a thread's new target. `attached` is false for a target the thread had. */
  syncReceipt: { input: Input<typeof SyncReceiptBody>; output: { ok: true; attached?: boolean } }
  syncThread: { input: { thread: string }; output: SyncThreadView }
  syncFind: { input: Input<typeof SyncFindQuery>; output: SyncFindView }
  /** Messages' copies on platforms that the caller's sync recorded, by target: another sync's never show. */
  syncCopies: { input: Input<typeof SyncCopiesQuery>; output: SyncCopiesView }
  /** Platform events into the caller's inbox, deduplicated by their platform IDs. */
  inboxPush: { input: Key & Input<typeof InboxPushBody>; output: { ok: true } }
  /** The caller's next inbox events, leased, one platform thread at a time and in order. */
  inboxNext: { input: Key & Input<typeof InboxNextQuery>; output: { items: InboxItem[] } }
  inboxAck: { input: Key & Id & Input<typeof InboxAckBody>; output: { ok: true } }
  /** Raw platform events, newest first, for debugging sync. */
  inbox: { input: Key & Input<typeof InboxQuery>; output: { events: InboxEntry[] } }
}

export type Method = keyof Protocol
