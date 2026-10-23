// `vboard/backend-a2/contract`: the board log's contract, its entity schemas, and the views
// people read. Sync bookkeeping, side contracts, and the folds stay internal.
export {
  ATTACHMENT_BYTES_MAX,
  IMPORT_BYTES_MAX,
  DIRECT_UPLOAD_BYTES_MAX,
  ATTACHMENTS_PER_MESSAGE_MAX,
  ActorId,
  ActorKind,
  Attachment,
  AttachmentId,
  Author,
  CHANNEL_PATH_MAX,
  ChannelPath,
  Emoji,
  Handle,
  LabelKey,
  LabelValue,
  Labels,
  MESSAGE_TEXT_MAX,
  MessageId,
  MessageText,
} from './schemas.ts'
export { BOARD_SESSION, Origin, boardContract, type BoardEvent, type BoardEvents, type ExternalAuthor } from './contract.ts'
export {
  actorsReducer,
  channelsReducer,
  messagesReducer,
  type Actor,
  type ActorsState,
  type Channel,
  type ChannelsState,
  type Message,
  type MessagesState,
} from './reducers.ts'
