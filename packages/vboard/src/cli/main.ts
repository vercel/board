#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import { FILTER_FLAGS, withMentions } from '../api/tail.ts'
import { BoardError, type Filters, type ProfileOption } from '../client/client.ts'
import { configDir, createClient, detectAgent, projectDir, projectUrl } from '../client/node.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { ATTACHMENT_BYTES_MAX, type Attachment } from '../contract/schemas.ts'
import { startInspector } from '../inspect/server.ts'
import { VERSION } from '../version.ts'
import { formatEvent, formatSchedule, formatSourceRead, formatStuck, formatThreads, who } from './format.ts'
import {
  AGENTS,
  allow,
  allowRules,
  cliOf,
  codexNetwork,
  decideStop,
  disallow,
  installedHook,
  installHook,
  markPosted,
  reminder,
  uninstallHook,
  workOf,
  type HookAgent,
} from './hooks.ts'

const HELP = `vboard ${VERSION}: a message board you mount in one route

usage: vboard <command> [options]      (also installed as \`vb\`)

  whoami                                   who am I, on which board, and when my token expires
  link <url>                               link this project to a board (.vboard/config.json)
  use <url>                                save the default board

  channels                                 channels, grouped by path prefix
  actors                                   actors and their handles

  read <channel> [filters] [--limit N]     threads in a channel, newest last (no channel: every channel)
  read <id>                                one thread

  post <channel> ["<text>"] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--id <key>]
  reply <id> ["<text>"] [--attach <file>]... [--id <key>] [--no-sync]
  schedule <channel|id> ["<text>"] (--in 1d | --at <time> | --every 30m) [--until <time> | --for 24h | --times N]
           [--label k=v]... [--attach <file>]... [--no-sync]
                                           post later, as you: once, or repeating until a stop or until canceled
  schedules [id] [--by <handle>] [--channel <c>] [--all]
                                           pending schedules (a thread's, with an id); --all adds done and canceled
  schedule cancel <schedule>               stop one, e.g. schedule cancel s12 (anyone may)
  edit <id> "<text>"
  delete <id>
  react <id> <emoji> [--remove]
  label <id> k=v... [--unset k]...
  typing <id> [status]                     show typing in the thread's synced platform threads (marks WhatsApp read);
                                           Slack shows the status, if given, instead of "Typing…"
  sync <id> <target>                       attach the thread to e.g. slack:#incidents, backfilling it
  inbox <key> [channel] [--limit N]        raw platform events, for debugging sync
  stuck                                    events that failed 10 times and stopped their thread (full access only)
  stuck retry|skip <event>                 retry one with a fresh 10 tries, or skip it so its thread goes on,
                                           e.g. stuck retry inbox:slack:C0123#55
  sources                                  the board's sources (its sync entries: slack, github, …)
  sources <key> read <channel|thread|link> [--limit N]
                                           read a source's channel, thread, or message link without syncing it,
                                           e.g. sources slack read '#general', or a Slack permalink (full access only)
  download <attachment> [path]             save an attachment (its name, here, by default; - for stdout)

  update ["<text>"] [--attach <file>]...   post a summary to this branch's work thread (channel \`work\`); --skip if there's none
  hooks [install|uninstall|status] [claude|codex|cursor|pi]...
                                           after a turn that didn't update the board, remind the agent to (linked projects only)

  tail [channel] [filters] [--all]         live, until Ctrl-C
  wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit (124 on timeout)

  inspect [--port N] [--no-open]           the board in your browser, as you: read, post, react (local only)

filters:  --re <id>  --by <handle>  --from <source>  --label k[=v|w]  --text <words>  --mentions [@handle]  --after <id>
          labels match a message or its thread's root; repeated flags all must match
global:   --url <url>  --as <profile>  --avatar <url>  --human  --handle <h>  --json
text:     pass "-" to read it from stdin; it may be left out when you --attach
env:      VBOARD_URL  VBOARD_TOKEN  VBOARD_AS  VBOARD_AVATAR  VBOARD_HANDLE`

class UsageError extends Error {}

const parsed = (() => {
  try {
    return parseArgs({
      args: withMentions(process.argv.slice(2)),
      allowPositionals: true,
      options: {
        ...FILTER_FLAGS,
        url: { type: 'string' },
        as: { type: 'string' },
        avatar: { type: 'string' },
        human: { type: 'boolean' },
        handle: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        unset: { type: 'string', multiple: true },
        id: { type: 'string' },
        'no-sync': { type: 'boolean' },
        sync: { type: 'string', multiple: true },
        attach: { type: 'string', multiple: true },
        skip: { type: 'boolean' },
        channel: { type: 'string' },
        agent: { type: 'string' },
        remove: { type: 'boolean' },
        after: { type: 'string' },
        limit: { type: 'string' },
        all: { type: 'boolean' },
        timeout: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        in: { type: 'string' },
        at: { type: 'string' },
        every: { type: 'string' },
        until: { type: 'string' },
        for: { type: 'string' },
        times: { type: 'string' },
      },
    })
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return null
  }
})()
// A misused flag runs nothing: the end of this file exits 2, once the error line is out.
const { values: flags, positionals } = parsed ?? { values: {} as NonNullable<typeof parsed>['values'], positionals: [] as string[] }

const out = (text: string) => process.stdout.write(`${text}\n`)
const printJson = (value: unknown) => out(JSON.stringify(value))

function messageId(value: string | undefined, what = 'message id'): number {
  const id = Number(value?.replace(/^#/, ''))
  if (!value || !Number.isInteger(id) || id <= 0) throw new UsageError(`expected a ${what}, got: ${value ?? '(nothing)'}`)
  return id
}

function labelPairs(values: string[] | undefined): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const value of values ?? []) {
    const at = value.indexOf('=')
    if (at <= 0) throw new UsageError(`labels look like key=value, got: ${value}`)
    pairs[value.slice(0, at)] = value.slice(at + 1)
  }
  return pairs
}

async function text(value: string | undefined): Promise<string> {
  if (value === undefined) throw new UsageError('missing message text')
  if (value !== '-') return value
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')
}


/** Uploads each `--attach` file, checking them all before sending any. */
async function attachments(board: ReturnType<typeof client>): Promise<Attachment[]> {
  const paths = flags.attach ?? []
  for (const path of paths) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new UsageError(`no such file: ${path}`)
    if (info.size > ATTACHMENT_BYTES_MAX) throw new UsageError(`${path} is over ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be`)
  }
  const uploaded: Attachment[] = []
  for (const path of paths)
    uploaded.push(
      await board.upload({
        data: new Uint8Array(await readFile(path)),
        name: basename(path),
      }),
    )
  return uploaded
}

/** `s12` or `12`. */
function scheduleId(value: string | undefined): number {
  const id = Number(value?.replace(/^s/i, ''))
  if (!value || !Number.isInteger(id) || id <= 0) throw new UsageError(`expected a schedule id like s12, got: ${value ?? '(nothing)'}`)
  return id
}

/** A time flag: anything `Date` reads, as ISO. */
function instant(flag: string, value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) throw new UsageError(`--${flag} takes a time like 2026-10-08T09:00:00Z, got: ${value}`)
  return time.toISOString()
}

function filters(channel?: string): Filters & { after?: number } {
  return {
    ...(channel ? { channel } : {}),
    ...(flags.re ? { re: messageId(flags.re) } : {}),
    ...(flags.by ? { by: flags.by } : {}),
    ...(flags.mentions ? { mentions: flags.mentions.replace(/^@/, '') } : {}),
    ...(flags.label?.length ? { label: flags.label } : {}),
    ...(flags.from ? { from: flags.from } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(flags.after !== undefined ? { after: Number(flags.after) } : {}),
  }
}

function client() {
  const profile: ProfileOption | undefined = flags.human
    ? null
    : flags.as
      ? flags.avatar
        ? { name: flags.as, avatar: flags.avatar }
        : flags.as
      : undefined
  return createClient({
    ...(flags.url ? { url: flags.url } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(flags.human ? { session: null } : {}),
    ...(flags.handle ? { handle: flags.handle } : {}),
  })
}

/**
 * What names an agent's turns, for the turn-end hook: its session, or for
 * Cursor, whose shell has no session ID, the project it works in.
 */
const turnKey = (agent: string, session: string | null) => session ?? (agent === 'cursor' ? `cursor@${projectDir()}` : null)

/** A write from an agent session counts as this turn's board update. */
function wrote() {
  const detected = flags.human ? null : detectAgent()
  const key = detected ? turnKey(detected.profile, detected.session) : null
  if (key) markPosted(key)
}

const fromNpx = (path: string) => /[\\/]_npx[\\/]/.test(path)

/** The first `vb` on PATH outside npx's cache, which is gone once npx exits. */
function globalVb(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'vb')
    if (existsSync(candidate) && !fromNpx(realpathSync(candidate))) return realpathSync(candidate)
  }
  return null
}

/**
 * How an agent's hook should run this CLI, long after this command exits:
 * `vb` when that's this CLI; under npx, a global `vb` of this version, else
 * this version through npx; otherwise this CLI's full path.
 */
function cliCommand(): { command: string; note?: string } {
  const self = realpathSync(process.argv[1]!)
  const installed = globalVb()
  if (!fromNpx(self)) {
    if (installed === self) return { command: 'vb' }
    const quote = (part: string) => (/^[\w./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)
    return { command: [process.execPath, self].map(quote).join(' ') }
  }
  let version = ''
  try {
    version = installed ? execFileSync(installed, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() : ''
  } catch {}
  if (version === VERSION) return { command: 'vb' }
  return {
    command: `npx -y vboard@${VERSION}`,
    note: `the hook runs vboard ${VERSION} through npx${installed ? ` (your vb is ${version || 'older'})` : ''}; \`npm i -g vboard\` makes it start faster`,
  }
}

/**
 * One thread per person, repo, and branch, in `work` (or `--channel`): every
 * agent's updates on a branch land together. Created on first use; board-only.
 */
async function postUpdate(board: ReturnType<typeof client>, content: string, files: Attachment[] = []) {
  const channel = flags.channel ?? 'work'
  const work = workOf(process.cwd())
  const me = await board.me()
  // The label matches replies too, so a busy branch can push the root past one page: page back to it.
  const find = async () => {
    let before: number | undefined
    for (let page = 0; page < 20; page++) {
      const { messages } = await board.messages({ channel, label: { work: work.key }, limit: 500, ...(before ? { before } : {}) })
      const root = messages.filter((m) => m.re === null && !m.deleted && m.by.principal === me.principal).at(-1)
      if (root || messages.length < 500) return root
      before = messages[0]!.id
    }
    return undefined
  }
  const create = () =>
    board.post(channel, {
      text: `**${work.repo}** · \`${work.branch}\``,
      labels: { work: work.key, repo: work.repo, branch: work.branch },
      noSync: true,
      // One root per person and branch: a second agent creating it at the same moment gets a conflict, not a twin.
      // Hashed, since ids are at most 200 characters and a principal and branch can be longer.
      id: `work:${createHash('sha256').update(`${me.principal}\n${work.key}`).digest('base64url')}`,
    })
  let root = await find()
  if (!root)
    try {
      root = await create()
    } catch (error) {
      if (!(error instanceof BoardError && error.code === 'duplicate_id')) throw error
      root = await find()
    }
  if (!root || root.deleted) throw new BoardError('no_work_thread', `couldn't find or start the work thread for ${work.key}`, 0)
  return board.reply(root.id, { text: content, noSync: true, ...(files.length ? { attachments: files } : {}) })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function hookAgents(names: string[]): HookAgent[] {
  const known = Object.keys(AGENTS) as HookAgent[]
  for (const name of names)
    if (!known.includes(name as HookAgent)) throw new UsageError(`unknown agent: ${name} (known: ${known.join(', ')})`)
  return names.length ? (names as HookAgent[]) : known
}

function printMessage(message: MessageView) {
  if (flags.json) printJson(message)
  else out(String(message.id))
}

function printEvent(event: BoardEventView) {
  if (flags.json) printJson(event)
  else out(formatEvent(event))
}

/** Best-effort: the URL is printed either way. */
function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  const child = spawn(command!, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function run(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case undefined:
    case 'help':
      out(HELP)
      return 0

    case 'link':
    case 'use': {
      const url = args[0]
      if (!url || args.length !== 1) throw new UsageError(`usage: vboard ${command} <url>`)
      const board = createClient({ url })
      const discovery = await board.discovery()
      const root = command === 'link' ? projectDir() : null
      const directory = root === null ? configDir() : join(root, '.vboard')
      if (root !== null) {
        const path = join(root, '.gitignore')
        const ignore = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return ''
          throw error
        })
        if (!ignore.split(/\r?\n/).some((line) => /^\/?\.vboard\/?$/.test(line)))
          await appendFile(path, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}.vboard/\n`)
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'config.json'), `${JSON.stringify({ url: discovery.url }, null, 2)}\n`, { mode: 0o600 })
      out(root === null ? `using ${discovery.url}` : `linked ${root} to ${discovery.url}`)
      return 0
    }

    case 'whoami': {
      const board = client()
      const me = await board.me()
      if (flags.json) {
        printJson({ ...me, board: board.url })
        return 0
      }
      const name = me.profile !== null ? `${me.name} via ${me.handle.split('/')[0]}` : me.name
      out(`${name} (${me.actor})`)
      out(`board  ${board.url}`)
      if (me.expiresAt) {
        const minutes = Math.max(0, Math.round((Date.parse(me.expiresAt) - Date.now()) / 60_000))
        out(`token  expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`)
      }
      if (me.session) out(`session  ${me.session}`)
      return 0
    }

    case 'channels': {
      const channels = await client().channels()
      if (flags.json) return channels.forEach(printJson), 0
      if (channels.length === 0) return out('no channels yet'), 0
      let group = ''
      for (const channel of channels) {
        const prefix = channel.path.includes('/') ? channel.path.slice(0, channel.path.lastIndexOf('/') + 1) : ''
        if (prefix !== group) {
          if (prefix) out(prefix)
          group = prefix
        }
        out(`${prefix ? '  ' : ''}${channel.path}  ${channel.threads} threads · ${channel.messages} messages · last #${channel.lastIndex}`)
      }
      return 0
    }

    case 'actors': {
      const actors = await client().actors()
      if (flags.json) return actors.forEach(printJson), 0
      for (const actor of actors) out(`@${actor.handle}  ${actor.name}  ${actor.id}`)
      return 0
    }

    case 'read': {
      const target = args[0]
      const filtering = !!(flags.re || flags.by || flags.from || flags.text || flags.mentions || flags.label?.length)
      if (!target && !filtering) throw new UsageError('usage: vboard read <channel|id> [filters], or read [filters] across channels')
      const board = client()
      if (target && /^#?\d+$/.test(target)) {
        const thread = await board.thread(messageId(target))
        if (flags.json) return [thread.message, ...thread.replies].forEach(printJson), 0
        out(formatThreads([thread.message, ...thread.replies]))
        for (const schedule of thread.schedules ?? []) out(formatSchedule(schedule, { pad: '  ' }))
        return 0
      }
      const page = await board.messages({
        ...filters(target),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return page.messages.forEach(printJson), 0
      out(`${target ?? 'all channels'} · cursor ${page.cursor}\n`)
      out(page.messages.length ? formatThreads(page.messages) : 'no messages')
      return 0
    }

    case 'post': {
      const [channel, body] = args
      if (!channel) throw new UsageError('usage: vboard post <channel> "<text>"')
      if (flags.sync?.length && flags['no-sync']) throw new UsageError('--sync and --no-sync contradict each other')
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(body)
      const files = await attachments(board)
      const message = await board.post(channel, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.sync?.length ? { sync: flags.sync } : {}),
      })
      wrote()
      printMessage(message)
      return 0
    }

    case 'reply': {
      const id = messageId(args[0])
      const board = client()
      const content = args[1] === undefined && flags.attach?.length ? '' : await text(args[1])
      const files = await attachments(board)
      const message = await board.reply(id, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      })
      wrote()
      printMessage(message)
      return 0
    }

    case 'schedule': {
      if (args[0] === 'cancel' && args.length === 2) {
        const { schedule, canceled } = await client().cancelSchedule(scheduleId(args[1]))
        if (flags.json) printJson(schedule)
        else out(canceled ? `canceled s${schedule.id}` : `s${schedule.id} is already ${schedule.state}`)
        return 0
      }
      const [target, body] = args
      if (!target) throw new UsageError('usage: vboard schedule <channel|id> "<text>" (--in 1d | --at <time> | --every 30m)')
      if (!flags.in && !flags.at && !flags.every) throw new UsageError('say when: --in 1d, --at <time>, or --every 30m')
      if (flags.sync?.length) throw new UsageError('a schedule posts where you point it: --sync is for post')
      const times = flags.times === undefined ? undefined : Number(flags.times)
      if (times !== undefined && !(Number.isInteger(times) && times > 0)) throw new UsageError(`--times takes a count, got: ${flags.times}`)
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(body)
      const files = await attachments(board)
      const where = /^#?\d+$/.test(target) ? messageId(target) : target
      const schedule = await board.schedule(where, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.in ? { in: flags.in } : {}),
        ...(flags.at ? { at: instant('at', flags.at) } : {}),
        ...(flags.every ? { every: flags.every } : {}),
        ...(flags.until ? { until: instant('until', flags.until) } : {}),
        ...(flags.for ? { for: flags.for } : {}),
        ...(times !== undefined ? { times } : {}),
      })
      wrote()
      if (flags.json) printJson(schedule)
      else out(formatSchedule(schedule))
      return 0
    }

    case 'schedules': {
      const list = await client().schedules({
        ...(args[0] ? { re: messageId(args[0]) } : {}),
        ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
        ...(flags.channel ? { channel: flags.channel } : {}),
        ...(flags.all ? { all: true } : {}),
      })
      if (flags.json) return list.forEach(printJson), 0
      if (list.length === 0) return out(flags.all ? 'no schedules' : 'no pending schedules'), 0
      out(list.map((schedule) => formatSchedule(schedule)).join('\n'))
      return 0
    }

    case 'update': {
      if (flags.skip) {
        wrote()
        out('skipped: nothing to share this turn')
        return 0
      }
      const board = client()
      const content = args[0] === undefined && flags.attach?.length ? '' : await text(args[0])
      const message = await postUpdate(board, content, await attachments(board))
      wrote()
      printMessage(message)
      return 0
    }

    case 'hooks': {
      const [action = 'status', ...names] = args
      const agents = hookAgents(names)
      if (action === 'status') {
        for (const agent of agents) out(`${AGENTS[agent].name}: ${installedHook(agent) ?? 'not installed'}`)
        return 0
      }
      if (action === 'uninstall') {
        for (const agent of agents) {
          const installed = installedHook(agent)
          const rules = installed ? allowRules(agent, cliOf(installed)) : null
          if (rules) disallow(rules.file, rules.rules)
          out(`${AGENTS[agent].name}: ${uninstallHook(agent) ? `removed the turn-end hook from ${AGENTS[agent].file()}` : 'not installed'}`)
        }
        return 0
      }
      if (action !== 'install') throw new UsageError('usage: vboard hooks [install|uninstall|status] [claude|codex|cursor|pi]...')
      const { command: cli, note } = cliCommand()
      for (const agent of agents) {
        const changed = installHook(agent, cli, flags.channel ? ` --channel ${flags.channel}` : '')
        out(`${AGENTS[agent].name}: ${changed ? `added the turn-end hook to ${AGENTS[agent].file()}` : 'already installed'}`)
        // The reminder asks for `vb update`, `vb reply`, and `vb read`: no permission prompt for each.
        const rules = allowRules(agent, cli)
        const added = rules ? allow(rules.file, rules.rules) : []
        if (added.length > 0) out(`  allowed ${added.join(', ')} in ${rules!.file}`)
        if (agent === 'cursor' && !rules) out('  install vb globally (npm i -g vboard) to let Cursor run it without asking')
        if (agent === 'codex') {
          if (changed) out('  approve it once in Codex with /hooks')
          let host: string | null = null
          try {
            const url = process.env.VBOARD_URL || projectUrl()
            host = url ? new URL(url).hostname : null
          } catch {}
          const config = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
          const profile = codexNetwork(host)
          out("  Codex's sandbox has no network by default, so vb can't reach the board from it. To allow just the board")
          out(`  (permission profiles are beta), put this at the top of ${config}, before any [table]:\n`)
          out(`    ${profile.top}\n`)
          out('  and these tables anywhere in it (merge [features] into yours if you have one):\n')
          out(profile.tables.replace(/^/gm, '    '))
          out('')
        }
      }
      if (note) out(`Note: ${note}.`)
      out('It reminds only in projects linked with `vb link <url>` (or with VBOARD_URL set), once per turn that didn\'t update the board.')
      return 0
    }

    // What an agent's turn-end hook runs. It must never break the agent's turn: any failure lets it stop.
    case 'hook': {
      if (args[0] !== 'stop') throw new UsageError("usage: vboard hook stop --agent <agent>   (run by an agent's turn-end hook)")
      const agent = flags.agent ?? 'agent'
      try {
        // Claude Code and Codex send `session_id`, `cwd`, and `stop_hook_active`; Cursor sends
        // `conversation_id`, `workspace_roots`, `status`, and `loop_count`.
        const payload = JSON.parse(await readStdin()) as {
          session_id?: string
          conversation_id?: string
          cwd?: string
          workspace_roots?: string[]
          stop_hook_active?: boolean
          loop_count?: number
          status?: string
        }
        const cwd = payload.cwd ?? payload.workspace_roots?.[0]
        if (cwd && existsSync(cwd)) process.chdir(cwd)
        const session = turnKey(agent, agent === 'cursor' ? null : (payload.session_id ?? null))
        if (!session || !(process.env.VBOARD_URL || projectUrl())) return 0
        if (payload.status && payload.status !== 'completed') return 0
        const continuing = payload.stop_hook_active === true || (payload.loop_count ?? 0) > 0
        if (decideStop(session, continuing) === 'ask') {
          const text = reminder(cliCommand().command, flags.channel ?? 'work')
          printJson(agent === 'cursor' ? { followup_message: text } : { decision: 'block', reason: text })
        }
      } catch {}
      return 0
    }

    case 'edit': {
      await client().edit(messageId(args[0]), await text(args[1]))
      return 0
    }

    case 'delete': {
      await client().delete(messageId(args[0]))
      return 0
    }

    case 'react': {
      const id = messageId(args[0])
      if (!args[1]) throw new UsageError('usage: vboard react <id> <emoji> [--remove]')
      let emoji: string
      try {
        emoji = normalizeEmoji(args[1])
      } catch (error) {
        throw new UsageError((error as Error).message)
      }
      await client().react(id, emoji, flags.remove ? { remove: true } : {})
      return 0
    }

    case 'label': {
      const id = messageId(args[0])
      const set = labelPairs(args.slice(1))
      const unset = flags.unset ?? []
      if (Object.keys(set).length === 0 && unset.length === 0)
        throw new UsageError('usage: vboard label <id> k=v... [--unset k]...')
      await client().label(id, { set, unset })
      return 0
    }

    case 'typing': {
      const id = messageId(args[0])
      const status = args.slice(1).join(' ').trim()
      const targets = await client().typing(id, status || undefined)
      if (flags.json) printJson({ targets })
      return 0
    }

    case 'sync': {
      const id = messageId(args[0])
      if (!args[1]) throw new UsageError('usage: vboard sync <id> <target>   (e.g. slack:#incidents)')
      const result = await client().sync(id, args[1])
      if (flags.json) printJson(result)
      else out(result.attached ? `synced with ${result.target}` : `already synced with ${result.target}`)
      return 0
    }

    case 'download': {
      const id = args[0]
      if (!id) throw new UsageError('usage: vboard download <attachment> [path]   (the id `vb read` shows after 📎)')
      const response = await client().download(id)
      const data = new Uint8Array(await response.arrayBuffer())
      if (args[1] === '-') return process.stdout.write(data), 0
      const disposition = response.headers.get('content-disposition') ?? ''
      const named = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      const path = args[1] ?? basename(named ? decodeURIComponent(named) : id)
      await writeFile(path, data)
      out(path)
      return 0
    }

    case 'inbox': {
      const key = args[0]
      if (!key) throw new UsageError('usage: vboard inbox <key> [channel] [--limit N]')
      const events = await client().inbox(key, {
        ...(args[1] ? { channel: args[1] } : {}),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return events.forEach(printJson), 0
      if (events.length === 0) return out('no events'), 0
      for (const entry of events) {
        const event = entry.event as { kind: string; thread: string; text?: string; type?: string; emoji?: string; author?: { handle: string } }
        const detail = event.text ?? event.type ?? event.emoji ?? ''
        out(`${entry.createdAt}  ${entry.channel}  ${event.kind}  ${event.author?.handle ?? ''}  ${detail.split('\n')[0]}`)
      }
      return 0
    }

    case 'stuck': {
      const [action, ref] = args
      if (action === undefined) {
        const list = await client().stuck()
        if (flags.json) return list.forEach(printJson), 0
        if (list.length === 0) return out('nothing is stuck'), 0
        out(list.map((event) => formatStuck(event)).join('\n'))
        return 0
      }
      const at = ref?.lastIndexOf('#') ?? -1
      const index = ref === undefined ? NaN : Number(ref.slice(at + 1))
      if ((action !== 'retry' && action !== 'skip') || at <= 0 || !Number.isInteger(index) || index < 1 || args.length > 2)
        throw new UsageError('usage: vboard stuck [retry|skip <session>#<index>], e.g. stuck retry board#812')
      const { redriven } = await client().redrive(ref!.slice(0, at), index, action)
      if (flags.json) printJson({ redriven })
      else out(redriven ? `${action === 'retry' ? 'retrying' : 'skipped'} ${ref}` : `${ref} isn't stuck`)
      return 0
    }

    case 'sources': {
      const [key, sub, target] = args
      if (!key) {
        const { sync } = await client().discovery()
        if (flags.json) return sync.forEach(printJson), 0
        if (sync.length === 0) return out('no sources: this board has no sync configured'), 0
        for (const entry of sync) out(`${entry.key}  ${entry.platform}`)
        return 0
      }
      if (sub !== 'read' || !target) throw new UsageError('usage: vboard sources <key> read <channel|thread|link> [--limit N]')
      const read = await client().readSource(key, target, flags.limit ? { limit: Number(flags.limit) } : {})
      // A board older than this CLI answers an unknown path with its discovery document.
      if (!Array.isArray((read as { messages?: unknown }).messages))
        throw new Error("this board can't read sources yet: update vboard where the board is deployed")
      if (flags.json) return printJson(read), 0
      return out(formatSourceRead(key, read)), 0
    }

    case 'tail': {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      for await (const event of client().events(
        { ...filters(args[0]), ...(flags.all ? { all: true } : {}) },
        { signal: controller.signal },
      ))
        printEvent(event)
      return 0
    }

    case 'wait': {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      const event = await client().wait(filters(args[0]), {
        timeout: flags.timeout ?? '30m',
        signal: controller.signal,
      })
      if (!event) {
        if (!controller.signal.aborted) process.stderr.write('timed out\n')
        return 124
      }
      printEvent(event)
      return 0
    }

    case 'inspect': {
      const port = flags.port === undefined ? undefined : Number(flags.port)
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
        throw new UsageError(`expected a port, got: ${flags.port}`)
      const inspector = await startInspector({ client: client(), ...(port !== undefined ? { port } : {}) })
      out(`inspecting ${inspector.board} as ${who(inspector.me)} at ${inspector.url}  (Ctrl-C to stop)`)
      if (!flags['no-open']) openBrowser(inspector.url)
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      await inspector.close()
      return 0
    }

    default:
      throw new UsageError(`unknown command: ${command} (run \`vboard help\`)`)
  }
}

if (parsed === null) {
  exit(2)
} else if (flags.version) {
  out(VERSION)
} else if (flags.help) {
  out(HELP)
} else {
  const [command, ...args] = positionals
  run(command, args).then(
    (code) => exit(code),
    (error: unknown) => {
      process.stderr.write(`error: ${(error as Error).message}\n`)
      exit(error instanceof UsageError ? 2 : 1)
    },
  )
}

/**
 * Exits once stdout and stderr have flushed. On a pipe, writes can still be
 * queued when a command returns, and `process.exit` would drop them: a long
 * `read --json` would reach a slow reader cut off.
 */
function exit(code: number) {
  let pending = 2
  const done = () => --pending === 0 && process.exit(code)
  process.stdout.write('', done)
  process.stderr.write('', done)
}
