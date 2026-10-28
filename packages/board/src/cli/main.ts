import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import { FILTER_FLAGS, withMentions } from '../api/tail.ts'
import { BoardError, type Filters, type ProfileOption } from '../client/client.ts'
import { boardUrl, configDir, connect, projectDir } from '../client/node.ts'
import { http } from '../backend-http/index.ts'
import { board as boardAt, type Board } from '../server/index.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { DIRECT_UPLOAD_BYTES_MAX, type Attachment, AttachmentId } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import { conformance } from '../conformance/index.ts'
import { actorName, formatAccess, formatConformance, formatEvent, formatSchedule, reactionNames, formatSourceRead, formatSynced, formatThreadSummaries, formatThreads, terminalText, who } from './format.ts'
import { AGENTS, allowRules, cliOf, disallow, installedHook, tilde, uninstallHook, type HookAgent } from './hooks.ts'

const help = () => `${app.name} ${VERSION}: a message board you mount in one route

usage: ${app.name} <command> [options]${app.name === 'board' ? '      (also installed as `vb`)' : ''}

  whoami                                   who am I, on which board, with which token, and what I can do
  link <url>                               link this project to a board (.board/config.json)
  use <url>                                save the default board

  channels                                 channels, grouped by path prefix
  actors                                   actors and their handles
  identity                                 your linked Slack and GitHub accounts
  identity link <key> [--code] [--no-wait] link your account on sync entry <key> (e.g. slack): sign in, or post a code from it
  identity unlink <account>                unlink one, by handle or actor ID

  read [channel] [filters] [--limit N]     the latest threads, one each: root, replies, latest reply
                                           (no channel: every channel)
  read <id>                                one thread, every message (filters: the root and the replies that match)
  read <link>                              the thread a Slack or GitHub link names, if the board synced it

  post <channel|id> ["<text>"] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--id <key>]
                                           a new thread in a channel, or with an id, a reply in its thread
  reply <id> ["<text>"] [--attach <file>]... [--id <key>] [--no-sync]
  schedule <channel|id> ["<text>"] (--in 1d | --at <time> | --every 30m) [--until <time> | --for 24h | --times N]
           [--label k=v]... [--attach <file>]... [--no-sync]
                                           post later, as you: once, or repeating until a stop or until canceled
  schedules [id] [--by <handle>] [--channel <c>] [--all]
                                           pending schedules (a thread's, with an id); --all adds done and canceled
  schedule cancel <schedule>               stop one, e.g. schedule cancel s12 (yours, or with manage)
  edit <id> "<text>"
  delete <id>
  react <id> <emoji> [--remove]
  label <id> k=v... [--unset k]...
  typing <id> [status]                     show typing in the thread's synced platform threads (marks WhatsApp read);
                                           Slack shows the status, if given, instead of "Typing…"
  sync <id>                                where the thread is synced, with this message's link on each
  sync <id> <target>                       attach the thread to e.g. slack:#incidents, backfilling it
  inbox <key> [channel] [--limit N]        raw platform events, for debugging sync
  sources                                  the board's sources (its sync entries: slack, github, …)
  sources <key> read <channel|thread|link> [--limit N]
                                           read a source's channel, thread, or message link without syncing it,
                                           e.g. sources slack read '#general', or a Slack permalink (full access only)
  sources <key> join <channel|link>        add the app to a public channel so it can be read, where the board
                                           opted in (slack({ join: true })); full access only
  download <attachment> [path]             save an attachment (its name, here, by default; - for stdout)
  conformance [--channel <c>]              check that the board speaks the protocol: posts to conformance,
                                           kept on the board, and deletes what it posted (1 if a check fails)

  hooks uninstall [claude|codex|cursor|pi]...
                                           remove the turn-end hooks an earlier board installed

  tail [channel] [filters] [--all]         live, until Ctrl-C
  wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit (124 on timeout)${Object.keys(app.commands).length > 0 ? `\n\n${Object.values(app.commands).map((command) => command.help).join('\n')}` : ''}

filters:  --re <id>  --by <handle>  --from <source>  --label k[=v|w]  --text <words>  --mentions [@handle]  --after <id>
          labels match a message or its thread's root; repeated flags all must match
global:   --url <url>  --as <profile>  --avatar <url>  --human  --handle <h>  --json
json:     one object per line (JSONL): { message, replies, last } for read <channel>, a message for read <id>
text:     pass "-" to read it from stdin; it may be left out when you --attach
env:      BOARD_URL  BOARD_TOKEN  BOARD_AS  BOARD_AVATAR  BOARD_HANDLE`

class UsageError extends Error {}

const OPTIONS = {
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
  channel: { type: 'string' },
  agent: { type: 'string' },
  remove: { type: 'boolean' },
  after: { type: 'string' },
  limit: { type: 'string' },
  all: { type: 'boolean' },
  timeout: { type: 'string' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  'no-inspect': { type: 'boolean' },
  dir: { type: 'string' },
  code: { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  in: { type: 'string' },
  at: { type: 'string' },
  every: { type: 'string' },
  until: { type: 'string' },
  for: { type: 'string' },
  times: { type: 'string' },
} as const

// No argument can hold a NUL, so a marked one can't be anything else.
const MARK = '\0'

/**
 * Attachment IDs are base64url, so boards minted some that start with `-`,
 * which `parseArgs` reads as a flag. Where `download` takes its ID, a token
 * shaped like one is the ID: this marks it to parse as a positional.
 */
function markAttachmentId(args: string[]): string[] {
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') positionals.push(arg)
    else if (positionals.length === 1 && positionals[0] === 'download' && AttachmentId.safeParse(arg).success)
      return [...args.slice(0, i), `${MARK}${arg}`, ...args.slice(i + 1)]
    else if (!arg.includes('=') && OPTIONS[arg.slice(2) as keyof typeof OPTIONS]?.type === 'string') i++
  }
  return args
}
/** Commands that are gone, and what to run instead. Their flags don't matter: an old hook's `vb update --skip` gets this too. */
function removedCommand(word: string): string | undefined {
  const cli = named()
  const removed: Record<string, string> = {
    update: `\`${cli} update\` is gone: reply in the thread you're working in (${cli} reply <id>), or post where it fits (${cli} post <channel>)`,
    stuck: `\`${cli} stuck\` is gone: a board on a2() keeps its dead letters in A2, on the backend's \`servers\``,
  }
  return Object.hasOwn(removed, word) ? removed[word] : undefined
}

/** The command word: the first argument that isn't a flag or a string flag's value (a bare `--mentions` takes none). */
export function commandWord(argv: string[]): string | undefined {
  const args = withMentions(argv)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') return args[i + 1]
    if (!arg.startsWith('-') || arg === '-') return arg
    if (!arg.includes('=') && OPTIONS[arg.slice(2) as keyof typeof OPTIONS]?.type === 'string') i++
  }
  return undefined
}

const parseAll = (args: string[]) => parseArgs({ args, allowPositionals: true, options: OPTIONS })

/** A command an app adds to board's: `serve` and `inspect`, in the standalone `board`. */
export type Command = {
  /** Its lines in `help`, indented as the others are. */
  help: string
  run(args: string[], context: CommandContext): Promise<number>
}

/** What a command an app adds gets from the CLI it runs in. */
export type CommandContext = {
  flags: Flags
  out: (text: string) => void
  usage: (message: string) => Error
  portFlag: () => number | undefined
  connection: typeof connection
  client: () => Board
  openBrowser: (url: string) => void
  saveLink: typeof saveLink
  linkedByServe: (root: string) => boolean
}

/**
 * The CLI an app runs: its name, as help, usage, and errors say it (`board`, `vercel board`),
 * and its own commands.
 */
export type App = { name: string; commands: Record<string, Command> }

type Flags = ReturnType<typeof parseAll>['values']

// What one run parsed, which every command reads. A process runs one command at a time.
let app: App = { name: 'board', commands: {} }
let flags = {} as Flags
let positionals: string[] = []

/** How messages name this CLI: `vb` for the standalone one, as they always have, or the app's own name. */
const named = () => (app.name === 'board' ? 'vb' : app.name)

/** Parses `argv` for this run: false, once the error line is out, when it doesn't. */
function parse(argv: string[]): boolean {
  const args = withMentions(argv)
  const removed = removedCommand(commandWord(args) ?? '')
  try {
    if (removed) throw new UsageError(removed)
    const parsed = parseAll(markAttachmentId(args))
    flags = parsed.values
    positionals = parsed.positionals.map((arg) => (arg.startsWith(MARK) ? arg.slice(MARK.length) : arg))
    return true
  } catch (error) {
    const unknown = (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && /'([^']+)'/.exec((error as Error).message)?.[1]
    io.error(terminalText(`error: ${unknown ? `unknown option: ${unknown} (run \`${app.name} help\`; text starting with - goes after --, as in -- "${unknown}")` : (error as Error).message}`) + '\n')
    return false
  }
}

/**
 * Where a run's output goes and its files come from: the terminal and this machine's, or for
 * `vb()`, its caller's, with the board handle it runs on.
 */
export type Io = {
  write(chunk: string | Uint8Array): void
  error(chunk: string): void
  /** A file's bytes, for `--attach`; null when there's no such file. */
  readFile(path: string): Promise<Uint8Array | null>
  /** Saves a file, for `download`. */
  writeFile(path: string, data: Uint8Array): Promise<void>
  /** What `-` reads. */
  stdin(): Promise<string>
  /** Stops `tail` and `wait`; without one, Ctrl-C does. */
  signal?: AbortSignal
  /** The handle to run on, in place of the one the environment and `--url` find. */
  board?: Board
}

const TERMINAL: Io = {
  write: (chunk) => void process.stdout.write(chunk),
  error: (chunk) => void process.stderr.write(chunk),
  async readFile(path) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    if (info.size > DIRECT_UPLOAD_BYTES_MAX) throw new UsageError(`${path} is over ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be`)
    return new Uint8Array(await readFile(path))
  },
  writeFile: (path, data) => writeFile(path, data),
  stdin: readStdin,
}
let io: Io = TERMINAL

// What a person reads can't drive their terminal; what a program reads is byte for byte what the board said.
const out = (text: string) => io.write(`${terminalText(text)}\n`)
const printJson = (value: unknown) => io.write(`${JSON.stringify(value)}\n`)

/** A message's ID as you'd write it: `#812` or `812`. It's passed to the board as it is. */
function messageId(value: string | undefined, what = 'message id'): string {
  const id = value?.replace(/^#/, '') ?? ''
  if (!/^[^\s/]+$/.test(id)) throw new UsageError(`expected a ${what}, got: ${value ?? '(nothing)'}`)
  return id
}

/** Whether an argument names a message rather than a channel: `#<id>`, or a bare number. */
const isMessageRef = (value: string) => /^#[^\s/]+$/.test(value) || /^\d+$/.test(value)

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
  return (await io.stdin()).replace(/\n$/, '')
}


/** Uploads each `--attach` file, reading them all before sending any. */
async function attachments(board: ReturnType<typeof client>): Promise<Attachment[]> {
  const files: { path: string; data: Uint8Array }[] = []
  for (const path of flags.attach ?? []) {
    const data = await io.readFile(path)
    if (!data) throw new UsageError(`no such file: ${path}`)
    if (data.byteLength > DIRECT_UPLOAD_BYTES_MAX) throw new UsageError(`${path} is over ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be`)
    files.push({ path, data })
  }
  const uploaded: Attachment[] = []
  for (const { path, data } of files) uploaded.push(await board.upload({ data: new Uint8Array(data), name: basename(path) }))
  return uploaded
}

/** `s12` or `12`. */
function scheduleId(value: string | undefined): string {
  const id = value?.replace(/^s(?=\d)/i, '') ?? ''
  if (!/^[^\s/]+$/.test(id)) throw new UsageError(`expected a schedule id like s12, got: ${value ?? '(nothing)'}`)
  return id
}

/** A time flag: anything `Date` reads, as ISO. */
function instant(flag: string, value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) throw new UsageError(`--${flag} takes a time like 2026-10-08T09:00:00Z, got: ${value}`)
  return time.toISOString()
}

function filters(channel?: string): Filters & { after?: string } {
  return {
    ...(channel ? { channel } : {}),
    ...(flags.re ? { re: messageId(flags.re) } : {}),
    ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
    ...(flags.mentions ? { mentions: flags.mentions.replace(/^@/, '') } : {}),
    ...(flags.label?.length ? { label: flags.label } : {}),
    ...(flags.from ? { from: flags.from } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(flags.after !== undefined ? { after: flags.after.replace(/^#/, '') } : {}),
  }
}

/**
 * The board this command talks to, `--url`'s or the one the environment points at, as `--as`
 * says: a handle on it, and how it reaches it (the credentials `vb` finds, `--handle`'s handle).
 */
/** The board the environment points at; with none, how to point at one, with the commands this app has. */
function configuredUrl(): string {
  try {
    return boardUrl()
  } catch (error) {
    if (!(error instanceof BoardError) || error.code !== 'no_board') throw error
    const ways = [`run \`${app.name} link <url>\``, 'set BOARD_URL', `run \`${app.name} use <url>\``, ...(app.commands.serve ? [`\`${app.name} serve\` for a local one`] : [])]
    throw new BoardError('no_board', `no board URL: ${ways.slice(0, -1).join(', ')}, or ${ways.at(-1)}`, 0)
  }
}

function connection(url: string | undefined = flags.url, options: { token?: string; handle?: string | undefined } = {}) {
  const at = (url ?? configuredUrl()).replace(/\/+$/, '')
  const handle = options.handle ?? flags.handle
  const transport = connect(at, { ...(options.token !== undefined ? { token: options.token } : {}), ...(handle ? { handle } : {}) })
  const board = boardAt({ backend: http(at, { fetch: transport.fetch }) })
  const profile: ProfileOption | undefined = flags.human
    ? null
    : flags.as
      ? flags.avatar
        ? { name: flags.as, avatar: flags.avatar }
        : flags.as
      : undefined
  return { url: at, transport, board: profile !== undefined ? board.as(profile) : board }
}

/** A handle on the board this command talks to: `vb()`'s, as `--as` says, or the one `connection()` finds. */
function client(): Board {
  if (!io.board) return connection().board
  if (flags.human) return io.board.as(null)
  if (flags.as) return io.board.as(flags.avatar ? { name: flags.as, avatar: flags.avatar } : flags.as)
  return io.board
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

/** A write went through, but some handles in it matched no one: they stayed plain text. */
function warnUnknownMentions(handles: string[] | undefined) {
  if (!handles?.length) return
  const names = handles.map((handle) => `@${handle}`)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  const one = names.length === 1
  io.error(terminalText(`warning: ${list} ${one ? 'matches' : 'match'} no one on the board, so ${one ? 'it stays' : 'they stay'} plain text and ${one ? 'notifies' : 'notify'} no one`) + '\n')
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
/** `url`, when it's an http or https URL as `new URL` reads it: the only kind the CLI opens, so a board can't hand the opener a flag or another scheme. */
function browsable(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

/** Opens an http(s) URL in the browser, as one argument to the opener: no shell reads it, Windows' included. */
function openBrowser(url: string) {
  const at = browsable(url)
  if (at === null) return
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', at] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', at] : ['xdg-open', at]
  const child = spawn(command!, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/** Writes the board link: the project's `.board/` (kept out of Git), or the saved default when `root` is null. */
async function saveLink(root: string | null, url: string, extra: Record<string, unknown> = {}) {
  const directory = root === null ? configDir() : join(root, '.board')
  if (root !== null) {
    const path = join(root, '.gitignore')
    const ignore = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (!ignore.split(/\r?\n/).some((line) => /^\/?\.board\/?$/.test(line)))
      await appendFile(path, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}.board/\n`)
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'config.json'), `${JSON.stringify({ url, ...extra }, null, 2)}\n`, { mode: 0o600 })
}

/** Whether the project's link was written by `vb serve` (`"serve": true`), so a new run may move it. */
function linkedByServe(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, '.board', 'config.json'), 'utf8')).serve === true
  } catch {
    return false
  }
}

function portFlag(): number | undefined {
  const port = flags.port === undefined ? undefined : Number(flags.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
    throw new UsageError(`expected a port, got: ${flags.port}`)
  return port
}

/** How long `identity link` waits for the sign-in or the code. */
const LINK_WAIT_MS = 10 * 60_000

async function identity(args: string[]): Promise<number> {
  const board = client()
  const [sub, target] = args
  if (sub === undefined) {
    const view = await board.identity()
    if (flags.json) return printJson(view), 0
    if (view.links.length === 0) out('no linked accounts')
    for (const link of view.links) out(`${link.handle ? `@${link.handle}  ` : ''}${link.actor}  by ${link.method === 'code' ? 'code' : 'sign-in'} · ${link.at}`)
    if (view.unlinked?.length) out(`not linked  ${view.unlinked.join(', ')}  (${named()} identity link <key>)`)
    return 0
  }
  if (sub === 'unlink') {
    if (!target || args.length !== 2) throw new UsageError(`usage: ${app.name} identity unlink <account>   (a handle or actor ID from \`${app.name} identity\`)`)
    const result = await board.unlinkAccount(target)
    if (flags.json) printJson(result)
    else out(`unlinked ${result.actor}`)
    return 0
  }
  if (sub !== 'link' || !target || args.length !== 2) throw new UsageError(`usage: ${app.name} identity [link <key> [--code] [--no-wait] | unlink <account>]`)
  const before = new Set((await board.identity()).links.map((link) => `${link.actor}|${link.at}`))
  // The entry's platform, as the board lists it: what the code is posted from, or the sign-in is for.
  const platform = (await board.discovery().catch(() => null))?.sync.find((entry) => entry.key === target)?.platform ?? target
  const { code, expiresAt, signIn } = await board.syncCode(target)
  const consent = signIn !== undefined && !flags.code
  // The board says where its sign-in is, and the CLI opens it: only a web page.
  if (consent && browsable(signIn) === null) throw new Error(`the board's sign-in isn't an http or https URL: ${JSON.stringify(signIn)}`)
  if (flags.json) printJson({ sync: target, platform, code, expiresAt, ...(signIn !== undefined ? { signIn } : {}) })
  const until = Date.now() + LINK_WAIT_MS
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 2000))
  /** An account linked on that platform since this run began: where the code or the sign-in landed. */
  const linkedSince = async () =>
    (await board.identity()).links.find((link) => link.actor.startsWith(`${platform}:user:`) && !before.has(`${link.actor}|${link.at}`))
  if (consent) {
    if (!flags.json) {
      out(`Sign in to ${platform} as yourself to link it (and to post as you there):\n\n  ${signIn}\n`)
      out(`Only open it yourself: whoever completes it links their account to you.`)
    }
    if (!flags['no-open'] && !flags.json) openBrowser(signIn!)
  } else if (!flags.json) {
    const minutes = Math.round((Date.parse(expiresAt) - Date.now()) / 60_000)
    out(`From your ${platform} account, post this as a message anywhere the board syncs, within ${minutes} minutes:\n\n  ${code}\n`)
  }
  if (flags['no-wait']) return 0
  // The sign-in, or the code's post, links the account where the entry's sync runs: it shows up in your links.
  while (Date.now() < Math.min(until, consent ? Infinity : Date.parse(expiresAt))) {
    await sleep()
    const linked = await linkedSince()
    if (linked) {
      if (flags.json) printJson(linked)
      else out(`linked ${linked.handle ? `@${linked.handle} ` : ''}(${linked.actor})`)
      return 0
    }
  }
  io.error('timed out\n')
  return 124
}

async function run(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case undefined:
    case 'help':
      out(help())
      return 0

    case 'link':
    case 'use': {
      const url = args[0]
      if (!url || args.length !== 1) throw new UsageError(`usage: ${app.name} ${command} <url>`)
      const discovery = await connection(url).board.discovery()
      const root = command === 'link' ? projectDir() : null
      await saveLink(root, discovery.url)
      out(root === null ? `using ${discovery.url}` : `linked ${root} to ${discovery.url}`)
      return 0
    }

    case 'whoami': {
      const { board, url, transport } = connection()
      const me = await board.me()
      const source = transport.source()
      if (flags.json) {
        printJson({ ...me, board: url, source })
        return 0
      }
      const name = me.profile !== null ? `${me.name} via ${me.handle.split('/')[0]}` : me.name
      out(`${name} (${me.actor})`)
      const rows: [string, string][] = [['board', url]]
      if (source) rows.push(['source', source])
      if (me.expiresAt) {
        const minutes = Math.max(0, Math.round((Date.parse(me.expiresAt) - Date.now()) / 60_000))
        rows.push(['token', `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`])
      }
      if (me.session) rows.push(['session', me.session])
      // Full access says nothing; anything less says what it is, one pattern a row.
      ;(me.can === undefined ? [] : formatAccess(me.can)).forEach((line, index) => rows.push([index === 0 ? 'can' : '', line]))
      const width = Math.max(...rows.map(([subject]) => subject.length))
      for (const [subject, value] of rows) out(`${subject.padEnd(width)}  ${value}`)
      return 0
    }

    case 'conformance': {
      if (args.length > 0) throw new UsageError(`usage: ${app.name} conformance [--channel <c>]`)
      const report = await conformance(client(), flags.channel ? { channel: flags.channel } : {})
      if (flags.json) printJson(report)
      else out(formatConformance(report))
      return report.ok ? 0 : 1
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
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
        out(`${prefix ? '  ' : ''}${channel.path}  ${count(channel.threads, 'thread', 'threads')} · ${count(channel.messages, 'message', 'messages')} · last #${channel.lastIndex}`)
      }
      return 0
    }

    case 'actors': {
      const actors = await client().actors()
      if (flags.json) return actors.forEach(printJson), 0
      for (const actor of actors) out(`@${actor.handle}  ${actor.name}  ${actor.id}${actor.person ? `  → @${actor.person.handle}` : ''}`)
      return 0
    }

    case 'identity':
      return identity(args)

    case 'read': {
      const target = args[0]
      const board = client()
      // A platform's link to a message (a Slack permalink, a GitHub comment) reads the board's thread it synced.
      const link = target !== undefined && /^https?:\/\//i.test(target)
      if (target && (link || isMessageRef(target))) {
        const thread = link ? await board.linked(target) : await board.thread(messageId(target))
        // A board older than this CLI answers /links with its discovery document. Its 404 stays: a
        // current board's means the link isn't one it synced.
        if (link && !Array.isArray((thread as { replies?: unknown }).replies))
          throw new Error("this board can't read links: update board where the board is deployed")
        // With filters, the root and only the replies that match them.
        const narrowed = Object.keys(filters()).length > 0
        const replies = narrowed
          ? (await board.messages({ ...filters(), re: thread.message.id, limit: 500 })).messages.filter((m) => m.re !== null)
          : thread.replies
        if (flags.json) return [thread.message, ...replies].forEach(printJson), 0
        // Reactions name people who may not have written here: look up the ones that show.
        const authors = new Set([thread.message, ...replies].map((m) => m.by.actor))
        const unnamed = reactionNames([thread.message, ...replies]).filter((id) => !authors.has(id))
        const known = unnamed.length
          ? new Map((await board.actors().catch(() => [])).filter((a) => unnamed.includes(a.id)).map((a) => [a.id, actorName(a)]))
          : new Map<string, string>()
        out(formatThreads([thread.message, ...replies], known))
        if (!narrowed) for (const schedule of thread.schedules ?? []) out(formatSchedule(schedule, { pad: '  ' }))
        return 0
      }
      const query = { ...filters(target), ...(flags.limit ? { limit: Number(flags.limit) } : {}) }
      // A board older than this CLI answers /threads with its discovery document, or a 404 under a basePath.
      const old = new Error("this board can't list threads: update board where the board is deployed")
      const page = await board.threads(query).catch((error: unknown) => {
        throw error instanceof BoardError && error.status === 404 ? old : error
      })
      if (!Array.isArray((page as { threads?: unknown }).threads)) throw old
      // Nothing in a channel that doesn't exist is a typo, not an empty channel.
      if (!page.threads.length && target && !(await board.channels()).some((c) => c.path === target || c.path.startsWith(target.replace(/\/?$/, '/'))))
        throw new Error(`no channel ${target}: board channels lists them`)
      if (flags.json) return page.threads.forEach(printJson), 0
      const count = `${page.threads.length} ${page.threads.length === 1 ? 'thread' : 'threads'}`
      out(`${target ?? 'all channels'} · ${count} · cursor ${page.cursor}${page.threads.length ? '\n' : ''}`)
      if (page.threads.length) out(formatThreadSummaries(page.threads, { channel: !target || target.endsWith('/') }))
      return 0
    }

    case 'post': {
      const [target, body] = args
      if (!target) throw new UsageError(`usage: ${app.name} post <channel|id> "<text>"`)
      const re = isMessageRef(target) ? messageId(target) : undefined
      if (re !== undefined && flags.sync?.length) throw new UsageError(`--sync attaches whole threads: post to a channel, or use ${named()} sync <id> <target>`)
      if (flags.sync?.length && flags['no-sync']) throw new UsageError('--sync and --no-sync contradict each other')
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(body)
      const files = await attachments(board)
      const options = {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      }
      const message = re === undefined
        ? await board.post(target, { ...options, ...(flags.sync?.length ? { sync: flags.sync } : {}) })
        : await board.reply(re, options)
      warnUnknownMentions(message.unknownMentions)
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
      warnUnknownMentions(message.unknownMentions)
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
      if (!target) throw new UsageError(`usage: ${app.name} schedule <channel|id> "<text>" (--in 1d | --at <time> | --every 30m)`)
      if (!flags.in && !flags.at && !flags.every) throw new UsageError('say when: --in 1d, --at <time>, or --every 30m')
      if (flags.sync?.length) throw new UsageError('a schedule posts where you point it: --sync is for post')
      const times = flags.times === undefined ? undefined : Number(flags.times)
      if (times !== undefined && !(Number.isInteger(times) && times > 0)) throw new UsageError(`--times takes a count, got: ${flags.times}`)
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(body)
      const files = await attachments(board)
      const where = isMessageRef(target) ? { re: messageId(target) } : target
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
      warnUnknownMentions(schedule.unknownMentions)
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

    case 'hooks': {
      const [action, ...names] = args
      if (action !== 'uninstall')
        throw new UsageError(`\`${`${named()} hooks ${action ?? ''}`.trimEnd()}\` is gone: turn-end hooks were removed. Run \`${named()} hooks uninstall\` to clear an earlier install`)
      const agents = hookAgents(names)
      const width = Math.max(...agents.map((agent) => AGENTS[agent].name.length))
      for (const agent of agents) {
        const installed = installedHook(agent)
        const cli = installed ? cliOf(installed) : null
        const rules = cli ? allowRules(agent, cli) : null
        if (rules) disallow(rules.file, rules.rules)
        out([AGENTS[agent].name.padEnd(width), uninstallHook(agent) ? 'removed' : 'not installed', installed ? tilde(AGENTS[agent].file()) : ''].join('  ').trimEnd())
      }
      return 0
    }

    // What an earlier board's turn-end hook still runs: it does nothing, so those turns end as they would without it.
    // `hooks uninstall` clears it.
    case 'hook':
      return 0

    case 'edit': {
      const { unknownMentions } = await client().edit(messageId(args[0]), await text(args[1]))
      warnUnknownMentions(unknownMentions)
      return 0
    }

    case 'delete': {
      await client().delete(messageId(args[0]))
      return 0
    }

    case 'react': {
      const id = messageId(args[0])
      if (!args[1]) throw new UsageError(`usage: ${app.name} react <id> <emoji> [--remove]`)
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
        throw new UsageError(`usage: ${app.name} label <id> k=v... [--unset k]...`)
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
      if (!args[1]) {
        const { targets } = await client().sync(id)
        if (flags.json) return targets.forEach(printJson), 0
        out(targets.length ? formatSynced(targets) : 'not synced anywhere')
        return 0
      }
      const result = await client().sync(id, args[1])
      if (flags.json) printJson(result)
      else out(result.attached ? `synced with ${result.target}` : `already synced with ${result.target}`)
      return 0
    }

    case 'download': {
      const id = args[0]
      if (!id) throw new UsageError(`usage: ${app.name} download <attachment> [path]   (the id \`${app.name} read\` shows on a file line)`)
      const response = await client().download(id)
      const data = new Uint8Array(await response.arrayBuffer())
      if (args[1] === '-') return io.write(data), 0
      const disposition = response.headers.get('content-disposition') ?? ''
      const named = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      const path = args[1] ?? basename(named ? decodeURIComponent(named) : id)
      await io.writeFile(path, data)
      out(path)
      return 0
    }

    case 'inbox': {
      const key = args[0]
      if (!key) throw new UsageError(`usage: ${app.name} inbox <key> [channel] [--limit N]`)
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

    case 'sources': {
      const [key, sub, target] = args
      if (!key) {
        const { sync } = await client().discovery()
        if (flags.json) return sync.forEach(printJson), 0
        if (sync.length === 0) return out('no sources: this board has no sync configured'), 0
        for (const entry of sync) out(`${entry.key}  ${entry.platform}`)
        return 0
      }
      if (sub === 'join' && target) {
        const joined = await client().joinSource(key, target)
        if (flags.json) return printJson(joined), 0
        const label = joined.name ? `#${joined.name}` : joined.channel
        return out(joined.joined ? `joined ${label}` : `already in ${label}`), 0
      }
      if (sub !== 'read' || !target) throw new UsageError(`usage: ${app.name} sources <key> read <channel|thread|link> [--limit N], or sources <key> join <channel|link>`)
      const read = await client().readSource(key, target, flags.limit ? { limit: Number(flags.limit) } : {})
      if (flags.json) return printJson(read), 0
      return out(formatSourceRead(key, read, Date.now(), named())), 0
    }

    case 'tail': {
      const controller = new AbortController()
      // Its handler goes when it's done: inside another CLI, the process goes on, and Ctrl-C should stop it.
      const release = stopOn(controller)
      try {
        for await (const event of client().events(
          { ...filters(args[0]), ...(flags.all ? { all: true } : {}) },
          { signal: controller.signal },
        ))
          printEvent(event)
      } finally {
        release()
      }
      return 0
    }

    case 'wait': {
      const controller = new AbortController()
      const release = stopOn(controller)
      const event = await client()
        .wait(filters(args[0]), { timeout: flags.timeout ?? '30m', signal: controller.signal })
        .finally(release)
      if (!event) {
        if (!controller.signal.aborted) io.error('timed out\n')
        return 124
      }
      printEvent(event)
      return 0
    }

    default: {
      const own = app.commands[command]
      if (own) return own.run(args, context())
      throw new UsageError(`unknown command: ${command} (run \`${app.name} help\`)`)
    }
  }
}


/** Aborts `controller` on the run's signal, or Ctrl-C without one; the returned function stops listening. */
function stopOn(controller: AbortController): () => void {
  const stop = () => controller.abort()
  if (io.signal) {
    if (io.signal.aborted) stop()
    io.signal.addEventListener('abort', stop, { once: true })
    const signal = io.signal
    return () => signal.removeEventListener('abort', stop)
  }
  process.once('SIGINT', stop)
  return () => process.off('SIGINT', stop)
}

/** What a command an app adds gets: this run's flags, and the helpers board's own commands use. */
const context = (): CommandContext => ({
  flags,
  out,
  usage: (message) => new UsageError(message),
  portFlag,
  connection,
  client,
  openBrowser,
  saveLink,
  linkedByServe,
})

/**
 * Runs board's CLI on `argv` (what follows the command name) as `app`, and answers its exit
 * code: 0 success, 1 error, 2 misuse, 124 when `wait` times out. Errors are one `error: …` line
 * on stderr. A long-running command (`tail`, `serve`) answers once it's stopped.
 */
export async function main(argv: string[], options: App): Promise<number> {
  app = options
  if (!parse(argv)) return 2
  if (flags.version) {
    out(VERSION)
    return 0
  }
  if (flags.help) {
    out(help())
    return 0
  }
  const [command, ...args] = positionals
  try {
    if (io.board) {
      if (flags.url || flags.handle) throw new UsageError(`--${flags.url ? 'url' : 'handle'} doesn't apply: the board handle you pass says which board and who`)
      if (command !== undefined && MACHINE.has(command)) throw new UsageError(`${command} isn't available in-process: it's about the machine vb runs on`)
    }
    return await run(command, args)
  } catch (error) {
    // A board's error says what the board said: it can't drive the terminal either.
    io.error(`${terminalText(`error: ${(error as Error).message}`)}\n`)
    return error instanceof UsageError ? 2 : 1
  }
}

/** The commands about the machine the CLI runs on, not the board: none of them run in-process. */
const MACHINE = new Set(['link', 'use', 'whoami', 'identity', 'hooks', 'hook', 'serve', 'inspect'])

/** `main()` with `io` in place of the terminal, for `vb()`. One run at a time, as `main()`'s. */
export async function mainWith(argv: string[], options: App, with_: Io): Promise<number> {
  io = with_
  try {
    return await main(argv, options)
  } finally {
    io = TERMINAL
  }
}
