import type { BoardEventView, GrantView, Me, MessageView, PrincipalView, ScheduleView, SourceRead, SyncedView, ThreadSummaryView, TokenView } from '../api/routes.ts'
import { displayEmoji } from '../contract/emoji.ts'
import { fileSize } from '../contract/files.ts'
import { displayText } from '../contract/bots.ts'
import type { CheckResult, ConformanceReport } from '../conformance/index.ts'

/** "claude via julian" for a profile, the name otherwise. */
/**
 * Text for a terminal. What boards and platforms say can carry control characters, ESC among them,
 * which starts the sequences that clear the screen, move the cursor, or retitle the window: each
 * but tab and newline shows as its picture (`␛`), a C1 control as `�`, and a Windows line end as a
 * newline. `--json` prints what the board said, as it said it.
 */
export const terminalText = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : '\ufffd'
  })

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

/** How many people a reaction names before it counts the rest: `👀 ada, claude, codex +9`. */
export const REACTION_NAMES = 3

function reactions(message: MessageView, names: Map<string, string>): string {
  const groups = Object.entries(message.reactions)
  if (groups.length === 0) return ''
  return groups
    .map(([emoji, actors]) => {
      const shown = actors.slice(0, REACTION_NAMES).map((id) => names.get(id) ?? id).join(', ')
      return `${displayEmoji(emoji)} ${shown}${actors.length > REACTION_NAMES ? ` +${actors.length - REACTION_NAMES}` : ''}`
    })
    .join('   ')
}

/** The actors a thread's reactions name on screen, for looking up the ones who didn't write in it. */
export function reactionNames(messages: MessageView[]): string[] {
  return [...new Set(messages.flatMap((m) => Object.values(m.reactions).flatMap((actors) => actors.slice(0, REACTION_NAMES))))]
}

/** An actor's display name from `/actors`, the way a message's author shows: `claude via julian`. */
export function actorName(actor: { handle: string; name: string }): string {
  const slash = actor.handle.indexOf('/')
  return slash === -1 ? actor.name : `${actor.name} via ${actor.handle.slice(0, slash)}`
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
    ...files.map((file) => `${pad}> file ${file.name}${file.url ? ` ${file.url}` : ''}`),
  ]
}

/** One message as a block: header line, indented text, reactions. */
export function formatMessage(message: MessageView, options: { reply?: boolean; names?: Map<string, string> } = {}) {
  const pad = options.reply ? '    ' : '      '
  const head = `${options.reply ? '  ↳ ' : ''}#${message.id}  ${authorName(message)} · ${ago(message.createdAt)}${
    message.editedAt ? ' (edited)' : ''
  }${message.schedule ? ` · scheduled ${message.schedule.id}` : ''}${labels(message)}`
  const body = message.deleted ? `${pad}(message removed)` : indent(displayText(message.text, message.by.actor), pad)
  const files = (message.attachments ?? []).map((a) => `${pad}file ${a.name} · ${a.type} · ${fileSize(a.size)} · ${a.id}`)
  const links = message.deleted ? [] : (message.links ?? []).flatMap((link) => embed(link, pad))
  const reacted = reactions(message, options.names ?? new Map())
  const undelivered = Object.entries(message.undelivered ?? {}).map(([target, error]) => `${pad}✗ didn't reach ${target}: ${error}`)
  return [head, body, ...files, ...links, ...(reacted ? [`${pad}${reacted}`] : []), ...undelivered].join('\n')
}

/** Threads in order, each root followed by its replies. */
export function formatThreads(messages: MessageView[], known: Map<string, string> = new Map()): string {
  const names = new Map([...known, ...messages.map((m) => [m.by.actor, authorName(m)] as const)])
  const byRoot = new Map<string, MessageView[]>()
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

/** A root's first line, cut to fit 80 columns under its header. */
function firstLine(message: MessageView): string {
  if (message.deleted) return '(message removed)'
  const text = displayText(message.text, message.by.actor).trim()
  const files = message.attachments?.length ?? 0
  if (!text) return files ? `(${files} ${files === 1 ? 'file' : 'files'})` : '(no text)'
  const [line = '', ...rest] = text.split(/\r?\n/)
  const shown = rest.length ? `${line.trimEnd()} …` : line
  return shown.length > 74 ? `${line.slice(0, 73)}…` : shown
}

/**
 * One block per thread, for `read <channel>`: the root's header and first line,
 * then how many replies it has and who wrote the latest, and when.
 */
export function formatThreadSummaries(threads: ThreadSummaryView[], options: { channel?: boolean; now?: number } = {}): string {
  const now = options.now ?? Date.now()
  return threads
    .map(({ message, replies, last }) => {
      const where = options.channel ? `${message.channel}  ` : ''
      const head = `#${message.id}  ${where}${authorName(message)} · ${ago(message.createdAt, now)}${labels(message)}`
      const activity = last
        ? `${replies} ${replies === 1 ? 'reply' : 'replies'} · last #${last.id} ${authorName(last)} · ${ago(last.createdAt, now)}`
        : 'no replies'
      // The root's reactions, counted: `read <id>` names who.
      const counted = Object.entries(message.reactions)
        .filter(([, actors]) => actors.length > 0)
        .map(([emoji, actors]) => `${displayEmoji(emoji)} ${actors.length}`)
        .join('   ')
      return [head, `      ${firstLine(message)}`, ...(counted ? [`      ${counted}`] : []), `      ${activity}`].join('\n')
    })
    .join('\n\n')
}

/**
 * `/me`'s `can` as `whoami` rows, a pattern and its permissions each (`ci/  read
 * post`), or none for full access. `manage` brings everything, so it says `all`.
 */
export function formatAccess(access: Me['can']): string[] {
  const patterns = Object.keys(access)
  if (patterns.length === 1 && patterns[0] === '*' && access['*']!.includes('manage')) return []
  if (patterns.length === 0) return ['nothing']
  const width = Math.max(...patterns.map((pattern) => pattern.length))
  return patterns.map((pattern) => {
    const permissions = access[pattern]!
    return `${pattern.padEnd(width)}  ${permissions.includes('manage') ? 'all' : permissions.length === 0 ? 'nothing' : permissions.join(' ')}`
  })
}

/** What a grant or token may do, as `--can` takes it: `dev/=read,post;ci/=read`, or `all`. */
export function formatCan(can: Me['can']): string {
  const patterns = Object.keys(can)
  if (patterns.length === 1 && patterns[0] === '*' && can['*']!.includes('manage')) return 'all'
  if (patterns.length === 0) return 'nothing'
  const permissions = (list: readonly string[]) => (list.includes('manage') ? 'all' : list.length === 0 ? 'none' : list.join(','))
  return patterns.map((pattern) => `${pattern}=${permissions(can[pattern]!)}`).join(';')
}

/** Rows of cells, each column padded to its widest, two spaces apart. */
const table = (rows: string[][]) => {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ').trimEnd()).join('\n')
}

/** A workflow as people name it: `ci.yml` for `.github/workflows/ci.yml`. */
const workflowName = (workflow: string) => workflow.replace(/^\.github\/workflows\/(?=[^/]+$)/, '')

/** A principal as the flags that name it: `--user ada@acme.com`, `--project web --environment production,preview`. */
export function principalFlags(principal: PrincipalView): string {
  switch (principal.kind) {
    case 'user':
      return `--user ${principal.email ?? principal.userId}`
    case 'project':
      return `--project ${principal.name ?? principal.projectId} --environment ${principal.environments.join(',')}`
    case 'github':
      return [
        `--github ${principal.repository}`,
        ...(principal.workflow !== undefined ? [`--workflow ${workflowName(principal.workflow)}`] : []),
        ...(principal.branch !== undefined ? [`--git-branch ${principal.branch}`] : []),
        ...(principal.event !== undefined ? [`--event ${principal.event}`] : []),
      ].join(' ')
    case 'oidc':
      return [`--oidc ${principal.issuer}`, ...Object.entries(principal.claims).flatMap(([name, value]) => [value].flat().map((one) => `--claim ${name}=${one}`))].join(' ')
    case 'all-projects':
      return `--all-projects --environment ${principal.environments.join(',')}`
    case 'app':
      return `--app ${principal.name ?? principal.clientId}`
    default:
      return `--${principal.kind}`
  }
}

/**
 * What a grant lets do, as `--can` writes it, `security/=none ci/=read,post`, or in words for
 * `*` alone: `read post react label`, or `everything your role allows` for all of it where team
 * roles cap it.
 */
export function grantCan(can: GrantView['can'], capped: boolean): string {
  const patterns = Object.keys(can)
  const words = (grant: GrantView['can'][string]) => (grant === 'all' ? 'all' : grant.length === 0 ? 'none' : grant.join(','))
  if (patterns.length === 1 && patterns[0] === '*') {
    const all = can['*']!
    if (all === 'all' || all.includes('manage')) return capped ? 'everything your role allows' : 'everything'
    return all.length === 0 ? 'nothing' : all.join(' ')
  }
  return patterns.map((pattern) => `${pattern}=${words(can[pattern]!)}`).join(' ')
}

const grantCells = (grant: GrantView) => [grant.id, grant.principals.map(principalFlags).join(' '), grantCan(grant.can, grant.capped)]

/** Each grant on a row: its ID, who it names (as the flags that would), and what it lets them do. */
export function formatGrants(grants: GrantView[]): string {
  return table(grants.map(grantCells))
}

/** One grant as its row: `g3  --everyone  security/=none`. */
export const grantRow = (grant: GrantView) => grantCells(grant).join('  ')

/** Each token on a row: its ID, its name, what it may do, and when it expires. */
export function formatTokens(tokens: TokenView[], now = Date.now()): string {
  return table(
    tokens.map((token) => [
      token.id,
      token.name,
      formatCan(token.can),
      `expires ${until(token.expiresAt, now)}${token.profile !== null ? ` · as ${token.profile}` : ''}${token.parent !== null ? ` · minted with ${token.parent}` : ''}`,
    ]),
  )
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
          : schedule.canceled?.reason === 'dropped'
            ? 'ended: the board dropped it'
            : schedule.canceled?.reason === 'revoked'
              ? 'ended: its creator can no longer post it'
              : 'canceled'
        : 'done'
  const sent = schedule.sent > 0 ? ` · ${schedule.sent} sent` : ''
  const files = schedule.attachments.length ? ` · ${schedule.attachments.length} ${schedule.attachments.length === 1 ? 'file' : 'files'}` : ''
  const text = displayText(schedule.text, schedule.by.actor)
  return [
    `${pad}${schedule.id}  ${where} · ${repeat}${stop} · ${when}${sent}${files} · by ${authorName(schedule)}`,
    indent(text || '(no text)', `${pad}    `),
  ].join('\n')
}

/** One line per live event, for `tail` and `wait`. */
export function formatEvent(event: BoardEventView): string {
  const message = event.message
  if (!message) return `#${event.cursor}  ${event.type}`
  const where = message.re === null ? message.channel : `${message.channel} ↳ #${message.re}`
  const who = authorName(message)
  switch (event.type) {
    case 'message.posted': {
      const files = (message.attachments ?? []).map((a) => ` · file ${a.name}`).join('')
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
      return `#${event.cursor}  ${event.type}`
  }
}

/**
 * Where a thread is synced, for `vb sync <id>`: a row a target, its sync key and where it is, then
 * the link to the message's copy there, or why it didn't reach it.
 */
export function formatSynced(targets: SyncedView['targets']): string {
  const where = (row: SyncedView['targets'][number]) => row.target.slice(row.key.length + 1)
  const keys = Math.max(...targets.map((row) => row.key.length))
  const wheres = Math.max(...targets.map((row) => where(row).length))
  return targets
    .map((row) => {
      const copy = row.undelivered !== null ? `didn't reach it: ${row.undelivered}` : (row.url ?? (row.message !== null ? `message ${row.message}` : 'no copy yet'))
      return `${row.key.padEnd(keys)}  ${where(row).padEnd(wheres)}  ${terminalText(copy)}`
    })
    .join('\n')
}

/**
 * A channel or thread read with `vb sources <key> read`: a header, then each message under its ID,
 * with the target that reads its thread when it has replies.
 */
export function formatSourceRead(key: string, read: SourceRead, now = Date.now(), cli = 'vb'): string {
  const where = `${key}:${read.channel}${read.name ? ` (#${read.name})` : ''}${read.thread ? `, thread ${read.thread}` : ''}`
  if (read.messages.length === 0) return `${where}\nno messages`
  const blocks = read.messages.map((message) => {
    const reply = read.thread !== null && message.id !== read.thread
    const pad = reply ? '    ' : '      '
    const when = message.createdAt ? ` · ${ago(message.createdAt, now)}` : ''
    const replies = message.replies > 0 && read.thread === null ? `  (${message.replies} ${message.replies === 1 ? 'reply' : 'replies'}: ${cli} sources ${key} read ${message.thread})` : ''
    return [
      `${reply ? '  ↳ ' : ''}${message.id}  ${message.author}${when}${replies}`,
      indent(message.text || '(no text)', pad),
      ...message.files.map((file) => `${pad}file ${file.name}${file.url ? ` ${file.url}` : ''}`),
    ].join('\n')
  })
  const more = read.next
    ? [`(more not shown: ${cli} sources ${key} read ${read.thread ?? read.channel} --after ${read.next})`]
    : read.more ? [`(${read.thread ? 'later replies' : 'older messages'} not shown: raise --limit, up to 200)`] : []
  return [where, ...blocks, ...more].join('\n')
}

/**
 * A conformance report: each group a heading, its checks under it, and why for one that failed
 * or was skipped, then the counts.
 */
export function formatConformance(report: ConformanceReport): string {
  const blocks: string[] = []
  for (const group of [...new Set(report.checks.map((check) => check.group))]) {
    const lines: string[] = [group]
    for (const check of report.checks.filter((c) => c.group === group)) {
      lines.push(`  ${check.status.padEnd(7)}  ${check.name}`)
      if (check.detail) lines.push(`           ${check.detail}`)
    }
    blocks.push(lines.join('\n'))
  }
  const count = (status: CheckResult['status']) => report.checks.filter((check) => check.status === status).length
  const counts = [`${count('passed')} passed`, ...(count('skipped') ? [`${count('skipped')} skipped`] : []), ...(count('failed') ? [`${count('failed')} failed`] : [])]
  return `${blocks.join('\n\n')}\n\n${counts.join(', ')}`
}
