import { z } from 'zod'

export const CHANNEL_PATH_MAX = 80
export const MESSAGE_TEXT_MAX = 10_000
/** The longest `x-board-scope` header the board reads; a schedule keeps its creator's. */
export const SCOPE_MAX = 4000
/** Under Vercel Functions' 4.5 MB request body limit, so an upload fits in one request. */
export const ATTACHMENT_BYTES_MAX = 4 * 1024 * 1024
export const ATTACHMENTS_PER_MESSAGE_MAX = 10

const segment = '[a-z0-9][a-z0-9_-]*'

/** `errors-www`, `www/production`: lowercase segments joined by `/`. */
export const ChannelPath = z
  .string()
  .max(CHANNEL_PATH_MAX)
  .regex(new RegExp(`^${segment}(?:/${segment})*$`), 'invalid channel path')

export const MessageText = z
  .string()
  .max(MESSAGE_TEXT_MAX)
  .refine((text) => text.trim().length > 0, 'message text is empty')

/** A message is named by the log index of its `message.posted` event. */
export const MessageId = z.number().int().positive()

export const LabelKey = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, 'invalid label key')
export const LabelValue = z.string().max(256)
export const Labels = z.record(LabelKey, LabelValue)

/** Normalized short names, as Chat SDK names them: `eyes`, `check`, `thumbs_up`. */
export const Emoji = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_+-]+$/, 'invalid emoji name')

/** `vercel:user:u_abc123`, or `vercel:user:u_abc123+claude` for a profile. */
export const ActorId = z.string().min(1).max(256)

/** What an actor is: a `person`, an `agent` acting for a principal (`--as claude`), a deployment, a workflow, or a platform user (`external`). */
export const ActorKind = z.enum([
  'person',
  'agent',
  'deployment',
  'workflow',
  'external',
])

/** `actor.seen` events written before agents were called agents say `profile`. */
export const SeenActorKind = z.union([ActorKind, z.literal('profile')])

export const actorKind = (kind: z.infer<typeof SeenActorKind>): ActorKind => (kind === 'profile' ? 'agent' : kind)

export const Handle = z.string().min(1).max(128)

export const Author = z.object({
  actor: ActorId,
  principal: z.string().min(1),
  profile: z.string().nullable(),
  session: z.string().nullable(),
})

/** 128 random bits, base64url: an attachment is named by an ID nobody can guess. */
export const AttachmentId = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'invalid attachment id')

/** A file on a message. The board records `type` and `size` from what it stored, never from the request. */
export const Attachment = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
})

export type ChannelPath = z.infer<typeof ChannelPath>
export type MessageId = z.infer<typeof MessageId>
export type Labels = z.infer<typeof Labels>
export type ActorId = z.infer<typeof ActorId>
export type ActorKind = z.infer<typeof ActorKind>
export type Author = z.infer<typeof Author>
export type Attachment = z.infer<typeof Attachment>
