import { getEmoji, type Adapter, type Attachment, type AdapterPostableMessage, type ChatInstance, type WebhookOptions } from 'chat'
import { createMockAdapter, createTestMessage } from '@chat-adapter/tests'

const textOf = (message: AdapterPostableMessage) =>
  typeof message === 'string' ? message : JSON.stringify(message)

export type WebhookPayload =
  | {
      type: 'message'
      threadId: string
      id: string
      text: string
      user: string
      name?: string
      raw?: unknown
      /** Files on the message; their bytes are what `served` holds at each `url`. */
      files?: { name: string; mimeType: string; url: string; size?: number }[]
    }
  | { type: 'delete'; threadId: string; id: string }
  | { type: 'edit'; threadId: string; id: string; text: string; user: string; name?: string; editedAt?: string }
  | { type: 'reaction'; threadId: string; messageId: string; emoji: string; added: boolean; user: string; raw?: unknown }

/** A platform adapter driven by test payloads, recording everything posted to it. */
export function fakePlatform(name: string, extend: (adapter: Adapter) => void = () => {}) {
  let chat!: ChatInstance
  let next = 0
  const posts: { threadId: string; text: string; id: string }[] = []
  const channelPosts: { channelId: string; text: string; id: string }[] = []
  const reactions: { threadId: string; messageId: string; emoji: string; added: boolean }[] = []
  const edits: { threadId: string; messageId: string; text: string }[] = []
  const deletes: { threadId: string; messageId: string }[] = []
  const typing: string[] = []
  const statuses: (string | undefined)[] = []
  /** What the platform hands over for a file URL: the bytes, or an error to throw. */
  const served = new Map<string, Uint8Array | Error>()
  const fetches: string[] = []
  const author = (user: string, name = user) => ({ userId: user, userName: name, fullName: name, isBot: false, isMe: false })
  const adapter: Adapter = createMockAdapter(name, {
    name,
    userName: 'board',
    initialize: async (instance: ChatInstance) => {
      chat = instance
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
    handleWebhook: async (request: Request, options?: WebhookOptions) => {
      if (request.headers.get('x-github-event')) return new Response('ok')
      const body = (await request.json()) as WebhookPayload | { type: 'event_callback' }
      // Slack's own event shape: Chat SDK has nothing to do with it here, the provider's `intercept` does.
      if (body.type === 'event_callback') return new Response('ok')
      if (body.type === 'delete')
        await chat.processMessageDeleted({ adapter, threadId: body.threadId, channelId: adapter.channelIdFromThreadId(body.threadId), messageId: body.id, raw: {} }, options)
      else if (body.type === 'edit')
        await chat.processMessageUpdated(
          { adapter, threadId: body.threadId, message: createTestMessage(body.id, body.text, { threadId: body.threadId, author: author(body.user, body.name), ...(body.editedAt ? { metadata: { dateSent: new Date('2024-01-15T10:30:00.000Z'), edited: true, editedAt: new Date(body.editedAt) } } : {}) }) },
          options,
        )
      else if (body.type === 'message')
        await chat.processMessage(
          adapter,
          body.threadId,
          createTestMessage(body.id, body.text, {
            threadId: body.threadId,
            author: author(body.user, body.name),
            ...(body.raw ? { raw: body.raw } : {}),
            ...(body.files
              ? {
                  attachments: body.files.map((f) => ({
                    type: f.mimeType.startsWith('image/') ? ('image' as const) : ('file' as const),
                    name: f.name,
                    mimeType: f.mimeType,
                    url: f.url,
                    ...(f.size !== undefined ? { size: f.size } : {}),
                    fetchMetadata: { url: f.url },
                    // The live closure doesn't survive the inbox: the board must use rehydrateAttachment.
                    fetchData: async () => {
                      throw new Error('stale fetchData called')
                    },
                  })),
                }
              : {}),
          }),
          options,
        )
      else
        await chat.processReaction(
          {
            adapter,
            threadId: body.threadId,
            messageId: body.messageId,
            emoji: getEmoji(body.emoji),
            rawEmoji: body.emoji,
            added: body.added,
            user: author(body.user),
            raw: body.raw ?? { event_ts: `${next++}` },
          },
          options,
        )
      return new Response('ok')
    },
    postMessage: async (threadId: string, message: AdapterPostableMessage) => {
      const id = `m${++next}`
      posts.push({ threadId, text: textOf(message), id })
      // Like Slack's adapter: files upload as their own message, and their IDs come back.
      const files = typeof message === 'object' && 'files' in message ? (message.files ?? []) : []
      return { id, threadId, raw: files.length ? { uploadedFileIds: files.map((f) => `F_${f.filename}`) } : {} }
    },
    editMessage: async (threadId: string, messageId: string, message: AdapterPostableMessage) => {
      edits.push({ threadId, messageId, text: textOf(message) })
      return { id: messageId, threadId, raw: {} }
    },
    deleteMessage: async (threadId: string, messageId: string) => {
      deletes.push({ threadId, messageId })
    },
    postChannelMessage: async (channelId: string, message: AdapterPostableMessage) => {
      const id = `t${++next}`
      channelPosts.push({ channelId, text: textOf(message), id })
      const files = typeof message === 'object' && 'files' in message ? message.files ?? [] : []
      return { id, threadId: `${channelId}:${id}`, raw: files.length ? { uploadedFileIds: files.map((file) => `F_${file.filename}`) } : {} }
    },
    // Like Slack's: rebuilds the download from what the attachment kept.
    rehydrateAttachment: (attachment: Attachment) => ({
      ...attachment,
      fetchData: async () => {
        const url = attachment.fetchMetadata!.url!
        fetches.push(url)
        const found = served.get(url)
        if (!found) throw new Error(`404 ${url}`)
        if (found instanceof Error) throw found
        return Buffer.from(found)
      },
    }),
    startTyping: async (threadId: string, status?: string) => {
      typing.push(threadId)
      statuses.push(status)
    },
    addReaction: async (threadId: string, messageId: string, emoji: unknown) => {
      reactions.push({ threadId, messageId, emoji: String(emoji), added: true })
    },
    removeReaction: async (threadId: string, messageId: string, emoji: unknown) => {
      reactions.push({ threadId, messageId, emoji: String(emoji), added: false })
    },
  } as Partial<Adapter>)
  extend(adapter)
  return { adapter, posts, channelPosts, reactions, edits, deletes, typing, statuses, served, fetches }
}


/** Gives the fake Slack adapter a Web API client, optionally behind an async bot token as with Vercel Connect. */
export function withSlackClient(client: unknown, asyncToken: boolean) {
  return (adapter: Adapter) => {
    if (!asyncToken) return void Object.assign(adapter, { webClient: client })
    let token: string | undefined
    Object.defineProperty(adapter, 'webClient', {
      get: () => {
        if (!token) throw new Error('botToken is configured as an async resolver')
        return client
      },
    })
    Object.assign(adapter, {
      getToken: async () => 'xoxb-test',
      withBotToken: (bound: string, fn: () => unknown) => {
        token = bound
        try {
          return fn()
        } finally {
          token = undefined
        }
      },
    })
  }
}
