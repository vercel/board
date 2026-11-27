import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type Failure } from '../src/cli/embedded.ts'
import { main, type Command } from '../src/cli/main.ts'
import { local } from '../src/cli/local.ts'
import { env, url, useBoard } from './cli-harness.ts'
import { board } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { as, fakeMessageboard } from './messageboard.ts'

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

/**
 * This process's environment as a fresh machine's, for the CLI: no board, agent, Vercel, or Actions
 * variables, as the subprocess tests clear them, and an empty home, so no cached token answers.
 */
async function isolated(): Promise<string> {
  for (const key of Object.keys(process.env)) if (/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)) vi.stubEnv(key, undefined)
  const home = await mkdtemp(join(tmpdir(), 'board-home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_CONFIG_HOME', home)
  return home
}

/** Markers only the inspector, `serve`, and A2's stores have. */
const MARKERS = { inspector: 'x-inspect-token', serve: 'serving a local board', a2: 'board-tables' }

/**
 * `entry`, bundled as the Vercel CLI bundles what it imports: for Node, every dependency inlined, in
 * a directory of its own, away from board's `dist`. Its files by name; `app.mjs` is the entry.
 */
async function bundleTo(entry: string, dir: string): Promise<Map<string, string>> {
  const file = join(import.meta.dirname, `.cli-entry-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(file, entry)
  try {
    await build({ config: false, entry: { app: file }, outDir: dir, platform: 'node', format: 'esm', dts: false, clean: false, logLevel: 'silent', deps: { alwaysBundle: [/.*/], onlyBundle: false } })
    const names = (await readdir(dir, { recursive: true })).filter((name) => /\.m?js$/.test(name))
    return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')] as const)))
  } finally {
    await rm(file, { force: true })
  }
}

async function bundled(entry: string): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'board-cli-'))
  try {
    return await bundleTo(entry, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const everything = (files: Map<string, string>) => [...files.values()].join('\n')

describe('the embedded CLI', () => {
  useBoard()

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('names the app that runs it in help, usage, and errors, and has neither inspect nor serve', async () => {
    const app = createApp({ appName: 'vercel board' })
    const help = await capture(() => app.run(['help']))
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(/^vercel board \d+\.\d+\.\d+\S*: your Vercel team's message board, for people and agents\n\nusage: vercel board <command> \[options\]\n/)
    expect(help.stdout).not.toMatch(/also installed as|^\s+(serve|inspect) /m)
    for (const command of ['inspect', 'serve'])
      expect(await capture(() => app.run([command]))).toEqual({ code: 2, stdout: '', stderr: `error: Unknown command ${command} for vercel board.\n\n  See all commands:\n    vercel board --help\n` })
    const extra = await capture(() => app.run(['conformance', 'extra']))
    expect(extra).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: conformance takes no arguments/) })
    expect(extra.stderr).toContain('    vercel board conformance --help\n')
    expect(await capture(() => app.run(['--nope']))).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Unknown option --nope for vercel board\.\n[\s\S]*    vercel board --help\n$/) })
  })

  it('hands failures to the app that runs it, to show as its own', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    const failures: [unknown, { json: boolean }][] = []
    const app = createApp({ appName: 'vercel board', onError: (failure, mode) => void failures.push([failure, mode]) })
    expect(await capture(() => app.run(['read', '99999']))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(await capture(() => app.run(['read', '99999', '--json']))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(failures).toEqual([
      [expect.objectContaining({ class: 'not_found', reason: 'message_not_found', message: "Couldn't find message #99999." }), { json: false }],
      [expect.objectContaining({ reason: 'message_not_found' }), { json: true }],
    ])
    // Misuse, with how to recover as a command it can run.
    expect(await capture(() => app.run(['raed', 'dev']))).toMatchObject({ code: 2, stderr: '' })
    expect(failures.at(-1)![0]).toMatchObject({ class: 'usage', reason: 'unknown_command', next: [{ argv: ['vercel', 'board', '--help'] }] })
  })

  it("has tasks, names the app in a task's ways out, and keeps a claim between its runs", async () => {
    const home = await isolated()
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', env.BOARD_TOKEN)
    const app = createApp({ appName: 'vercel board' })
    expect((await capture(() => app.run(['help']))).stdout).toMatch(/^ {2}tasks \[channel\] +open tasks, oldest first/m)
    expect((await capture(() => app.run(['tasks', 'run', '--help']))).stdout).toContain('\n    vercel board tasks run 812 --result "tests pass" -- make test\n')

    const made = await capture(() => app.run(['tasks', 'create', 'embedded', 'fix CVE-123 in acme/web']))
    expect(made).toMatchObject({ code: 0, stderr: '' })
    const id = made.stdout.trim()
    // What to run next is the app's command, not vb's.
    expect(await capture(() => app.run(['tasks', 'complete', id, 'done']))).toEqual({ code: 1, stdout: '', stderr: `error: You hold no claim on task #${id} as yourself.\n\n  Claim it:\n    vercel board tasks claim ${id}\n` })
    const reserved = await capture(() => app.run(['label', id, 'board.task=claimed']))
    expect(reserved).toMatchObject({ code: 2, stdout: '' })
    expect(reserved.stderr).toMatch(new RegExp(`^error: Can't label #${id}\\. Labels under board\\. are the board's own\\.\\n  [^\\n]+\\n\\n  Claim it:\\n    vercel board tasks claim ${id}\\n$`))

    // One run claims and the next settles: the claim is kept where the app's CLI keeps its state.
    expect(await capture(() => app.run(['tasks', 'claim', id]))).toEqual({ code: 0, stdout: `#${id}  yours for 15m  fix CVE-123 in acme/web\n`, stderr: '' })
    expect((await readdir(join(home, 'board', 'claims'))).filter((name) => name.endsWith('.json'))).toHaveLength(1)
    expect(await capture(() => app.run(['tasks', 'complete', id, 'fixed in a1b2c3']))).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
    expect(await readdir(join(home, 'board', 'claims'))).toEqual([])
    expect(await capture(() => app.run(['tasks', 'embedded', '--state', 'all']))).toEqual({ code: 0, stdout: `#${id}  completed  fix CVE-123 in acme/web         fixed in a1b2c3\n`, stderr: '' })

    // What a task waits for is set there too, and a command cut short names the app's help.
    const next = (await capture(() => app.run(['tasks', 'create', 'embedded/next', 'review the fix']))).stdout.trim()
    const first = (await capture(() => app.run(['tasks', 'create', 'embedded/next', 'tag the release']))).stdout.trim()
    expect(await capture(() => app.run(['tasks', 'needs', next, first]))).toEqual({ code: 0, stdout: `${next} needs #${first}\n`, stderr: '' })
    expect(await capture(() => app.run(['tasks', 'needs', next]))).toEqual({ code: 2, stdout: '', stderr: 'error: Missing the tasks it waits for now, by ID, or --none for nothing.\n\n  See how to use it:\n    vercel board tasks --help\n' })
    expect(await capture(() => app.run(['tasks', 'needs', next, '--none']))).toEqual({ code: 0, stdout: `${next} needs nothing\n`, stderr: '' })
    expect(await capture(() => app.run(['tasks', 'embedded/next']))).toEqual({ code: 0, stdout: `#${next}  ready      review the fix\n#${first}  ready      tag the release\n`, stderr: '' })

    // A plan from a file, in as many writes as it takes: one that stops midway names the app's command to finish it.
    const steps = Array.from({ length: 101 }, (_, n) => ({ text: `step ${n}`, ...(n === 100 ? { needs: ['999999'] } : {}) }))
    const plan = join(home, 'plan.json')
    await writeFile(plan, JSON.stringify(steps))
    const stopped = await capture(() => app.run(['tasks', 'create', 'embedded-plan', '--file', plan]))
    expect(stopped).toMatchObject({ code: 2, stdout: '' })
    expect(stopped.stderr).toMatch(new RegExp(`\\n  made 100 of 101: #\\d+ to #\\d+\\n\\n  Make the rest, under the same key: what was made stays as it is:\\n    vercel board tasks create embedded-plan --file ${plan} --idempotency-key [0-9a-f-]{36}\\n$`))
  }, 30_000)

  it("asks for the app's login and team only when a request needs them, and reaches that team's board with them", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    const sent: (string | null)[] = []
    const teams: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization'))
      const { searchParams } = new URL(String(input instanceof Request ? input.url : input))
      teams.push(searchParams.get('teamId') ?? searchParams.get('slug'))
      return api.fetch(input, init)
    })
    let asked = 0
    let resolved = 0
    const app = createApp({ appName: 'vercel board', login: async () => (asked++, 'user:u_jb'), team: async () => (resolved++, 'team_test') })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      // Help, a typo, and misuse need no login: nothing asks for it.
      for (const args of [['--help'], ['read', '--help'], ['raed', 'dev'], ['read', 'dev', '--nope'], ['react', '1']]) await capture(() => app.run(args))
      expect([asked, resolved, sent]).toEqual([0, 0, []])
      // The team the app resolved, and its login.
      const whoami = await capture(() => app.run(['whoami']))
      expect(whoami).toMatchObject({ code: 0, stdout: expect.stringContaining('source  the Vercel CLI\n') })
      expect([asked > 0, resolved > 0]).toEqual([true, true])
      expect(new Set(sent)).toEqual(new Set(['Bearer user:u_jb']))
      expect(new Set(teams)).toEqual(new Set(['team_test']))
      // --scope still names the team itself.
      ;[resolved, teams.length] = [0, 0]
      expect((await capture(() => app.run(['read', 'general', '--scope', 'acme']))).code).toBe(0)
      expect([resolved, new Set(teams)]).toEqual([0, new Set(['acme'])])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends its requests to Vercel's API through the app's fetch, which adds the login's credentials, never its own", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    // The app's fetch, as `vercel board` signs a DPoP login's request: credentials of its own, for this method and URL.
    const signed: string[] = []
    const unsigned = vi.fn()
    const app = createApp({
      appName: 'vercel board',
      login: async () => 'user:u_jb',
      team: async () => 'team_test',
      fetch: async (input, init = {}) => {
        const url = String(input instanceof Request ? input.url : input)
        if (new Headers(init.headers).has('authorization')) unsigned(url)
        signed.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
        return api.fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: 'Bearer user:u_jb' } })
      },
    })
    const fetching = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sent around the app'))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect((await capture(() => app.run(['post', 'general', 'hello']))).code).toBe(0)
      expect(await capture(() => app.run(['read', 'general']))).toMatchObject({ code: 0, stdout: expect.stringContaining('hello') })
      expect(signed).toEqual(expect.arrayContaining([expect.stringMatching(/^POST \/v1\/messageboard\//), expect.stringMatching(/^GET \/v1\/messageboard\//)]))
      expect([unsigned.mock.calls, fetching.mock.calls]).toEqual([[], []])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('fails with what a team it was handed throws, as the app said it, never as an internal error', async () => {
    const home = await isolated()
    const fetching = vi.spyOn(globalThis, 'fetch')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failures: Failure[] = []
    const app = createApp({
      appName: 'vercel board',
      onError: (failure) => failures.push(failure),
      login: async () => 'user:u_jb',
      team: async () => {
        throw new Error('request to https://api.vercel.com/v2/user failed, reason: getaddrinfo ENOTFOUND')
      },
    })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect((await capture(() => app.run(['read', 'general']))).code).toBe(1)
      expect(failures).toMatchObject([
        {
          class: 'platform',
          reason: 'api_error',
          message: "Couldn't tell which team's board to use.",
          details: ['request to https://api.vercel.com/v2/user failed, reason: getaddrinfo ENOTFOUND'],
          next: [
            { instruction: "Use a team's board", argv: ['vercel', 'board', 'read', 'general', '--scope', '<TEAM>'] },
            { instruction: 'Or a board at a URL (or set BOARD_URL)', argv: ['vercel', 'board', 'read', 'general', '--url', '<URL>'] },
          ],
        },
      ])
      expect([fetching.mock.calls, logged.mock.calls]).toEqual([[], []])
    } finally {
      fetching.mockRestore()
      logged.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("talks to the team's board in Vercel's API when nothing points at another: the linked project's team's, or --scope's", async () => {
    const home = await isolated()
    // Linked a directory up, as an app's root is from its src.
    await mkdir(join(home, 'app', '.vercel'), { recursive: true })
    await mkdir(join(home, 'app', 'src'))
    await writeFile(join(home, 'app', '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_test', projectId: 'prj_app' }))
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const asked: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      asked.push(String(input instanceof Request ? input.url : input))
      return api.fetch(input, init)
    })
    const cwd = process.cwd()
    process.chdir(join(home, 'app', 'src'))
    try {
      const app = createApp({ appName: 'vercel board' })
      const posted = await capture(() => app.run(['post', 'general', 'on the team board']))
      expect(posted).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_1\n$/) })
      // The ID it prints goes back in as it came out.
      const id = posted.stdout.trim()
      expect(await capture(() => app.run(['reply', id, 'a reply']))).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_2\n$/) })
      const thread = await capture(() => app.run(['read', id]))
      expect(thread).toMatchObject({ code: 0, stdout: expect.stringContaining('a reply') })
      expect(thread.stdout).toContain('on the team board')
      // The thread's own ID, as --json gives it, reads that thread too: it's no channel's name.
      const threadId = JSON.parse((await capture(() => app.run(['read', id, '--json']))).stdout).message.thread
      expect(threadId).toMatch(/^thr_[0-9a-f-]{36}$/)
      const byThread = await capture(() => app.run(['read', threadId]))
      expect(byThread).toMatchObject({ code: 0, stdout: expect.stringContaining('a reply') })
      expect(byThread.stdout).toContain('on the team board')
      const whoami = await capture(() => app.run(['whoami']))
      expect(whoami.code).toBe(0)
      expect(whoami.stdout).toContain('board   https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test\nsource  the Vercel CLI\n')
      const read = await capture(() => app.run(['read', 'general', '--scope', 'acme', '--json']))
      expect(read.code).toBe(0)
      expect(JSON.parse(read.stdout).threads[0]).toMatchObject({ message: { text: 'on the team board' } })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
    const teams = asked.map((at) => {
      const { origin, searchParams } = new URL(at)
      return `${origin} ${searchParams.get('teamId') ?? `slug=${searchParams.get('slug')}`}`
    })
    expect(new Set(teams)).toEqual(new Set(['https://api.vercel.com team_test', 'https://api.vercel.com slug=acme']))
  })

  it("lists a team board's channels by name alone, since Vercel's API counts nothing in them", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      for (const text of ['one', 'two']) expect((await capture(() => app.run(['post', 'dev/web', text, '--scope', 'acme']))).code).toBe(0)
      expect(await capture(() => app.run(['channels', '--scope', 'acme']))).toEqual({ code: 0, stdout: 'dev/\n  dev/web\ngeneral\n', stderr: '' })
      expect(JSON.parse((await capture(() => app.run(['channels', '--scope', 'acme', '--json']))).stdout)).toEqual({ channels: [{ path: 'dev/web' }, { path: 'general' }], next: null })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("lists the team's boards you can use with list or ls, by the names --name takes, its default marked", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({
      slug: 'acme',
      boards: [
        { name: 'security', id: 'brd_security', members: ['u_jb'] },
        { name: 'design', id: 'brd_design' },
        { name: 'secret', id: 'brd_secret', members: ['u_someone_else'] },
      ],
    })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      expect(await capture(() => app.run(['list', '--scope', 'acme']))).toEqual({
        code: 0,
        stdout: 'General   brd_test  default\nsecurity  brd_security  private\ndesign    brd_design\n',
        stderr: '',
      })
      expect((await capture(() => app.run(['ls', '--scope', 'acme']))).stdout).toContain('security  brd_security  private\n')
      const listed = JSON.parse((await capture(() => app.run(['list', '--scope', 'acme', '--json']))).stdout)
      expect(listed.defaultBoardId).toBe('brd_test')
      expect(listed.boards.map((board: { name: string }) => board.name)).toEqual(['General', 'security', 'design'])
      // A board named by its URL in Vercel's API names its team.
      expect((await capture(() => app.run(['list', '--url', 'https://api.vercel.com/v1/messageboard/boards/brd_design?teamId=team_test']))).stdout).toContain('design    brd_design\n')
      // A board of its own has no team's to list, and --name picks one rather than listing them.
      const own = await capture(() => app.run(['list', '--url', 'https://board.example.com/api/board']))
      expect(own).toMatchObject({ code: 2, stderr: expect.stringContaining("is a board of its own, with no team's boards to list") })
      expect(await capture(() => app.run(['list', '--scope', 'acme', '--name', 'design']))).toMatchObject({ code: 2, stderr: expect.stringContaining('--name picks one') })
      // 0.55.0's `boards` is `list` now, and says so.
      expect(await capture(() => app.run(['boards', '--scope', 'acme']))).toMatchObject({ code: 2, stderr: expect.stringContaining('list') })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("says to run it again in seconds when Vercel's API rate-limits it, the same wait with --json", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    // The API's 429: its whole minute, whatever its limit has left.
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      /\/threads$/.test(new URL(String(input)).pathname)
        ? Promise.resolve(Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '60', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60), 'x-ratelimit-limit': '600' } }))
        : api.fetch(input, init),
    )
    const cwd = process.cwd()
    process.chdir(home)
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const app = createApp({ appName: 'vercel board' })
      const read = async (...more: string[]) => {
        const done = capture(() => app.run(['read', 'general', '--scope', 'acme', ...more]))
        await vi.advanceTimersByTimeAsync(40_000)
        return done
      }
      const shown = await read()
      expect(shown.code).not.toBe(0)
      expect(shown.stderr).toContain('Wait 15s, then run it again')
      expect(shown.stderr).toContain('a try a few seconds later usually gets through')
      expect(shown.stderr).not.toMatch(/Wait (6\d|1m)/)
      const json = await read('--json')
      expect(JSON.parse(json.stderr || json.stdout)).toMatchObject({ status: 'error', reason: 'rate_limited', data: { error: { retryAfter: 15 } } })
    } finally {
      vi.useRealTimers()
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("takes a team board's message ID as it prints one, bare, wherever a channel or a message goes", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      const posted = await capture(() => app.run(['post', 'dev', 'deploy failed', '--scope', 'acme']))
      // Printed bare, so it pastes into a shell, where a leading # starts a comment.
      expect(posted).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_1\n$/) })
      const id = posted.stdout.trim()
      expect(await capture(() => app.run(['post', id, 'on it', '--scope', 'acme']))).toMatchObject({ code: 0, stdout: `${id.replace(/_1$/, '_2')}\n` })
      const read = await capture(() => app.run(['read', id, '--scope', 'acme', '--json']))
      expect(read.code).toBe(0)
      expect(JSON.parse(read.stdout)).toMatchObject({ message: { id, text: 'deploy failed' }, replies: [{ text: 'on it' }] })
      // The reply went in the thread, not to a channel named for the ID.
      expect(JSON.parse((await capture(() => app.run(['channels', '--scope', 'acme', '--json']))).stdout)).toEqual({ channels: [{ path: 'dev' }, { path: 'general' }], next: null })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("says to attach text over the limit when Vercel's API refuses it, on a post and an edit", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      const long = 'x'.repeat(10_001)
      expect(await capture(() => app.run(['post', 'dev', long, '--scope', 'acme']))).toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/^error: Can't post to dev\. A message's text is at most 10,000 characters\.\n\n {2}Put the long part in a file and --attach it, with a short summary as the text\n/),
      })
      const id = (await capture(() => app.run(['post', 'dev', 'short', '--scope', 'acme']))).stdout.trim()
      expect(await capture(() => app.run(['edit', id, long, '--scope', 'acme']))).toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/A message's text is at most 10,000 characters\.\n\n {2}Keep the edit short, and reply with the long part in a file with --attach\n/),
      })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("says what Vercel's board says of a read it doesn't serve: threads by author or source, and every channel at once", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    const as = async (who: string, args: string[]) => {
      vi.stubEnv('VERCEL_AUTH_TOKEN', `user:${who}`)
      return capture(() => app.run([...args, '--scope', 'acme']))
    }
    const app = createApp({ appName: 'vercel board' })
    try {
      const root = (await as('u_val', ['post', 'dev', 'A by val'])).stdout.trim()
      expect((await as('u_jb', ['reply', root, 'on A, by jb'])).code).toBe(0)
      // The board's own words, under what the run was doing: what it doesn't do, and what to do there.
      const index = "they keep no search index. Read one channel's threads, or one thread, and look through what it answers"
      for (const [flags, named] of [[['--by', 'me'], 'author'], [['--source', 'slack'], 'source']] as const) {
        const refused = await as('u_val', ['read', 'dev', ...flags])
        expect([refused.code, refused.stdout, refused.stderr], flags[0]).toEqual([
          1,
          '',
          expect.stringMatching(new RegExp(`^error: Can't read dev\\. This board doesn't support it\\.\\n  Vercel's boards don't support reading threads by ${named} yet: ${index}\\n`)),
        ])
      }
      for (const [args, what] of [[['read'], 'reading every channel at once'], [['read', 'dev/'], 'reading every channel under dev/ at once'], [['read', '--label', 'state=open'], 'reading every channel at once']] as const) {
        const refused = await as('u_val', [...args])
        expect([refused.code, refused.stdout], args.join(' ')).toEqual([1, ''])
        expect(refused.stderr, args.join(' ')).toContain(`\n  Vercel's boards don't support ${what} yet: name one channel, and read the others one at a time. The channel list has their names\n`)
      }
      // One channel, and one thread, read as ever: a label narrows the channel, and --after the thread.
      expect((await as('u_val', ['read', 'dev'])).stdout).toMatch(/^dev · 1 thread · /)
      expect((await as('u_val', ['read', 'dev', '--label', 'state=open'])).stdout).toMatch(/^dev · 0 threads · /)
      const after = await as('u_val', ['read', root, '--after', root])
      expect([after.code, after.stdout.includes('A by val'), after.stdout.includes('on A, by jb')]).toEqual([0, true, true])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("pages a channel's threads back on Vercel's board with --before, by the command each read prints", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme', inlineThreadMessages: true })
    // Its files go to the attachments bucket, as presigned URLs send them.
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => (String(input instanceof Request ? input.url : input).startsWith('http://storage.test/') ? api.files(input, init) : api.fetch(input, init)))
    const cwd = process.cwd()
    process.chdir(home)
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const app = createApp({ appName: 'vercel board' })
    const run = (args: string[]) => capture(() => app.run([...args, '--scope', 'acme']))
    try {
      const ids: string[] = []
      for (const n of [1, 2, 3, 4, 5]) ids.push((await run(['post', 'dev', `job ${n}`])).stdout.trim())
      const shown = (stdout: string) => [...stdout.matchAll(/^#(\S+) /gm)].map((match) => match[1]!)
      // The newest two, then each page before, pasted as it says: every thread once, down to the first.
      let { stdout } = await run(['read', 'dev', '--limit', '2'])
      const seen = shown(stdout)
      expect(seen).toEqual(ids.slice(3))
      for (let page = 0; page < 5; page++) {
        const older = /\n\(older not shown: vercel board (.+)\)\n/.exec(stdout)
        if (!older) break
        expect(older[1]).toMatch(/^read dev --limit 2 (--scope acme )?--before \S+/)
        ;({ stdout } = await run(older[1]!.split(' ').filter((word) => word !== '--scope' && word !== 'acme')))
        seen.unshift(...shown(stdout))
      }
      expect(seen).toEqual(ids)
      // The last page says nothing of older ones: there are none.
      expect(stdout).not.toContain('older not shown')
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("finds what mentions you on Vercel's board in one page of a channel's threads, says how far it looked, and waits on from there", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme', inlineThreadMessages: true, inlineActors: true })
    const val = board({ backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, 'user:u_val') }) })
    const asked = await val.post('dev', { text: '@julian/claude what is the cache key?' })
    for (let n = 0; n < 3; n++) await val.post('dev', { text: `noise ${n}` })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const app = createApp({ appName: 'vercel board' })
    const run = (args: string[]) => capture(() => app.run([...args, '--scope', 'acme', '--as', 'claude']))
    const reads = () => api.requests.filter((request) => request.startsWith('GET '))
    try {
      api.requests.length = 0
      await run(['read', 'dev'])
      const plain = reads().length
      api.requests.length = 0
      // The newest page holds no mention: it says how far it looked, and how to look further.
      let read = await run(['read', 'dev', '--mentions', '--limit', '2'])
      expect(read).toMatchObject({ code: 0, stderr: '' })
      expect(read.stdout).toContain('dev · 0 threads')
      expect(read.stdout).toContain('(looked through 2 threads, at the first and latest message of each: a match under a newer reply is not found)')
      // No more requests than a plain read and who `me` is.
      expect(reads().length).toBeLessThanOrEqual(plain + 1)
      const older = /\(older not shown: vercel board (.+)\)/.exec(read.stdout)
      expect(older?.[1]).toMatch(/^read dev --mentions --limit 2 --scope acme --as claude --before \S+$/)
      read = await run(older![1]!.split(' ').filter((word, at, all) => !['--scope', '--as'].includes(word) && !['--scope', '--as'].includes(all[at - 1]!)))
      expect(read.stdout).toContain(`#${asked.id}`)
      expect(read.stdout).toContain('what is the cache key?')
      // What's new since is a wait from the newest page's cursor, which sees a mention posted after the read.
      read = await run(['read', 'dev', '--mentions'])
      const since = /\nnew since then: vercel board (.+)\n/.exec(read.stdout)
      expect(since?.[1]).toMatch(/^wait dev --mentions --scope acme --as claude --after \S+$/)
      const later = await val.post('dev', { text: '@julian/claude and the TTL?' })
      const waited = await run([...since![1]!.split(' ').filter((word, at, all) => !['--scope', '--as'].includes(word) && !['--scope', '--as'].includes(all[at - 1]!)), '--timeout', '5'])
      expect(waited).toMatchObject({ code: 0 })
      expect(waited.stdout).toContain(later.id)
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("names where another project's import came from by that project, and its own by its key", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme', projects: { prj_www: 'www' } })
    // www's deployment syncs Slack, and brings Ada's message in.
    const www = board({ backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, 'project:prj_www:production') }) })
    await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    await www.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'general', text: 'checkout is down', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    await board({ backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, 'user:u_jb') }) }).post('general', { text: 'on the board' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      const read = async (...args: string[]) => {
        const done = await capture(() => app.run(['read', 'general', '--scope', 'acme', '--json', ...args]))
        expect(done.code).toBe(0)
        return (JSON.parse(done.stdout) as { threads: { message: { text: string; from: string | null } }[] }).threads.map(({ message }) => [message.text, message.from])
      }
      vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
      expect(await read()).toEqual([['checkout is down', 'www/slack'], ['on the board', null]])
      // Inside www, its own key is as its sync names it.
      vi.stubEnv('VERCEL_AUTH_TOKEN', 'project:prj_www:production')
      expect(await read()).toEqual([['checkout is down', 'slack'], ['on the board', null]])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("shows someone a text mentions by ID by their handle, asking Vercel's API for them by ID, never for every actor", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    const on = (principal: string) => board({ backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, principal) }) })
    // Val is on the board, but wrote nothing in general.
    await on('user:u_val').post('dev', { text: 'elsewhere' })
    const root = await on('user:u_ada').post('general', { text: 'can @[vercel:user:u_val] look?' })
    const lists: string[][] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actors')) lists.push(url.searchParams.getAll('id'))
      return api.fetch(input, init)
    })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
      const app = createApp({ appName: 'vercel board' })
      for (const target of ['general', root.id]) {
        lists.length = 0
        const read = await capture(() => app.run(['read', target, '--scope', 'acme']))
        expect(read).toMatchObject({ code: 0, stdout: expect.stringContaining('can @u_val look?') })
        // One request names Val, and none lists everyone.
        expect(lists.filter((ids) => ids.includes('vercel:user:u_val'))).toHaveLength(1)
        expect(lists.filter((ids) => ids.length === 0)).toEqual([])
      }
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('shows a deployment by its project, with its environment outside production, or by its ID where the API names it by that', async () => {
    for (const [projectIdHandles, production, preview] of [
      [false, 'www', 'www (preview)'],
      [true, 'prj_www', 'prj_www@preview'],
    ] as const) {
      const home = await isolated()
      const api = fakeMessageboard({ slug: 'acme', projects: { prj_www: 'www' }, projectIdHandles })
      const www = (environment: string) => board({ backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, `project:prj_www:${environment}`) }) })
      const root = await www('production').post('general', { text: 'deployed' })
      await www('preview').reply(root.id, { text: 'deployed a preview' })
      const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
      const cwd = process.cwd()
      process.chdir(home)
      try {
        vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
        const app = createApp({ appName: 'vercel board' })
        const read = await capture(() => app.run(['read', root.id, '--scope', 'acme']))
        expect(read.stdout.split('\n').filter((line) => line.includes(' · ')).map((line) => line.replace(/^.*?_\d+  /, '').replace(/ · .*$/, ''))).toEqual([production, preview])
        // In every environment, a deployment goes by its project's name.
        const handle = projectIdHandles ? 'prj_www@preview' : 'www'
        expect(await capture(() => app.run(['actors', '--scope', 'acme']))).toMatchObject({
          code: 0,
          stdout: `@${handle}  ${preview}  vercel:project:prj_www:preview\n@${production}  ${production}  vercel:project:prj_www:production\n`,
        })
      } finally {
        fetching.mockRestore()
        process.chdir(cwd)
        await rm(home, { recursive: true, force: true })
      }
    }
  })

  it("says you're not signed in when there's no Vercel login to reach the team's board with", async () => {
    const home = await isolated()
    const fetching = vi.spyOn(globalThis, 'fetch')
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => createApp({ appName: 'vercel board' }).run(['whoami']))).toMatchObject({
        code: 1,
        stderr: "error: You're not logged in to Vercel.\n\n  Log in:\n    vercel login\n",
      })
      expect(fetching.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).startsWith('https://api.vercel.com/v1/messageboard'))).toEqual([])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("shows what Vercel's API says you may do on a team's board, by your team role or your credentials, and when they stop working", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ me: { 'user:u_jb': { can: { 'dev/': ['read', 'post'], 'ci/': ['read'] }, expiresAt: Date.now() + 90 * 60_000 } } })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const whoami = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(whoami.code).toBe(0)
      expect(whoami.stdout).toMatch(/^token +expires in 1h 30m$/m)
      expect(whoami.stdout).toMatch(/^can +ci\/ +read\n +dev\/  read post$/m)
      // The team's owner may do everything, which whoami doesn't spell out, with no expiry; a viewer reads and reacts.
      const roles = fakeMessageboard({ roles: { u_jb: 'owner', u_ada: 'viewer' } })
      fetching.mockImplementation(async (input, init) => roles.fetch(input, init))
      const owner = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(owner).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Ada Lovelace \(vercel:user:u_jb\)\n/) })
      expect(owner.stdout).not.toMatch(/^(can|token) /m)
      vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_ada')
      const viewer = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(viewer.stdout).toMatch(/^can +\*  read react$/m)
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends BOARD_TOKEN to Vercel's API ahead of your login, from vb and from a CLI that runs board's with no login of its own, and your login without it, each refusal saying what to renew", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    vi.stubEnv('VERCEL_TOKEN', 'user:u_bo')
    vi.stubEnv('BOARD_TOKEN', 'p9Lr4vTzQ2wc')
    const api = fakeMessageboard({ tokens: { p9Lr4vTzQ2wc: 'user:u_ada' } })
    const sent: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Request(input, init).headers.get('authorization'))
      return api.fetch(input, init)
    })
    const run = (...args: string[]) => capture(() => main([...args, '--scope', 'test'], { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const whoami = await run('whoami')
      expect(whoami.code).toBe(0)
      expect(whoami.stdout).toMatch(/^.* \(vercel:user:u_ada\)\n/)
      expect(new Set(sent)).toEqual(new Set(['Bearer p9Lr4vTzQ2wc']))
      // A CLI that runs board's and gives it no login finds its credentials as vb does.
      sent.length = 0
      const app = createApp({ appName: 'vercel board', team: async () => 'team_test' })
      expect((await capture(() => app.run(['read', 'general']))).code).toBe(0)
      expect(new Set(sent)).toEqual(new Set(['Bearer p9Lr4vTzQ2wc']))
      // A BOARD_TOKEN it refuses is yours to replace: logging in changes nothing.
      vi.stubEnv('BOARD_TOKEN', 'not-a-token')
      expect((await run('read', 'general')).stderr).toContain('BOARD_TOKEN')
      // Without it, your login, and never VERCEL_TOKEN.
      vi.stubEnv('BOARD_TOKEN', '')
      sent.length = 0
      expect((await run('whoami')).stdout).toMatch(/^.* \(vercel:user:u_jb\)\n/)
      expect(new Set(sent)).toEqual(new Set(['Bearer user:u_jb']))
      vi.stubEnv('VERCEL_AUTH_TOKEN', 'not-a-token')
      const refused = await run('read', 'general')
      expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('vercel login') })
      expect(refused.stderr).not.toContain('BOARD_TOKEN')
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("runs as the login an app gives it wherever the app runs, on the app's team: a deployment's own token and BOARD_TOKEN go only from an app that gives none", async () => {
    const home = await isolated()
    // On a deployment of another team's project, with a BOARD_TOKEN too: each is someone else.
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const oidc = `${part({ alg: 'none' })}.${part({ owner_id: 'team_deployment', exp: Math.floor(Date.now() / 1000) + 3600 })}.`
    const onDeployment = () => {
      for (const [key, set] of Object.entries({ VERCEL: '1', VERCEL_OIDC_TOKEN: oidc, BOARD_TOKEN: 'p9Lr4vTzQ2wc' })) vi.stubEnv(key, set)
    }
    onDeployment()
    const tokens = { [oidc]: 'project:prj_pong:production', p9Lr4vTzQ2wc: 'user:u_bo' }
    // The login's team's board, and the deployment's team's.
    const boards = { team_test: fakeMessageboard({ tokens }), team_deployment: fakeMessageboard({ teamId: 'team_deployment', tokens }) }
    const sent: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      const team = new URL(request.url).searchParams.get('teamId')
      const bearer = request.headers.get('authorization')
      sent.push(`${bearer === `Bearer ${oidc}` ? "the deployment's token" : bearer} on ${team ?? 'no team'}`)
      return boards[team === 'team_deployment' ? 'team_deployment' : 'team_test'].fetch(input, init)
    })
    const whoami = async (app: ReturnType<typeof createApp>) => {
      sent.length = 0
      const ran = await capture(() => app.run(['whoami', '--json']))
      return { ...(ran.code === 0 ? (JSON.parse(ran.stdout) as { principal: string; source: string }) : { failed: ran.stderr }), sent: [...new Set(sent)] }
    }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      // The app's login, on the app's team.
      const app = createApp({ appName: 'vercel board', login: async () => 'user:u_jb', team: async () => 'team_test' })
      expect(await whoami(app)).toMatchObject({ principal: 'vercel:user:u_jb', source: 'the Vercel CLI', sent: ['Bearer user:u_jb on team_test'] })
      // Off a deployment, BOARD_TOKEN doesn't go ahead of it either.
      vi.stubEnv('VERCEL', '')
      vi.stubEnv('VERCEL_OIDC_TOKEN', '')
      expect(await whoami(app)).toMatchObject({ principal: 'vercel:user:u_jb', sent: ['Bearer user:u_jb on team_test'] })
      onDeployment()
      // A login with no team isn't on the team the deployment's token names: that's the team of a token that didn't go.
      expect(await whoami(createApp({ appName: 'vercel board', login: async () => 'user:u_jb' }))).toMatchObject({ principal: 'vercel:user:u_jb', sent: ['Bearer user:u_jb on no team'] })
      // An app that gives no login finds its credentials as vb does: the deployment's own token, on the team it names.
      expect(await whoami(createApp({ appName: 'vercel board' }))).toMatchObject({ principal: 'vercel:project:prj_pong:production', source: 'Vercel OIDC', sent: ["the deployment's token on team_deployment"] })
      // A login Vercel's API refuses is the one to renew, whatever BOARD_TOKEN holds.
      const refused = await capture(() => createApp({ appName: 'vercel board', login: async () => 'not-a-token', team: async () => 'team_test' }).run(['read', 'general']))
      expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('vercel login') })
      expect(refused.stderr).not.toContain('BOARD_TOKEN')
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends the token an app was passed to Vercel's API itself, in place of the app's login, and says it's the one to replace when it's refused", async () => {
    const home = await isolated()
    // On a deployment, with a BOARD_TOKEN too: each is someone else, and so is the app's login.
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const oidc = `${part({ alg: 'none' })}.${part({ owner_id: 'team_test', exp: Math.floor(Date.now() / 1000) + 3600 })}.`
    for (const [key, set] of Object.entries({ VERCEL: '1', VERCEL_OIDC_TOKEN: oidc, BOARD_TOKEN: 'p9Lr4vTzQ2wc' })) vi.stubEnv(key, set)
    const api = fakeMessageboard({ tokens: { [oidc]: 'project:prj_pong:production', p9Lr4vTzQ2wc: 'user:u_bo', w3Nc8sJd1hFy: 'user:u_ada' } })
    const sent: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Request(input, init).headers.get('authorization'))
      return api.fetch(input, init)
    })
    // The app's fetch adds its own login's credentials to whatever it sends, as `vercel board`'s does.
    const appFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', 'Bearer user:u_jb')
      return globalThis.fetch(input, { ...init, headers })
    }
    const app = (token?: string) => createApp({ appName: 'vercel board', team: async () => 'team_test', login: async () => 'user:u_jb', fetch: appFetch, ...(token ? { token } : {}) })
    const whoami = async (token?: string) => JSON.parse((await capture(() => app(token).run(['whoami', '--json']))).stdout) as { principal: string; source: string }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await whoami('w3Nc8sJd1hFy')).toMatchObject({ principal: 'vercel:user:u_ada', source: 'the token you passed' })
      expect(new Set(sent)).toEqual(new Set(['Bearer w3Nc8sJd1hFy']))
      // Off a deployment, BOARD_TOKEN doesn't go ahead of it either.
      vi.stubEnv('VERCEL', '')
      vi.stubEnv('VERCEL_OIDC_TOKEN', '')
      expect(await whoami('w3Nc8sJd1hFy')).toMatchObject({ principal: 'vercel:user:u_ada' })
      // It's the run's: the next one, passed none, is the app's login again, through the app's fetch: the one a passed token never takes.
      sent.length = 0
      expect(await whoami()).toMatchObject({ principal: 'vercel:user:u_jb', source: 'the Vercel CLI' })
      expect(new Set(sent)).toEqual(new Set(['Bearer user:u_jb']))
      vi.stubEnv('VERCEL', '1')
      vi.stubEnv('VERCEL_OIDC_TOKEN', oidc)
      // One Vercel's API refuses is yours to replace: neither logging in nor BOARD_TOKEN changes what's passed.
      const refused = await capture(() => app('not-a-token').run(['read', 'general']))
      expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('Pass a token it accepts') })
      expect(refused.stderr).not.toMatch(/vercel login|BOARD_TOKEN/)
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends a token an app's command hands the CLI's connection to Vercel's API, in place of your login", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ tokens: { w3Nc8sJd1hFy: 'user:u_ada' } })
    const sent: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Request(input, init).headers.get('authorization'))
      return api.fetch(input, init)
    })
    // A token an app's command passes in place of your login.
    const probe: Command = {
      spec: { name: 'probe', description: 'who a token is on the board', arguments: [], options: [], examples: [] },
      run: async (_args, { connection, out }) => {
        out((await connection(undefined, { token: 'w3Nc8sJd1hFy' }).board.me()).actor)
        return 0
      },
    }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => main(['probe', '--scope', 'test'], { name: 'board', commands: { probe } }))).toMatchObject({ code: 0, stdout: 'vercel:user:u_ada\n' })
      expect(new Set(sent)).toEqual(new Set(['Bearer w3Nc8sJd1hFy']))
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("narrows a connection to Vercel's API with x-board-can, on your login", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ postContext: true })
    const sent: { can: string | null; type: string | null; authorization: string | null }[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/threads'))
        sent.push({ can: request.headers.get('x-board-can'), type: request.headers.get('content-type'), authorization: request.headers.get('authorization') })
      return api.fetch(input, init)
    })
    // What `vb conformance` does for its narrowed caller: its own credential, with x-board-can.
    const probe: Command = {
      spec: { name: 'probe', description: 'posts as a narrowed caller', arguments: [], options: [], examples: [] },
      run: async (_args, { connection, out }) => {
        out((await connection(undefined, { can: 'dev=read,post' }).board.post('dev', { text: 'narrowed' })).channel)
        return 0
      },
    }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      for (const [name, value] of [['VERCEL_AUTH_TOKEN', 'user:u_jb']] as const) {
        vi.stubEnv(name, value)
        sent.length = 0
        expect(await capture(() => main(['probe', '--scope', 'test'], { name: 'board', commands: { probe } }))).toMatchObject({ code: 0, stdout: 'dev\n' })
        expect(sent, name).toEqual([{ can: 'dev=read,post', type: 'application/json', authorization: `Bearer ${value}` }])
      }
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("reaches a team's board by the URL whoami prints for it, with --url or BOARD_URL, and in its Vercel project with neither", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard()
    const asked: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input instanceof Request ? input.url : input)}`)
      return api.fetch(input, init)
    })
    const app = { name: 'board', commands: local }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const whoami = await capture(() => main(['whoami', '--scope', 'test'], app))
      const board = /^board +(\S+)$/m.exec(whoami.stdout)?.[1]
      expect(board).toBe('https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test')
      asked.length = 0
      expect((await capture(() => main(['post', 'general', 'by its URL', '--url', board!], app))).code).toBe(0)
      // The URL's own board, in its own team: no other is looked for.
      expect(asked.length).toBeGreaterThan(0)
      for (const request of asked) {
        const { pathname, searchParams } = new URL(request.split(' ')[1]!)
        expect(searchParams.get('teamId'), request).toBe('team_test')
        expect(pathname, request).toMatch(/^\/v1\/messageboard\/(boards\/brd_test(\/|$)|me$)/)
      }
      // A board that isn't there says so.
      const missing = board!.replace('brd_test', 'brd_missing')
      expect(await capture(() => main(['whoami', '--url', missing], app))).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: /) })
      vi.stubEnv('BOARD_URL', board!)
      expect((await capture(() => main(['read', 'general'], app))).stdout).toContain('by its URL')
      vi.stubEnv('BOARD_URL', undefined)
      // In a directory linked to a Vercel project, its team's board, with no URL and no --scope.
      await mkdir(join(home, '.vercel'))
      await writeFile(join(home, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_test', projectId: 'prj_app' }))
      expect((await capture(() => main(['read', 'general'], app))).stdout).toContain('by its URL')
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("picks the team's board by its name with --name or BOARD_NAME, --name ahead of BOARD_URL, and only a name", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ boards: [{ name: 'security' }] })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const app = { name: 'board', commands: local }
    const run = (...args: string[]) => capture(() => main(args, app))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect((await run('post', 'dev', 'rotate the keys', '--scope', 'test', '--name', 'security')).code).toBe(0)
      // The team's default board has no such channel, and says it's the default, and how to read another.
      const elsewhere = await run('read', 'dev', '--scope', 'test')
      expect(elsewhere).toMatchObject({ code: 1, stdout: '' })
      expect(elsewhere.stderr).toContain("This is test's default board: --name reads another of its boards.")
      expect(elsewhere.stderr).toContain('    vb channels --scope test\n')
      expect(elsewhere.stderr).toContain('    vb read dev --scope test --name <BOARD>\n')
      // A board --name names says nothing of the default.
      expect((await run('read', 'nowhere', '--scope', 'test', '--name', 'security')).stderr).not.toContain('default board')
      // --name names a team's board as --scope does: BOARD_URL doesn't take its place.
      vi.stubEnv('BOARD_URL', 'https://elsewhere.example/api/board')
      expect((await run('read', 'dev', '--name', 'SECURITY')).stdout).toContain('rotate the keys')
      vi.stubEnv('BOARD_URL', undefined)
      vi.stubEnv('BOARD_NAME', 'security')
      expect((await run('read', 'dev', '--scope', 'test')).stdout).toContain('rotate the keys')
      // On its own, as --name is: the team the environment finds, or the login's.
      expect((await run('read', 'dev')).stdout).toContain('rotate the keys')
      // Beside BOARD_URL, which names another board, nothing says which: misuse, not a guess.
      vi.stubEnv('BOARD_URL', 'https://elsewhere.example/api/board')
      expect(await run('read', 'dev')).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: BOARD_NAME names a team's board, and BOARD_URL a board by its URL: unset one\.\n/) })
      vi.stubEnv('BOARD_URL', undefined)
      vi.stubEnv('BOARD_NAME', undefined)
      // A board's URL names its team, so --scope beside it would pick nothing.
      expect(await run('read', 'dev', '--scope', 'test', '--url', 'https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test')).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --url names its board, its team included, and --scope a team's board/) })
      // A BOARD_NAME a run doesn't use isn't read: --url picks the board.
      vi.stubEnv('BOARD_NAME', 'acme/security')
      expect(await run('whoami', '--url', 'https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test')).toMatchObject({ code: 0, stdout: expect.stringContaining('brd_test') })
      vi.stubEnv('BOARD_NAME', undefined)
      // A board no one made yet: a person is told, and nothing makes it.
      expect(await run('read', 'dev', '--name', 'nope')).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: no board named nope on this team, or none you can see\./) })
      expect(api.requests).not.toContain('POST /boards/ensure')
      // What isn't a name, or names a board twice, is misuse: another team's board is --scope's.
      for (const args of [['--name', 'security', '--url', 'https://www.example.com/api/board'], ['--name', 'x'.repeat(65)]])
        expect(await run('read', 'dev', ...args), args.join(' ')).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: /) })
      expect(await run('read', 'dev', '--name', 'acme/security')).toMatchObject({ code: 2, stderr: expect.stringContaining('    vb read dev --scope acme --name security\n') })
      vi.stubEnv('BOARD_NAME', 'acme/security')
      expect(await run('read', 'dev')).toMatchObject({ code: 2, stderr: expect.stringContaining('pass its team with --scope') })
      vi.stubEnv('BOARD_NAME', undefined)
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("reaches a team's board by its URL, which names its team, from a login whose default team is another", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    // acme isn't the login's default team: a request reaches it only when it names it.
    const api = fakeMessageboard({ teamId: 'team_acme', slug: 'acme', notDefault: true, boards: [{ name: 'ops', id: 'brd_ops1' }] })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const at = 'https://api.vercel.com/v1/messageboard/boards/brd_ops1?teamId=team_acme'
      expect((await run('post', 'dev', 'on ops one', '--url', at)).code).toBe(0)
      expect((await run('read', 'dev', '--url', at)).stdout).toContain('on ops one')
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("tells a person how to make a board their name finds none of, and makes it with --ensure", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const api = fakeMessageboard({ boards: [{ name: 'vault', members: ['u_ada'] }] })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await run('read', 'dev', '--name', 'nope')).toMatchObject({
        code: 1,
        stderr: "error: no board named nope on this team, or none you can see.\n\n  Check the name, or make it:\n    vb read dev --name nope --ensure\n",
      })
      // The way out adds --ensure before --, so the text after it stays text.
      expect((await run('post', 'dev', '--name', 'nope', '--', '--ensure')).stderr).toContain('    vb post dev --name nope --ensure -- --ensure\n')
      expect(api.requests.filter((request) => request === 'POST /boards/ensure')).toEqual([])
      // Following it makes the board, and posts there.
      expect((await run('post', 'dev', 'first', '--name', 'nope', '--ensure')).code).toBe(0)
      expect((await run('read', 'dev', '--name', 'nope')).stdout).toContain('first')
      // A private board's name is taken: pick another, or ask for access.
      expect(await run('read', 'dev', '--name', 'vault', '--ensure')).toMatchObject({
        code: 1,
        stderr: "error: the board name vault is taken.\n\n  Pick another name, or ask whoever can see it for access.\n",
      })
      // --ensure makes a board by its name: without one, or beside a URL, it's misuse.
      expect(await run('read', 'dev', '--ensure')).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --ensure makes the board --name names: pass --name too\.\n/) })
      expect(await run('read', 'dev', '--ensure', '--url', 'https://board.example/api/board')).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --ensure makes a team's board by its name, and --url/) })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("says a board conformance couldn't open is an error, with ways out that check another board, not a failed check", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const api = fakeMessageboard({ oneBoard: true })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const said = await run('conformance', '--scope', 'test', '--name', 'scratch', '--ensure')
      expect(said).toMatchObject({ code: 1, stdout: '' })
      expect(said.stderr).toMatch(/^error: Can't check the board\. The team has all the boards it can\./)
      expect(said.stderr).not.toContain('failed')
      // The team's board is no way out here: conformance refuses it without a name.
      expect(said.stderr).not.toMatch(/^    vb conformance( --scope test)?\n/m)
      // A URL names its team, so --scope goes with --name.
      expect(said.stderr).toContain('    vb conformance --url <URL>\n')
      expect(said.stderr).toContain('    vb conformance --scope test --name General\n')
      // --ensure takes no value: what follows it stays.
      expect((await run('conformance', '--name', 'scratch', '--ensure', '--scope', 'test')).stderr).toContain('    vb conformance --scope test --name General\n')
      const json = await run('conformance', '--name', 'scratch', '--ensure', '--json')
      expect(json).toMatchObject({ code: 1, stdout: '' })
      expect(JSON.parse(json.stderr)).toMatchObject({ status: 'error', reason: 'too_many_boards' })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('tells a project it has no access to a board, and who fixes that', async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'project:prj_pong:preview')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const api = fakeMessageboard({ boardId: null, boards: [{ name: 'security', granted: ['prj_pong:production'] }] })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      // vb only finds a board without --ensure: one the project can't see is none to it.
      expect(await run('read', 'dev', '--name', 'security')).toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/^error: no board named security on this team, or none you can see\.\n/),
      })
      expect(await run('read', 'dev', '--name', 'security', '--ensure')).toMatchObject({
        code: 1,
        stderr: "error: this project has no access to board security (prj_pong, preview).\n\n  Grant it: vb grants create --project prj_pong --environment preview --name security --scope team_test --can '*=read,post,react,label'\n",
      })
      expect(await run('read', 'dev')).toMatchObject({
        code: 1,
        stderr: "error: this project has no access to the team's board (prj_pong, preview).\n\n  Grant it: vb grants create --project prj_pong --environment preview --scope team_test --can '*=read,post,react,label'\n",
      })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("points the words people type for search, claim, and mentions at what a team's board takes", async () => {
    const home = await isolated()
    const run = async (...args: string[]) => JSON.parse((await capture(() => main([...args, '--json'], { name: 'board', commands: local }))).stderr).next
    try {
      // A team's board keeps no text index and reads one channel: one channel's page, by text or by mentions.
      expect(await run('search', 'ENOTFOUND', '--scope', 'acme')).toMatchObject([{ argv: ['vb', 'read', '<CHANNEL>', '--text', '<PHRASE>'] }, { argv: ['vb', '--help'] }])
      expect(await run('mentions', '--scope', 'acme')).toMatchObject([{ argv: ['vb', 'read', '<CHANNEL>', '--mentions'] }, { argv: ['vb', '--help'] }])
      // A board at a URL of its own searches by text, and nothing says which board, so it's the one that works everywhere.
      expect(await run('grep', 'ENOTFOUND', '--url', 'http://localhost:4000')).toMatchObject([{ argv: ['vb', 'read', '<CHANNEL>', '--text', '<PHRASE>'] }, { argv: ['vb', '--help'] }])
      expect(await run('find', 'ENOTFOUND')).toMatchObject([{ argv: ['vb', 'read', '<CHANNEL>', '--text', '<PHRASE>'] }, { argv: ['vb', '--help'] }])
      // A claim is a task's, on every board.
      expect(await run('claim', '812', '--scope', 'acme')).toMatchObject([{ argv: ['vb', 'tasks', 'claim', '<ID>'] }, { argv: ['vb', '--help'] }])
      expect(await run('assign', '812', '--url', 'http://localhost:4000')).toMatchObject([{ argv: ['vb', 'tasks', 'assign', '<ID>', '<PROFILE>'] }, { argv: ['vb', '--help'] }])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("gives a read, a post, and a schedule Vercel's board refuses the same command without what it can't do", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    // Its files go to the attachments bucket, as presigned URLs send them.
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => (String(input instanceof Request ? input.url : input).startsWith('http://storage.test/') ? api.files(input, init) : api.fetch(input, init)))
    const cwd = process.cwd()
    process.chdir(home)
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const next = async (...args: string[]) => {
      const run = await capture(() => main([...args, '--json'], { name: 'board', commands: local }))
      const failure = JSON.parse(run.stderr)
      expect(failure.reason, args.join(' ')).toBe('not_supported')
      return failure.next.map((recovery: { argv: string[] }) => recovery.argv)
    }
    try {
      await writeFile(join(home, 'notes.txt'), 'notes')
      // A filter it keeps no index of: the same read without it, which it serves.
      expect(await next('read', 'dev', '--source', 'slack', '--scope', 'acme')).toEqual([['vb', 'read', 'dev', '--scope', 'acme', '--json']])
      expect(await next('read', 'dev', '--by', 'me', '--label', 'state=open', '--scope', 'acme')).toEqual([['vb', 'read', 'dev', '--label', 'state=open', '--scope', 'acme', '--json']])
      // Every channel, or every one under a prefix: their names, then one of them.
      expect(await next('read', '--scope', 'acme')).toEqual([
        ['vb', 'channels', '--scope', 'acme'],
        ['vb', 'read', '<CHANNEL>', '--scope', 'acme', '--json'],
      ])
      expect(await next('read', 'dev/', '--mentions', '--scope', 'acme')).toEqual([
        ['vb', 'channels', 'dev/', '--scope', 'acme'],
        ['vb', 'read', '<CHANNEL>', '--scope', 'acme', '--json'],
      ])
      // A post's --sync and a schedule's files: the same write without them.
      expect(await next('post', 'dev', 'checkout is down', '--sync', 'slack:#incidents', '--scope', 'acme')).toEqual([['vb', 'post', 'dev', 'checkout is down', '--scope', 'acme', '--json']])
      expect(await next('schedule', 'dev', 'standup', '--in', '5m', '--attach', join(home, 'notes.txt'), '--scope', 'acme')).toEqual([['vb', 'schedule', 'dev', 'standup', '--in', '5m', '--scope', 'acme', '--json']])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("says what Vercel's API's grant rules refuse in its words, under what it couldn't do", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'project:prj_pong:production')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const api = fakeMessageboard()
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      // A project may read and post, and manages nothing: the API refuses with grant_forbidden.
      expect(await run('grants')).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: You can't list grants\.\n  listing grants takes manage at \*\n/) })
      expect(JSON.parse((await run('grants', '--json')).stderr)).toMatchObject({
        reason: 'permission_denied',
        data: { error: { code: 'grant_forbidden', message: 'listing grants takes manage at *', status: 403 } },
        // What it may do is whoami's, as whoever it ran as, and more is someone else's to give.
        next: [{ argv: ['vb', 'whoami'], when: 'See what you can do on this board' }],
        hint: "Or ask someone who manages the board's grants to give you access",
      })
      expect(JSON.parse((await run('grants', '--as', 'pinger', '--json')).stderr).next).toMatchObject([{ argv: ['vb', 'whoami', '--as', 'pinger'] }])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('puts a way out before --, so following it posts the same text to the board it names', async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const api = fakeMessageboard()
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    // What a way out says to run, as argv: its last indented line, unquoted.
    const wayOut = (stderr: string) => stderr.trimEnd().split('\n').at(-1)!.trim().split(' ').slice(1).map((arg) => arg.replace(/^'(.*)'$/, '$1'))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      // Text that reads like options, after --: the way out leaves it as it is, and adds its own before it.
      const missing = await run('post', 'dev', '--name', 'ops', '--', '--scope')
      expect(missing.code).toBe(1)
      const argv = wayOut(missing.stderr)
      expect(argv.slice(argv.indexOf('--'))).toEqual(['--', '--scope'])
      expect((await run(...argv)).code).toBe(0)
      expect((await run('read', 'dev', '--name', 'ops')).stdout).toContain('--scope')
      // So does the way out for a team in --name.
      const slashed = await run('post', 'dev', '--name', 'acme/ops', '--', '--rollback')
      expect(slashed.code).toBe(2)
      expect(wayOut(slashed.stderr)).toEqual(['post', 'dev', '--scope', 'acme', '--name', 'ops', '--', '--rollback'])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("takes a grant naming a repository's runs or an OIDC issuer on Vercel's board, and says an older API's refusal in its own words", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard()
    // An API from before it took them, which answers each with a 400 of its own.
    let older = false
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const asked = new URL(input instanceof Request ? input.url : String(input))
      if (older && ((typeof init?.body === 'string' && /"kind":"(github|oidc)"/.test(init.body)) || asked.searchParams.has('github')))
        return Response.json({ error: { code: 'unsupported_principal', message: 'Grants name no GitHub or OIDC principals.' } }, { status: 400 })
      return api.fetch(input, init)
    })
    const run = (...args: string[]) => capture(() => main([...args, '--scope', 'test'], { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await run('grants', 'create', '--github', 'acme/web', '--git-branch', 'main', '--can', 'ci/=post')).toEqual({ code: 0, stdout: 'created g4  --github acme/web --git-branch main  ci/=post\n', stderr: '' })
      expect(await run('grants', 'create', '--oidc', 'https://gitlab.com', '--claim', 'sub=project_path:acme/api:*', '--can', 'deploys=post')).toEqual({
        code: 0,
        stdout: 'created g5  --oidc https://gitlab.com --claim sub=project_path:acme/api:*  deploys=post\n',
        stderr: '',
      })
      expect(await run('grants', 'explain', 'ci/www', '--github', 'acme/web', '--git-branch', 'main')).toEqual({ code: 0, stdout: 'ci/ wins. Closest grant for acme/web: g4 (--github): post.\n', stderr: '' })
      older = true
      // The API's words, and no way out of the handle's: it doesn't know what this API takes.
      expect(await run('grants', 'create', '--github', 'acme/web', '--can', 'ci/=post')).toEqual({ code: 2, stdout: '', stderr: "error: Can't create the grant.\n  Grants name no GitHub or OIDC principals.\n" })
      expect(JSON.parse((await run('grants', 'create', '--github', 'acme/web', '--can', 'ci/=post', '--json')).stderr)).toEqual({
        status: 'error',
        reason: 'unsupported_principal',
        message: "Can't create the grant.",
        data: { error: { code: 'unsupported_principal', message: 'Grants name no GitHub or OIDC principals.', status: 400 } },
      })
      expect(await run('grants', 'explain', 'ci', '--github', 'acme/web')).toEqual({ code: 2, stdout: '', stderr: "error: Can't explain ci.\n  Grants name no GitHub or OIDC principals.\n" })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("goes as a GitHub Actions job's own OIDC token on Vercel's board, and says what to do when no team or token works", async () => {
    const home = await isolated()
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const job = `${part({ alg: 'none' })}.${part({ repository: 'acme/web', exp: Math.floor(Date.now() / 1000) + 3600 })}.`
    const api = fakeMessageboard({ tokens: { [job]: 'github:repo:700001' } })
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://actions.example/token')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-for-the-cli')
    // GitHub mints a token Vercel's API takes, or with another job's request token, one it doesn't.
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === 'https://actions.example') return Response.json({ value: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'request-for-the-cli' ? job : 'not-a-token' })
      return api.fetch(input, init)
    })
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    // Someone who manages the board let the repository's runs post in ci/.
    await board({ backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, 'user:u_jb') }) }).createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['post'] } })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      vi.stubEnv('VERCEL_ORG_ID', 'team_test')
      expect(await run('whoami')).toEqual({
        code: 0,
        stdout: 'acme/web (github:repo:700001)\nboard   https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test\nsource  GitHub Actions OIDC\ncan     ci/  post\n',
        stderr: '',
      })
      expect(await run('post', 'ci', 'deploy failed')).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_1\n$/) })
      // A token that names no team, and nothing that does: a board by its name, with no --scope or VERCEL_ORG_ID.
      vi.stubEnv('VERCEL_ORG_ID', '')
      expect(await run('post', 'ci', 'deploy failed', '--name', 'ops')).toEqual({
        code: 2,
        stdout: '',
        stderr: "error: A GitHub Actions token names no Vercel team, so there's no team's board to use.\n\n  Use a team's board: add --scope <TEAM_ID>\n  Or set VERCEL_ORG_ID to its ID\n",
      })
      // The job's log never repeats what it was about to post.
      const { stderr } = await run('post', 'ci', 'deploy failed', '--name', 'ops', '--json')
      expect(JSON.parse(stderr)).toMatchObject({ status: 'action_required', reason: 'missing_scope' })
      expect(stderr).not.toContain('deploy failed')
      // A token Vercel's API doesn't take: no login in the job to log in again with.
      vi.stubEnv('VERCEL_ORG_ID', 'team_test')
      vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-for-another-job')
      expect(await run('post', 'ci', 'deploy failed')).toEqual({
        code: 1,
        stdout: '',
        stderr: "error: The board didn't accept your credentials.\n  This token is invalid, expired, or revoked.\n\n  Pass a token it accepts in BOARD_TOKEN\n",
      })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("checks only a board someone named, never the team's by default, since it posts and changes grants", async () => {
    const home = await isolated()
    // As a project, which Vercel's board takes watchers from.
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'project:prj_pong:production')
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const api = fakeMessageboard()
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const writes = () => fetching.mock.calls.filter(([input, init]) => (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET').length
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      for (const args of [['conformance'], ['conformance', '--scope', 'test']]) {
        const refused = await run(...args)
        expect(refused).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: conformance posts and changes grants, so name a scratch board for it\.\n/) })
        expect(refused.stderr).toContain(`    vb ${args.join(' ')} --name <BOARD>\n`)
        expect(refused.stderr).toContain(`    vb ${args.join(' ')} --url <URL>\n`)
      }
      expect(writes()).toBe(0)
      // Named, even the team's default board, it runs: the person chose it.
      const named = await run('conformance', '--name', 'General')
      expect(named.code).not.toBe(2)
      expect(named.stdout).toMatch(/\d+ passed/)
      expect(writes()).toBeGreaterThan(0)
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('says how to point it at a board with the commands it has, standalone, where there is no team board', async () => {
    const home = await isolated()
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => main(['read', 'dev'], { name: 'board', commands: local }))).toMatchObject({
        code: 2,
        stderr: expect.stringMatching(/^error: No board to use\. [\s\S]*\n    vb read dev --scope <TEAM>\n/),
      })
    } finally {
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lists inspect and serve in the standalone board only, in a section of their own after wait', async () => {
    const help = await capture(() => main(['help'], { name: 'board', commands: local }))
    expect(help.stdout).toMatch(/^usage: board <command> \[options\]      \(also installed as `vb`\)$/m)
    // inspect and serve after wait, in a section of their own, and then the options every command takes.
    expect(help.stdout).toMatch(/\n  wait \[channel\|id\] \[filters\] \[--after id\] \[--timeout 10m\][^\n]*\n(?: {4,}[^\n]*\n)*\n  inspect +the board in your browser[^\n]*\n(?: {4,}[^\n]*\n)*  serve +run a board on this machine[\s\S]*local:user:<your OS\s+user>\n\nfilters:/)
  })

  it("takes the login the Vercel CLI hands it in VERCEL_AUTH_TOKEN, never a token cached for someone else's", async () => {
    const home = await isolated()
    // A token `vercel login`'s account minted for this board, cached as board caches them.
    const tokens = join(home, 'board', 'tokens')
    await mkdir(tokens, { recursive: true })
    const audience = 'https://board.example/api/board'
    await writeFile(join(tokens, `${createHash('sha256').update(audience).digest('hex').slice(0, 32)}.json`), JSON.stringify({ token: 'someone-elses', expiresAt: Date.now() + 3_600_000, name: null, avatar: null }))
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'vca_from_the_vercel_cli')
    vi.stubEnv('BOARD_URL', 'https://board.example/api/board')
    const asked: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      asked.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`)
      if (url.replace(/\/$/, '') === 'https://board.example/api/board') return Response.json({ version: '0', url: 'https://board.example/api/board', audience: 'https://board.example/api/board', team_id: 'team_1', project_id: 'prj_board', sync: [] })
      return Response.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 })
    })
    try {
      await capture(() => createApp({ appName: 'vercel board' }).run(['whoami']))
    } finally {
      fetching.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
    expect(asked.filter((line) => line.startsWith('https://api.vercel.com/')).every((line) => line.endsWith('Bearer vca_from_the_vercel_cli'))).toBe(true)
    expect(asked.some((line) => line.startsWith('https://api.vercel.com/'))).toBe(true)
  })

  it('leaves no Ctrl-C handler behind once wait or tail is done, since the process it runs in goes on', async () => {
    await isolated()
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', env.BOARD_TOKEN)
    const before = process.listenerCount('SIGINT')
    const app = createApp({ appName: 'vercel board' })
    expect((await capture(() => app.run(['wait', 'quiet', '--timeout', '1s']))).code).toBe(1)
    // No board answers there, so tail fails before it reads anything.
    vi.stubEnv('BOARD_URL', url.replace(/\/api\/board$/, '/nowhere'))
    expect((await capture(() => app.run(['tail', 'quiet']))).code).toBe(1)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('never brings the inspector, serve, or A2 into an app that bundles it', async () => {
    const embedded = await bundled("import { createApp } from '../src/cli/embedded.ts'\nawait createApp({ appName: 'vercel board' }).run(process.argv.slice(2))")
    expect(everything(embedded).includes(MARKERS.serve), 'serve in the embedded CLI').toBe(false)
    expect(everything(embedded).includes(MARKERS.a2), 'A2 in the embedded CLI').toBe(false)
    expect(everything(embedded).includes(MARKERS.inspector), 'the inspector in the embedded CLI').toBe(false)
    // The standalone CLI has all three, so the markers find what they look for.
    const standalone = everything(await bundled("import '../src/cli/bin.ts'"))
    for (const [what, marker] of Object.entries(MARKERS)) expect(standalone.includes(marker), `${what} in the standalone CLI`).toBe(true)
  }, 120_000)

  /** `inspect` as a subprocess, until it says where it serves; `stop` is Ctrl-C, answering the exit code. */
  async function inspecting(argv: string[], extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [...argv, 'inspect', '--port', '0', '--no-open'], { env: { ...env, ...extra } })
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const address = await new Promise<string | null>((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        const found = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)
        if (found) resolve(found[1]!)
      })
      child.on('close', () => resolve(null))
    })
    return {
      address,
      stdout: () => stdout,
      stderr: () => stderr,
      exited,
      stop: () => (child.kill('SIGINT'), exited),
    }
  }

  it("serves the page it's installed with, standalone", async () => {
    const served = await inspecting([join(import.meta.dirname, '../dist/cli.mjs')])
    expect(await (await fetch(`${served.address}/app.js`)).text()).toBe(await readFile(join(import.meta.dirname, '../dist/inspect/app.js'), 'utf8'))
    expect(await served.stop()).toBe(0)
  }, 30_000)
})
