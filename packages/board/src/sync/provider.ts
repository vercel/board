import { z } from 'zod'
import type { Actor } from '../contract/folds.ts'
import type { MessageView, SourceJoin, SourceRead } from '../api/routes.ts'
import { ExternalEvent, type ExternalAuthor, type ExternalFile, type ExternalLink, type Link } from '../contract/external.ts'
import type { ProviderEvent, SyncRoot } from './events.ts'
import { routesOf, type Routes, type Sync, type SyncFn } from './fn.ts'
import type { UserTokens } from './users.ts'

export const ResolvedTarget = z.object({ target: z.string().min(1), channel: z.string().min(1), kind: z.enum(['channel', 'thread']) }).strict()
export type ResolvedTarget = z.infer<typeof ResolvedTarget>

/** The fields a provider's `event` builds its typed event from. */
export type SyncContext = { id: string; key: string; event: ExternalEvent; raw: unknown }

export type RenderInput = {
  /** The message as clients see it: its IDs are refs. */
  message: Readonly<MessageView>
  author: Readonly<Actor> | null
  /** How this platform mentions an actor, through linked accounts; null when it can't. */
  mentionOf: (actor: string) => string | null
  label: string
  target: string
}
/** How a platform shows a board message: markdown, which the platform converts to its own format. */
export type Renderer = (input: RenderInput) => string

export type FileDelivery = { message: string; files: string[] }

/** What a linked message said, or why the platform wouldn't say. */
export type FetchedLink = Pick<Link, 'snapshot' | 'unavailable'>

/** Why a platform wouldn't read a channel or thread on demand. Its message is shown as is. */
export class UnreadableError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Whether `resolveChannel` failed because the platform has no such channel, so no event can be
 * in it, rather than because it couldn't tell (a failed listing, a missing scope).
 */
export const channelMissing = (error: unknown) => error instanceof UnreadableError && error.code === 'channel_not_found'

/** A file to send: its bytes (a Node `Buffer` is one), its name, and its type. */
export type ProviderFile = { data: Uint8Array; filename: string; mimeType?: string }
/**
 * Who a post is from, for a platform that can show it as the sender (Slack's per-message
 * username and icon): `name` is the label the text opens with (`**name**: …`).
 */
export type ProviderSender = { name: string; avatar: string | null }
export type ProviderPost = { markdown: string; files?: ProviderFile[]; as?: ProviderSender }
export type ProviderDelivery = { thread: string; message: string; files?: string[] }
export type ProviderOptions = {
  platform: string
  canStartThreads?: boolean
  singleReaction?: boolean
  uploadsFiles?: boolean
  /** People's own tokens, to post as them and to link accounts by signing in. */
  users?: UserTokens | null
}

export const ReceivedEvent = z.object({ event: ExternalEvent, raw: z.unknown(), dedupe: z.string().min(1) })
export type ReceivedEvent = z.infer<typeof ReceivedEvent>
export type Receive = (received: ReceivedEvent) => Promise<void>

const routed = new WeakMap<object, Routes>()
/** The channels a provider's sync function routes, when a helper made it: the webhook keeps only theirs. */
export const routesFor = (provider: object): Routes | undefined => routed.get(provider)

export abstract class SyncProvider<E extends ProviderEvent = ProviderEvent> {
  readonly platform: string
  readonly canStartThreads: boolean
  readonly singleReaction: boolean
  readonly uploadsFiles: boolean
  // A method's parameter is checked both ways, so a SlackProvider is still a SyncProvider.
  private readonly fn: { run(sync: Sync<E>): unknown }
  /** People's tokens, when the adapter has them: messages they write post as them. */
  readonly users: UserTokens | null
  protected readonly options: ProviderOptions

  constructor(options: ProviderOptions, sync: SyncFn<E>) {
    if (typeof sync !== 'function') throw new Error(`${options.platform} needs a sync function: what each event does, like channels({ '#dev': 'dev' })`)
    this.fn = { run: sync }
    const routes = routesOf(sync)
    if (routes) routed.set(this, routes)
    this.options = options
    this.users = options.users ?? null
    this.platform = options.platform
    this.canStartThreads = options.canStartThreads ?? false
    this.singleReaction = options.singleReaction ?? false
    this.uploadsFiles = options.uploadsFiles ?? false
  }

  abstract receive(key: string, request: Request, emit: Receive): Promise<Response>
  abstract resolveChannel(key: string): Promise<string>
  abstract resolveTarget(target: string): Promise<ResolvedTarget>
  abstract post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost): Promise<ProviderDelivery>

  /** The platform account a person's token belongs to. */
  async whoAmI(_token: string): Promise<ExternalAuthor> { throw new Error(`${this.platform} can't post as a person`) }
  /** `post`, as the person whose token this is. */
  async postAs(_token: string, _target: string, _kind: ResolvedTarget['kind'], _body: ProviderPost): Promise<ProviderDelivery> {
    throw new Error(`${this.platform} can't post as a person`)
  }
  async editAs(_token: string, _thread: string, _message: string, _body: ProviderPost): Promise<void> {}
  async deleteAs(_token: string, _thread: string, _message: string): Promise<void> {}

  async findByEmail(_email: string): Promise<ExternalAuthor | null> { return null }
  mention(_actor: Actor): string | null { return null }
  async fetchRoot(_thread: string): Promise<SyncRoot | null> { return null }
  async fetchFile(_file: ExternalFile): Promise<Uint8Array | null> { return null }
  /** The platform's own link to an event's message, or null when it has none. */
  async permalink(_event: E): Promise<string | null> { return null }
  /** A linked message the platform didn't describe, read from the platform. */
  async fetchLink(_link: ExternalLink): Promise<FetchedLink> { return { snapshot: null, unavailable: `${this.platform} can't read it` } }
  /**
   * The message a URL of this platform's names, by its own thread and message IDs, or null for a
   * URL that isn't one. `message` is null for a link to a thread itself. It asks the platform
   * nothing: the board answers from what it synced (`vb read <url>`).
   */
  locate(_url: string): { thread: string; message: string | null } | null { return null }
  /** The platform's URL for one of its messages, by its own IDs, or null when it has none (`vb sync <id>`). */
  async url(_thread: string, _message: string): Promise<string | null> { return null }
  /**
   * A channel or thread, read on demand for whoever asked: nothing is synced,
   * stored, or joined. Throws `UnreadableError` for what it won't read.
   */
  async read(_target: string, _options: { limit: number }): Promise<SourceRead> {
    throw new UnreadableError('unsupported', `${this.platform} can't be read on demand`)
  }
  /** Adds the board's app to a channel so `read` can read it, where the board opted in. Throws `UnreadableError` otherwise. */
  async join(_target: string): Promise<SourceJoin> {
    throw new UnreadableError('unsupported', `${this.platform} can't join channels on demand`)
  }
  async edit(_thread: string, _message: string, _body: ProviderPost): Promise<void> {}
  async delete(_thread: string, _message: string): Promise<void> {}
  async react(_thread: string, _message: string, _emoji: string, _added: boolean): Promise<void> {}
  async startTyping(_thread: string, _latest: string | null, _status?: string): Promise<void> {}
  /**
   * The channel whose inbox a thread's events land in (`slack:C0123ABC` for `slack:C0123ABC:1727.1234`),
   * worked out without calling the platform. Null when the provider can't tell: a key's inbox then
   * lists only the mapped channels'.
   */
  inboxChannel(_key: string, _thread: string): string | null { return null }
  async deleteFiles(_ids: string[]): Promise<void> {}
  refusesFiles(_error: unknown): boolean { return false }
  async uploadFiles(_thread: string, _files: ProviderFile[]): Promise<FileDelivery> {
    throw new Error(`${this.platform} does not support file uploads`)
  }

  abstract event(context: SyncContext): E

  /** Runs the sync function the provider was made with: what every event does, both ways. */
  sync(sync: Sync<E>): unknown {
    return this.fn.run(sync)
  }


  /** The default rendering: `**${label}**: ${text}`. A `Renderer` passed to `deliver` replaces it. */
  render(input: RenderInput): string {
    return `**${input.label}**: ${input.message.text}`
  }
}
