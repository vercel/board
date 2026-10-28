// `@vercel/board/cli`: board's CLI, to run inside another one, as `vercel board`. It has every
// command but `serve` and `inspect`, which run something on this machine, and loads neither: no
// A2 and no inspector reach an app that bundles it.
import type { Board } from '../server/index.ts'
import { commandWord, main, mainWith } from './main.ts'

export { commandWord }

/**
 * Board's CLI as `appName` names it in help, usage, and errors (`vercel board`). `run` takes what follows the name, and answers the exit code:
 * 0 success, 1 error, 2 misuse, 124 when `wait` times out. It never exits the process itself. One `run`
 * at a time: a run's flags are the CLI's while it runs.
 */
export function createApp(options: { appName: string }): { run(args: string[]): Promise<number> } {
  return { run: (args) => main(args, { name: options.appName, commands: {} }) }
}

/** Where a `vb()` command's files come from and go, and what stops it. A command that needs one it lacks says so. */
export type VbOptions = {
  /** A file's bytes, for `--attach`; null when there's no such file. */
  readFile?: (path: string) => Promise<Uint8Array | null> | PromiseLike<Uint8Array | null>
  /** Saves a file, for `download`. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void> | PromiseLike<void>
  /** The text `-` reads, as stdin would hold it. */
  stdin?: string
  /** Stops `tail` and `wait`, as Ctrl-C does. */
  signal?: AbortSignal
  /** Commands this caller doesn't run, which answer 2: `['tail', 'wait']` for an agent's tool. */
  refuse?: string[]
}

/** What a `vb()` command printed, and its exit code: 0, 1 for an error, 2 for misuse, 124 when `wait` timed out. */
export type VbResult = { code: number; stdout: string; stderr: string }

const lacking = (what: string) => async (): Promise<never> => {
  throw new Error(`${what}: pass it in vb()'s options`)
}

// Runs share the CLI's flags, so one runs at a time; the rest wait their turn.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs the vb command `argv` (`['read', '42']`, `['reply', '42', 'on it']`) on `board`, in this
 * process, and returns what the CLI would print. `board` already says which board and who, so
 * `--url` and `--handle` don't apply, and the commands about your machine (`link`, `use`, `whoami`,
 * `identity`, `hooks`, `serve`, `inspect`) answer 2. Calls run one at a time, in order, so
 * `tail` and `wait`, which hold the rest until they end, need `options.signal`.
 */
export function vb(board: Board, argv: string[], options: VbOptions = {}): Promise<VbResult> {
  // `tail` never ends by itself and `wait` runs up to 30 minutes, holding every later call: only with a way to stop them.
  const word = commandWord(argv)
  if (word !== undefined && options.refuse?.includes(word))
    return Promise.resolve({ code: 2, stdout: '', stderr: `error: ${word} isn't available here\n` })
  if ((word === 'tail' || word === 'wait') && !options.signal)
    return Promise.resolve({ code: 2, stdout: '', stderr: `error: ${word} runs until it's stopped, and vb() runs one call at a time: pass a signal\n` })
  const result = queue.then(async () => {
    let stdout = ''
    let stderr = ''
    const decoder = new TextDecoder()
    const code = await mainWith(argv, { name: 'board', commands: {} }, {
      board,
      write: (chunk) => void (stdout += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })),
      error: (chunk) => void (stderr += chunk),
      readFile: options.readFile ? async (path) => options.readFile!(path) : lacking('--attach reads files'),
      writeFile: options.writeFile ? async (path, data) => options.writeFile!(path, data) : lacking('download saves files'),
      stdin: options.stdin !== undefined ? async () => options.stdin! : lacking('- reads stdin'),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { code, stdout, stderr }
  })
  queue = result.catch(() => {})
  return result
}
