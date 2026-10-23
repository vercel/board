import type { z } from 'zod'
import type { Actor } from '../contract/reducers.ts'
import type { Attachment } from '../contract/schemas.ts'
import type {
  AckBody,
  ChannelView,
  Discovery,
  EditBody,
  EventsPage,
  EventsQuery,
  IdentityView,
  InboxAckBody,
  InboxEntry,
  InboxItem,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LinkedAccount,
  LabelBody,
  MatchesQuery,
  MatchView,
  Me,
  MessagesPage,
  MessagesQuery,
  MessageView,
  PersonView,
  PostBody,
  ReactBody,
  RegisterBody,
  RegistrationView,
  ScheduleBody,
  SchedulesQuery,
  ScheduleView,
  SourceRead,
  SourceReadQuery,
  ThreadsPage,
  SyncAccountBody,
  SyncCodeBody,
  SyncCodeView,
  SyncCopiesQuery,
  SyncCopiesView,
  SyncFindQuery,
  SyncFindView,
  SyncImportBody,
  SyncReceiptBody,
  SyncRootsQuery,
  SyncThreadView,
  SyncUnlinkBody,
  ThreadsQuery,
  ThreadView,
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
  actors: { input: Nothing; output: { actors: (Actor & { person?: PersonView })[]; cursor: string } }
  identity: { input: Nothing; output: IdentityView }
  messages: { input: Input<typeof MessagesQuery>; output: MessagesPage }
  threads: { input: Input<typeof ThreadsQuery>; output: ThreadsPage }
  message: { input: Id; output: ThreadView }
  post: { input: Input<typeof PostBody>; output: { message: MessageView; unknownMentions?: string[] } }
  /** The caller's own post with client ID `id`, as it landed: 404 `post_not_found` when there's none. */
  posted: { input: Id; output: { message: MessageView } }
  edit: { input: Id & Input<typeof EditBody>; output: { ok: true; unknownMentions?: string[] } }
  delete: { input: Id; output: { ok: true } }
  react: { input: Id & Input<typeof ReactBody>; output: { ok: true } }
  label: { input: Id & Input<typeof LabelBody>; output: { ok: true } }
  schedule: { input: Input<typeof ScheduleBody>; output: { schedule: ScheduleView; unknownMentions?: string[] } }
  schedules: { input: Input<typeof SchedulesQuery>; output: { schedules: ScheduleView[] } }
  cancelSchedule: { input: Id; output: { schedule: ScheduleView; canceled: boolean } }
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
  syncRoots: { input: Input<typeof SyncRootsQuery>; output: { roots: MessageView[] } }
  /** Platform events into the caller's inbox, deduplicated by their platform IDs. */
  inboxPush: { input: Key & Input<typeof InboxPushBody>; output: { ok: true } }
  /** The caller's next inbox events, leased, one platform thread at a time and in order. */
  inboxNext: { input: Key & Input<typeof InboxNextQuery>; output: { items: InboxItem[] } }
  inboxAck: { input: Key & Id & Input<typeof InboxAckBody>; output: { ok: true } }
  /** Raw platform events, newest first, for debugging sync. */
  inbox: { input: Key & Input<typeof InboxQuery>; output: { events: InboxEntry[] } }
  /** A code for linking the caller's account, and the sign-in that carries it when the entry signs people in. */
  syncCode: { input: Input<typeof SyncCodeBody>; output: SyncCodeView }
  /** 404 `bad_code` for a code that isn't live. */
  syncAccount: { input: Input<typeof SyncAccountBody>; output: { person: string; link: LinkedAccount } }
  syncUnlink: { input: Input<typeof SyncUnlinkBody>; output: { ok: true } }
}

export type Method = keyof Protocol
