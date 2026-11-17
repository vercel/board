import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import { deploymentToken, personToken } from './harness.ts'
import { CLI, env, tmp, url, vb } from './cli-harness.ts'

// What the cli-tasks*.test.ts files share: `vb tasks` against the calling file's board, the people
// and profiles that work its tasks, and the claims the CLI keeps between commands.

export type Env = NodeJS.ProcessEnv

/** A command that must work: what it printed. */
export async function ok(args: string[], extra: Env = {}, stdin?: string): Promise<string> {
  const ran = await vb(args, extra, stdin)
  expect(ran, `vb ${args.join(' ')}\n${ran.stderr}`).toMatchObject({ code: 0, stderr: '' })
  return ran.stdout
}

/** A new task in `channel`, by its ID. */
export const create = async (channel: string, text: string, flags: string[] = [], extra: Env = {}) => (await ok(['tasks', 'create', channel, text, ...flags], extra)).trim()

/** A task's root, as `read --json` has it. */
export const task = async (id: string, extra: Env = {}): Promise<MessageView> => (JSON.parse(await ok(['read', id, '--json'], extra)) as { message: MessageView }).message
export const state = async (id: string) => (await task(id)).task?.state

/** A failure as `--json` leaves it on stderr. */
export const failure = (ran: { stderr: string }) => JSON.parse(ran.stderr) as { reason: string; message: string; next?: { command: string; argv: string[]; when: string }[]; data?: unknown }

/**
 * Another person on the team, and a deployment on it, which labels everywhere and manages nothing:
 * each at a machine of its own, so with a config home of its own, where its claims are kept.
 */
const homes = new Map<string, Promise<string>>()
const homeOf = (who: string) => homes.get(who) ?? homes.set(who, tmp(`board-${who}-`)).get(who)!
export const bo = async (): Promise<Env> => ({ BOARD_TOKEN: await personToken('u_bo', url), XDG_CONFIG_HOME: await homeOf('bo') })
export const deployment = async (): Promise<Env> => ({ BOARD_TOKEN: await deploymentToken('web', 'prj_web', 'production', { audience: url }), XDG_CONFIG_HOME: await homeOf('web') })

/** A run that writes as `profile`, as an agent's environment names one. */
export const asProfile = (profile: string): Env => ({ BOARD_PROFILE: profile })

/** The files the CLI keeps claims in. */
export const claimsDir = () => join(env.XDG_CONFIG_HOME!, 'board', 'claims')
export const claimFiles = async () => (await readdir(claimsDir()).catch(() => [])).filter((name) => name.endsWith('.json'))
/** The claims the CLI holds, as their files say: which task each is for, and its token. */
export const claims = async () =>
  Promise.all((await claimFiles()).map(async (name) => ({ name, ...(JSON.parse(await readFile(join(claimsDir(), name), 'utf8')) as { board: string; task: string; profile: string | null; epoch: number; token: string; until: string }) })))
export const claimOn = async (id: string) => (await claims()).filter((claim) => claim.task === id)

/** A `vb` that runs until it's done or stopped, with what it has printed so far. */
export function start(args: string[], extra: Env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  const printed = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => (printed.stdout += chunk))
  child.stderr.on('data', (chunk) => (printed.stderr += chunk))
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  return { child, printed, exited }
}

export const until = async (holds: () => Promise<boolean> | boolean, what: string, ms = 10_000) => {
  for (const deadline = Date.now() + ms; !(await holds()); ) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The board's events about `channel`, bookkeeping included, as the API has them. */
export async function events(channel: string): Promise<BoardEventView[]> {
  const response = await fetch(`${url}/events?after=0&all=1&channel=${channel}`, { headers: { authorization: `Bearer ${env.BOARD_TOKEN}` } })
  return ((await response.json()) as { events: BoardEventView[] }).events
}
