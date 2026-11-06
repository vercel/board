import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { serve } from './http.ts'
import { localBoard, personToken } from './harness.ts'

// The CLI end to end, shared by the cli*.test.ts files. They're split so vitest runs
// them in parallel: each file serves a board of its own, with `useBoard()`.

export const CLI = join(import.meta.dirname, '../src/cli/bin.ts')
// Every directory a test makes lives under one root, which holds an empty `.git`
// (as stray ones in `~` or `/tmp` do): it isn't a checkout, so nothing links there.
export const TEMP = realpathSync(mkdtempSync(join(tmpdir(), 'board-cli-')))
mkdirSync(join(TEMP, '.git'))
export const tmp = (prefix: string) => mkdtemp(join(TEMP, prefix))

export let server: Awaited<ReturnType<typeof serve>>
export let url: string
export let env: NodeJS.ProcessEnv

/** Serves the calling file's board before its tests, and stops it after. */
export function useBoard() {
  beforeAll(async () => {
    // No fixed URL: the board infers its own from requests, as when mounted.
    server = await serve(localBoard({ url: undefined }).fetch)
    url = `${server.origin}/api/board`
    // Every variable `detectAgent` reads, so the suite passes inside an agent's session too (Pi's included).
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key),
      ),
    )
    env = {
      ...clean,
      BOARD_URL: url,
      BOARD_TOKEN: await personToken('u_julian', url),
      BOARD_HANDLE: 'julian',
      HOME: await tmp('board-home-'),
      XDG_CONFIG_HOME: await tmp('board-'),
    }
  })
  afterAll(() => server.close())
}

export function vb(args: string[], extra: NodeJS.ProcessEnv = {}, stdin?: string, cwd?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

export function vb_in(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}
