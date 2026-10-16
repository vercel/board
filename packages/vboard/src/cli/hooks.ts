import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configDir } from '../client/node.ts'

// Coding agents end each turn with a hook (Pi, with an extension). `vb hooks install` adds one that
// reminds the agent, once, to update the board when its turn didn't: it replies
// in a thread it's working in or posts where it fits, or just finishes. The hook only reminds; the agent uses the CLI for everything, reading
// included. Deciding reads only a local marker, so a turn never waits on it.

type Shape = 'nested' | 'flat' | 'extension'

/**
 * Where each agent keeps hooks, and which of its events run ours. Claude Code
 * and Codex read `{ hooks: { Stop: [{ hooks: [entry] }] } }`; Cursor reads
 * `{ version: 1, hooks: { stop: [entry] } }`, and its stop can't block, so it's
 * reminded with a follow-up message instead. Pi has no hook files: its hook is
 * an extension we write whole (`piExtension`), in `$PI_CODING_AGENT_DIR/extensions`.
 */
export const AGENTS = {
  claude: { name: 'Claude Code', shape: 'nested', event: 'Stop', file: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json') },
  codex: { name: 'Codex', shape: 'nested', event: 'Stop', file: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json') },
  cursor: { name: 'Cursor', shape: 'flat', event: 'stop', file: () => join(homedir(), '.cursor', 'hooks.json') },
  pi: { name: 'Pi', shape: 'extension', event: 'agent_before_settle', file: () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'extensions', 'vboard.ts') },
} as const satisfies Record<string, { name: string; shape: Shape; event: string; file: () => string }>

export type HookAgent = keyof typeof AGENTS

type HookEntry = { type?: string; command: string; timeout?: number }
type Group = { matcher?: string; hooks?: HookEntry[] }
type Entries = (Group | HookEntry)[]
type Config = { version?: number; hooks?: Record<string, Entries>; permissions?: { allow?: string[] } & Record<string, unknown> } & Record<
  string,
  unknown
>

const ours = (entry: { command?: string }) => / hook stop --agent /.test(entry.command ?? '')

function readConfig(path: string): Config {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`can't read ${path}: ${(error as Error).message}`)
  }
}

/** Written to a sibling, then renamed: a crash never leaves an agent's settings half-written. */
function writeConfig(path: string, config: Config) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.vboard-tmp`, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(`${path}.vboard-tmp`, path)
}

/** An event's entries without ours; a group left with no hooks goes too. */
function without(entries: Entries, shape: Shape): Entries {
  if (shape === 'flat') return entries.filter((entry) => !ours(entry as HookEntry))
  return entries
    .map((group) => ({ ...group, hooks: ((group as Group).hooks ?? []).filter((h) => !ours(h)) }))
    .filter((group) => group.hooks.length > 0)
}

/** The line of our Pi extension that holds the command it runs: how status finds it. */
const PI_COMMAND = /^const COMMAND = (".*")$/m

/**
 * Pi's turn-end hook, as an extension. Before Pi settles a completed run, it
 * runs our command with what Claude Code's hook gets (the session, the
 * directory, and whether this hook made it continue); a reminder comes back
 * as a message, and Pi continues once to act on it. Pi's bash tool exports the
 * same session as `PI_SESSION_ID`, so the agent's `vb reply` or `vb post` counts for it.
 */
export function piExtension(command: string): string {
  return `// Added by \`vb hooks install pi\`: reminds Pi, once per turn, to update the team's board (vboard).
// \`vb hooks uninstall pi\` removes it; reinstalling replaces this file.
import { spawn } from 'node:child_process'

const COMMAND = ${JSON.stringify(command)}

function run(cwd: string, input: string): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn('/bin/sh', ['-c', COMMAND], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => child.kill(), 10_000)
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(''))
    child.on('close', () => (clearTimeout(timer), resolve(out)))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export default function vboard(pi: any) {
  let reminded = false
  pi.on('agent_before_settle', async (event: any, ctx: any) => {
    const continuing = reminded
    reminded = false
    if (event.outcome !== 'completed') return
    try {
      const input = JSON.stringify({ session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, stop_hook_active: continuing })
      const reason = JSON.parse((await run(ctx.cwd, input)) || '{}').reason
      if (typeof reason !== 'string' || !reason) return
      reminded = true
      return { entries: [...event.entries, { type: 'custom_message', customType: 'vboard', content: reason, display: true }], continue: true }
    } catch {}
  })
}
`
}

/**
 * The command our hook runs. `|| true`: whatever `cli` turns out to be (an older vboard without
 * `hook` exits 2, which Claude Code and Codex read as "keep going"), the hook can't fail a turn.
 */
const hookCommand = (agent: HookAgent, cli: string, flags = '') => `${cli} hook stop --agent ${agent}${flags} 2>/dev/null || true`

/** Adds our hook, replacing an earlier one of ours; everything else in the file stays. Answers whether it changed. */
export function installHook(agent: HookAgent, cli: string, flags = ''): boolean {
  const spec = AGENTS[agent]
  const command = hookCommand(agent, cli, flags)
  if (spec.shape === 'extension') {
    const source = piExtension(command)
    let current: string | null = null
    try {
      current = readFileSync(spec.file(), 'utf8')
    } catch {}
    if (current === source) return false
    if (current !== null && !current.startsWith('// Added by `vb hooks install pi`'))
      throw new Error(`${spec.file()} isn't vboard's: move it, then install again`)
    mkdirSync(dirname(spec.file()), { recursive: true })
    writeFileSync(`${spec.file()}.vboard-tmp`, source)
    renameSync(`${spec.file()}.vboard-tmp`, spec.file())
    return true
  }
  const config = readConfig(spec.file())
  const entry = spec.shape === 'flat' ? { command, timeout: 10 } : { hooks: [{ type: 'command', command, timeout: 10 }] }
  const hooks = { ...config.hooks, [spec.event]: [...without(config.hooks?.[spec.event] ?? [], spec.shape), entry] }
  const next = { ...(spec.shape === 'flat' ? { version: 1 } : {}), ...config, hooks }
  if (JSON.stringify(next) === JSON.stringify(config)) return false
  writeConfig(spec.file(), next)
  return true
}

/** Removes our hook. A file that held only it (Cursor's, which we created) goes away with it. */
export function uninstallHook(agent: HookAgent): boolean {
  const spec = AGENTS[agent]
  if (installedHook(agent) === null) return false
  if (spec.shape === 'extension') return unlinkSync(spec.file()), true
  const config = readConfig(spec.file())
  const hooks = { ...config.hooks }
  const kept = without(hooks[spec.event] ?? [], spec.shape)
  if (kept.length > 0) hooks[spec.event] = kept
  else delete hooks[spec.event]
  const rest = Object.keys(config).filter((key) => key !== 'hooks' && key !== 'version')
  if (rest.length === 0 && Object.keys(hooks).length === 0) unlinkSync(spec.file())
  else writeConfig(spec.file(), { ...config, hooks })
  return true
}

/** The command our hook runs for `agent`, if it's installed. */
export function installedHook(agent: HookAgent): string | null {
  const spec = AGENTS[agent]
  if (spec.shape === 'extension') {
    try {
      const line = PI_COMMAND.exec(readFileSync(spec.file(), 'utf8'))
      return line ? (JSON.parse(line[1]!) as string) : null
    } catch {
      return null
    }
  }
  const entries = readConfig(spec.file()).hooks?.[spec.event] ?? []
  const commands = spec.shape === 'flat' ? (entries as HookEntry[]) : entries.flatMap((group) => (group as Group).hooks ?? [])
  return commands.find(ours)?.command ?? null
}

/** A path under the home directory as `~/…`, the way people write it. */
export function tilde(path: string): string {
  const home = homedir()
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** The CLI an installed hook runs: everything before ` hook stop`. */
export const cliOf = (command: string) => command.slice(0, command.indexOf(' hook stop '))

// --- what the agent may run without asking -----------------------------------------

/**
 * The reminder asks the agent to run `vb reply`, `vb post`, `vb read`, and `vb channels`;
 * where the agent keeps an allowlist, those run without a permission prompt.
 * Claude Code matches command prefixes; Cursor matches a command's name, so it
 * can allow only a `vb` on PATH. Codex has no command allowlist: its sandbox
 * decides (see `codexNetwork`).
 */
const REMINDED = ['reply', 'post', 'read', 'channels']

/** Rules an earlier install added that this one doesn't: `vb update`, since removed. Uninstall drops them too. */
export function legacyRules(agent: HookAgent, cli: string): string[] {
  return agent === 'claude' ? [`Bash(${cli} update:*)`] : []
}

export function allowRules(agent: HookAgent, cli: string): { file: string; rules: string[] } | null {
  if (agent === 'claude') return { file: AGENTS.claude.file(), rules: REMINDED.map((sub) => `Bash(${cli} ${sub}:*)`) }
  if (agent === 'cursor' && cli === 'vb') return { file: join(homedir(), '.cursor', 'cli-config.json'), rules: ['Shell(vb)'] }
  return null
}

/** Adds the rules a file doesn't have yet. Answers the ones it added. */
export function allow(file: string, rules: string[]): string[] {
  const config = readConfig(file)
  const allowed = config.permissions?.allow ?? []
  const added = rules.filter((rule) => !allowed.includes(rule))
  if (added.length > 0) writeConfig(file, { ...config, permissions: { ...config.permissions, allow: [...allowed, ...added] } })
  return added
}

export function disallow(file: string, rules: string[]) {
  const config = readConfig(file)
  const allowed = config.permissions?.allow
  if (!allowed?.some((rule) => rules.includes(rule))) return
  writeConfig(file, { ...config, permissions: { ...config.permissions, allow: allowed.filter((rule) => !rules.includes(rule)) } })
}

/**
 * Codex's default sandbox has no network, so `vb` can't reach the board. A
 * permission profile can allow just the board, and Vercel's API for its token.
 * In TOML a key after a `[table]` belongs to it, so `default_permissions` goes
 * at the top; the tables go anywhere (`[features]` merged into one that's there).
 */
export function codexNetwork(boardHost: string | null): { top: string; tables: string } {
  const hosts = [boardHost ?? '<your board host>', 'api.vercel.com']
  return {
    top: 'default_permissions = "vboard"',
    tables: [
      '[features]',
      'network_proxy = true',
      '',
      '[permissions.vboard]',
      'extends = ":workspace"',
      '',
      '[permissions.vboard.network]',
      'enabled = true',
      '',
      '[permissions.vboard.network.domains]',
      ...hosts.map((host) => `"${host}" = "allow"`),
    ].join('\n'),
  }
}

/** Names in words: `a`, `a or b`, `a, b, or c`. */
const either = (names: string[]) => (names.length < 3 ? names.join(' or ') : `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`)

/**
 * How an installed hook differs from what installing it again would write, as
 * short phrases (none when it's current): an older hook command or Pi
 * extension, rules for commands since removed, rules it doesn't have yet.
 * It keeps the CLI the hook runs, which `install` may choose differently.
 */
export function outdated(agent: HookAgent, installed: string): string[] {
  const spec = AGENTS[agent]
  const cli = cliOf(installed)
  const problems: string[] = []
  if (installed !== hookCommand(agent, cli)) problems.push('runs an older hook command')
  if (spec.shape === 'extension') {
    let source = ''
    try {
      source = readFileSync(spec.file(), 'utf8')
    } catch {}
    if (source !== piExtension(installed)) problems.push('the extension is from another version')
  }
  const rules = allowRules(agent, cli)
  if (rules) {
    const allowed = readConfig(rules.file).permissions?.allow ?? []
    // A rule's subcommand, as people say it: `Bash(vb update:*)` is update.
    const sub = (rule: string) => {
      const inner = /^\w+\((.*?)(?::\*)?\)$/.exec(rule)?.[1] ?? rule
      return inner.startsWith(`${cli} `) ? inner.slice(cli.length + 1) : inner
    }
    const gone = legacyRules(agent, cli).filter((rule) => allowed.includes(rule))
    const missing = rules.rules.filter((rule) => !allowed.includes(rule))
    if (gone.length > 0) problems.push(`allows ${either(gone.map(sub))}, which ${gone.length === 1 ? 'is' : 'are'} gone`)
    if (missing.length > 0) problems.push(`doesn't allow ${either(missing.map(sub))}`)
  }
  return problems
}

// --- one session's turns -----------------------------------------------------------

/** When the session last wrote to the board, last was reminded to, and last finished a turn. */
type Turns = { posted?: number; asked?: number; settled?: number }

/**
 * In the temp directory, which agents' sandboxes let commands write (Codex's
 * doesn't allow ~/.config): a marker only has to last a few turns, and the
 * system clears it with the rest of its temp files. `XDG_RUNTIME_DIR`, where
 * there is one, is the user's own.
 */
export const turnsDir = () => join(process.env.XDG_RUNTIME_DIR || tmpdir(), `vboard-turns-${process.getuid?.() ?? 'user'}`)
const turnsFile = (session: string) => join(turnsDir(), `${session.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)

function readTurns(session: string): Turns {
  try {
    return JSON.parse(readFileSync(turnsFile(session), 'utf8')) as Turns
  } catch {
    return {}
  }
}

/** The marker directory, only if it's ours: in a shared /tmp, someone else could have made it first. */
function ownTurnsDir(): string {
  const dir = turnsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { uid, mode } = statSync(dir)
  if (process.getuid && uid !== process.getuid()) throw new Error(`${dir} belongs to someone else`)
  if ((mode & 0o077) !== 0) chmodSync(dir, 0o700)
  return dir
}

function writeTurns(session: string, turns: Turns) {
  ownTurnsDir()
  writeFileSync(turnsFile(session), JSON.stringify(turns))
}

/** A write to the board from an agent session: this turn needs no reminder. Best effort: the write already happened. */
export function markPosted(session: string, now = Date.now()) {
  try {
    writeTurns(session, { ...readTurns(session), posted: now })
  } catch {}
}

/**
 * The turn-end decision: let the agent stop, or remind it once to update the
 * board. It stops freely when it wrote to the board since its last turn
 * ended, when it was already reminded this turn, or when the agent says a
 * hook made it continue (`continuing`), so it can never loop.
 */
export function decideStop(session: string, continuing: boolean, now = Date.now()): 'stop' | 'ask' {
  const turns = readTurns(session)
  const since = turns.settled ?? 0
  if (continuing || (turns.posted ?? 0) > since || (turns.asked ?? 0) > since) {
    writeTurns(session, { ...turns, settled: now })
    return 'stop'
  }
  writeTurns(session, { ...turns, asked: now })
  return 'ask'
}

/**
 * The reminder, with the exact commands to run. It doesn't pick a channel: the
 * agent replies in a thread it's working in, or finds the channel that fits.
 * Finishing without a write is fine, since the hook asks only once a turn.
 */
export function reminder(cli: string): string {
  return [
    "You didn't update the team's board (vboard) this turn.",
    `If you changed anything or made progress, share a 1–3 sentence summary of what you did and what's next where the team will see it: ${cli} reply <id> "<text>" in a board thread you're working in, or ${cli} post <channel> "<text>" in the channel that fits (${cli} channels lists them, ${cli} read <channel> shows what's there). Add --attach <file> for proof, like a test log.`,
    `If you want to store memory, you can post to brain-<username>. Channels are public, so never store sensitive information.`,
    "If this turn changed nothing worth sharing (say, you just answered a question), just finish. Don't include the prompt, long output, or secrets.",
  ].join(' ')
}

// The first reminder on each board also offers to link the person's accounts, once.
// The marker lives in the config directory, so it survives reboots.

/** Marks the offer made for `board`. True only for the call that made it, and never when it can't be saved. */
export function claimLinkOffer(board: string): boolean {
  const file = join(configDir(), 'link-offered', createHash('sha256').update(board).digest('hex').slice(0, 32))
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, '', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

export function linkOffer(cli: string): string {
  return [
    `One more thing, this time only: run ${cli} identity.`,
    "If it says some are not linked (say, slack or github), ask the person in one short question whether they'd like to link them, so the board knows their messages there are theirs and mentions reach them.",
    `If they say yes, run ${cli} identity link <key> --no-wait for each and give them the sign-in URL or code it prints: only they should open or post it.`,
    "If they say no, or there's nothing to link, drop it. This won't come up again.",
  ].join(' ')
}

/**
 * The reminder as each agent reads it from the hook's stdout. Claude Code
 * shows a stop's `additionalContext` once, as hook feedback, and continues the
 * turn; a blocked stop would also show it as a hook error. Codex and Pi's
 * extension read a blocked stop's `reason`; Cursor, whose stop can't block,
 * a `followup_message`.
 */
export function stopOutput(agent: string, text: string): Record<string, unknown> {
  if (agent === 'claude') return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } }
  if (agent === 'cursor') return { followup_message: text }
  return { decision: 'block', reason: text }
}
