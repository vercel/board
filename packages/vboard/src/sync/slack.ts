import { ChatSyncProvider, type ChatInput } from './chat-provider.ts'
import type { Adapter, Message as ChatMessage } from 'chat'
import { markdownOf } from './chat.ts'
import { z } from 'zod'
import { envelope, eventSchema } from './events.ts'
import { UnreadableError, type ResolvedTarget, type ProviderPost, type ProviderDelivery, type ProviderSender, type SyncContext, type SyncHandler, type EventMapping, type RenderInput, type ReceivedEvent, type FetchedLink } from './provider.ts'
import type { SourceMessage, SourceRead } from '../api/routes.ts'
import { stringifyMarkdown } from 'chat'
import { LINKS_PER_MESSAGE_MAX, type ExternalLink } from '../contract/contract.ts'
import { MESSAGE_TEXT_MAX } from '../contract/schemas.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import { connectSlackAdapter } from '@vercel/connect/chat'
import { connectUserTokens, withUserTokens } from './users.ts'

type SlackChannel = { id?: string; name?: string; is_member?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean; is_ext_shared?: boolean }
export type SlackClient = {
  conversations: {
    list(args: Record<string, unknown>): Promise<{
      channels?: SlackChannel[]
      response_metadata?: { next_cursor?: string }
    }>
    info(args: { channel: string }): Promise<{ channel?: SlackChannel }>
    join(args: { channel: string }): Promise<unknown>
    /** Reads a linked message or a thread; needs `channels:history` (`groups:history` for private channels). */
    replies?(args: { channel: string; ts: string; oldest?: string; latest?: string; inclusive?: boolean; limit: number }): Promise<{ messages?: SlackMessage[]; has_more?: boolean }>
    /** Reads a channel, newest first, for `vb sources <key> read`; needs `channels:history`. */
    history?(args: { channel: string; limit: number }): Promise<{ messages?: SlackMessage[]; has_more?: boolean }>
  }
  users?: {
    info(args: { user: string }): Promise<{ user?: SlackUser }>
    lookupByEmail?(args: { email: string }): Promise<{ user?: SlackUser }>
  }
  files?: { delete(args: { file: string }): Promise<unknown> }
  /** Posts an agent's message under its own name; needs `chat:write.customize` for `username` and `icon_url`. */
  chat?: {
    postMessage(args: SlackPost): Promise<{ ts?: string }>
    /** A message's link, with the workspace's own host and a reply's `thread_ts`. */
    getPermalink?(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>
  }
  /** Says which scopes the app has (`response_metadata.scopes`, from Slack's `x-oauth-scopes`). */
  /** Also whose a token is (`user_id`), for a person's own. */
  auth?: { test(args?: Record<string, unknown>): Promise<{ user_id?: string; user?: string; response_metadata?: { scopes?: string[] } }> }
}

type SlackPost = {
  channel: string
  thread_ts?: string
  text?: string
  markdown_text?: string
  username?: string
  icon_url?: string
  unfurl_links?: boolean
  unfurl_media?: boolean
}

/** What the Slack adapter does to a message before posting it, used when vboard posts one itself. */
type SlackInternals = Omit<Adapter, 'decodeThreadId'> & {
  decodeThreadId(threadId: string): { channel: string; threadTs: string }
  formatConverter?: { toSlackPayload?(message: { markdown: string }): { text: string } | { markdown_text: string } }
  resolveMessageMentions?(message: { markdown: string }, threadId: string): Promise<{ markdown: string }>
}

/** The `**name**: ` a message's text opens with, taken out when Slack shows the name as the sender. */
export function withoutLabel(markdown: string, name: string): string {
  const label = new RegExp(`^\\*\\*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*: `)
  return markdown.replace(label, '')
}

/** HTML elements GitHub renders in comments; anything else in angle brackets (`<@U123>`, `<https://…>`, `a < b`) is left alone. */
const HTML_TAGS = new Set(
  'a abbr b bdi bdo blockquote br caption center cite code dd del details dfn div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q rp rt ruby s samp section small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video wbr'.split(' '),
)
const MARKS: Record<string, string> = { b: '**', strong: '**', i: '_', em: '_', code: '`', kbd: '`', s: '~~', del: '~~', strike: '~~' }
const BLOCKS = new Set(['p', 'div', 'details', 'table', 'tr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const attribute = (attrs: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)?.slice(1).find((v) => v !== undefined) ?? ''

/** GitHub's markdown allows inline HTML, which Slack shows as raw tags: as markdown instead, outside code. */
export function withoutHtml(markdown: string): string {
  if (!/<\/?[a-z!]/i.test(markdown) || /[\uE000\uE001]/.test(markdown)) return markdown
  // Code keeps its HTML, byte for byte: it's what someone wanted shown. Read left to right, so a
  // code span's `<!--` stays code and a comment hides everything in it, backticks and all.
  const code: string[] = []
  let hidden = false
  const text = markdown.replace(
    /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[^\n]*?``|`[^`\n]+`)|<!--[\s\S]*?(?:-->|$)/g,
    (_, span: string | undefined) => (span === undefined ? ((hidden = true), '') : `\uE000${code.push(span) - 1}\uE001`),
  )
  const out = text
    .replace(/<img\b([^>]*)>/gi, (_, attrs: string) => attribute(attrs, 'alt'))
    .replace(/<source\b[^>]*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
      const href = attribute(attrs, 'href')
      const label = inner.replace(/<[^>]*>/g, '').trim()
      return href ? (label ? `[${label}](${href})` : href) : label
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?([a-z][a-z0-9]*)\b(?:\s[^<>]*)?\/?>/gi, (tag, name: string) => {
      const lower = name.toLowerCase()
      if (!HTML_TAGS.has(lower)) return tag
      const closing = tag.startsWith('</')
      if (lower === 'summary') return closing ? '**\n\n' : '**'
      return MARKS[lower] ?? (BLOCKS.has(lower) && closing ? '\n' : '')
    })
  if (!hidden && out === text) return markdown
  // Tidied around the code, never inside it: each span is still one placeholder here.
  const tidy = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  return tidy.replace(/\uE000(\d+)\uE001/g, (_, i: string) => code[Number(i)]!)
}

/**
 * A sender's picture as Slack's `icon_url`: an https image. The board's built-in agent
 * avatars are SVGs, which Slack won't show, so those keep the app's icon.
 */
export function slackIcon(avatar: string | null): string | null {
  if (!avatar) return null
  try {
    const url = new URL(avatar)
    return url.protocol === 'https:' && !/\/avatars\/[a-z0-9-]+$/.test(url.pathname) && !url.pathname.endsWith('.svg') ? avatar : null
  } catch {
    return null
  }
}

type SlackUser = {
  id?: string
  name?: string
  real_name?: string
  is_bot?: boolean
  profile?: { display_name?: string; real_name?: string; image_72?: string; image_48?: string }
}

type SlackFile = { name?: string; title?: string; permalink?: string }
type SlackMessage = {
  ts?: string
  text?: string
  user?: string
  username?: string
  bot_profile?: { name?: string }
  files?: SlackFile[]
  thread_ts?: string
  reply_count?: number
}
/** What Slack attaches to a message that links another: `is_msg_unfurl` marks a message link's. */
type SlackAttachment = {
  is_msg_unfurl?: boolean
  /** A forward's shared message. */
  is_share?: boolean
  from_url?: string
  original_url?: string
  channel_id?: string
  ts?: string
  author_id?: string
  author_name?: string
  author_subname?: string
  text?: string
  files?: SlackFile[]
}

/**
 * Slack message permalinks in mrkdwn: `https://acme.slack.com/archives/C0123/p1727000000123456`,
 * with `?thread_ts=…` for a reply. Slack escapes `&` in text as `&amp;`.
 */
const PERMALINK = /https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})((?:\?|&amp;|&)[^\s|>]*)?/g

/** `1727000000.123456` → its ISO time. */
const tsTime = (ts: string | undefined) => {
  const seconds = Number(ts)
  return ts && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

const filesOf = (files: SlackFile[] | undefined) =>
  (files ?? []).slice(0, 20).map((file) => ({ name: (file.name || file.title || 'file').slice(0, 1000), url: file.permalink?.slice(0, 4000) ?? null }))

/** A permalink's channel, ts and thread, or null when `url` isn't a Slack message's. */
function permalinkOf(url: string) {
  const match = new RegExp(PERMALINK.source).exec(url)
  if (!match || match.index !== 0) return null
  const [, channel, seconds, micros, query] = match
  const ts = `${seconds}.${micros}`
  return { url: match[0].replaceAll('&amp;', '&'), channel: channel!, ts, thread: /[?&]thread_ts=(\d+\.\d+)/.exec(query?.replaceAll('&amp;', '&') ?? '')?.[1] ?? ts }
}

/** A Slack attachment as a link's snapshot. */
const snapshotOf = (att: SlackAttachment, ts: string, markdown: (mrkdwn: string) => string) => ({
  author: (att.author_subname || att.author_name || att.author_id || 'someone').slice(0, 256),
  text: markdown(att.text ?? '').slice(0, MESSAGE_TEXT_MAX),
  createdAt: tsTime(att.ts ?? ts),
  files: filesOf(att.files),
})

/**
 * Every Slack message a message's mrkdwn links to, in order, with the unfurls Slack attached for them,
 * then the messages it forwards: a forward's shared message is only in its `is_share` attachments.
 */
export function slackLinks(key: string, text: string, attachments: SlackAttachment[] = [], markdown: (mrkdwn: string) => string = (t) => t): ExternalLink[] {
  const links: ExternalLink[] = []
  // A message linked twice (its text and a forward's share) is one link, with whichever snapshot came.
  const add = (found: NonNullable<ReturnType<typeof permalinkOf>>, att: SlackAttachment | undefined) => {
    const known = links.find((link) => link.url === found.url || (link.thread === `${key}:${found.channel}:${found.thread}` && link.message === found.ts))
    if (known) {
      if (!known.snapshot && att) known.snapshot = snapshotOf(att, found.ts, markdown)
      return
    }
    if (found.url.length > 4000 || links.length === LINKS_PER_MESSAGE_MAX) return
    links.push({ url: found.url, thread: `${key}:${found.channel}:${found.thread}`, message: found.ts, snapshot: att ? snapshotOf(att, found.ts, markdown) : null })
  }
  for (const match of text.matchAll(PERMALINK)) {
    const found = permalinkOf(match[0])!
    add(found, attachments.find((att) => att.is_msg_unfurl && ((att.channel_id === found.channel && att.ts === found.ts) || att.from_url?.replaceAll('&amp;', '&') === found.url)))
  }
  for (const att of attachments) {
    const found = att.is_share ? permalinkOf(att.from_url ?? att.original_url ?? '') : null
    if (found) add(found, att)
  }
  return links
}

/**
 * What a forward with no text of its own says: the messages it shares, quoted,
 * so the board (and whoever watches it) reads what was forwarded, not "(no text)".
 */
export function forwardText(links: ExternalLink[]): string {
  return links.filter((link) => link.snapshot).map((link) => {
    const { author, text } = link.snapshot!
    const lines = text.trim() ? text.trim().split('\n') : ['']
    // A first line that opens a block (a fence, a list, a heading, a quote) only works at a line's start.
    const head = /^(```|~~~|[-*+] |\d+[.)] |#{1,6} |>)/.test(lines[0]!) ? [`> **${author}**:`, `> ${lines[0]}`] : [`> **${author}**: ${lines[0]}`]
    return [...head, ...lines.slice(1).map((line) => `> ${line}`)].map((line) => line.trimEnd()).concat('', link.url).join('\n')
  }).join('\n\n')
}

/** Slack's answers that mean "no files from this app", not "try again". */
const REFUSED = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'no_permission',
  'restricted_action',
  'file_uploads_disabled',
  'file_uploads_except_images_disabled',
  'file_upload_size_restricted',
])

/** A Slack API error's code (`missing_scope`), with the scope it needed. */
function slackError(error: unknown): string {
  const data = (error as { data?: { error?: string; needed?: string } }).data
  if (!data?.error) return (error as Error).message
  return data.needed ? `${data.error}, needs ${data.needed}` : data.error
}

/** Extensions Slack shows as text (a preview, not a download): it calls any other extension binary. */
const SLACK_TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bash', 'sql', 'diff', 'patch'])
const TEXT_TYPES = /^(text\/|application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|x-sh)\b)/

/**
 * The name a file goes to Slack under. Slack picks a file's type from its
 * extension, so a text file named `run.log` arrives as a binary download;
 * `run.log.txt` arrives as text it previews. The board keeps the file's own name.
 */
export function slackFileName(filename: string, mimeType?: string): string {
  if (!mimeType || !TEXT_TYPES.test(mimeType)) return filename
  const extension = /\.([^./]+)$/.exec(filename)?.[1]?.toLowerCase()
  return extension && SLACK_TEXT_EXTENSIONS.has(extension) ? filename : `${filename}.txt`
}

export const SlackEvent = eventSchema('slack', 'message')
export type SlackEvent = z.infer<typeof SlackEvent>

export type SlackHandler = SyncHandler<SlackEvent>
export type SlackOptions = {
  /**
   * A Vercel Connect connector (`'slack/acme'`): vboard builds the Slack adapter,
   * its Web API client, and people's sign-in, so messages they write post as them.
   * Or your own Chat SDK adapter, wrapped in `withUserTokens` to post as people.
   */
  adapter: Adapter | string
  render?: (input: RenderInput) => string
  /** Not needed with a connector. */
  client?: () => Promise<SlackClient>
  channels: Record<string, EventMapping<SlackEvent>>
}

/**
 * Syncs Slack channels with board channels. Keys are channels by name
 * (`'#prs'`) or ID (`'C0123ABC'`); values are a board channel (a two-way
 * mirror) or a callback that handles every incoming event. The app joins public
 * channels it isn't in; private ones need an invite.
 */
export function slack(options: SlackOptions): SlackProvider {
  return new SlackProvider(options)
}

type SlackWithTokens = Adapter & { webClient?: SlackClient; withBotToken?<T>(token: string, fn: () => T): T }

/** A Slack adapter, client, and people's tokens, all from one Vercel Connect connector. */
function fromConnector(connector: string) {
  const credentials = connectSlackAdapter(connector)
  const adapter = withUserTokens(createSlackAdapter(credentials) as unknown as SlackWithTokens, connectUserTokens(connector))
  const botToken = credentials.botToken
  const client = async () => adapter.withBotToken!(typeof botToken === 'function' ? await botToken() : botToken, () => adapter.webClient!)
  return { adapter: adapter as Adapter, client }
}

export class SlackProvider extends ChatSyncProvider<SlackEvent> {
  private readonly web: () => Promise<SlackClient | undefined>
  private customize: Promise<boolean> | undefined

  constructor(given: SlackOptions) {
    const connected = typeof given.adapter === 'string' ? fromConnector(given.adapter) : null
    const options = connected ? { ...given, adapter: connected.adapter, client: given.client ?? connected.client } : { ...given, adapter: given.adapter as Adapter }
    const tokens = options.adapter as SlackWithTokens
    let directClient: SlackClient | undefined
    if (!options.client) {
      try {
        directClient = (options.adapter as Adapter & { webClient?: SlackClient }).webClient
      } catch {
        throw new Error('slack requires a public client resolver when the adapter uses async tokens')
      }
    }
    async function client(): Promise<SlackClient | undefined> {
      return options.client ? options.client() : directClient
    }

    // One listing resolves every name. A miss lists again, since the channel may be
    // new (the sync engine throttles retries). Without `groups:read`, Slack refuses
    // to list private channels at all, so the listing falls back to public ones.
    let listing: Promise<SlackChannel[]> | undefined
    let publicOnly = false
    async function list(client: SlackClient, types: string): Promise<SlackChannel[]> {
      const channels: SlackChannel[] = []
      let cursor: string | undefined
      do {
        const page = await client.conversations.list({
          types,
          exclude_archived: true,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        })
        channels.push(...(page.channels ?? []))
        cursor = page.response_metadata?.next_cursor || undefined
      } while (cursor)
      return channels
    }
    async function listAll(client: SlackClient): Promise<SlackChannel[]> {
      if (!publicOnly)
        try {
          return await list(client, 'public_channel,private_channel')
        } catch (error) {
          if (!slackError(error).startsWith('missing_scope')) throw error
          publicOnly = true
        }
      return list(client, 'public_channel')
    }
    function channels(client: SlackClient, fresh: boolean) {
      if (fresh || !listing) {
        const promise = listAll(client)
        promise.catch(() => {
          if (listing === promise) listing = undefined
        })
        listing = promise
      }
      return listing
    }

    async function find(client: SlackClient, name: string): Promise<SlackChannel & { id: string }> {
      const match = (all: SlackChannel[]) =>
        all.find((channel): channel is SlackChannel & { id: string } => channel.name === name && !!channel.id)
      let found
      try {
        found = match(await channels(client, false)) ?? match(await channels(client, true))
      } catch (error) {
        throw new UnreadableError('list_failed', `can't list Slack channels to find #${name} (${slackError(error)}); use its ID instead`)
      }
      if (!found)
        throw new UnreadableError(
          'channel_not_found',
          publicOnly
            ? `no public Slack channel named #${name} (the app lacks groups:read, so a private channel needs its ID)`
            : `no Slack channel named #${name} (a private channel shows up once the app is invited)`,
        )
      return found
    }

    // Slack only sends a channel's events to apps in it. Never throws: a channel the
    // app can't join still resolves, and the log says who to invite.
    const joined = new Map<string, Promise<void>>()
    function join(client: SlackClient, id: string, known?: SlackChannel) {
      let promise = joined.get(id)
      if (!promise) {
        promise = (async () => {
          const channel = known ?? (await client.conversations.info({ channel: id }).then((r) => r.channel, () => undefined))
          if (!channel || channel.is_member) return
          const label = channel.name ? `#${channel.name}` : id
          if (channel.is_private)
            return console.warn(`[vboard] slack: invite the app to ${label}; it can't join private channels itself`)
          try {
            await client.conversations.join({ channel: id })
          } catch (error) {
            joined.delete(id)
            console.warn(`[vboard] slack: couldn't join ${label} (${slackError(error)}); invite the app to it`)
          }
        })()
        joined.set(id, promise)
      }
      return promise
    }

    // Slack's events carry user IDs only; their pictures come from users.info, once each.
    const avatars = new Map<string, Promise<string | null>>()
    function avatarOf(user: string): Promise<string | null> {
      let promise = avatars.get(user)
      if (!promise) {
        promise = client()
          .then(async (web) => {
            const profile = (await web?.users?.info({ user }))?.user?.profile
            return profile?.image_72 ?? profile?.image_48 ?? null
          })
          .catch(() => null)
        avatars.set(user, promise)
      }
      return promise
    }

    // Slack's own mrkdwn → markdown, the way Chat SDK reads every Slack message.
    const converter = (options.adapter as { formatConverter?: { toAst(text: string): Parameters<typeof stringifyMarkdown>[0] } }).formatConverter
    const mrkdwn = (text: string) => {
      try {
        return converter ? stringifyMarkdown(converter.toAst(text)).trim() : text
      } catch {
        return text
      }
    }
    const names = new Map<string, Promise<string>>()
    function nameOf(user: string): Promise<string> {
      let promise = names.get(user)
      if (!promise) {
        promise = client()
          .then(async (web) => {
            const found = (await web?.users?.info({ user }))?.user
            return found?.profile?.real_name || found?.real_name || found?.profile?.display_name || found?.name || user
          })
          .catch(() => user)
        names.set(user, promise)
      }
      return promise
    }

    const fileIds = (raw: unknown) => ((raw as { uploadedFileIds?: string[] } | null)?.uploadedFileIds ?? []).filter(Boolean)
    // Slack tags each file with its event's team, and the adapter fetches a tagged
    // file with that team's installed token, which a single-workspace app (one bot
    // token, as Vercel Connect gives it) never stores: "Installation not found".
    // Without the tag, the adapter uses its bot token.
    // An app that can also install through OAuth (a client ID) keeps the tag, so
    // each team's files use that team's token.
    const internals = options.adapter as Adapter & { defaultBotTokenProvider?: unknown; installationProvider?: unknown; clientId?: unknown }
    const singleWorkspace = !!internals.defaultBotTokenProvider && !internals.installationProvider && !internals.clientId
    super({
      fileIds,
      fileToFetch(file) {
        if (!singleWorkspace || !file.fetchMetadata) return file
        const { teamId: _team, enterpriseId: _enterprise, isEnterpriseInstall: _install, ...rest } = file.fetchMetadata
        return { ...file, fetchMetadata: rest }
      },
      render: options.render,
      platform: 'slack',
      adapter: options.adapter,
      canStartThreads: true,
      // The adapter uploads files given without text as their own message: here, right after the text.
      async uploadFiles(thread, files) {
        const sent = await options.adapter.postMessage(thread, { markdown: '', files })
        return { message: sent.id, files: fileIds(sent.raw) }
      },
      uploadName: (file) => slackFileName(file.filename, file.mimeType),
      refusesFiles: (error) => REFUSED.has((error as { data?: { error?: string } } | null)?.data?.error ?? ''),
      async deleteFiles(ids) {
        const web = await client()
        for (const file of ids)
          await web?.files?.delete({ file }).catch((error: unknown) => console.warn(`[vboard] slack: couldn't delete file ${file} (${slackError(error)})`))
      },
      async findByEmail(email) {
        const web = await client()
        const user = (await web?.users?.lookupByEmail?.({ email }).catch(() => undefined))?.user
        if (!user?.id) return null
        const handle = user.profile?.display_name || user.name || user.id
        return {
          id: `slack:user:${user.id}`, handle,
          name: user.profile?.real_name || user.real_name || handle,
          avatar: user.profile?.image_72 ?? user.profile?.image_48 ?? null,
          isBot: user.is_bot === true,
        }
      },
      mention: (actor) => actor.id.startsWith('slack:user:') ? `<@${actor.id.slice('slack:user:'.length)}>` : null,
      // `#name` is looked up by name; anything else is a channel ID.
      async resolveChannel(key) {
        if (!key.startsWith('#')) {
          const web = await client().catch(() => undefined)
          if (web) await join(web, key)
          return key
        }
        const web = await client()
        if (!web) throw new Error(`can't look up Slack channel ${key}: use its ID instead`)
        const channel = await find(web, key.slice(1))
        await join(web, channel.id, channel)
        return channel.id
      },
      // A forward has no text of its own: it says what it shares.
      markdown(message) {
        const text = markdownOf(message)
        if (text.trim()) return text
        const raw = message.raw as { attachments?: SlackAttachment[] } | null
        const shared = Array.isArray(raw?.attachments) ? raw.attachments.filter((att) => att.is_share) : []
        return shared.length ? forwardText(slackLinks('', '', shared, mrkdwn)) : text
      },
      links(key, message) {
        const raw = message.raw as { text?: unknown; attachments?: SlackAttachment[] } | null
        return slackLinks(key, typeof raw?.text === 'string' ? raw.text : message.text, Array.isArray(raw?.attachments) ? raw.attachments : [], mrkdwn)
      },
      // A link Slack didn't unfurl, read with the app's token, but only from a public channel
      // the app is already in. The token reads what the app can, not what the person who
      // posted the link can, and every board reader would see the snapshot: private
      // channels and DMs are left to Slack's unfurl, which checks the poster. Nor does it
      // join a channel someone linked, which would announce the app there.
      async fetchLink(link): Promise<FetchedLink> {
        const [, channel, thread] = link.thread.split(':')
        const web = await client()
        if (!web?.conversations.replies || !channel || !thread) return { snapshot: null, unavailable: 'no Slack client to read it with' }
        let found: SlackMessage | undefined
        try {
          const info = (await web.conversations.info({ channel })).channel
          if (!info) return { snapshot: null, unavailable: 'channel_not_found' }
          if (info.is_private || info.is_im || info.is_mpim) return { snapshot: null, unavailable: 'private_channel' }
          if (!info.is_member) return { snapshot: null, unavailable: 'not_in_channel' }
          const { messages } = await web.conversations.replies({ channel, ts: thread, oldest: link.message, latest: link.message, inclusive: true, limit: 1 })
          found = messages?.find((m) => m.ts === link.message)
        } catch (error) {
          return { snapshot: null, unavailable: slackError(error) }
        }
        if (!found) return { snapshot: null, unavailable: 'message_not_found' }
        const author = found.user ? await nameOf(found.user) : found.username || found.bot_profile?.name || 'someone'
        return { unavailable: null, snapshot: {
          author: author.slice(0, 256), text: mrkdwn(found.text ?? '').slice(0, MESSAGE_TEXT_MAX),
          createdAt: tsTime(found.ts), files: filesOf(found.files),
        } }
      },
      // A channel or thread read on demand (`vb sources <key> read`), with the same limits as a link:
      // public channels the app is already in. It never joins (that would announce the
      // app, and Slack would start sending the channel's events), and nothing it reads
      // is stored; the board still only listens to the channels it's configured with.
      async read(target, { limit }): Promise<SourceRead> {
        const web = await client()
        if (!web) throw new UnreadableError('no_client', 'no Slack client to read it with')
        let channel: string
        let thread: string | null = null
        const link = new RegExp(PERMALINK.source).exec(target)
        if (link) {
          const [, id, seconds, micros, query] = link
          channel = id!
          thread = /[?&]thread_ts=(\d+\.\d+)/.exec(query?.replaceAll('&amp;', '&') ?? '')?.[1] ?? `${seconds}.${micros}`
        } else if (target.startsWith('#')) {
          channel = (await find(web, target.slice(1))).id
        } else {
          const parsed = /^([A-Z0-9]+)(?::(\d+\.\d+))?$/.exec(target)
          if (!parsed) throw new UnreadableError('invalid_target', `not a Slack channel, thread, or message link: ${target} (try #name, C0123, C0123:1727000000.123456, or a permalink)`)
          channel = parsed[1]!
          thread = parsed[2] ?? null
        }
        let found: SlackMessage[]
        let more = false
        let name: string | null = null
        try {
          const info = (await web.conversations.info({ channel })).channel
          if (!info) throw new UnreadableError('channel_not_found', `no Slack channel ${channel}`)
          name = info.name ?? null
          const label = name ? `#${name}` : channel
          if (info.is_private || info.is_im || info.is_mpim)
            throw new UnreadableError('private_channel', `${label} is private: the board only reads public channels on demand`)
          // Slack Connect: another organization's people write here, so it isn't ours to read on demand.
          if (info.is_ext_shared)
            throw new UnreadableError('shared_channel', `${label} is shared with another organization: the board doesn't read those on demand`)
          if (!info.is_member)
            throw new UnreadableError('not_in_channel', `the app isn't in ${label}: someone needs to add it (it won't join on its own)`)
          if (thread) {
            const replies = web.conversations.replies
            if (!replies) throw new UnreadableError('no_client', "this Slack client can't read threads")
            let page = await replies({ channel, ts: thread, limit })
            // A reply's ts reads only that reply: read the thread it's in instead.
            const root = page.messages?.[0]?.thread_ts
            if (root && root !== thread) {
              thread = root
              page = await replies({ channel, ts: root, limit })
            }
            found = page.messages ?? []
            more = page.has_more ?? false
          } else {
            if (!web.conversations.history) throw new UnreadableError('no_client', "this Slack client can't read channels")
            const page = await web.conversations.history({ channel, limit })
            found = (page.messages ?? []).reverse()
            more = page.has_more ?? false
          }
        } catch (error) {
          if (error instanceof UnreadableError) throw error
          throw new UnreadableError(slackError(error).split(',')[0]!, `Slack refused to read ${target}: ${slackError(error)}`)
        }
        const messages = await Promise.all(found.slice(0, limit).filter((m) => m.ts).map(async (m): Promise<SourceMessage> => ({
          id: m.ts!,
          thread: `${channel}:${m.thread_ts ?? m.ts}`,
          author: (m.user ? await nameOf(m.user) : m.username || m.bot_profile?.name || 'someone').slice(0, 256),
          text: mrkdwn(m.text ?? '').slice(0, MESSAGE_TEXT_MAX),
          createdAt: tsTime(m.ts),
          replies: m.reply_count ?? 0,
          files: filesOf(m.files),
        })))
        return { channel, name, thread, messages, more: more || found.length > limit }
      },
      // Slack unfurls a message link a moment later, as a `message_changed` that keeps the text.
      // Chat SDK drops those (nothing it shows changed), so they come here.
      intercept(key, _headers, body): ReceivedEvent[] {
        let event: { type?: string; subtype?: string; channel?: string; message?: SlackMessage & { thread_ts?: string; attachments?: SlackAttachment[] }; previous_message?: { text?: string } } | undefined
        try {
          event = (JSON.parse(body) as { event?: typeof event }).event
        } catch {
          return []
        }
        const inner = event?.message
        if (event?.type !== 'message' || event.subtype !== 'message_changed' || !event.channel || !inner?.ts) return []
        if (!inner.attachments?.some((att) => att.is_msg_unfurl) || inner.text !== event.previous_message?.text) return []
        // Every link, unfurled or not: the event replaces the message's links, and the board
        // keeps what it already knew about the ones Slack didn't unfurl.
        const links = slackLinks(key, inner.text ?? '', inner.attachments, mrkdwn)
        const unfurled = links.filter((link) => link.snapshot)
        if (unfurled.length === 0) return []
        const thread = `${key}:${event.channel}:${inner.thread_ts ?? inner.ts}`
        return [{
          dedupe: `unfurl:${thread}|${inner.ts}|${unfurled.map((link) => link.message).join(',')}`,
          raw: event,
          event: {
            kind: 'edited', channel: `${key}:${event.channel}`, thread, subthread: null, message: inner.ts,
            text: inner.text ?? '', linksOnly: true, links,
            author: { id: 'slack:system', handle: 'slack', name: 'Slack', avatar: null, isBot: true },
          },
        }]
      },
      avatar: (message: ChatMessage) => (message.author.userId ? avatarOf(message.author.userId) : Promise.resolve(null)),
      groupThread: (thread) => thread,
      // A Slack thread is named by its root message's ts.
      isRoot: (thread, messageId) => thread.slice(thread.lastIndexOf(':') + 1) === messageId,
      context: () => null,
      ...(typeof tokens.withBotToken === 'function'
        ? {
            runAs: <T>(token: string, fn: () => Promise<T>) => tokens.withBotToken!(token, fn),
            async whoAmI(token: string) {
              const me = await tokens.withBotToken!(token, () => tokens.webClient!.auth!.test())
              if (!me.user_id) throw new Error("Slack didn't say whose token this is")
              const web = await client().catch(() => undefined)
              const user = (await web?.users?.info({ user: me.user_id }).catch(() => undefined))?.user
              const handle = user?.profile?.display_name || user?.name || me.user || me.user_id
              return {
                id: `slack:user:${me.user_id}`, handle,
                name: user?.profile?.real_name || user?.real_name || handle,
                avatar: user?.profile?.image_72 ?? user?.profile?.image_48 ?? null,
                isBot: false,
              }
            },
          }
        : {}),
      async resolveTarget(target): Promise<ResolvedTarget> {
        const at = target.indexOf(':')
        const channel = await this.resolveChannel(at === -1 ? target : target.slice(0, at))
        return { target: at === -1 ? channel : `${channel}:${target.slice(at + 1)}`, channel, kind: at === -1 ? 'channel' : 'thread' }
      },
    })
    for (const [key, value] of Object.entries(options.channels)) this.map(key, value)
    this.web = client
  }

  /**
   * An agent's message goes out under its own name (`clever-lemur via vboard-factory`), and its
   * picture when it has one Slack can show, instead of the app's, with the text's
   * `**name**: ` label dropped. Without `chat:write.customize` it posts as the app, label and all.
   */
  override async post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost): Promise<ProviderDelivery> {
    const { as, ...given } = body
    const post = { ...given, markdown: withoutHtml(given.markdown) }
    return (as && !post.files?.length ? await this.postNamed(target, as, post.markdown) : null) ?? super.post(target, kind, post)
  }

  /** An edit keeps the label out only where the message went out under the agent's name. */
  override async edit(thread: string, message: string, body: ProviderPost) {
    const { as, ...given } = body
    const post = { ...given, markdown: withoutHtml(given.markdown) }
    const named = as ? await this.sentAs(thread, message, as.name) : false
    await super.edit(thread, message, named && as ? { ...post, markdown: withoutLabel(post.markdown, as.name) } : post)
  }

  private async postNamed(target: string, as: ProviderSender, markdown: string): Promise<ProviderDelivery | null> {
    const adapter = (await this.ready()) as SlackInternals
    const web = await this.web()
    if (!web?.chat || !adapter.formatConverter?.toSlackPayload || !(await this.canCustomize(web))) return null
    const threadId = this.toChat(target)
    const { channel, threadTs } = adapter.decodeThreadId(threadId)
    const message = { markdown: withoutLabel(markdown, as.name) }
    const resolved = (await adapter.resolveMessageMentions?.(message, threadId)) ?? message
    const icon = slackIcon(as.avatar)
    const sent = await web.chat.postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...adapter.formatConverter.toSlackPayload(resolved),
      unfurl_links: false,
      unfurl_media: false,
      username: as.name.slice(0, 80),
      ...(icon ? { icon_url: icon } : {}),
    })
    if (!sent.ts) throw new Error('slack: chat.postMessage returned no ts')
    return { thread: this.toNative(`${adapter.name}:${channel}:${threadTs || sent.ts}`), message: sent.ts }
  }

  /** Whether the app may set a message's username and icon (`chat:write.customize`), asked once. */
  private canCustomize(web: SlackClient): Promise<boolean> {
    this.customize ??= (async () => (await web.auth?.test())?.response_metadata?.scopes?.includes('chat:write.customize') ?? false)().catch(
      (error: unknown) => {
        this.customize = undefined
        console.warn(`[vboard] slack: couldn't check the app's scopes (${slackError(error)}); posting as the app`)
        return false
      },
    )
    return this.customize
  }

  /** Whether a message Slack has went out under `name`. */
  private async sentAs(thread: string, message: string, name: string): Promise<boolean> {
    const web = await this.web().catch(() => undefined)
    const channel = thread.slice(0, thread.indexOf(':'))
    if (!web?.conversations.replies || !channel) return false
    const found = await web.conversations
      .replies({ channel, ts: message, oldest: message, latest: message, inclusive: true, limit: 1 })
      .then((page) => page.messages?.find((m) => m.ts === message), () => undefined)
    return found?.username === name.slice(0, 80)
  }

  /**
   * Slack's link to the event's message, from `chat.getPermalink`, so it has the workspace's
   * own host (Enterprise Grid included) and a reply's `thread_ts`. Null for an event without
   * one message to link (a lifecycle event, or a deleted message Slack no longer has); throws
   * when Slack won't say. It reads only the URL: nothing is synced or joined.
   */
  override async permalink(event: SlackEvent): Promise<string | null> {
    if (event.kind === 'lifecycle' || event.kind === 'deleted') return null
    const channel = event.channel.slice(event.key.length + 1)
    const web = await this.web()
    if (!web?.chat?.getPermalink) throw new Error('slack: no client with chat.getPermalink to link the message with')
    let found: string | undefined
    try {
      found = (await web.chat.getPermalink({ channel, message_ts: event.message })).permalink
    } catch (error) {
      throw new Error(`slack: couldn't get the permalink for ${channel} ${event.message} (${slackError(error)})`)
    }
    if (!found) throw new Error('slack: chat.getPermalink returned no permalink')
    return found
  }

  override eventId(key: string, input: ChatInput): string {
    if (input.kind !== 'reaction') return super.eventId(key, input)
    const reaction = input.reaction
    const stamp = z.looseObject({ event_ts: z.string().min(1) }).parse(reaction.raw).event_ts
    return `reaction:${key}:${this.toNative(reaction.threadId)}|${reaction.messageId}|${reaction.rawEmoji}|${reaction.user.userId}|${reaction.added}|${stamp}`
  }

  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>): SlackEvent {
    return SlackEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
export { withUserTokens, type UserTokens } from './users.ts'
