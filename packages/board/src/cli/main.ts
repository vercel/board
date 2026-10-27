#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import { FILTER_FLAGS, withMentions } from '../api/tail.ts'
import { BoardError, type Filters, type ProfileOption } from '../client/client.ts'
import { boardUrl, configDir, connect, detectAgent, projectDir, projectUrl } from '../client/node.ts'
import { http } from '../backend-http/index.ts'
import { board as boardAt, type Board } from '../server/index.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { DIRECT_UPLOAD_BYTES_MAX, type Attachment, AttachmentId } from '../contract/schemas.ts'
import { startInspector } from '../inspect/server.ts'
import { VERSION } from '../version.ts'
import { conformance } from '../conformance/index.ts'
import { actorName, formatAccess, formatConformance, formatEvent, formatSchedule, reactionNames, formatSourceRead, formatSynced, formatThreadSummaries, formatThreads, terminalText, who } from './format.ts'
import {
  AGENTS,
  allow,
  allowRules,
  claimLinkOffer,
  cliOf,
  codexNetwork,
  decideStop,
  disallow,
  installedHook,
  installHook,
  legacyRules,
  linkOffer,
  markPosted,
  outdated,
  reminder,
  stopOutput,
  tilde,
  uninstallHook,
  type HookAgent,
} from './hooks.ts'

const HELP = `board ${VERSION}: a message board you mount in one route

usage: board <command> [options]      (also installed as \`vb\`)

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

  hooks [install|uninstall|status] [claude|codex|cursor|pi]...
                                           after a turn that didn't update the board, remind the agent to (linked projects only)

  tail [channel] [filters] [--all]         live, until Ctrl-C
  wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit (124 on timeout)

  inspect [--port N] [--no-open]           the board in your browser, as you: read, post, react (local only)
  serve [--port N] [--dir <dir>] [--no-inspect] [--no-open]
                                           run a board on this machine (127.0.0.1:4100, no sync), link this
                                           project to it, and open the inspector; its log lives in .board/,
                                           and you're local:user:<your OS user> (or --handle)

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
const REMOVED: Record<string, string> = {
  update: "`vb update` is gone: reply in the thread you're working in (vb reply <id>), or post where it fits (vb post <channel>)",
  stuck: '`vb stuck` is gone: a board on a2() keeps its dead letters in A2, on the backend\'s `servers`',
}

/** The command word: the first argument that isn't a flag or a string flag's value. */
function commandWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') return args[i + 1]
    if (!arg.startsWith('-') || arg === '-') return arg
    if (!arg.includes('=') && OPTIONS[arg.slice(2) as keyof typeof OPTIONS]?.type === 'string') i++
  }
  return undefined
}

const parsed = (() => {
  const args = withMentions(process.argv.slice(2))
  const removed = REMOVED[commandWord(args) ?? '']
  try {
    if (removed) throw new UsageError(removed)
    return parseArgs({ args: markAttachmentId(args), allowPositionals: true, options: OPTIONS })
  } catch (error) {
    const unknown = (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && /'([^']+)'/.exec((error as Error).message)?.[1]
    process.stderr.write(terminalText(`error: ${unknown ? `unknown option: ${unknown} (run \`board help\`; text starting with - goes after --, as in -- "${unknown}")` : (error as Error).message}`) + '\n')
    return null
  }
})()
// A misused flag runs nothing: the end of this file exits 2, once the error line is out.
const { values: flags, positionals: marked } = parsed ?? { values: {} as NonNullable<typeof parsed>['values'], positionals: [] as string[] }
const positionals = marked.map((arg) => (arg.startsWith(MARK) ? arg.slice(MARK.length) : arg))

// What a person reads can't drive their terminal; what a program reads is byte for byte what the board said.
const out = (text: string) => process.stdout.write(`${terminalText(text)}\n`)
const printJson = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)

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
    if (info.size > DIRECT_UPLOAD_BYTES_MAX) throw new UsageError(`${path} is over ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be`)
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
function connection(url: string | undefined = flags.url, options: { token?: string; handle?: string | undefined } = {}) {
  const at = (url ?? boardUrl()).replace(/\/+$/, '')
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

/** A handle on the board this command talks to. */
const client = (): Board => connection().board

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
    if (existsSync(candidate) && !fromNpx(realpathSync(candidate))) return candidate
  }
  return null
}

/**
 * Whether `bin` runs the CLI at `self`: a symlink to it (npm), or a shell
 * shim that execs node on it (pnpm, through `$basedir`- or `$basedir_abs`-relative paths).
 */
function runsCli(bin: string, self: string): boolean {
  try {
    const real = realpathSync(bin)
    if (real === self) return true
    if (statSync(real).size > 64 * 1024) return false
    const script = readFileSync(real, 'utf8')
    if (!script.startsWith('#!')) return false
    const basedir = dirname(bin)
    // pnpm 10 quotes "$basedir/…"; pnpm 11 quotes "$basedir_abs/…" and notes `# cmd-shim-target=<path>`.
    const paths = [
      ...[...script.matchAll(/"([^"\n]+)"/g)].map(([, quoted]) => quoted!.replace(/^\$(?:\{basedir(?:_abs)?\}|basedir(?:_abs)?)(?=\/)/, basedir)),
      ...[...script.matchAll(/^# cmd-shim-target=(.+)$/gm)].map(([, target]) => target!.trim()),
    ]
    for (const path of paths) if (isAbsolute(path) && existsSync(path) && realpathSync(path) === self) return true
  } catch {}
  return false
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
    if (installed && runsCli(installed, self)) return { command: 'vb' }
    const quote = (part: string) => (/^[\w./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)
    return { command: [process.execPath, self].map(quote).join(' ') }
  }
  let version = ''
  try {
    version = installed ? execFileSync(installed, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() : ''
  } catch {}
  if (version === VERSION) return { command: 'vb' }
  return {
    command: `npx -y @vercel/board@${VERSION}`,
    note: `the hook runs board ${VERSION} through npx${installed ? ` (your vb is ${version || 'older'})` : ''}; \`npm i -g @vercel/board\` makes it start faster`,
  }
}

/**
 * The board version a hook's CLI runs: pinned in an npx command, else what it
 * answers to `--version` (the first `vb` on PATH, for plain `vb`). Null when
 * it doesn't answer with one.
 */
function hookVersion(cli: string): string | null {
  const pinned = /^npx -y @vercel\/board@(\S+)$/.exec(cli)
  if (pinned) return pinned[1]!
  try {
    const answer = execFileSync('/bin/sh', ['-c', `${cli} --version`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return /^\d+\.\d+\.\d+\S*$/.test(answer) ? answer : null
  } catch {
    return null
  }
}

/** Whether version `a` comes before `b`, by major, minor, and patch. */
function olderVersion(a: string, b: string): boolean {
  const parts = (version: string) => version.split(/[.-]/).slice(0, 3).map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
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
  process.stderr.write(terminalText(`warning: ${list} ${one ? 'matches' : 'match'} no one on the board, so ${one ? 'it stays' : 'they stay'} plain text and ${one ? 'notifies' : 'notify'} no one`) + '\n')
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
    if (view.unlinked?.length) out(`not linked  ${view.unlinked.join(', ')}  (vb identity link <key>)`)
    return 0
  }
  if (sub === 'unlink') {
    if (!target || args.length !== 2) throw new UsageError('usage: board identity unlink <account>   (a handle or actor ID from `vb identity`)')
    const result = await board.unlinkAccount(target)
    if (flags.json) printJson(result)
    else out(`unlinked ${result.actor}`)
    return 0
  }
  if (sub !== 'link' || !target || args.length !== 2) throw new UsageError('usage: board identity [link <key> [--code] [--no-wait] | unlink <account>]')
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
  process.stderr.write('timed out\n')
  return 124
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
      if (!url || args.length !== 1) throw new UsageError(`usage: board ${command} <url>`)
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
      if (args.length > 0) throw new UsageError('usage: board conformance [--channel <c>]')
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
      if (!target) throw new UsageError('usage: board post <channel|id> "<text>"')
      const re = isMessageRef(target) ? messageId(target) : undefined
      if (re !== undefined && flags.sync?.length) throw new UsageError('--sync attaches whole threads: post to a channel, or use vb sync <id> <target>')
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
      wrote()
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
      wrote()
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
      if (!target) throw new UsageError('usage: board schedule <channel|id> "<text>" (--in 1d | --at <time> | --every 30m)')
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
      wrote()
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
      const [action = 'status', ...names] = args
      const agents = hookAgents(names)
      const width = Math.max(...agents.map((agent) => AGENTS[agent].name.length))
      const row = (agent: HookAgent, ...cells: string[]) => out([AGENTS[agent].name.padEnd(width), ...cells].join('  ').trimEnd())
      if (action === 'status') {
        const versions = new Map<string, string | null>()
        for (const agent of agents) {
          const installed = installedHook(agent)
          if (installed === null) {
            row(agent, 'not installed')
            continue
          }
          // What installing again would change, and whether the board the hook runs is older than this one.
          const cli = cliOf(installed)
          const problems = outdated(agent, installed)
          if (!versions.has(cli)) versions.set(cli, hookVersion(cli))
          const version = versions.get(cli)
          const behind = version != null && olderVersion(version, VERSION)
          if (behind) problems.push(`runs board ${version}, not ${VERSION}`)
          row(agent, (problems.length ? 'outdated' : 'installed').padEnd(9), tilde(AGENTS[agent].file()))
          if (problems.length === 0) continue
          for (const problem of problems) out(`  ${problem}`)
          const global = behind && cli === 'vb'
          const fixes = [...(global ? ['npm i -g @vercel/board'] : []), ...(problems.length > (global ? 1 : 0) ? [`vb hooks install ${agent}`] : [])]
          out(`  fix with ${fixes.join(', then ')}`)
        }
        return 0
      }
      if (action === 'uninstall') {
        for (const agent of agents) {
          const installed = installedHook(agent)
          const cli = installed ? cliOf(installed) : null
          const rules = cli ? allowRules(agent, cli) : null
          if (rules) disallow(rules.file, [...rules.rules, ...legacyRules(agent, cli!)])
          row(agent, uninstallHook(agent) ? 'removed' : 'not installed', installed ? tilde(AGENTS[agent].file()) : '')
        }
        return 0
      }
      if (action !== 'install') throw new UsageError('usage: board hooks [install|uninstall|status] [claude|codex|cursor|pi]...')
      const { command: cli, note } = cliCommand()
      // One block per agent: its name and file, then what happened and what's left to do, indented.
      for (const agent of agents) {
        const had = installedHook(agent) !== null
        const changed = installHook(agent, cli)
        // The reminder asks for `vb reply`, `vb post`, `vb read`, and `vb channels`: no permission prompt for each.
        const rules = allowRules(agent, cli)
        const added = rules ? allow(rules.file, rules.rules) : []
        const dropped = rules ? disallow(rules.file, legacyRules(agent, cli)) : false
        // "already installed" only when nothing was written: a new hook command, rule, or dropped rule is an update.
        out(`${AGENTS[agent].name}  ${tilde(AGENTS[agent].file())}`)
        out(`  ${!had ? 'added the turn-end hook' : changed || added.length > 0 || dropped ? 'updated' : 'already installed'}`)
        if (added.length > 0) out(`  ${agent === 'claude' ? 'reply, post, read, and channels run without asking' : 'vb runs without asking'}`)
        if (agent === 'cursor' && !rules) out('  npm i -g @vercel/board lets Cursor run vb without asking')
        if (agent === 'codex') {
          if (changed) out('  approve it once in Codex with /hooks')
          let host: string | null = null
          try {
            const url = process.env.BOARD_URL || projectUrl()
            host = url ? new URL(url).hostname : null
          } catch {}
          const config = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
          const profile = codexNetwork(host)
          out(`  to let vb reach the board from Codex's sandbox, add to ${tilde(config)}:`)
          out('')
          out(['# a permission profile (beta) that opens the network to just the board', '', '# at the top, before any [table]', profile.top, '', '# anywhere (merge [features] into yours)', profile.tables].join('\n').replace(/^(?=.)/gm, '    '))
        }
        out('')
      }
      if (note) out(`${note[0]!.toUpperCase()}${note.slice(1)}.`)
      out('The hooks remind once per turn without a board update.')
      out('They stay quiet outside projects linked with `vb link <url>`.')
      return 0
    }

    // What an agent's turn-end hook runs. It must never break the agent's turn: any failure lets it stop.
    case 'hook': {
      if (args[0] !== 'stop') throw new UsageError("usage: board hook stop --agent <agent>   (run by an agent's turn-end hook)")
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
        const boardUrl = process.env.BOARD_URL || projectUrl()
        if (!session || !boardUrl) return 0
        if (payload.status && payload.status !== 'completed') return 0
        const continuing = payload.stop_hook_active === true || (payload.loop_count ?? 0) > 0
        if (decideStop(session, continuing) === 'ask') {
          const cli = cliCommand().command
          // The first reminder on this board also offers, once, to link the person's accounts.
          const text = claimLinkOffer(boardUrl) ? `${reminder(cli)}\n\n${linkOffer(cli)}` : reminder(cli)
          printJson(stopOutput(agent, text))
        }
      } catch {}
      return 0
    }

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
      if (!args[1]) throw new UsageError('usage: board react <id> <emoji> [--remove]')
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
        throw new UsageError('usage: board label <id> k=v... [--unset k]...')
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
      if (!id) throw new UsageError('usage: board download <attachment> [path]   (the id `vb read` shows on a file line)')
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
      if (!key) throw new UsageError('usage: board inbox <key> [channel] [--limit N]')
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
      if (sub !== 'read' || !target) throw new UsageError('usage: board sources <key> read <channel|thread|link> [--limit N], or sources <key> join <channel|link>')
      const read = await client().readSource(key, target, flags.limit ? { limit: Number(flags.limit) } : {})
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

    case 'serve': {
      if (args.length > 0) throw new UsageError('usage: board serve [--port N] [--dir <dir>] [--no-inspect] [--no-open]')
      const port = portFlag()
      const root = projectDir()
      const { localHandle, serveLocal } = await import('./serve.ts')
      const handle = flags.handle ?? process.env.BOARD_HANDLE
      const local = await serveLocal({
        dir: flags.dir ?? join(root, '.board'),
        ...(port !== undefined ? { port } : {}),
        ...(handle ? { handle: localHandle(handle) } : {}),
      })
      let inspector: Awaited<ReturnType<typeof startInspector>> | null = null
      try {
        // Link this project, unless it's linked to another board (a remote one, or a \`board()\` dev
        // server on localhost): then say how to reach this one. A link an earlier \`vb serve\` wrote moves.
        const linked = projectUrl()
        if (linked === undefined || linked === local.url || linkedByServe(root)) {
          await saveLink(root, local.url, { serve: true })
          if (linked !== local.url) out(`linked ${root} to ${local.url}`)
        } else out(`${root} stays linked to ${linked}; reach this board with BOARD_URL=${local.url}`)
        out(`serving a local board at ${local.url} as ${local.principal}, its log in ${local.dir}  (Ctrl-C to stop)`)
        if (!flags['no-inspect']) {
          // With this board's token, whatever BOARD_TOKEN says.
          const { board } = connection(local.url, { token: local.token, handle: local.handle })
          inspector = await startInspector({ client: board.as(null) })
          out(`inspector at ${inspector.url}`)
          if (!flags['no-open']) openBrowser(inspector.url)
        }
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve)
          process.once('SIGTERM', resolve)
        })
      } finally {
        await inspector?.close()
        await local.close()
      }
      return 0
    }

    case 'inspect': {
      const port = portFlag()
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
      throw new UsageError(`unknown command: ${command} (run \`board help\`)`)
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
      // A board's error says what the board said: it can't drive the terminal either.
      process.stderr.write(`${terminalText(`error: ${(error as Error).message}`)}\n`)
      exit(error instanceof UsageError ? 2 : 1)
    },
  )
}

/**
 * Exits once stdout and stderr have flushed. On a pipe, writes can still be
 * queued when a command returns, and `process.exit` would drop them: a long
 * `read <id> --json` would reach a slow reader cut off.
 */
function exit(code: number) {
  let pending = 2
  const done = () => --pending === 0 && process.exit(code)
  process.stdout.write('', done)
  process.stderr.write('', done)
}
