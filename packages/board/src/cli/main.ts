import { spawn } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import type { MessageView } from '../api/routes.ts'
import { withMentions } from '../api/tail.ts'
import { BoardError, type Filters, type ProfileOption } from '../client/client.ts'
import { boardUrl, connect, handFetch, handLogin, vercelProjectFile } from '../client/node.ts'
import { http } from '../backend-http/index.ts'
import { credentialed, credentialSource, handTeam, vercel } from '../backend-vercel/index.ts'
import { board as boardAt, type Board } from '../server/index.ts'
import { isBoardName } from '../server/board.ts'
import { isApiMessageId } from '../server/backend-vercel.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { ATTACHMENTS_PER_MESSAGE_MAX, DIRECT_UPLOAD_BYTES_MAX, MESSAGE_TEXT_MAX, type Attachment, AttachmentId } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import { conformance } from '../conformance/index.ts'
import { explainPrincipalOf, explanationLine, GrantMisuse, grantCanOf, KINDS, principalsIn, type OptionToken } from './grants.ts'
import { formatSchema, formatSchemas } from './schemas.ts'
import { parseSchemaId } from '../contract/data-schemas.ts'
import { block } from '../contract/blocks.ts'
import { actorName, formatAccess, formatConformance, formatEvent, formatGrants, grantRow, formatSchedule, reactionNames, formatSourceRead, formatSynced, formatThreadSummaries, formatThreads, terminalText, who } from './format.ts'
import { AGENTS, allowRules, cliOf, disallow, installedHook, tilde, uninstallHook, type HookAgent } from './hooks.ts'
import { commands, filters as filterOptions, globalOptions, options, type CliCommand } from './commands.ts'
import { commandHelp, commandPath, rootHelp } from './help.ts'
import { closest, commandLine, exitCode, failureDocument, formatFailure, type Failure, type Recovery, type Warning } from './failure.ts'

/** A failure this run says in its own words: what a command throws to stop with it. */
export class Failed extends Error {
  readonly failure: Failure
  constructor(failure: Failure) {
    super(failure.message)
    this.failure = failure
  }
}

/**
 * Misuse: `message` says what's wrong with the command as typed. It exits 2, and points at the
 * command's help unless `next` says something better.
 */
function usage(message: string, options: { reason?: string; next?: Recovery[] } = {}): Failed {
  return new Failed({ class: 'usage', reason: options.reason ?? 'invalid_arguments', message, next: options.next ?? [helpRecovery()] })
}

/** A command's help page, which says how to use it. */
const helpRecovery = (command = current.command): Recovery => ({ instruction: 'See how to use it', argv: [...cli(), ...(command ? [command] : []), '--help'] })

/** This CLI's name as argv, to build a command a person runs: `['vb']`, `['vercel', 'board']`. */
const cli = () => named().split(' ')

/** This run's command as typed, with `extra` where options go: before any `--`, after which everything is text. */
function rerun(...extra: string[]): string[] {
  const at = typed.indexOf('--')
  return [...cli(), ...(at === -1 ? [...typed, ...extra] : [...typed.slice(0, at), ...extra, ...typed.slice(at)])]
}

/** A command line without `options` and their values. */
const without = (argv: string[], ...options: string[]): string[] =>
  argv.filter((arg, at) => !options.some((option) => arg === option || argv[at - 1] === option || arg.startsWith(`${option}=`)))

/**
 * This run's command line without `options`, with `extra` in their place: both before any `--`,
 * since what follows it is text, which a way out mustn't change or add options to.
 */
function rerunWithout(options: string[], ...extra: string[]): string[] {
  const at = typed.indexOf('--')
  const before = at === -1 ? typed : typed.slice(0, at)
  return [...cli(), ...without(before, ...options), ...extra, ...(at === -1 ? [] : typed.slice(at))]
}

/** What the parser accepts: every option, by name (`commands.ts`). */
const OPTIONS = options

/** Options by their short letter: `n` is `limit`. */
const SHORT: Record<string, string> = Object.fromEntries(
  Object.entries(OPTIONS).flatMap(([name, option]) => ('short' in option ? [[option.short, name]] : [])),
)

/**
 * Whether `arg` is a string option written apart from its value, whose value is the next argument:
 * `--limit 5`, `-n 5`, or the last of a group of short ones, `-an 5`.
 */
function takesValue(arg: string): boolean {
  if (arg.includes('=')) return false
  const string = (name: string | undefined) => name !== undefined && OPTIONS[name as keyof typeof OPTIONS]?.type === 'string'
  if (arg.startsWith('--')) return string(arg.slice(2))
  // In a group, a string option takes what follows it in the group, or, last, the next argument.
  const letters = arg.slice(1)
  const first = [...letters].findIndex((letter) => string(SHORT[letter]))
  return first === letters.length - 1
}

/** A command's own name for `word`, which may be one of its aliases (`rm` is `delete`). */
const canonical = (word: string | undefined) => (word === undefined ? word : (commands.find((command) => command.aliases?.includes(word))?.name ?? word))

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
    else if (takesValue(arg)) i++
  }
  return args
}
/** Commands that are gone, and what to run instead. Their flags don't matter: an old hook's `vb update --skip` gets this too. */
function removedCommand(word: string): Failed | undefined {
  const gone = (next: Recovery[], why = '') => usage(`\`${named()} ${word}\` is gone.${why}`, { reason: 'unknown_command', next })
  const url: Recovery[] = [
    { instruction: "Pass the board's URL", argv: [...cli(), 'read', 'dev', '--url', '<URL>'] },
    { instruction: "Or, in a Vercel project, its team's board needs no URL" },
  ]
  const removed: Record<string, () => Failed> = {
    update: () =>
      gone([
        { instruction: "Reply in the thread you're working in", argv: [...cli(), 'reply', '<ID>', '<TEXT>'] },
        { instruction: 'Or post where it fits', argv: [...cli(), 'post', '<CHANNEL>', '<TEXT>'] },
      ]),
    stuck: () => gone([]),
    link: () => gone(url),
    use: () => gone(url),
  }
  return Object.hasOwn(removed, word) ? removed[word]!() : undefined
}

/**
 * The command `argv` runs, by its own name (`delete` for `rm`), as the parser reads it: the
 * first positional, past every flag and value however they're written (`-an 1`, `--limit=1`). A
 * bare `--mentions` takes none.
 */
export function commandWord(argv: string[]): string | undefined {
  const { positionals } = parseArgs({ args: markAttachmentId(withMentions(argv)), allowPositionals: true, options: OPTIONS, strict: false })
  return canonical(positionals[0])
}

const parseAll = (args: string[]) => parseArgs({ args, allowPositionals: true, options: OPTIONS })

/** A command an app adds to board's: `serve`, in the standalone `board`. */
export type Command = {
  /** What it is, as help shows it, with the options it takes from `commands.ts`'s. */
  spec: CliCommand
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
}

/**
 * The CLI an app runs: its name, as help, usage, and errors say it (`board`, `vercel board`),
 * and its own commands.
 */
export type App = {
  name: string
  commands: Record<string, Command>
  /**
   * With no board URL, it talks to the team's board in Vercel's API even outside a Vercel project:
   * your login's team, as `vercel board` does. Without it, only in one (or with `--scope`).
   */
  teamBoard?: boolean
  /** Shows a failure as this app shows its own; without it, the CLI prints `error: …`, or with `--json`, its JSON document. */
  onError?: (failure: Failure, mode: { json: boolean }) => void
  /** Shows a warning, outside `--json` (where it's in the result's `warnings`); without it, the CLI prints `warning: …`. */
  onWarning?: (warning: Warning) => void
  /** Your Vercel login, asked for only when a request needs it: the app's own, refreshed when it's asked. */
  login?: () => Promise<string>
  /**
   * How board's requests to Vercel's API go with that login: the app's own fetch, which adds the
   * login's credentials (a DPoP proof, say). Without it, board sends the login as a Bearer token.
   */
  fetch?: typeof fetch
  /**
   * The team whose board to use when `--scope` names none, as the app resolves its own (its link,
   * its saved team), asked for only when a request needs it. Null is your login's default team.
   */
  team?: () => Promise<string | null>
}

type Flags = ReturnType<typeof parseAll>['values']

// What one run parsed, which every command reads. A process runs one command at a time.
let app: App = { name: 'board', commands: {} }
let flags = {} as Flags
let positionals: string[] = []
/** Every option as it was typed, in order: what reads principal flags and the modifiers after each. */
let ordered: OptionToken[] = []
/** The command this run runs, by its own name, and what follows it: what a failure says it was doing. */
let current: { command: string | undefined; args: string[] } = { command: undefined, args: [] }
/** What this run was given, as typed: what a recovery runs again, with what it lacked. */
let typed: string[] = []
/** What this run's writes had to say, for its JSON result. */
let warnings: Warning[] = []
/** The board this run reached by its URL, for a failure to name. */
let reached: string | null = null
/** How long the message text this run sends is, for a backend's refusal of it to say what to do instead. */
let sentLength = 0

/** The help `words` ask for: a command's page when they name one (`read`, `sources read`), or else every command. */
function help(words: readonly string[] = []): string {
  const own = Object.values(app.commands).map((command) => command.spec)
  const path = commandPath(words, [...commands, ...own])
  return path ? commandHelp(app.name, path) : rootHelp({ name: app.name, commands: own }, VERSION)
}

/** How messages name this CLI: `vb` for the standalone one, as they always have, or the app's own name. */
const named = () => (app.name === 'board' ? 'vb' : app.name)

/** The commands that take their text as an argument, where text that starts with `-` goes after `--`. */
const TEXT = new Set(['post', 'reply', 'edit', 'schedule'])

/** Parses `argv` for this run, or throws what's wrong with it. */
function parse(argv: string[]) {
  const args = withMentions(argv)
  const word = commandWord(args)
  current = { command: word, args: [] }
  const removed = removedCommand(word ?? '')
  if (removed) throw removed
  try {
    const parsed = parseAll(markAttachmentId(args))
    ordered = parseArgs({ args: markAttachmentId(args), allowPositionals: true, options: OPTIONS, tokens: true }).tokens.flatMap((token) =>
      token.kind === 'option' ? [{ name: token.name, value: token.value }] : [],
    )
    flags = parsed.values
    positionals = parsed.positionals.map((arg) => (arg.startsWith(MARK) ? arg.slice(MARK.length) : arg))
  } catch (error) {
    throw parseFailure(error as Error & { code?: string }, argv, word)
  }
  // An option only another command takes would be dropped without a word (`edit --attach`): it's unknown here too.
  const known = specOf(word) && new Set(optionsOf(word))
  const foreign = known && ordered.find((option) => !known.has(option.name))
  if (foreign) throw foreignOption(foreign.name, word!)
}

/** An option `word` doesn't take: what to do instead, where there's something better to say than that. */
function foreignOption(name: string, word: string): Failed {
  if (name === 'text' && TEXT.has(word)) return usage(`--text is a filter for read, tail, and wait. ${word} takes its text as an argument, in quotes.`)
  if (name === 'sync' && word === 'schedule') return usage("Can't use --sync with schedule. A schedule posts where you point it.")
  if (name === 'attach' && word === 'edit') return usage("edit can't attach files: reply with the file instead.", { reason: 'unknown_option', next: [{ instruction: 'Reply with it', argv: [...cli(), 'reply', '<ID>', '<TEXT>', '--attach', '<FILE>'] }] })
  return usage(`Unknown option --${name} for ${named()} ${word}.`, { reason: 'unknown_option', next: [{ instruction: 'See all options', argv: [...cli(), word, '--help'] }] })
}

/** What the parser rejected, as misuse: an unknown option (with the likeliest one meant), or an option without its value. */
function parseFailure(error: Error & { code?: string }, argv: string[], word: string | undefined): Failed {
  const option = error.message.match(/--[a-z][\w-]*/)?.[0] ?? /'(-[^' ,]+)/.exec(error.message)?.[1]
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) {
    // One argument can hold several words (a shell variable that wasn't split): it's that argument
    // that's unknown, not the option it starts with, which may well be real. The parser names a long
    // one whole, and only a short group's start (`- `, `-z`), and nothing after `--` is an option.
    const token = /^Unknown option '(.*?)'\. /.exec(error.message)?.[1]
    const dash = argv.indexOf('--')
    const options = dash === -1 ? argv : argv.slice(0, dash)
    const spaced = token === undefined ? undefined : options.find((arg) => /\s/.test(arg) && (token.startsWith('--') ? arg === token : arg.startsWith(token)))
    const guess = !spaced && option.startsWith('--') ? closest(option.slice(2), optionsOf(word)) : undefined
    const next: Recovery[] = [{ instruction: 'See all options', argv: [...cli(), ...(word ? [word] : []), '--help'] }]
    const unknown = spaced ?? option
    const at = argv.indexOf(unknown)
    if (word && TEXT.has(word) && at !== -1) {
      // The text goes first after the `--` there is, or a new one.
      const rest = [...argv.slice(0, at), ...argv.slice(at + 1)]
      const dash = rest.indexOf('--')
      const text = dash === -1 ? [...rest, '--', unknown] : [...rest.slice(0, dash + 1), unknown, ...rest.slice(dash + 1)]
      next.push({ instruction: 'Or, for text that starts with -, put it after --', argv: [...cli(), ...text] })
    }
    const where = `${named()}${word ? ` ${word}` : ''}`
    return usage(`Unknown option ${spaced ? JSON.stringify(spaced) : option} for ${where}.${guess ? ` Did you mean --${guess}?` : ''}`, { reason: 'unknown_option', next })
  }
  if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return usage(`${option} needs a value.`, { reason: 'missing_value' })
  return usage(sentence(error.message))
}

/** The options `word`'s command takes, its subcommands' and the filters included, and the ones every command takes. */
/** The command `word` names, board's or the app's, as help shows it. */
const specOf = (word: string | undefined): CliCommand | undefined =>
  word === undefined ? undefined : [...commands, ...Object.values(app.commands).map((own) => own.spec)].find((known) => known.name === word)

function optionsOf(word: string | undefined): string[] {
  const command = specOf(word)
  const own = command ? [command, ...(command.subcommands ?? [])].flatMap((c) => [...c.options, ...(c.filters ? filterOptions : [])]) : []
  return [...own, ...globalOptions].map((option) => option.name)
}

/** `text` as a sentence: a capital first, and a period last. */
const sentence = (text: string) => {
  const trimmed = text.trim()
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? '' : '.'}`
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
  /** Saves a file, for `download`; with `exclusive`, fails rather than replace one that's there. */
  writeFile(path: string, data: Uint8Array, options?: { exclusive?: boolean }): Promise<void>
  /** What `-` reads. */
  stdin(): Promise<string>
  /** Stops `tail` and `wait`, and fails any other command its requests haven't finished, as `board`'s handle ends them; without one, Ctrl-C stops `tail` and `wait`. */
  signal?: AbortSignal
  /** The handle to run on, in place of the one the environment and `--url` find. */
  board?: Board
  /** Whether a person reads it at a terminal: JSON is indented there. */
  tty?: boolean
}

const TERMINAL: Io = {
  write: (chunk) => void process.stdout.write(chunk),
  error: (chunk) => void process.stderr.write(chunk),
  async readFile(path) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    if (info.size > DIRECT_UPLOAD_BYTES_MAX) throw tooLarge(path)
    return new Uint8Array(await readFile(path))
  },
  async writeFile(path, data, { exclusive = false } = {}) {
    try {
      await writeFile(path, data, { flag: exclusive ? 'wx' : 'w' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw exists(path)
      throw error
    }
  },
  stdin: readStdin,
  tty: process.stdout.isTTY === true,
}
let io: Io = TERMINAL

// What a person reads can't drive their terminal; what a program reads is byte for byte what the board said.
const out = (text: string) => io.write(`${terminalText(text)}\n`)
/** `--json`'s result: one document, with what the run's writes warned about, indented at a terminal. */
const result = (value: object) => io.write(`${JSON.stringify(warnings.length ? { ...value, warnings } : value, null, io.tty ? 2 : undefined)}\n`)
/** One line of a JSON stream (`tail`): compact, wherever it goes. */
const line = (value: object) => io.write(`${JSON.stringify(value)}\n`)

/** A message's ID as you'd write it: `#812` or `812`. It's passed to the board as it is. */
function messageId(value: string | undefined, what = 'message ID'): string {
  const id = value?.replace(/^#/, '') ?? ''
  if (value === undefined) throw usage(`Missing the ${what}.`, { reason: 'missing_arguments' })
  if (!/^[^\s/]+$/.test(id)) throw usage(`${value} isn't a ${what}.`)
  return id
}

/** A download that would replace a file, which only a path given to download may. */
const exists = (path: string) =>
  usage(`${path} is already here, and download keeps it: give download a path to save the attachment elsewhere.`, {
    reason: 'file_exists',
    next: [{ instruction: 'Save it under another name', argv: [...cli(), 'download', '<ID>', '<PATH>'] }],
  })

/** A file over what a direct upload takes. */
const tooLarge = (path: string) =>
  new Failed({ class: 'limit', reason: 'payload_too_large', message: `Can't attach ${path}. It's over ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be.` })

/** Whether an ID goes in and out bare: a number, or one Vercel's API hands out (`msg_…`), a message even where a channel has its name. */
const bareId = (value: string) => /^\d+$/.test(value) || isApiMessageId(value)

/** Whether an argument names a message rather than a channel: `#<id>`, or an ID that goes bare. */
const isMessageRef = (value: string) => /^#[^\s/]+$/.test(value) || bareId(value)

/** A message's ID as it's passed back: bare when it goes bare, `#<id>` when it could be a channel's name. */
const messageRef = (id: string) => (bareId(id) ? id : `#${id}`)

/** `--if-revision N`, as an edit or a delete takes it. */
function ifRevision(): { revision?: number } {
  const given = flags['if-revision']
  if (given === undefined) return {}
  if (!/^[1-9]\d{0,15}$/.test(given)) throw usage(`--if-revision takes the message's revision, a number, and ${given} isn't one.`)
  return { revision: Number(given) }
}

function labelPairs(
  values: string[] | undefined,
  wrong = "Labels look like key=value, and {value} isn't one.",
  /** What to say of `key=`, a label with no value, where one can't be meant: none lets it through, as `--if key=` matches a label that has none. */
  empty: string | null = '{value} has no value: a label needs one.',
): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const value of values ?? []) {
    const at = value.indexOf('=')
    if (at <= 0) throw usage(wrong.replace('{value}', value))
    // `owner=` would set a label with no value, which still counts as set.
    if (at === value.length - 1 && empty !== null) throw usage(empty.replace('{value}', value).replace('{key}', value.slice(0, at)))
    pairs[value.slice(0, at)] = value.slice(at + 1)
  }
  return pairs
}

/**
 * A post or reply takes one text. What follows it was meant to be part of the message, or a label,
 * and would be dropped without a word: say so, and how each is written.
 */
function oneText(command: string, target: string, extra: string[]) {
  const [first] = extra
  if (first === undefined) return
  if (/^[\w.-]+=/.test(first))
    throw usage(`${first} looks like a label, and ${command} takes labels with --label.`, {
      next: [{ instruction: 'Label it as you post it', argv: [...cli(), command, target, '<TEXT>', '--label', first] }],
    })
  throw usage(
    first === '-'
      ? `${command} takes one text, and - (stdin) is a second. For a long message, pass - alone as the text: it has no title.`
      : `${command} takes one text, and ${first.length > 40 ? `${first.slice(0, 40)}…` : first} is one too many. Quote the whole message as one argument: it has no title.`,
  )
}

/**
 * A message's text: the argument, stdin for `-`, or the file `--text-file` names (`-` for stdin).
 * `optional` when the message can go without, as one with `--attach` files can.
 */
async function text(value: string | undefined, { optional = false } = {}): Promise<string> {
  const file = flags['text-file']
  if (file !== undefined) {
    if (value !== undefined) throw usage("Can't use --text-file with text: a message has no title, so its whole text comes from one or the other.")
    if (file === '-') return (await io.stdin()).replace(/\n$/, '')
    const data = await io.readFile(file).catch((error: unknown) => {
      // A file too big to attach is far too long for a message: say it of the text, not of --attach.
      if (!(error instanceof Failed) || error.failure.reason !== 'payload_too_large') throw error
      throw new Failed({ class: 'limit', reason: 'payload_too_large', message: `Can't use ${file} as the text. A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString('en-US')} characters.` })
    })
    if (!data) throw usage(`Can't read ${file}. There's no such file.`, { reason: 'file_not_found', next: [] })
    return new TextDecoder().decode(data).replace(/\n$/, '')
  }
  if (value === undefined) {
    if (optional) return ''
    throw usage("Missing the message's text: pass it, - to read it from stdin, or --text-file <path>.", { reason: 'missing_arguments' })
  }
  if (value !== '-') return value
  return (await io.stdin()).replace(/\n$/, '')
}


/** Uploads each `--attach` file, reading them all before sending any. */
async function attachments(board: ReturnType<typeof client>): Promise<Attachment[]> {
  const paths = flags.attach ?? []
  // The board takes at most this many on a message: say so before uploading any, not after uploading them all.
  if (paths.length > ATTACHMENTS_PER_MESSAGE_MAX)
    throw usage(`Can't attach ${paths.length} files. A message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}.`, {
      reason: 'too_many_attachments',
      next: [{ instruction: `Attach the rest in another reply, or bundle them into one file (a zip or tarball)`, argv: [...cli(), 'reply', '<ID>', '<TEXT>', '--attach', '<FILE>'] }],
    })
  const files: { path: string; data: Uint8Array }[] = []
  for (const path of paths) {
    const data = await io.readFile(path)
    // `--attach -` is someone piping the message's text: stdin is the text's, as `-` or `--text-file -`.
    if (!data && path === '-')
      throw usage("Can't attach -: stdin is for the message's text. Pass - as the text to read it from stdin.", {
        reason: 'file_not_found',
        next: [{ instruction: 'Post text from stdin', argv: [...cli(), current.command ?? 'post', '<channel|id>', '-'] }],
      })
    if (!data) throw usage(`Can't attach ${path}. There's no such file.`, { reason: 'file_not_found', next: [] })
    if (data.byteLength > DIRECT_UPLOAD_BYTES_MAX) throw tooLarge(path)
    files.push({ path, data })
  }
  const uploaded: Attachment[] = []
  for (const { path, data } of files) uploaded.push(await board.upload({ data: new Uint8Array(data), name: basename(path) }))
  return uploaded
}

/**
 * Whether `value` is a schedule's own ID and not a message's: `s12` on a local board, `sch_…` on
 * Vercel's. A message's is a number or `msg_…`, so neither is ever one.
 */
export const isScheduleId = (value: string): boolean => /^(?:s\d+|sch_\S+)$/i.test(value)

/** A schedule's ID as the board gave it: `s12`, or `sch_…` on Vercel's board. */
function scheduleId(value: string | undefined): string {
  if (value === undefined) throw usage('Missing the schedule ID, like s12.', { reason: 'missing_arguments' })
  if (!/^[^\s/]+$/.test(value)) throw usage(`${value} isn't a schedule ID like s12.`)
  return value
}

/** A grant's ID as the board gave it: `g3`, or another board's own. */
function grantId(value: string | undefined): string {
  if (value === undefined) throw usage('Missing the grant ID, like g3.', { reason: 'missing_arguments' })
  if (!/^[^\s/]+$/.test(value)) throw usage(`${value} isn't a grant ID like g3.`)
  return value
}

/** What a grant's flags say, or the misuse in them. */
function grantFlags<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof GrantMisuse) throw usage(error.message, error.next ? { next: error.next } : {})
    throw error
  }
}

/** Refuses the principal flags `verb` doesn't take: plain ones on update, `--add-` and `--remove-` ones elsewhere. */
function onlyPrincipalFlags(verb: 'create' | 'update' | 'explain') {
  for (const { name } of ordered) {
    const kind = name.replace(/^(add|remove)-/, '')
    if (!(KINDS as readonly string[]).includes(kind)) continue
    const prefixed = kind !== name
    if (verb === 'update' && !prefixed) throw usage(`grants update adds and removes principals: --add-${kind} or --remove-${kind}, not --${kind}.`)
    if (verb !== 'update' && prefixed) throw usage(`--${name} is for grants update: grants ${verb} names principals as --${kind}.`)
  }
}

/** A time flag: anything `Date` reads, as ISO. */
function instant(flag: string, value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) throw usage(`--${flag} takes a time like 2026-10-08T09:00:00Z, and ${value} isn't one.`)
  return time.toISOString()
}

function filters(channel?: string): Filters & { after?: string } {
  return {
    ...(channel ? { channel } : {}),
    ...(flags.re ? { re: messageId(flags.re) } : {}),
    ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
    ...(flags.mentions ? { mentions: flags.mentions.replace(/^@/, '') } : {}),
    ...(flags.label?.length ? { label: flags.label } : {}),
    ...(flags.source ? { from: flags.source } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(flags.after !== undefined ? { after: flags.after.replace(/^#/, '') } : {}),
  }
}

/**
 * The board the environment points at. With none, the team's board for an app that has one
 * (null), or else how to point at one, with the commands this app has.
 */
function configuredUrl(): string | null {
  try {
    return boardUrl()
  } catch (error) {
    if (!(error instanceof BoardError) || error.code !== 'no_board') throw error
    // In a Vercel project, its team's board.
    if (app.teamBoard || process.env.VERCEL_ORG_ID || vercelProjectFile()) return null
    throw new Failed({
      class: 'missing_input',
      reason: 'missing_scope',
      actionRequired: true,
      message: "No board to use. Nothing sets one, and this directory isn't in a Vercel project.",
      next: [
        { instruction: "Use a team's board", argv: rerun('--scope', '<TEAM>') },
        { instruction: 'Or a board at a URL', argv: rerun('--url', '<URL>') },
      ],
    })
  }
}

/**
 * What a message says: its text, or with `--schema`, a block of that schema and nothing else, whose
 * JSON the text is, from wherever text comes (the argument, stdin, `--text-file`).
 */
async function content(value: string | undefined, options: { optional?: boolean } = {}): Promise<string> {
  const said = await given(value, options)
  sentLength = said.length
  return said
}

async function given(value: string | undefined, options: { optional?: boolean }): Promise<string> {
  const schema = flags.schema
  if (schema === undefined) return text(value, options)
  if (!parseSchemaId(schema)) throw usage(`${schema} doesn't name a schema. One is name@version, like sandbox@1.`)
  let data: unknown
  try {
    data = JSON.parse(await text(value))
  } catch (error) {
    if (error instanceof Failed) throw error
    throw usage(`With --schema, the text is ${schema}'s JSON, and this isn't JSON.`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw usage(`With --schema, the text is a JSON object, like {"id":"sbx-123"}.`)
  return block(schema, data as Record<string, unknown>)
}

/** A schema's JSON Schema, as `--schema` gives it: inline JSON, the file `@<path>` names, or stdin for `-`. */
async function definition(): Promise<Record<string, unknown>> {
  const given = flags.schema
  if (given === undefined) throw usage('Missing --schema: its JSON Schema, inline, @<file>, or - for stdin.', { reason: 'missing_arguments' })
  let source = given
  if (given === '-') source = await io.stdin()
  else if (given.startsWith('@')) {
    const file = given.slice(1)
    const data = await io.readFile(file)
    if (!data) throw usage(`Can't read ${file}. There's no such file.`, { reason: 'file_not_found', next: [] })
    source = new TextDecoder().decode(data)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    // A path given bare is the likeliest slip: say how a file is named.
    throw usage(given === '-' || given.startsWith('@') ? `${given === '-' ? 'stdin' : given.slice(1)} isn't JSON.` : `--schema takes JSON, or a file as @<path>: ${given.length > 40 ? `${given.slice(0, 40)}…` : given} isn't JSON.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw usage('A schema is a JSON object: {"type":"object", …}.')
  return parsed as Record<string, unknown>
}

/** A board that predates what this run asked of it. */
const outdated = (message: string) =>
  new Failed({
    class: 'platform',
    reason: 'board_outdated',
    message: `${message} It's older than this CLI.`,
    next: [{ instruction: 'Update @vercel/board where the board is deployed' }],
  })

/** A message ID as a failure names it: `#812`. */
const ref = (value: string | undefined) => (value === undefined ? 'a message' : `#${value.replace(/^#/, '')}`)

/** What this run was doing, as a failure's headline says it: `post to dev`, `reply to #812`. */
function doing(): string {
  const { command, args } = current
  const [a, b, c] = args
  const message = a !== undefined && isMessageRef(a)
  switch (command) {
    case 'read':
      return a === undefined ? 'read the board' : /^https?:\/\//i.test(a) ? 'read that link' : `read ${message ? ref(a) : a}`
    case 'post':
      return message ? `reply to ${ref(a)}` : `post to ${a ?? 'a channel'}`
    case 'reply':
      return `reply to ${ref(a)}`
    case 'edit':
    case 'delete':
    case 'label':
      return `${command} ${ref(a)}`
    case 'react':
      return `react to ${ref(a)}`
    case 'typing':
      return `show typing in ${ref(a)}`
    case 'sync':
      return b === undefined ? `list where ${ref(a)} is synced` : `sync ${ref(a)} with ${b}`
    case 'schedule':
      return a === 'cancel' ? `cancel schedule ${b}` : `schedule a message in ${message ? ref(a) : (a ?? 'a channel')}`
    case 'channels':
      return a === 'create' ? `create ${b ?? 'the channel'}` : 'list channels'
    case 'schedules':
    case 'actors':
      return `list ${command}`
    case 'grants':
      return a === 'create' ? 'create the grant' : a === 'update' ? `update grant ${b}` : a === 'explain' ? `explain ${b ?? 'the channel'}` : a === 'revoke' ? `revoke grant ${b}` : 'list grants'
    case 'schemas':
      return a === 'create' ? `register schema ${b ?? ''}`.trimEnd() : a === 'inspect' ? `read schema ${b ?? ''}`.trimEnd() : 'list schemas'
    case 'sources':
      return b === undefined ? 'list sources' : `${b} ${c ?? 'it'} on ${a}`
    case 'download':
      return `download ${a ?? 'the attachment'}`
    case 'inbox':
      return `read ${a}'s inbox`
    case 'tail':
      return `follow ${a ?? 'the board'}`
    case 'wait':
      return `wait on ${a ?? 'the board'}`
    case 'whoami':
      return 'reach the board'
    case 'conformance':
      return 'check the board'
    default:
      return `run ${named()}${command ? ` ${command}` : ''}`
  }
}

/** The commands whose first argument is always a message. */
const ON_MESSAGE = new Set(['reply', 'edit', 'delete', 'react', 'label', 'typing', 'sync', 'schedules'])

/** What a 404 means this run couldn't find, when its arguments name it: `message #812`. */
function missing(): string | undefined {
  const { command = '', args } = current
  const [a, b] = args
  if (a === undefined) return undefined
  if (command === 'read' && /^https?:\/\//i.test(a)) return "that link's message on this board"
  if (ON_MESSAGE.has(command) || (['read', 'post', 'schedule'].includes(command) && isMessageRef(a))) return `message ${ref(a)}`
  if (command === 'schedule' && a === 'cancel' && b !== undefined) return `schedule ${b}`
  if (command === 'grants' && (a === 'revoke' || a === 'update') && b !== undefined) return `grant ${b}`
  if (command === 'schemas' && a === 'inspect' && b !== undefined) return `schema ${b}`
  if (command === 'download') return `attachment ${a}`
  return undefined
}

/**
 * What `error` means for this run, in the Vercel CLI's terms. What the handle raised itself says
 * what and why, and its hint what fixes it. What a board answered is said by what this run was
 * doing, with the board's words under it and in `data`, never in what to run: a board can answer
 * with any code, the handle's own included.
 */
function failureOf(error: unknown): Failure {
  if (error instanceof Failed) return error.failure
  const message = error instanceof Error ? error.message : String(error)
  const { code, status, hint, origin } = error as { code?: unknown; status?: unknown; hint?: unknown; origin?: unknown }
  // Not the board's or the handle's: the system's (a file it couldn't write), or a bug.
  if (typeof code !== 'string' || typeof status !== 'number')
    return { class: 'unknown', reason: 'unexpected_error', message: `Failed to ${doing()}.`, details: [message] }
  const said = { error: { code, message, status, ...(typeof hint === 'string' ? { hint } : {}) } }
  if (origin === 'handle') {
    const fix: Recovery[] = typeof hint === 'string' ? [{ instruction: hint }] : []
    const own = (kind: Failure['class'], reason: string, next: Recovery[] = fix): Failure => ({
      class: kind, reason, message, ...(next.length ? { next } : {}), data: said,
    })
    switch (code) {
      case 'not_logged_in':
        return { class: 'auth', reason: 'login_required', message: "You're not logged in to Vercel.", next: [{ instruction: 'Log in', argv: ['vercel', 'login'] }], data: said }
      case 'no_access':
        return own('permission', 'permission_denied')
      case 'wrong_project':
        return own('permission', 'wrong_project')
      case 'protected':
        return own('permission', 'deployment_protected')
      case 'no_project':
        return own('platform', 'no_project')
      case 'no_token':
        return own('auth', 'token_unavailable')
      case 'no_board':
        // A person's named board that isn't there, or that they can't see: this command again makes it.
        return own('not_found', 'board_not_found', [{ instruction: 'Check the name, or make it', argv: rerun('--ensure') }])
      case 'board_name_taken':
        return own('conflict', 'board_name_taken')
      case 'board_not_granted':
        return own('permission', 'board_not_granted')
      case 'watchers_need_project':
        return own('permission', 'watchers_need_project')
      case 'unsupported_principal':
        return own(status === 403 ? 'permission' : 'usage', 'unsupported_principal')
      case 'invalid_board_name':
        return own('usage', 'invalid_arguments', [helpRecovery()])
      case 'too_many_redirects':
        return own('network', 'network_error')
      case 'invalid_duration':
        return own('usage', 'invalid_arguments', [helpRecovery()])
      case 'wrong_audience':
      case 'redirected':
        return own('usage', 'wrong_url')
      case 'too_large':
        return { ...own('limit', 'payload_too_large'), message: `Can't ${doing()}. ${sentence(message)}` }
      case 'no_team':
        return { ...own('platform', 'api_error'), message: "Couldn't tell which team's board to use.", details: [message] }
      case 'upload_failed':
        return { ...own('platform', 'upload_failed'), message: `Failed to ${doing()}.`, details: [message] }
      case 'channel_exists':
        return own('conflict', 'channel_exists')
      case 'channel_granted':
        return own('conflict', 'channel_granted')
      case 'no_own_principal':
        return own('usage', 'no_own_principal')
      case 'port_taken':
        return own('conflict', 'port_taken', [{ instruction: 'Pick another port', argv: [...cli(), current.command ?? 'serve', '--port', '<PORT>'] }])
    }
  }
  // The board's, said by what this run was doing, with its own words under it. Which board it was
  // matters when reaching it is what failed.
  const theirs = (kind: Failure['class'], reason: string, headline: string, next: Recovery[] = []): Failure => ({
    class: kind,
    reason,
    message: headline,
    details: [message],
    ...(reached && ['auth', 'permission', 'network', 'platform'].includes(kind) ? { context: [['Board', reached]] as [string, string][] } : {}),
    ...(next.length ? { next } : {}),
    data: said,
  })
  const specific = (fallback: string) => (/^[a-z]+(_[a-z]+)+$/.test(code) && code !== 'invalid_request' && code !== 'remote_error' ? code : fallback)
  // A block the board refused, written with --schema: what that schema holds is a read away.
  if (status === 400 && code === 'invalid_block' && flags.schema !== undefined && parseSchemaId(flags.schema))
    return theirs('usage', code, `Can't ${doing()}.`, [{ instruction: `See what ${flags.schema} holds`, argv: [...cli(), 'schemas', 'inspect', flags.schema] }])
  if (status === 400 && code === 'schema_not_found' && current.command !== 'schemas')
    return theirs('usage', code, `Can't ${doing()}.`, [{ instruction: 'See the schemas this board has', argv: [...cli(), 'schemas'] }])
  // Too much text: what it can't hold goes in a file, on a message that can take one (an edit can't).
  // Vercel's API says it as `invalid_message`, which also means empty text: only text over the limit is too long.
  if (status === 400 && (code === 'text_too_long' || (code === 'invalid_message' && sentLength > MESSAGE_TEXT_MAX)))
    return {
      ...theirs('limit', 'payload_too_large', `Can't ${doing()}. A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString('en-US')} characters.`, [
        { instruction: current.command === 'edit' ? 'Keep the edit short, and reply with the long part in a file with --attach' : 'Put the long part in a file and --attach it, with a short summary as the text' },
      ]),
      details: [],
    }
  // What the board said is what to fix.
  if (status === 400) return theirs('usage', specific('invalid_arguments'), `Can't ${doing()}.`)
  if (status === 401)
    return theirs(
      'auth',
      'login_required',
      "The board didn't accept your credentials.",
      // A token you passed is yours to replace: logging in changes nothing while BOARD_TOKEN is set. Vercel's board never reads it.
      process.env.BOARD_TOKEN && reached && !vercelBoard(reached) ? [{ instruction: 'Pass a token it accepts in BOARD_TOKEN, or unset it' }] : [{ instruction: 'Log in again', argv: ['vercel', 'login'] }],
    )
  if (status === 403) return theirs('permission', 'permission_denied', `You can't ${doing()}.`)
  if (status === 404) {
    const thing = missing()
    // What it names says it, and the board's "message not found: 812" says no more.
    return thing ? { ...theirs('not_found', specific('not_found'), `Couldn't find ${thing}.`), details: [] } : theirs('not_found', specific('not_found'), `Can't ${doing()}.`)
  }
  if (status === 409) {
    // A reply's --after: what's newer is in its thread, after the message it named.
    const { args } = current
    const newer = code === 'newer_message' && flags.after !== undefined && args[0] !== undefined
    // A label write's --if: who holds it now is a read away.
    const labeled = code === 'label_conflict' && (flags.if !== undefined || flags['if-unset'] !== undefined) && args[0] !== undefined
    // An edit's or a delete's --if-revision: the message as it is now has the revision to pass.
    const changed = code === 'revision_conflict' && flags['if-revision'] !== undefined && args[0] !== undefined
    // A schema version that's there with another definition: what it holds is a read away.
    if (code === 'schema_immutable' && current.command === 'schemas' && args[1] !== undefined)
      return theirs('conflict', code, `Can't ${doing()}.`, [{ instruction: "See what it's registered as", argv: [...cli(), 'schemas', 'inspect', args[1]] }])
    return theirs('conflict', specific('conflict'), `Can't ${doing()}.`, newer
      ? [{ instruction: `Read what came after ${ref(flags.after)}`, argv: [...cli(), 'read', args[0]!.replace(/^#/, ''), '--after', flags.after!.replace(/^#/, '')] }]
      : labeled
        ? [{ instruction: 'See its labels now', argv: [...cli(), 'read', args[0]!.replace(/^#/, '')] }]
        : changed
          ? [{ instruction: 'Read it as it is now', argv: [...cli(), 'read', args[0]!.replace(/^#/, ''), '--json'] }]
          : [])
  }
  if (status === 413) return theirs('limit', 'payload_too_large', `Can't ${doing()}. It's too large for the board.`)
  if (status === 429) return theirs('rate_limit', 'rate_limited', 'Too many requests to the board. Try again in a minute.')
  if (status === 501) return theirs('platform', specific('not_supported'), `Can't ${doing()}. This board doesn't support it.`)
  if (code === 'unreachable') return theirs('network', 'network_error', "Couldn't reach the board.")
  return theirs('platform', 'api_error', `Failed to ${doing()}.`)
}

/** How this run ends with `failure`: shown on stderr, or by the app, and its exit code. */
function report(failure: Failure, json: boolean): number {
  if (app.onError) app.onError(failure, { json })
  else if (json) io.error(`${JSON.stringify(failureDocument(failure))}\n`)
  else io.error(`${terminalText(formatFailure(failure))}\n`)
  return exitCode(failure)
}

/**
 * A team's board in Vercel's API, by the URL its discovery names it with
 * (`https://api.vercel.com/v1/messageboard/boards/<board>?teamId=<team>`): its board and team.
 */
function vercelBoard(url: string): { board: string; team?: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const found = /^\/v1\/messageboard\/boards\/([^/]+)\/?$/.exec(parsed.pathname)
  if (parsed.origin !== 'https://api.vercel.com' || !found) return null
  const team = parsed.searchParams.get('teamId')
  return { board: decodeURIComponent(found[1]!), ...(team ? { team } : {}) }
}

/** Who the handle writes as: `--as`'s profile (with `--avatar`), or what the environment says (`BOARD_PROFILE`), else yourself. */
function profileFlag(): ProfileOption | undefined {
  if (flags.avatar !== undefined && !flags.as) throw usage('--avatar is the avatar of the profile --as names: pass --as too.', { reason: 'missing_arguments' })
  if (!flags.as) return undefined
  return flags.avatar ? { name: flags.as, avatar: flags.avatar } : flags.as
}

/**
 * The board this command talks to, as `--as` says: a handle on it, where it is (null until its
 * discovery says, for a team's board), and how it reaches it. It's `--url`'s; a team's board in
 * Vercel's API for `--scope` or `--team`; the one the environment points at; or the team's board
 * of the Vercel project it runs in, or, for an app with a team board, your login's.
 */
function connection(url: string | undefined = flags.url, options: { token?: string; can?: string; headers?: Record<string, string> } = {}) {
  const profile = profileFlag()
  const team = flags.scope ?? flags.team
  const name = boardNameFlag(url, team)
  // A name names a team's board as --scope does, so it goes before BOARD_URL too.
  const configured = url ?? (team === undefined && name === undefined ? configuredUrl() : null)
  if (configured === null) {
    const board = boardAt({ backend: vercel({ ...(team !== undefined ? { team } : {}), ...sending(options.token, options.can, options.headers) }), ...(name !== undefined ? { name, ensure: flags.ensure === true } : {}) })
    return { url: null, transport: { source: credentialSource }, board: profile !== undefined ? board.as(profile) : board }
  }
  const at = configured.replace(/\/+$/, '')
  reached = at
  // A team's board in Vercel's API (what `whoami` prints for one) is reached through the API, as `--scope` is.
  const onVercel = vercelBoard(at)
  if (onVercel) {
    const board = boardAt({ backend: vercel({ ...onVercel, ...sending(options.token, options.can, options.headers) }) })
    return { url: at as string | null, transport: { source: credentialSource }, board: profile !== undefined ? board.as(profile) : board }
  }
  const extra = { ...options.headers, ...(options.can !== undefined ? { 'x-board-can': options.can } : {}) }
  const transport = connect(at, { ...(options.token !== undefined ? { token: options.token } : {}), ...(Object.keys(extra).length > 0 ? { fetch: withHeaders(extra) } : {}) })
  const board = boardAt({ backend: http(at, { fetch: transport.fetch }) })
  return { url: at as string | null, transport: transport as { source(): string | null }, board: profile !== undefined ? board.as(profile) : board }
}

/**
 * The team's board this run names: `--name`, or `BOARD_NAME`, on `--scope`'s team or the one the
 * environment finds. A URL names a board itself, its team included. `BOARD_NAME` is read only
 * where it picks the board: beside `BOARD_URL`, which names another, nothing says which one.
 */
function boardNameFlag(url: string | undefined, team: string | undefined): string | undefined {
  if (flags.name !== undefined && flags.url !== undefined)
    throw usage("--name names a team's board, and --url a board by its URL: pass one of them.", { reason: 'conflicting_options' })
  if (team !== undefined && flags.url !== undefined)
    throw usage("--url names its board, its team included, and --scope a team's board: pass one of them.", { reason: 'conflicting_options' })
  if (flags.ensure && flags.url !== undefined)
    throw usage("--ensure makes a team's board by its name, and --url names a board by its URL: pass one of them.", { reason: 'conflicting_options' })
  if (url !== undefined) return undefined
  const named = process.env.BOARD_NAME || undefined
  if (flags.name === undefined && team === undefined && named !== undefined && process.env.BOARD_URL?.trim())
    throw usage("BOARD_NAME names a team's board, and BOARD_URL a board by its URL: unset one.", { reason: 'conflicting_options' })
  const given = flags.name ?? named
  if (given === undefined && flags.ensure) throw usage('--ensure makes the board --name names: pass --name too.', { reason: 'missing_arguments' })
  if (given === undefined) return undefined
  const from = flags.name !== undefined ? '--name' : 'BOARD_NAME'
  if (given.includes('/')) {
    // Another team's board is its team, with --scope, and its name.
    const [owner, ...rest] = given.split('/')
    const argv = rerunWithout(['--name', '--scope', '--team'], '--scope', owner || '<TEAM>', '--name', rest.join('/') || '<NAME>')
    throw usage(`${from} takes a board's name alone, not its team's.`, {
      next: [flags.name !== undefined ? { instruction: 'Pass its team with --scope', argv } : { instruction: 'Set BOARD_NAME to the name alone, and pass its team with --scope' }],
    })
  }
  if (!isBoardName(given)) throw usage(`${from} ${given} isn't a board's name: one is 1 to 64 characters.`)
  return given
}

/** For Vercel's API, `token` in place of your own credentials, `can` narrowing them, and `headers` beside them. */
function sending(token: string | undefined, can?: string, extra: Record<string, string> = {}): { fetch?: typeof fetch } {
  if (token === undefined && can === undefined && Object.keys(extra).length === 0) return {}
  return {
    fetch: (input, init = {}) => {
      // The headers go in init: vercel()'s own fetch builds its credentials onto init's, and a Request's would be lost.
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
      if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
      if (can !== undefined) headers.set('x-board-can', can)
      for (const [name, value] of Object.entries(extra)) headers.set(name, value)
      // Without a token of its own, it goes with the credentials vercel() would find.
      return (token === undefined ? credentialed() : globalThis.fetch)(input, { ...init, headers })
    },
  }
}

/** A fetch that adds `headers` to each request to a board on HTTP, as a proxy holding its credentials would: `x-board-can`, say. */
function withHeaders(headers: Record<string, string>): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init)
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
    return globalThis.fetch(request)
  }
}

/** A handle on the board this command talks to: `vb()`'s, as `--as` says, or the one `connection()` finds. */
function client(): Board {
  if (!io.board) return connection().board
  const profile = profileFlag()
  return profile === undefined ? io.board : io.board.as(profile)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function hookAgents(names: string[]): HookAgent[] {
  const known = Object.keys(AGENTS) as HookAgent[]
  for (const name of names)
    if (!known.includes(name as HookAgent)) throw usage(`Unknown agent ${name}. The agents are ${known.join(', ')}.`)
  return names.length ? (names as HookAgent[]) : known
}

/** Says what a write that went through had to say: in its JSON result with `--json`, on stderr otherwise. */
function warn(warning: Warning) {
  if (flags.json) warnings.push(warning)
  else if (app.onWarning) app.onWarning(warning)
  else io.error(`${terminalText(`warning: ${warning.message}`)}\n`)
}

/** A post or reply: its ID, or with `--json`, the message. */
function printMessage(message: MessageView) {
  if (flags.json) result({ message, outcome: 'posted' })
  else out(messageRef(message.id))
}

/** A write that answers nothing but that it went through: with `--json`, which message, and what happened to it. */
function printDone(id: string, outcome: string) {
  if (flags.json) result({ message: { id }, outcome })
  else out(`${outcome} ${messageRef(id)}`)
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

function portFlag(): number | undefined {
  const port = flags.port === undefined ? undefined : Number(flags.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
    throw usage(`${flags.port} isn't a port.`, { reason: 'invalid_port' })
  return port
}

async function run(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case undefined:
    case 'help':
      out(help(args))
      return 0

    case 'whoami': {
      const { board, url: given, transport } = connection()
      // Its discovery too, so a URL to a board that isn't there, or you can't reach, says so.
      const [me, discovered] = await Promise.all([board.me(), board.discovery()])
      const url = given ?? discovered.url
      const source = transport.source()
      if (flags.json) {
        result({ ...me, board: url, source })
        return 0
      }
      out(`${who(me)} (${me.actor})`)
      const rows: [string, string][] = [['board', url]]
      if (source) rows.push(['source', source])
      if (me.expiresAt) {
        const minutes = Math.max(0, Math.round((Date.parse(me.expiresAt) - Date.now()) / 60_000))
        rows.push(['token', `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`])
      }
      // Full access says nothing; anything less says what it is, one pattern a row.
      ;(me.can === undefined ? [] : formatAccess(me.can)).forEach((line, index) => rows.push([index === 0 ? 'can' : '', line]))
      const width = Math.max(...rows.map(([subject]) => subject.length))
      for (const [subject, value] of rows) out(`${subject.padEnd(width)}  ${value}`)
      return 0
    }

    case 'conformance': {
      if (args.length > 0) throw usage('conformance takes no arguments: pass its channel with --channel.')
      // It posts and changes grants, so it checks a board someone named, never the team's by default.
      const named = flags.name !== undefined || flags.url !== undefined || Boolean(process.env.BOARD_URL?.trim()) || Boolean(process.env.BOARD_NAME)
      if (!io.board && !named)
        throw usage('conformance posts and changes grants, so name a scratch board for it.', {
          reason: 'needs_scratch_board',
          next: [
            { instruction: 'Check a scratch board on this team, by its name', argv: rerun('--name', '<BOARD>') },
            { instruction: 'Or a board by its URL', argv: rerun('--url', '<URL>') },
          ],
        })
      // The same board with this run's own credential and headers of the run's (x-board-can, a profile), as a proxy holding it sends them:
      // what `vb()` was handed can't be opened again.
      const withHeaders = io.board ? {} : { withHeaders: (headers: Record<string, string>) => connection(undefined, { headers }).board }
      const report = await conformance(client(), { ...(flags.channel ? { channel: flags.channel } : {}), ...withHeaders })
      if (flags.json) result(report)
      else out(formatConformance(report))
      return report.ok ? 0 : 1
    }

    case 'channels': {
      const [sub, ...rest] = args
      if (sub === 'create') {
        const [path, extra] = rest
        if (!path) throw usage('Missing the channel to create, such as dev/alerts.', { reason: 'missing_arguments' })
        if (extra !== undefined) throw usage(`channels create takes one channel: ${extra} is one too many.`)
        const { channel, created, grants } = await client().createChannel(path, flags.private ? { private: true } : {})
        if (flags.json) result({ channel, outcome: created ? 'created' : 'unchanged', ...(grants ? { grants } : {}) })
        else if (grants) {
          // The channel, then the two grants that close it, each a line.
          out(`created channel ${channel.path}`)
          for (const grant of grants) out(`created ${grantRow(grant)}`)
        } else out(created ? `created ${channel.path}` : `${channel.path} already exists`)
        return 0
      }
      if (sub !== undefined && sub !== 'list') throw usage(`Unknown command ${sub} for ${named()} channels.`, { reason: 'unknown_command' })
      if (rest.length > 0) throw usage(`channels list takes no arguments: ${rest[0]} is one too many.`)
      const channels = await client().channels()
      if (flags.json) return result({ channels }), 0
      if (channels.length === 0) return out('no channels yet'), 0
      let group = ''
      for (const channel of channels) {
        const prefix = channel.path.includes('/') ? channel.path.slice(0, channel.path.lastIndexOf('/') + 1) : ''
        if (prefix !== group) {
          if (prefix) out(prefix)
          group = prefix
        }
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
        const { threads, messages, lastIndex } = channel
        // Counts only where the board keeps them: a team board in Vercel's API doesn't. One made
        // before anything posted to it has no last message.
        const counted = threads !== undefined && messages !== undefined
          ? `  ${count(threads, 'thread', 'threads')} · ${count(messages, 'message', 'messages')}${lastIndex ? ` · last #${lastIndex}` : ''}`
          : ''
        out(`${prefix ? '  ' : ''}${channel.path}${counted}`)
      }
      return 0
    }

    case 'actors': {
      const actors = await client().actors()
      if (flags.json) return result({ actors }), 0
      for (const actor of actors) out(`@${actor.handle}  ${actorName(actor)}  ${actor.id}`)
      return 0
    }

    case 'read': {
      const target = args[0]
      const board = client()
      // A platform's link to a message (a Slack permalink, a GitHub comment) reads the board's thread it synced.
      const link = target !== undefined && /^https?:\/\//i.test(target)
      if (target && (link || isMessageRef(target))) {
        const thread = link ? await board.linked(target) : await board.thread(messageId(target))
        // A board older than this CLI answers /links with its discovery document. Its 404 stays: a
        // current board's means the link isn't one it synced.
        if (link && !Array.isArray((thread as { replies?: unknown }).replies)) throw outdated("This board can't read links.")
        // With filters, the root and only the replies that match them.
        const narrowed = Object.keys(filters()).length > 0
        const replies = narrowed
          ? (await board.messages({ ...filters(), re: thread.message.id, limit: 500 })).messages.filter((m) => m.re !== null)
          : thread.replies
        if (flags.json) return result({ ...thread, replies }), 0
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
      const old = outdated("This board can't list threads.")
      // Only a board's own "no route" is one without the route: any other 404 says what it is.
      const page = await board.threads(query).catch((error: unknown) => {
        throw error instanceof BoardError && error.status === 404 && /^no route: /.test(error.message) ? old : error
      })
      if (!Array.isArray((page as { threads?: unknown }).threads)) throw old
      // Nothing in a channel that doesn't exist is a typo, not an empty channel.
      if (!page.threads.length && target) {
        const channels = (await board.channels()).map((c) => c.path)
        if (!channels.some((path) => path === target || path.startsWith(target.replace(/\/?$/, '/')))) {
          const guess = closest(target, channels)
          throw new Failed({
            class: 'not_found',
            reason: 'channel_not_found',
            message: `Couldn't find channel ${target}.${guess ? ` Did you mean ${guess}?` : ''}`,
            details: ['A channel appears with its first post: one nobody has posted in yet is not there to read.'],
            next: [{ instruction: 'See its channels', argv: [...cli(), 'channels'] }],
          })
        }
      }
      if (flags.json) return result(page), 0
      const count = `${page.threads.length} ${page.threads.length === 1 ? 'thread' : 'threads'}`
      out(`${target ?? 'all channels'} · ${count} · cursor ${page.cursor}${page.threads.length ? '\n' : ''}`)
      if (page.threads.length) out(formatThreadSummaries(page.threads, { channel: !target || target.endsWith('/') }))
      // The cursor is where this read stopped: the next command is the one that reads on from it.
      // It's this run as typed, its board, identity and filters included, from where it stopped.
      out(`\nnew since then: ${commandLine(rerunWithout(['--after'], '--after', String(page.cursor)))}`)
      return 0
    }

    case 'post': {
      const [target, body] = args
      if (!target) throw usage('Missing the channel or message to post to.', { reason: 'missing_arguments' })
      oneText('post', target, args.slice(2))
      const re = isMessageRef(target) ? messageId(target) : undefined
      if (re !== undefined && flags.sync?.length)
        throw usage("Can't use --sync on a reply. It syncs whole threads.", {
          next: [{ instruction: 'Sync the thread instead', argv: [...cli(), 'sync', re, '<TARGET>'] }],
        })
      if (flags.sync?.length && flags['no-sync']) throw usage("Can't use --sync with --no-sync.")
      if (re === undefined && flags.after !== undefined)
        throw usage("Can't use --after on a new thread. It's for replies: the thread's newest message.")
      const board = client()
      const said = await content(body, { optional: !!flags.attach?.length })
      const files = await attachments(board)
      const options = {
        text: said,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['idempotency-key'] ? { id: flags['idempotency-key'] } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      }
      const message = re === undefined
        ? await board.post(target, { ...options, ...(flags.sync?.length ? { sync: flags.sync } : {}) })
        : await board.reply(re, { ...options, ...(flags.after !== undefined ? { after: messageId(flags.after) } : {}) })
      printMessage(message)
      return 0
    }

    case 'reply': {
      const id = messageId(args[0])
      oneText('reply', args[0]!, args.slice(2))
      const board = client()
      const said = await content(args[1], { optional: !!flags.attach?.length })
      const files = await attachments(board)
      const message = await board.reply(id, {
        text: said,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['idempotency-key'] ? { id: flags['idempotency-key'] } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.after !== undefined ? { after: messageId(flags.after) } : {}),
      })
      printMessage(message)
      return 0
    }

    case 'schedule': {
      if (args[0] === 'cancel' && args.length === 2) {
        const { schedule, canceled } = await client().cancelSchedule(scheduleId(args[1]))
        if (flags.json) result({ schedule, outcome: canceled ? 'canceled' : 'unchanged' })
        else out(canceled ? `canceled ${schedule.id}` : `${schedule.id} is already ${schedule.state}`)
        return 0
      }
      const [target, body] = args
      if (!target) throw usage('Missing the channel or message to schedule a message in.', { reason: 'missing_arguments' })
      if (!flags.in && !flags.at && !flags.every) throw usage("Can't schedule a message without a time: pass --in 1d, --at <time>, or --every 30m.", { reason: 'missing_arguments' })
      const times = flags.times === undefined ? undefined : Number(flags.times)
      if (times !== undefined && !(Number.isInteger(times) && times > 0)) throw usage(`--times takes a count, and ${flags.times} isn't one.`)
      const board = client()
      const said = await content(body, { optional: !!flags.attach?.length })
      const files = await attachments(board)
      const where = isMessageRef(target) ? { re: messageId(target) } : target
      const schedule = await board.schedule(where, {
        text: said,
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
      if (flags.json) result({ schedule, outcome: 'scheduled' })
      else out(formatSchedule(schedule))
      return 0
    }

    case 'grants': {
      const [verb, ...rest] = args
      if (verb === undefined || verb === 'list') {
        if (rest.length > 0) throw usage(`grants list takes no arguments: ${rest[0]} is one too many.`)
        const list = await client().grants()
        if (flags.json) return result({ grants: list }), 0
        out(list.length === 0 ? 'no grants' : formatGrants(list))
        return 0
      }
      if (verb === 'create') {
        if (rest.length > 0) throw usage(`grants create takes no arguments: ${rest[0]} is one too many.`)
        onlyPrincipalFlags('create')
        const principals = grantFlags(() => principalsIn(ordered, [''])).map(({ principal }) => principal)
        if (principals.length === 0)
          throw usage('A grant names whom it lets in: --user, --project, --github, --oidc, --all-users, --all-projects, or --everyone.', { reason: 'missing_arguments' })
        const can = grantFlags(() => grantCanOf(flags.can ?? []))
        if (Object.keys(can).length === 0) throw usage("A grant says what it lets them do: --can pattern=permissions, like --can 'ci/=read,post'.", { reason: 'missing_arguments' })
        const { grant } = await client().createGrant({ principals, can })
        if (flags.json) result({ grant, outcome: 'created' })
        else out(`created ${grantRow(grant)}`)
        return 0
      }
      if (verb === 'update') {
        const id = grantId(rest[0])
        if (rest.length > 1) throw usage(`grants update takes one grant: ${rest[1]} is one too many.`)
        onlyPrincipalFlags('update')
        const named = grantFlags(() =>
          // To drop an environment, remove the principal and add it back with the ones it keeps, in one
          // update: as two, removing a grant's only principal would leave it naming no one.
          principalsIn(ordered, ['add-', 'remove-'], ({ kind, value }) => {
            const named = value !== undefined ? [value] : []
            return [
              {
                instruction: 'Remove it and add it back with the environments it keeps',
                argv: [...cli(), 'grants', 'update', id, `--remove-${kind}`, ...named, `--add-${kind}`, ...named, '--environment', '<ENVIRONMENTS>'],
              },
            ]
          }),
        )
        const add = named.filter(({ prefix }) => prefix === 'add-').map(({ principal }) => principal)
        const remove = named.filter(({ prefix }) => prefix === 'remove-').map(({ principal }) => principal)
        const can = flags.can !== undefined ? grantFlags(() => grantCanOf(flags.can!)) : undefined
        if (add.length === 0 && remove.length === 0 && can === undefined)
          throw usage(`grants update ${id} changes nothing: add or remove a principal (--add-user, --remove-project, …), or give --can.`, { reason: 'missing_arguments' })
        const { grant } = await client().updateGrant(id, { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}), ...(can !== undefined ? { can } : {}) })
        if (flags.json) result({ grant, outcome: 'updated' })
        else out(`updated ${grantRow(grant)}`)
        return 0
      }
      if (verb === 'explain') {
        const [channel, extra] = rest
        if (channel === undefined) throw usage('Missing the channel to explain, such as security/incidents.', { reason: 'missing_arguments' })
        if (extra !== undefined) throw usage(`grants explain takes one channel: ${extra} is one too many.`)
        onlyPrincipalFlags('explain')
        const { principal, subject, kind } = grantFlags(() => explainPrincipalOf(ordered))
        const explanation = await client().explain(channel, principal)
        if (flags.json) result({ explanation })
        else out(explanationLine(explanation, subject, kind))
        return 0
      }
      if (verb === 'revoke') {
        const id = grantId(rest[0])
        const { revoked } = await client().revokeGrant(id)
        if (flags.json) result({ grant: id, outcome: revoked ? 'revoked' : 'unchanged' })
        else out(revoked ? `revoked ${id}` : `${id} is already gone`)
        return 0
      }
      throw usage(`Unknown command ${verb} for ${named()} grants.`, { reason: 'unknown_command' })
    }

    case 'schemas': {
      const [verb, ...rest] = args
      if (verb === undefined || verb === 'list') {
        if (rest.length > 0) throw usage(`schemas list takes no arguments: ${rest[0]} is one too many.`)
        const list = await client().schemas()
        if (flags.json) return result({ schemas: list }), 0
        out(formatSchemas(list))
        return 0
      }
      if (verb !== 'inspect' && verb !== 'create') throw usage(`Unknown command ${verb} for ${named()} schemas.`, { reason: 'unknown_command' })
      const [id, extra] = rest
      if (id === undefined) throw usage(`Missing the schema to ${verb}: its name and version, like sandbox@1.`, { reason: 'missing_arguments' })
      if (extra !== undefined) throw usage(`schemas ${verb} takes one schema: ${extra} is one too many.`)
      const wanted = parseSchemaId(id)
      if (!wanted) throw usage(`${id} doesn't name a schema. One is name@version, like sandbox@1.`)
      if (verb === 'inspect') {
        const schema = await client().schema(id)
        if (flags.json) result({ schema })
        else out(formatSchema(schema))
        return 0
      }
      const { schema, created } = await client().createSchema({
        ...wanted,
        schema: await definition(),
        ...(flags.description !== undefined ? { description: flags.description } : {}),
      })
      if (flags.json) result({ schema, outcome: created ? 'created' : 'unchanged' })
      else out(created ? `created ${schema.id}` : `${schema.id} is already registered`)
      return 0
    }

    case 'schedules': {
      // A schedule's own ID (s12) shows that schedule, whatever became of it: sent, canceled, or still pending.
      if (args[0] !== undefined && isScheduleId(args[0])) {
        const one = (await client().schedules({ all: true })).find((schedule) => schedule.id.toLowerCase() === args[0]!.toLowerCase())
        if (!one)
          throw new Failed({
            class: 'not_found',
            reason: 'schedule_not_found',
            message: `Couldn't find schedule ${args[0]}.`,
            next: [{ instruction: 'See every schedule, done and canceled ones too', argv: [...cli(), 'schedules', '--all'] }],
          })
        if (flags.json) return result({ schedules: [one] }), 0
        return out(formatSchedule(one)), 0
      }
      const list = await client().schedules({
        ...(args[0] ? { re: messageId(args[0]) } : {}),
        ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
        ...(flags.channel ? { channel: flags.channel } : {}),
        ...(flags.all ? { all: true } : {}),
      })
      if (flags.json) return result({ schedules: list }), 0
      if (list.length === 0) return out(flags.all ? 'no schedules' : 'no pending schedules'), 0
      out(list.map((schedule) => formatSchedule(schedule)).join('\n'))
      return 0
    }

    case 'hooks': {
      const [action, ...names] = args
      if (action !== 'uninstall')
        throw usage(`\`${`${named()} hooks ${action ?? ''}`.trimEnd()}\` is gone. Turn-end hooks were removed.`, {
          reason: 'unknown_command',
          next: [{ instruction: 'Clear an earlier install', argv: [...cli(), 'hooks', 'uninstall'] }],
        })
      const agents = hookAgents(names)
      const width = Math.max(...agents.map((agent) => AGENTS[agent].name.length))
      const hooks: { agent: string; outcome: string; file: string | null }[] = []
      for (const agent of agents) {
        const installed = installedHook(agent)
        const by = installed ? cliOf(installed) : null
        const rules = by ? allowRules(agent, by) : null
        if (rules) disallow(rules.file, rules.rules)
        const removed = uninstallHook(agent)
        hooks.push({ agent, outcome: removed ? 'removed' : 'unchanged', file: installed ? AGENTS[agent].file() : null })
        if (!flags.json) out([AGENTS[agent].name.padEnd(width), removed ? 'removed' : 'not installed', installed ? tilde(AGENTS[agent].file()) : ''].join('  ').trimEnd())
      }
      if (flags.json) result({ hooks })
      return 0
    }

    // What an earlier board's turn-end hook still runs: it does nothing, so those turns end as they would without it.
    // `hooks uninstall` clears it.
    case 'hook':
      return 0

    case 'edit': {
      const id = messageId(args[0])
      await client().edit(id, await content(args[1]), ifRevision())
      printDone(id, 'edited')
      return 0
    }

    case 'delete': {
      const id = messageId(args[0])
      await client().delete(id, ifRevision())
      printDone(id, 'deleted')
      return 0
    }

    case 'react': {
      const id = messageId(args[0])
      if (!args[1]) throw usage('Missing the emoji to react with, like eyes or thumbs_up.', { reason: 'missing_arguments' })
      let emoji: string
      try {
        emoji = normalizeEmoji(args[1])
      } catch {
        throw usage(`Unknown emoji ${args[1]}. Use a short name, like eyes or thumbs_up.`)
      }
      await client().react(id, emoji, flags.remove ? { remove: true } : {})
      printDone(id, flags.remove ? 'unreacted' : 'reacted')
      return 0
    }

    case 'label': {
      const id = messageId(args[0])
      const set = labelPairs(args.slice(1), undefined, '{value} has no value. To remove the label, --unset {key}.')
      const unset = flags.unset ?? []
      if (Object.keys(set).length === 0 && unset.length === 0)
        throw usage('Missing the labels: k=v to set one, --unset k to remove one.', { reason: 'missing_arguments' })
      // What the labels must be now: --if k=v has the value, --if-unset k has none.
      const expected: Record<string, string | null> = labelPairs(flags.if, "--if takes key=value, and {value} isn't one. For a label that mustn't be set, --if-unset key.", null)
      for (const key of flags['if-unset'] ?? []) {
        if (Object.hasOwn(expected, key)) throw usage(`Can't use --if ${key}=… with --if-unset ${key}.`)
        expected[key] = null
      }
      await client().label(id, { set, unset, ...(Object.keys(expected).length ? { if: expected } : {}) })
      printDone(id, 'labeled')
      return 0
    }

    case 'typing': {
      const id = messageId(args[0])
      const status = args.slice(1).join(' ').trim()
      const targets = await client().typing(id, status || undefined)
      if (flags.json) result({ targets })
      return 0
    }

    case 'sync': {
      const id = messageId(args[0])
      if (!args[1]) {
        const { targets } = await client().sync(id)
        if (flags.json) return result({ targets }), 0
        out(targets.length ? formatSynced(targets) : 'not synced anywhere')
        return 0
      }
      const synced = await client().sync(id, args[1])
      if (flags.json) result({ ...synced, outcome: synced.attached ? 'synced' : 'unchanged' })
      else out(synced.attached ? `synced with ${synced.target}` : `already synced with ${synced.target}`)
      return 0
    }

    case 'download': {
      const id = args[0]
      if (!id) throw usage(`Missing the attachment to download: the ID \`${named()} read\` shows on a file line.`, { reason: 'missing_arguments' })
      // An ID has no dot or slash: this is the file's name, which many attachments may share.
      if (/[./]/.test(id))
        throw usage(`${id} is a file's name, and download takes the attachment's ID: the last thing on its file line when you read its thread.`, {
          next: [{ instruction: 'Read the thread to see the ID', argv: [...cli(), 'read', '<ID>'] }],
        })
      const response = await client().download(id)
      const data = new Uint8Array(await response.arrayBuffer())
      if (args[1] === '-') return io.write(data), 0
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      // Whoever posted the file chose its name: saved by it, it never lands as a dotfile or replaces a file.
      const saveAs = basename(filename ? decodeURIComponent(filename) : id).replace(/^\.+/, '')
      const path = args[1] ?? (saveAs || id)
      await io.writeFile(path, data, { exclusive: args[1] === undefined })
      if (flags.json) result({ attachment: { id }, path, outcome: 'downloaded' })
      else out(path)
      return 0
    }

    case 'inbox': {
      const key = args[0]
      if (!key) throw usage('Missing the sync entry whose inbox to read, such as slack.', { reason: 'missing_arguments' })
      const events = await client().inbox(key, {
        ...(args[1] ? { channel: args[1] } : {}),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return result({ events }), 0
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
        if (flags.json) return result({ sources: sync }), 0
        if (sync.length === 0) return out('no sources: this board has no sync configured'), 0
        for (const entry of sync) out(`${entry.key}  ${entry.platform}`)
        return 0
      }
      if (sub === 'join' && target) {
        const joined = await client().joinSource(key, target)
        if (flags.json) return result({ ...joined, outcome: joined.joined ? 'joined' : 'unchanged' }), 0
        const label = joined.name ? `#${joined.name}` : joined.channel
        return out(joined.joined ? `joined ${label}` : `already in ${label}`), 0
      }
      if (sub !== 'read' && sub !== 'join') throw usage(sub === undefined ? `Missing what to do with ${key}: read or join.` : `Unknown command ${sub} for ${named()} sources.`, { reason: sub === undefined ? 'missing_arguments' : 'unknown_command' })
      if (!target) throw usage(`Missing the channel, thread, or link to ${sub}.`, { reason: 'missing_arguments' })
      const read = await client().readSource(key, target, { ...(flags.limit ? { limit: Number(flags.limit) } : {}), ...(flags.after ? { after: String(flags.after) } : {}) })
      if (flags.json) return result(read), 0
      return out(formatSourceRead(key, read, Date.now(), named())), 0
    }

    case 'tail': {
      const controller = new AbortController()
      // Its handler goes when it's done: inside another CLI, the process goes on, and Ctrl-C should stop it.
      const stop = stopOn(controller)
      try {
        for await (const event of client().events(
          { ...filters(args[0]), ...(flags.all ? { all: true } : {}) },
          { signal: controller.signal },
        ))
          if (flags.json) line(event)
          else out(formatEvent(event))
      } finally {
        stop.release()
      }
      // Ctrl-C is a cancel; the caller's signal is how `vb()` ends a tail.
      return stop.interrupted() ? 130 : 0
    }

    case 'wait': {
      const controller = new AbortController()
      const stop = stopOn(controller)
      // A bare number is seconds, as `timeout 30` and `sleep 30` are: the client's own bare number is milliseconds.
      const timeout = /^\d+$/.test(flags.timeout ?? '') ? `${flags.timeout}s` : (flags.timeout ?? '30m')
      // A message's ID where a channel goes is its thread: a channel of that name would never answer.
      const thread = args[0] !== undefined && isMessageRef(args[0]) && flags.re === undefined ? args[0] : undefined
      // Its thread is its root's, and what's wanted is what comes after it: an answer already there is one.
      const root = thread === undefined ? undefined : (await client().thread(messageId(thread))).message.id
      const waitsOn = root === undefined ? filters(args[0]) : { ...filters(), re: root, ...(flags.after === undefined ? { after: messageId(thread!) } : {}) }
      const event = await client()
        .wait(waitsOn, { timeout, signal: controller.signal })
        .finally(stop.release)
      if (!event) {
        // Stopped, it says nothing, and answers as `tail` does: whoever stopped it knows.
        if (controller.signal.aborted) return stop.interrupted() ? 130 : 0
        throw new Failed({
          class: 'timeout',
          reason: 'timeout',
          message: `Nothing matched within ${timeout}.`,
          // What was already there when it started never matches: the commonest reason a wait comes back empty.
          details: [waitsOn.after === undefined ? 'wait sees only what arrives after it starts. For what is already there, read, or pass --after <id>.' : `Nothing came after ${waitsOn.after}.`],
          next: [{ instruction: 'See what is there now', argv: [...cli(), 'read', ...(thread ?? flags.re ?? args[0] ? [(thread ?? flags.re ?? args[0])!] : [])] }],
        })
      }
      if (flags.json) result({ event })
      else {
        out(formatEvent(event))
        // One event a wait: this is where it stopped, so the next wait misses nothing after it.
        // This run as typed, its board, identity and filters included, from where it stopped.
        out(`next: ${commandLine(rerunWithout(['--after'], '--after', String(event.cursor)))}`)
      }
      return 0
    }

    default: {
      const own = app.commands[command]
      if (own) return own.run(args, context())
      const names = [...commands.flatMap((known) => [known.name, ...(known.aliases ?? [])]), ...Object.keys(app.commands)]
      const guess = closest(command, names)
      // What people and agents type for a command that goes by another name here.
      const said = Object.hasOwn(OTHER_NAMES, command.toLowerCase()) ? OTHER_NAMES[command.toLowerCase()] : undefined
      throw usage(`Unknown command ${command} for ${named()}.${said ? '' : guess ? ` Did you mean ${guess}?` : ''}`, {
        reason: 'unknown_command',
        next: [
          ...(said ? [{ instruction: said.instruction, argv: [...cli(), ...said.argv] }] : []),
          { instruction: 'See all commands', argv: [...cli(), '--help'] },
        ],
      })
    }
  }
}


/** Words for a command this CLI names otherwise, and the command they mean. */
const OTHER_NAMES: Record<string, { instruction: string; argv: string[] }> = {
  search: { instruction: 'Search is a filter on read', argv: ['read', '<CHANNEL>', '--text', '<PHRASE>'] },
  find: { instruction: 'Search is a filter on read', argv: ['read', '<CHANNEL>', '--text', '<PHRASE>'] },
  grep: { instruction: 'Search is a filter on read', argv: ['read', '<CHANNEL>', '--text', '<PHRASE>'] },
  list: { instruction: "List a channel's threads with read", argv: ['read', '<CHANNEL>'] },
  ls: { instruction: "List a channel's threads with read", argv: ['read', '<CHANNEL>'] },
  threads: { instruction: "List a channel's threads with read", argv: ['read', '<CHANNEL>'] },
  messages: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  thread: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  show: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  get: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  view: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  history: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  send: { instruction: 'Start a thread with post', argv: ['post', '<CHANNEL>', '<TEXT>'] },
  create: { instruction: 'Start a thread with post', argv: ['post', '<CHANNEL>', '<TEXT>'] },
  comment: { instruction: 'Reply in a thread', argv: ['reply', '<ID>', '<TEXT>'] },
  answer: { instruction: 'Reply in a thread', argv: ['reply', '<ID>', '<TEXT>'] },
  update: { instruction: "Change a message's text with edit", argv: ['edit', '<ID>', '<TEXT>'] },
  remove: { instruction: 'Delete a message', argv: ['delete', '<ID>'] },
  rm: { instruction: 'Delete a message', argv: ['delete', '<ID>'] },
  cancel: { instruction: 'Cancel a schedule', argv: ['schedule', 'cancel', '<SCHEDULE>'] },
  unschedule: { instruction: 'Cancel a schedule', argv: ['schedule', 'cancel', '<SCHEDULE>'] },
  remind: { instruction: 'Post later with schedule', argv: ['schedule', '<TARGET>', '<TEXT>', '--in', '<DURATION>'] },
  attach: { instruction: 'Attach a file to a post', argv: ['post', '<TARGET>', '<TEXT>', '--attach', '<FILE>'] },
  upload: { instruction: 'Attach a file to a post', argv: ['post', '<TARGET>', '<TEXT>', '--attach', '<FILE>'] },
  claim: { instruction: 'Claim a thread with a label, unless someone has', argv: ['label', '<ID>', 'owner=<YOU>', '--if-unset', 'owner'] },
  assign: { instruction: 'Claim a thread with a label, unless someone has', argv: ['label', '<ID>', 'owner=<YOU>', '--if-unset', 'owner'] },
  tag: { instruction: 'Set labels on a message', argv: ['label', '<ID>', '<KEY=VALUE>'] },
  labels: { instruction: 'Set labels on a message', argv: ['label', '<ID>', '<KEY=VALUE>'] },
  mentions: { instruction: 'Mentions are a filter on read and wait', argv: ['read', '--mentions'] },
  watch: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  follow: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  subscribe: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  listen: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  users: { instruction: 'See who is on the board', argv: ['actors'] },
  members: { instruction: 'See who is on the board', argv: ['actors'] },
  me: { instruction: 'See who you are', argv: ['whoami'] },
}

/**
 * Aborts `controller` on the run's signal, or Ctrl-C without one. `release` stops listening, and
 * `interrupted` says whether Ctrl-C stopped it.
 */
function stopOn(controller: AbortController): { release: () => void; interrupted: () => boolean } {
  const stop = () => controller.abort()
  if (io.signal) {
    if (io.signal.aborted) stop()
    io.signal.addEventListener('abort', stop, { once: true })
    const signal = io.signal
    return { release: () => signal.removeEventListener('abort', stop), interrupted: () => false }
  }
  process.once('SIGINT', stop)
  return { release: () => process.off('SIGINT', stop), interrupted: () => controller.signal.aborted }
}

/** What a command an app adds gets: this run's flags, and the helpers board's own commands use. */
const context = (): CommandContext => ({
  flags,
  out,
  usage: (message) => usage(message),
  portFlag,
  connection,
  client,
  openBrowser,
})

/**
 * Runs board's CLI on `argv` (what follows the command name) as `app`, and answers its exit
 * code: 0 success, 1 error (a `wait` that timed out included), 2 misuse, 130 when Ctrl-C stops it. A
 * failure goes to `app.onError`, or to stderr: `error: ` and what failed, then how to fix it, or
 * with `--json`, one JSON document. A long-running command (`tail`, `serve`) answers once it's
 * stopped.
 */
export async function main(argv: string[], options: App): Promise<number> {
  // The app's login and team are the run's, and only the run's.
  handLogin(options.login ?? null)
  handTeam(options.team ?? null)
  handFetch(options.fetch ?? null)
  try {
    return await runOnce(argv, options)
  } finally {
    handLogin(null)
    handTeam(null)
    handFetch(null)
  }
}

async function runOnce(argv: string[], options: App): Promise<number> {
  app = options
  typed = argv
  flags = {} as Flags
  positionals = []
  warnings = []
  reached = null
  sentLength = 0
  try {
    parse(argv)
    if (flags.version) {
      if (flags.json) result({ version: VERSION })
      else out(VERSION)
      return 0
    }
    // --help is help, never the command it's on: that command's page.
    if (flags.help) {
      out(help(positionals))
      return 0
    }
    const [word, ...args] = positionals
    const command = canonical(word)
    current = { command, args }
    if (io.board) {
      const given = flags.url ? 'url' : flags.name !== undefined ? 'name' : flags.ensure ? 'ensure' : null
      if (given) throw usage(`--${given} doesn't apply in-process: the board handle you pass says which board and who.`, { next: [] })
      if (command !== undefined && MACHINE.has(command))
        throw usage(`${command} isn't available in-process: it's about the machine ${named()} runs on.`, { reason: 'not_available', next: [] })
    }
    return await run(command, args)
  } catch (error) {
    // Its caller's signal ended its requests: `tail` and `wait` end as they do when it stops them, the rest say so.
    if (io.signal?.aborted) {
      if (current.command === 'tail' || current.command === 'wait') return 0
      error = stopped(io.signal.reason)
    }
    // Before the parser says, `--json` is whether it was typed before any `--`.
    const json = flags.json ?? argv.slice(0, argv.includes('--') ? argv.indexOf('--') : undefined).includes('--json')
    return report(failureOf(error), json)
  }
}

/** The commands that change the board, whatever their arguments. */
const WRITES = new Set(['post', 'reply', 'edit', 'delete', 'label', 'react', 'schedule', 'sync'])

/** What a run its caller's signal stopped says: a write it was making may have landed. */
function stopped(reason: unknown): Failed {
  const timedOut = reason instanceof Error && reason.name === 'TimeoutError'
  // A subcommand that writes is `channels create`'s first word, `sources <key> join`'s second.
  const sub = current.command === 'sources' ? current.args[1] : current.args[0]
  const writes = WRITES.has(current.command ?? '') || ['create', 'update', 'revoke', 'cancel', 'join'].includes(sub ?? '')
  return new Failed({
    class: timedOut ? 'timeout' : 'canceled',
    reason: timedOut ? 'timeout' : 'canceled',
    message: `${timedOut ? 'Timed out' : 'Stopped'} before it could ${doing()}.`,
    ...(writes ? { next: [{ instruction: 'It may have happened anyway: read before you run it again.' }] } : {}),
  })
}

/** The commands about the machine the CLI runs on, not the board: none of them run in-process. */
const MACHINE = new Set(['whoami', 'hooks', 'hook', 'serve', 'inspect'])

/** `main()` with `io` in place of the terminal, for `vb()`. One run at a time, as `main()`'s. */
export async function mainWith(argv: string[], options: App, with_: Io): Promise<number> {
  io = with_
  try {
    return await main(argv, options)
  } finally {
    io = TERMINAL
  }
}
