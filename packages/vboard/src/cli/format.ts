import type { BoardEventView, MessageView, ScheduleView, SourceRead, StuckEvent } from '../api/routes.ts'
import { displayEmoji } from '../contract/emoji.ts'
import { fileSize } from '../contract/files.ts'
import { displayText } from '../contract/bots.ts'

/** "claude via julian" for a profile, the name otherwise. */
/** "claude via julian" for a profile, the name otherwise. */
export const who = (me: { name: string; handle: string; profile: string | null }): string =>
  me.profile !== null && me.handle.includes('/') ? `${me.name} via ${me.handle.slice(0, me.handle.indexOf('/'))}` : me.name

export function authorName(message: Pick<MessageView, 'author' | 'by'>): string {
  const author = message.author
  if (!author) return message.by.actor
  const slash = author.handle.indexOf('/')
  if (message.by.profile !== null && slash !== -1)
    return `${author.name} via ${author.handle.slice(0, slash)}`
  return author.name
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')

function labels(message: MessageView): string {
  const entries = Object.entries(message.labels)
  return entries.length ? `  [${entries.map(([k, v]) => `${k}=${v}`).join(' ')}]` : ''
}

function reactions(message: MessageView, names: Map<string, string>): string {
  const groups = Object.entries(message.reactions)
  if (groups.length === 0) return ''
  return groups
    .map(([emoji, actors]) => `${displayEmoji(emoji)} ${actors.map((id) => names.get(id) ?? id).join(', ')}`)
    .join('   ')
}

/** Lines of a linked message an embed shows before it trails off. */
const EMBED_LINES = 12

/** A linked platform message, quoted under the message that links it, or why the board couldn't read it. */
function embed(link: NonNullable<MessageView['links']>[number], pad: string): string[] {
  if (!link.snapshot) return [`${pad}↪ ${link.url} (couldn't read it: ${link.unavailable ?? 'unknown'})`]
  const { author, text, files } = link.snapshot
  const lines = text.trim() ? text.trim().split('\n') : []
  const shown = lines.length > EMBED_LINES ? [...lines.slice(0, EMBED_LINES), '…'] : lines
  return [
    `${pad}↪ ${author}${link.message !== null ? ` · #${link.message}` : ''} · ${link.url}`,
    ...shown.map((line) => `${pad}> ${line}`),
    ...files.map((file) => `${pad}> 📎 ${file.name}${file.url ? ` ${file.url}` : ''}`),
  ]
}

/** One message as a block: header line, indented text, reactions. */
export function formatMessage(message: MessageView, options: { reply?: boolean; names?: Map<string, string> } = {}) {
  const pad = options.reply ? '    ' : '      '
  const head = `${options.reply ? '  ↳ ' : ''}#${message.id}  ${authorName(message)} · ${ago(message.createdAt)}${
    message.editedAt ? ' (edited)' : ''
  }${message.schedule ? ` ⏰ s${message.schedule.id}` : ''}${labels(message)}`
  const body = message.deleted ? `${pad}(message removed)` : indent(displayText(message.text, message.by.actor), pad)
  const files = (message.attachments ?? []).map((a) => `${pad}📎 ${a.name} · ${a.type} · ${fileSize(a.size)} · ${a.id}`)
  const links = message.deleted ? [] : (message.links ?? []).flatMap((link) => embed(link, pad))
  const reacted = reactions(message, options.names ?? new Map())
  const undelivered = Object.entries(message.undelivered ?? {}).map(([target, error]) => `${pad}✗ didn't reach ${target}: ${error}`)
  return [head, body, ...files, ...links, ...(reacted ? [`${pad}${reacted}`] : []), ...undelivered].join('\n')
}

/** Threads in order, each root followed by its replies. */
export function formatThreads(messages: MessageView[]): string {
  const names = new Map(messages.map((m) => [m.by.actor, authorName(m)]))
  const byRoot = new Map<number, MessageView[]>()
  const roots: MessageView[] = []
  const orphans: MessageView[] = []
  for (const message of messages) {
    if (message.re === null) roots.push(message)
    else (byRoot.get(message.re) ?? byRoot.set(message.re, []).get(message.re)!).push(message)
  }
  const rootIds = new Set(roots.map((r) => r.id))
  for (const [root, replies] of byRoot) if (!rootIds.has(root)) orphans.push(...replies)
  const blocks = roots.map((root) =>
    [formatMessage(root, { names }), ...(byRoot.get(root.id) ?? []).map((r) => formatMessage(r, { reply: true, names }))].join('\n'),
  )
  for (const reply of orphans)
    blocks.push(`(in thread #${reply.re})\n${formatMessage(reply, { reply: true, names })}`)
  return blocks.join('\n\n')
}

/** `90m` → `1h30m`, `1d`: milliseconds as a duration flag would say them. */
export function span(ms: number): string {
  const parts: string[] = []
  let rest = Math.round(ms / 1000)
  for (const [unit, size] of [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    if (rest >= size) parts.push(`${Math.floor(rest / size)}${unit}`)
    rest %= size
  }
  return parts.join('') || '0s'
}

/** `in 25m`, or `due` once it's past. */
const until = (iso: string, now: number) => {
  const ms = Date.parse(iso) - now
  if (ms <= 0) return 'due'
  return `in ${span(ms < 60_000 ? Math.ceil(ms / 1000) * 1000 : Math.ceil(ms / 60_000) * 60_000)}`
}

/** A stuck event: its ref (what `stuck retry` takes), what it holds up, and why it stopped. */
export function formatStuck(event: StuckEvent, now = Date.now()): string {
  const where = event.root !== null ? `#${event.root}` : (event.thread ?? event.external ?? event.lane ?? 'no lane')
  const error = (event.error ?? 'no error recorded').split('\n')[0]!.slice(0, 200)
  return `${event.session}#${event.index}  ${event.type}  ${where}  failed ${event.failures}× · stopped ${ago(event.failedAt, now)} ago\n    ${error}`
}

/** One schedule: what it sends, when, where, and how it stops. */
export function formatSchedule(schedule: ScheduleView, options: { pad?: string; now?: number } = {}): string {
  const now = options.now ?? Date.now()
  const pad = options.pad ?? ''
  const where = schedule.re === null ? `new thread in ${schedule.channel}` : `#${schedule.re}`
  const repeat = schedule.every === null ? 'once' : `every ${span(schedule.every)}`
  const stop =
    schedule.every === null
      ? ''
      : schedule.times !== null
        ? ` · ${schedule.times} times`
        : schedule.until !== null
          ? ` · until ${schedule.until}`
          : ' · until canceled'
  const when =
    schedule.state === 'pending'
      ? `next ${until(schedule.next!, now)} (${schedule.next})`
      : schedule.state === 'canceled'
        ? schedule.canceled?.reason === 'thread_deleted'
          ? 'ended: the thread was deleted'
          : 'canceled'
        : 'done'
  const sent = schedule.sent > 0 ? ` · ${schedule.sent} sent` : ''
  const files = schedule.attachments.length ? ` · 📎 ${schedule.attachments.length}` : ''
  const text = displayText(schedule.text, schedule.by.actor)
  return [
    `${pad}⏰ s${schedule.id}  ${where} · ${repeat}${stop} · ${when}${sent}${files} · by ${authorName(schedule)}`,
    indent(text || '(no text)', `${pad}    `),
  ].join('\n')
}

/** One line per live event, for `tail` and `wait`. */
export function formatEvent(event: BoardEventView): string {
  const message = event.message
  if (!message) return `#${event.index}  ${event.type}`
  const where = message.re === null ? message.channel : `${message.channel} ↳ #${message.re}`
  const who = authorName(message)
  switch (event.type) {
    case 'message.posted': {
      const files = (message.attachments ?? []).map((a) => `  📎 ${a.name}`).join('')
      return `#${message.id}  ${where}  ${who}: ${displayText(message.text, message.by.actor)}${files}`
    }
    case 'message.edited':
      return `#${message.id}  ${where}  ${who} (edited): ${displayText(message.text, message.by.actor)}`
    case 'message.deleted':
      return `#${message.id}  ${where}  (message removed)`
    case 'message.linked':
      return `#${message.id}  ${where}  ↪ links ${(message.links ?? []).map((link) => link.message !== null ? `#${link.message}` : link.url).join(', ') || 'nothing'}`
    case 'reaction.added':
    case 'reaction.removed':
      return `#${message.id}  ${where}  ${displayEmoji(event.payload.emoji)} ${
        event.type === 'reaction.added' ? 'added' : 'removed'
      } by ${event.actor?.name ?? event.payload.by.actor}`
    case 'labels.changed': {
      const set = Object.entries(event.payload.set).map(([k, v]) => `${k}=${v}`)
      const unset = event.payload.unset.map((k) => `-${k}`)
      return `#${message.id}  ${where}  labels ${[...set, ...unset].join(' ')}${event.actor ? ` by ${event.actor.name}` : ''}`
    }
    case 'message.sync_failed':
      return `#${message.id}  ${where}  ✗ didn't reach ${event.payload.target}: ${event.payload.error}`
    default:
      return `#${event.index}  ${event.type}`
  }
}

/**
 * A channel or thread read with `vb sources <key> read`: a header, then each message under its ID,
 * with the target that reads its thread when it has replies.
 */
export function formatSourceRead(key: string, read: SourceRead, now = Date.now()): string {
  const where = `${key}:${read.channel}${read.name ? ` (#${read.name})` : ''}${read.thread ? `, thread ${read.thread}` : ''}`
  if (read.messages.length === 0) return `${where}\nno messages`
  const blocks = read.messages.map((message) => {
    const reply = read.thread !== null && message.id !== read.thread
    const pad = reply ? '    ' : '      '
    const when = message.createdAt ? ` · ${ago(message.createdAt, now)}` : ''
    const replies = message.replies > 0 && read.thread === null ? `  (${message.replies} ${message.replies === 1 ? 'reply' : 'replies'}: vb sources ${key} read ${message.thread})` : ''
    return [
      `${reply ? '  ↳ ' : ''}${message.id}  ${message.author}${when}${replies}`,
      indent(message.text || '(no text)', pad),
      ...message.files.map((file) => `${pad}📎 ${file.name}${file.url ? ` ${file.url}` : ''}`),
    ].join('\n')
  })
  const more = read.more ? [`(${read.thread ? 'later replies' : 'older messages'} not shown: raise --limit, up to 200)`] : []
  return [where, ...blocks, ...more].join('\n')
}
