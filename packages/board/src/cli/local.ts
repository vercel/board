// The standalone `board` CLI's own commands, which run something on this machine: `serve` (a
// `local()` board) and `inspect` (the inspector's page). An app that embeds board's CLI leaves them out, so
// it never loads A2 or the inspector.
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectDir } from '../client/node.ts'
import { startInspector } from '../inspect/server.ts'
import { option } from './commands.ts'
import type { Command, CommandContext } from './main.ts'
import { who } from './format.ts'

/** Until Ctrl-C or a SIGTERM, whichever comes first: then neither is listened for. */
const stopped = () =>
  new Promise<void>((resolve) => {
    const done = () => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })

const inspect: Command = {
  spec: {
    name: 'inspect',
    description: 'the board in your browser, as you: read, post, react (local only)',
    arguments: [],
    options: [option('port', 'the port to listen on (default: a free one)'), option('no-open')],
    examples: [{ name: 'open the board in your browser', value: 'inspect' }],
  },
  async run(_args, { flags, out, portFlag, client, openBrowser }: CommandContext) {
    const port = portFlag()
    const inspector = await startInspector({ client: client(), ...(port !== undefined ? { port } : {}) })
    out(`inspecting ${inspector.board} as ${who(inspector.me)} at ${inspector.url}  (Ctrl-C to stop)`)
    if (!flags['no-open']) openBrowser(inspector.url)
    await stopped()
    await inspector.close()
    return 0
  },
}

/** Keeps the local board's log (`.board/`) out of the project's Git. */
async function ignoreLog(root: string) {
  const path = join(root, '.gitignore')
  const ignore = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (!ignore.split(/\r?\n/).some((line) => /^\/?\.board\/?$/.test(line)))
    await appendFile(path, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}.board/\n`)
}

const serve: Command = {
  spec: {
    name: 'serve',
    description:
      "run a board on this machine (127.0.0.1:4100, no sync) and open the inspector: other commands reach it with --url or BOARD_URL. Its log lives in .board/, and you're local:user:<your OS user> (or --handle)",
    arguments: [],
    options: [option('port', 'the port to listen on (default: 4100)'), option('dir'), option('no-inspect'), option('no-open')],
    examples: [{ name: 'run a board here, and open it', value: 'serve' }],
  },
  async run(args, { flags, out, usage, portFlag, connection, openBrowser }: CommandContext) {
    if (args.length > 0) throw usage('serve takes no arguments: pass its port with --port, and its directory with --dir.')
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
      if (!flags.dir) await ignoreLog(root)
      out(`serving a local board at ${local.url} as ${local.principal}, its log in ${local.dir}  (Ctrl-C to stop)`)
      out(`reach it with --url ${local.url}, or BOARD_URL=${local.url}`)
      if (!flags['no-inspect']) {
        // With this board's token, whatever BOARD_TOKEN says.
        const { board } = connection(local.url, { token: local.token, handle: local.handle })
        inspector = await startInspector({ client: board.as(null) })
        out(`inspector at ${inspector.url}`)
        if (!flags['no-open']) openBrowser(inspector.url)
      }
      await stopped()
    } finally {
      await inspector?.close()
      await local.close()
    }
    return 0
  },
}

/** The commands only the standalone `board` has, in the order its help lists them. */
export const local: Record<string, Command> = { inspect, serve }
