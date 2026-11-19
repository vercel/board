import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands, filters, globalOptions, options, usage, type CliCommand } from '../src/cli/commands.ts'
import { local } from '../src/cli/local.ts'
import { main } from '../src/cli/main.ts'

/** What `run` printed, and the exit code it answered. */
async function capture(run: () => Promise<number>) {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true))
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true))
  try {
    return { code: await run(), stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

const app = { name: 'board', commands: local }

/** Every command and subcommand, with the path that names it, and each again by its aliases. */
const paths = (list: readonly CliCommand[]): CliCommand[][] =>
  list.flatMap((command) => [
    ...[command, ...(command.aliases ?? []).map((alias) => ({ ...command, name: alias }))].map((named) => [named]),
    ...(command.subcommands ?? []).map((sub) => [command, sub]),
  ])
const every = paths([...commands, ...Object.values(local).map((command) => command.spec)])

/** A command line as a shell splits it: words, and quoted words whole. */
const words = (line: string) => [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!)

describe("the CLI's commands, as data", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("shows a command's own page for --help and help <command>, subcommands included", async () => {
    const read = await capture(() => main(['read', '--help'], app))
    expect(read.code).toBe(0)
    expect(read.stdout).toMatch(/^usage: board read \[channel\|id\|link\] \[filters\] \[options\]\n\nthe latest threads/)
    expect(read.stdout).toMatch(/\noptions:\n  -n, --limit <N> +threads to list \(default: 50, at most 500\)\n  --before <older> +a channel's threads before a page: the older its read\n +printed\n/)
    expect(read.stdout).toMatch(/\nfilters:\n  --re <id> +in a thread/)
    // A bare --mentions means you: its value is optional.
    expect(read.stdout).toMatch(/\n  --mentions \[@handle\] +mentioning a handle/)
    expect(read.stdout).toContain("\nexamples:\n  list a channel's latest threads\n    board read dev\n")
    // Every page ends with the global options most runs need, and where the rest are.
    for (const path of every) {
      const page = (await capture(() => main([...path.map((command) => command.name), '--help'], app))).stdout
      expect(page.endsWith('\n\nglobal:   --json  --as <profile>  --scope <team>  --url <url>\n          and the rest every command takes: board help\n'), path.map((command) => command.name).join(' ')).toBe(true)
    }
    expect((await capture(() => main(['sources', 'slack', 'read', '--help'], app))).stdout).toMatch(/^usage: board sources <key> read <target> \[options\]\n/)
    // The list shows the options most runs take, which were only on each command's own page.
    const list = (await capture(() => main(['--help'], app))).stdout
    expect(list).toMatch(/\n  post <channel\|id> \[text\] \[--label k=v\]\.\.\. \[--attach file\]\.\.\./)
    expect(list).toMatch(/\n  label <id> \[k=v\]\.\.\. \[--if-unset k\] \[--unset k\]/)
    expect(list).toMatch(/\n  schedules \[id\] \[--by handle\] \[--all\]/)
    // With them the list still fits 80 columns, and each option a row names is one its command takes.
    expect(list.split('\n').filter((line) => line.length > 80)).toEqual([])
    for (const command of commands)
      for (const flag of command.brief?.match(/--[a-z-]+/g) ?? [])
        expect([...command.options, ...(command.filters ? filters : []), ...globalOptions].map((option) => `--${option.name}`), `${command.name} ${flag}`).toContain(flag)
    // A word that names no command is unknown with --help too, as without it: the closest one, and misuse's exit.
    for (const argv of [['raed', '--help'], ['help', 'raed']])
      expect(await capture(() => main(argv, app)), argv.join(' ')).toEqual({
        code: 2,
        stdout: '',
        stderr: 'error: Unknown command raed for vb. Did you mean read?\n\n  See all commands:\n    vb --help\n',
      })
    // And what it goes by here, when it goes by another name.
    expect((await capture(() => main(['search', '--help'], app))).stderr).toMatch(/^error: Unknown command search for vb\.\n\n {2}Search is a filter on read:\n/)
    // With no word, or `help` alone, it's the list of every command.
    for (const argv of [['--help'], ['help']]) expect((await capture(() => main(argv, app))).stdout, argv.join(' ')).toMatch(/^board \S+: /)
  })

  it('gives each short letter to one option, since every command parses them all', () => {
    const letters = Object.values(options).flatMap((option) => ('short' in option && option.short !== undefined ? [option.short] : []))
    expect(letters.length).toBeGreaterThan(0)
    expect(letters.filter((letter, at) => letters.indexOf(letter) !== at)).toEqual([])
  })

  it('runs every command it lists: none answers that it is unknown', async () => {
    // Nothing answers here, so a command that reaches the board fails fast instead of doing anything.
    vi.stubEnv('BOARD_URL', 'http://127.0.0.1:9/api/board')
    vi.stubEnv('BOARD_TOKEN', 'test')
    vi.stubEnv('HOME', await mkdtemp(join(tmpdir(), 'board-home-')))
    for (const path of every) {
      const name = path.map((command) => command.name).join(' ')
      // These hold until stopped, or run a server.
      if (['tail', 'wait', 'serve', 'help'].includes(path[0]!.name)) continue
      const argv = path.flatMap((command, at) => [
        command.name,
        ...command.arguments.filter((argument) => argument.required || (command.argumentsBeforeSubcommand && at < path.length - 1)).map((argument) => (argument.name === 'url' ? 'http://127.0.0.1:9/api/board' : argument.name === 'id' ? '1' : 'x')),
      ])
      const ran = await capture(() => main(argv, app))
      expect(ran.stderr, name).not.toMatch(/unknown command/)
    }
  }, 60_000)

  it("parses every example, which lands on its own command's page", async () => {
    for (const path of every)
      for (const example of path.at(-1)!.examples) {
        // An example runs as it's written, with sample values: a CLI that runs board shows it as one to copy, and refuses a `<…>` left to fill in.
        expect(example.value, example.value).not.toMatch(/<[a-z][\w |.-]*>/i)
        // What follows `--` is the command `tasks run` starts, its own `--help` included: board's goes before it.
        const argv = words(example.value)
        const own = argv.includes('--') ? argv.indexOf('--') : argv.length
        const shown = await capture(() => main([...argv.slice(0, own), '--help', ...argv.slice(own)], app))
        expect(shown, example.value).toMatchObject({ code: 0, stderr: '' })
        // An alias's page is its command's, by its own name.
        const named = path.map((command) => commands.find((own) => own.aliases?.includes(command.name)) ?? command)
        expect(shown.stdout.split('\n')[0], example.value).toBe(`usage: board ${usage(named)}${shown.stdout.split('\n')[0]!.endsWith(' [options]') ? ' [options]' : ''}`)
      }
  })

  it('ships as data that imports nothing, so a CLI that runs board can read its commands on every start', async () => {
    const root = join(import.meta.dirname, '..')
    const exports = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).exports as Record<string, { default: string }>
    const entry = join(root, exports['./cli/commands']!.default)
    // Statements that import, static (`import … from`, `export … from`) or dynamic (`import(…)`), not data that says from.
    const imports = (code: string) =>
      [...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm)].map((match) => match[1] ?? match[2]!)
    // The entry re-exports one chunk of its own, the data, and that chunk imports nothing.
    const fromEntry = imports(await readFile(entry, 'utf8'))
    expect(fromEntry).toHaveLength(1)
    expect(fromEntry[0]).toMatch(/^\.\/commands-[\w-]+\.mjs$/)
    expect(imports(await readFile(join(dirname(entry), fromEntry[0]!), 'utf8'))).toEqual([])
  })
})
