import { AsyncLocalStorage } from 'node:async_hooks'
import type { Adapter, Author as ChatAuthor, Chat, FileUpload, Message as ChatMessage, ReactionEvent } from 'chat'
import type { Actor } from '../contract/folds.ts'
import { LINKS_PER_MESSAGE_MAX, type ExternalAuthor, type ExternalFile, type ExternalLink } from '../contract/external.ts'
import { SyncProvider, ResolvedTarget, type Receive, type ReceivedEvent, type ProviderOptions, type ProviderPost, type ProviderFile, type ProviderDelivery, type FileDelivery, type FetchedLink } from './provider.ts'
import type { ProviderEvent, SyncRoot } from './events.ts'
import type { SyncFn } from './fn.ts'
import type { SourceJoin, SourceRead } from '../api/routes.ts'
import { createChat, markdownOf } from './chat.ts'
import { externalAuthor } from './types.ts'
import { userTokensOf } from './users.ts'
export { externalAuthor } from './types.ts'

export type ChatInput =
  | { kind: 'message' | 'edited'; message: ChatMessage }
  | { kind: 'deleted'; thread: string; message: string; raw: unknown }
  | { kind: 'reaction'; reaction: ReactionEvent }

export type ChatTransport = Omit<ProviderOptions, 'uploadsFiles'> & {
  adapter: Adapter
  findByEmail?(email: string): Promise<ExternalAuthor | null>
  mention?(actor: Actor): string | null
  author?(author: ChatAuthor, raw: unknown): ExternalAuthor
  resolveChannel(key: string): Promise<string>
  resolveTarget(target: string): Promise<ResolvedTarget>
  groupThread?(thread: string): string
  channelOf?(thread: string): string
  isRoot?(thread: string, message: string): boolean
  fromChatId?(id: string): string
  toChatId?(id: string): string
  context?(message: ChatMessage): string | null
  markdown?(message: ChatMessage): string
  /** Platform messages a message links to, located under sync key `key`. */
  links?(key: string, message: ChatMessage): ExternalLink[]
  fetchLink?(link: ExternalLink): Promise<FetchedLink>
  /** The message a URL of the platform's names, by its own IDs: `SyncProvider.locate`. */
  locate?(url: string): { thread: string; message: string | null } | null
  /** The platform's URL for a message, by its own IDs: `SyncProvider.url`. */
  url?(thread: string, message: string): Promise<string | null>
  /** A channel or thread, read on demand without syncing it. */
  read?(target: string, options: { limit: number }): Promise<SourceRead>
  /** Adds the app to a channel so `read` can read it. */
  join?(target: string): Promise<SourceJoin>
  avatar?(message: ChatMessage): Promise<string | null>
  fetchRoot?(thread: string): Promise<Omit<SyncRoot, 'raw'> & { raw?: unknown }>
  intercept?(key: string, headers: Headers, body: string): ReceivedEvent[]
  /** Edits and deletes in a webhook that the adapter doesn't emit itself, as the adapter would have. */
  missed?(headers: Headers, body: string): ChatInput[]
  uploadFiles?(thread: string, files: FileUpload[]): Promise<FileDelivery>
  /** The name a file is uploaded under, when the platform reads more into a name than the board does. */
  uploadName?(file: ProviderFile): string
  fileIds?(raw: unknown): string[]
  refusesFiles?(error: unknown): boolean
  deleteFiles?(ids: string[]): Promise<void>
  /** What the adapter needs to fetch a file again, if not everything the event carried. */
  fileToFetch?(file: ExternalFile): ExternalFile
  startTyping?(thread: string, latest: string | null, status?: string): Promise<void>
  /** Runs adapter calls with a person's token instead of the bot's: how a message posts as them. */
  runAs?<T>(token: string, fn: () => Promise<T>): Promise<T>
  /** The platform account a person's token belongs to. */
  whoAmI?(token: string): Promise<ExternalAuthor>
}

const externalFile = (file: NonNullable<ChatMessage['attachments']>[number]): ExternalFile => ({
  type: file.type,
  ...(file.name ? { name: file.name.slice(0, 1000) } : {}),
  ...(file.mimeType ? { mimeType: file.mimeType.slice(0, 255) } : {}),
  ...(typeof file.size === 'number' && Number.isInteger(file.size) && file.size >= 0 ? { size: file.size } : {}),
  ...(file.url && file.url.length <= 4000 ? { url: file.url } : {}),
  ...(file.fetchMetadata ? { fetchMetadata: file.fetchMetadata } : {}),
})

export abstract class ChatSyncProvider<E extends ProviderEvent = ProviderEvent> extends SyncProvider<E> {
  protected readonly transport: ChatTransport
  private readonly chat: Chat
  private readonly receiving = new AsyncLocalStorage<{ key: string; emit: Receive }>()
  private initialized: Promise<void> | undefined

  constructor(transport: ChatTransport, sync: SyncFn<E>) {
    super({ ...transport, users: transport.users ?? userTokensOf(transport.adapter), uploadsFiles: !!transport.uploadFiles }, sync)
    this.transport = transport
    this.chat = createChat(transport.adapter)
    const onMessage = async (_thread: unknown, message: ChatMessage) => this.emit({ kind: 'message', message })
    this.chat.onNewMessage(/[\s\S]*/, onMessage)
    this.chat.onNewMention(onMessage)
    this.chat.onMessageUpdated(async (_thread, message) => this.emit({ kind: 'edited', message }))
    this.chat.onMessageDeleted(async (event) => this.emit({ kind: 'deleted', thread: event.threadId, message: event.messageId, raw: event.raw }))
    this.chat.onReaction(async (reaction) => this.emit({ kind: 'reaction', reaction }))
  }

  protected toNative(id: string): string {
    const native = id.slice(id.indexOf(':') + 1)
    return this.transport.fromChatId?.(native) ?? native
  }

  protected toChat(id: string): string {
    return `${this.transport.adapter.name}:${this.transport.toChatId?.(id) ?? id}`
  }

  protected locationOf(key: string, chatThread: string) {
    const native = this.toNative(chatThread)
    const precise = `${key}:${native}`
    const thread = `${key}:${this.transport.groupThread?.(native) ?? native}`
    const channel = this.transport.channelOf?.(native) ?? this.toNative(this.transport.adapter.channelIdFromThreadId(chatThread))
    return { channel: `${key}:${channel}`, thread, subthread: precise === thread ? null : precise }
  }

  override inboxChannel(key: string, thread: string): string {
    const native = thread.slice(key.length + 1)
    return `${key}:${this.transport.channelOf?.(native) ?? this.toNative(this.transport.adapter.channelIdFromThreadId(this.toChat(native)))}`
  }

  eventId(key: string, input: ChatInput): string {
    if (input.kind === 'reaction') throw new Error(`${this.platform} must supply a stable reaction occurrence ID`)
    if (input.kind === 'deleted') return `deleted:${key}:${this.toNative(input.thread)}|${input.message}`
    const message = input.message
    const location = `${key}:${this.toNative(message.threadId)}|${message.id}`
    return input.kind === 'message' ? `message:${location}` : `edited:${location}|${message.text}`
  }

  protected author(author: ChatAuthor, raw: unknown) {
    return this.transport.author?.(author, raw) ?? externalAuthor(this.platform, author)
  }

  protected async authorOf(message: ChatMessage) {
    const author = this.author(message.author, message.raw)
    const avatar = await this.transport.avatar?.(message).catch(() => null)
    return avatar ? { ...author, avatar } : author
  }

  protected async normalize(key: string, input: ChatInput): Promise<ReceivedEvent> {
    const dedupe = this.eventId(key, input)
    if (input.kind === 'deleted') {
      return { dedupe, raw: input.raw, event: { kind: 'deleted', ...this.locationOf(key, input.thread), message: input.message } }
    }
    if (input.kind === 'reaction') {
      const event = input.reaction
      const emoji = (event.emoji?.name ?? event.rawEmoji).toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 64) || 'unknown'
      return { dedupe, raw: event.raw, event: {
        kind: 'reaction', ...this.locationOf(key, event.threadId), message: event.messageId,
        emoji, added: event.added, author: this.author(event.user, event.raw),
      } }
    }
    const message = input.message
    const found = this.transport.links?.(key, message) ?? []
    const links = found.length ? { links: found.slice(0, LINKS_PER_MESSAGE_MAX) } : {}
    const common = {
      ...this.locationOf(key, message.threadId), message: message.id,
      text: this.transport.markdown?.(message) ?? markdownOf(message), author: await this.authorOf(message),
      ...links,
    }
    return { dedupe, raw: message.raw, event: input.kind === 'edited' ? { kind: 'edited', ...common } : {
      kind: 'message', ...common,
      isRoot: this.transport.isRoot?.(this.toNative(message.threadId), message.id) ?? false,
      context: this.transport.context?.(message) ?? null,
      ...(message.attachments?.length ? { files: message.attachments.slice(0, 20).map(externalFile) } : {}),
    } }
  }

  private async emit(input: ChatInput) {
    const context = this.receiving.getStore()
    if (!context) throw new Error('Chat SDK emitted an event outside a verified request')
    await context.emit(await this.normalize(context.key, input))
  }

  override receive(key: string, request: Request, emit: Receive): Promise<Response> {
    return this.receiving.run({ key, emit }, () => this.receiveRequest(key, request, emit))
  }

  private async receiveRequest(key: string, request: Request, emit: Receive): Promise<Response> {
    const body = this.transport.intercept || this.transport.missed ? await request.clone().text() : null
    const tasks: Promise<unknown>[] = []
    const webhooks = this.chat.webhooks as Record<string, (request: Request, options: { waitUntil(task: Promise<unknown>): void }) => Promise<Response>>
    const response = await webhooks[this.transport.adapter.name]!(request, { waitUntil: (task) => void tasks.push(task) })
    const results: PromiseSettledResult<unknown>[] = []
    while (tasks.length) results.push(...await Promise.allSettled(tasks.splice(0)))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
    if (response.ok && body !== null) {
      for (const input of this.transport.missed?.(request.headers, body) ?? []) await emit(await this.normalize(key, input))
      for (const received of this.transport.intercept?.(key, request.headers, body) ?? []) await emit(received)
    }
    return response
  }

  protected async ready() {
    this.initialized ??= this.chat.initialize().catch((error) => {
      this.initialized = undefined
      throw error
    })
    await this.initialized
    return this.transport.adapter
  }

  override resolveChannel(key: string) { return this.transport.resolveChannel(key) }
  override async resolveTarget(target: string) { return ResolvedTarget.parse(await this.transport.resolveTarget.call(this, target)) }
  override async findByEmail(email: string) { return this.transport.findByEmail?.(email) ?? null }
  override mention(actor: Actor) { return this.transport.mention?.(actor) ?? null }
  override async fetchRoot(thread: string): Promise<SyncRoot | null> {
    const root = await this.transport.fetchRoot?.(thread)
    return root ? { ...root, raw: root.raw ?? null } : null
  }
  override async fetchLink(link: ExternalLink): Promise<FetchedLink> {
    return this.transport.fetchLink ? this.transport.fetchLink(link) : super.fetchLink(link)
  }
  override locate(url: string): { thread: string; message: string | null } | null {
    return this.transport.locate ? this.transport.locate(url) : super.locate(url)
  }
  override async url(thread: string, message: string): Promise<string | null> {
    return this.transport.url ? this.transport.url(thread, message) : super.url(thread, message)
  }

  override async read(target: string, options: { limit: number }): Promise<SourceRead> {
    return this.transport.read ? this.transport.read(target, options) : super.read(target, options)
  }
  override async join(target: string): Promise<SourceJoin> {
    return this.transport.join ? this.transport.join(target) : super.join(target)
  }
  override async fetchFile(file: ExternalFile): Promise<Uint8Array | null> {
    // Ready first: an adapter may resolve a file's credentials from its Chat state.
    const adapter = await this.ready()
    const fetch = adapter.rehydrateAttachment?.({ ...(this.transport.fileToFetch?.(file) ?? file) }).fetchData
    if (!fetch) return null
    const data = await fetch()
    return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  override async post(target: string, kind: ResolvedTarget['kind'], { as: _sender, files, ...body }: ProviderPost): Promise<ProviderDelivery> {
    if (kind === 'channel' && !this.canStartThreads) throw new Error(`${this.platform} cannot start threads`)
    await this.ready()
    const sent = await (kind === 'channel' ? this.chat.channel(this.toChat(target)) : this.chat.thread(this.toChat(target))).post(files?.length ? { ...body, files: this.named(files) } : body)
    return { thread: this.toNative(sent.threadId), message: sent.id, ...(files?.length ? { files: this.transport.fileIds?.(sent.raw) ?? [] } : {}) }
  }
  override async whoAmI(token: string) {
    if (!this.transport.whoAmI) return super.whoAmI(token)
    await this.ready()
    return this.transport.whoAmI(token)
  }
  /** As the person: ready first, so the adapter learns its own identity with the bot's token, never theirs. */
  private async as<T>(token: string, fn: () => Promise<T>): Promise<T> {
    if (!this.transport.runAs) throw new Error(`${this.platform} can't post as a person`)
    await this.ready()
    return this.transport.runAs(token, fn)
  }
  override async postAs(token: string, target: string, kind: ResolvedTarget['kind'], body: ProviderPost) {
    return this.as(token, () => this.post(target, kind, body))
  }
  override async editAs(token: string, thread: string, message: string, body: ProviderPost) {
    await this.as(token, () => this.edit(thread, message, body))
  }
  override async deleteAs(token: string, thread: string, message: string) {
    await this.as(token, () => this.delete(thread, message))
  }
  override async edit(thread: string, message: string, { as: _sender, files, ...body }: ProviderPost) {
    await (await this.ready()).editMessage(this.toChat(thread), message, files ? { ...body, files: this.named(files) } : body)
  }
  override async delete(thread: string, message: string) { await (await this.ready()).deleteMessage(this.toChat(thread), message) }
  override async react(thread: string, message: string, emoji: string, added: boolean) {
    const adapter = await this.ready()
    if (added) await adapter.addReaction(this.toChat(thread), message, emoji)
    else await adapter.removeReaction(this.toChat(thread), message, emoji)
  }
  override async startTyping(thread: string, latest: string | null, status?: string) {
    const adapter = await this.ready()
    if (this.transport.startTyping) await this.transport.startTyping(this.toChat(thread), latest, status)
    else await adapter.startTyping(this.toChat(thread), status)
  }
  override async uploadFiles(thread: string, files: ProviderFile[]) {
    await this.ready()
    if (!this.transport.uploadFiles) return super.uploadFiles(thread, files)
    return this.transport.uploadFiles(this.toChat(thread), this.named(files))
  }
  /** Files as the Chat SDK takes them: Buffers, named as the platform wants. */
  private named(files: ProviderFile[]): FileUpload[] {
    const name = this.transport.uploadName
    return files.map((file) => ({
      ...file,
      data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength),
      ...(name ? { filename: name(file) } : {}),
    }))
  }
  override refusesFiles(error: unknown) { return this.transport.refusesFiles?.(error) ?? false }
  override async deleteFiles(ids: string[]) { await this.transport.deleteFiles?.(ids) }
}
