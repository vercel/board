import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

const CLI = join(import.meta.dirname, '../src/cli/main.ts')
// Every directory a test makes lives under one root, which holds an empty `.git`
// (as stray ones in `~` or `/tmp` do): it isn't a checkout, so nothing links there.
const TEMP = realpathSync(mkdtempSync(join(tmpdir(), 'vboard-cli-')))
mkdirSync(join(TEMP, '.git'))
const tmp = (prefix: string) => mkdtemp(join(TEMP, prefix))

let server: Awaited<ReturnType<typeof serve>>
let url: string
let env: NodeJS.ProcessEnv

beforeAll(async () => {
  // No fixed URL: the board infers its own from requests, as when mounted.
  server = await serve(testBoard({ url: undefined }).fetch)
  url = `${server.origin}/api/board`
  // Every variable `detectAgent` reads, so the suite passes inside an agent's session too (Pi's included).
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|VBOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key),
    ),
  )
  env = {
    ...clean,
    VBOARD_URL: url,
    VBOARD_TOKEN: await personToken('u_julian', url),
    VBOARD_HANDLE: 'julian',
    HOME: await tmp('vboard-home-'),
    XDG_CONFIG_HOME: await tmp('vboard-'),
  }
})
afterAll(() => server.close())

function vb(args: string[], extra: NodeJS.ProcessEnv = {}, stdin?: string, cwd?: string) {
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

function vb_in(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
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

describe('cli', () => {
  it('links a checkout from a subdirectory, ignores the link, and reads it from other subdirectories', async () => {
    const root = await tmp('vboard-link-')
    const directory = join(root, 'packages', 'app')
    const global = await tmp('vboard-global-')
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: /worktree')
    await writeFile(join(root, '.gitignore'), 'node_modules')
    await mkdir(join(global, 'vboard'))
    await writeFile(join(global, 'vboard', 'config.json'), JSON.stringify({ url: 'http://global.invalid/api/board' }))
    const local = { VBOARD_URL: undefined, XDG_CONFIG_HOME: global }

    expect(await vb(['link', `${url}/`], local, undefined, directory)).toMatchObject({
      code: 0, stderr: '', stdout: `linked ${root} to ${url}\n`,
    })
    expect(JSON.parse(await readFile(join(root, '.vboard', 'config.json'), 'utf8'))).toEqual({ url })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.vboard/\n')
    expect(JSON.parse(await readFile(join(global, 'vboard', 'config.json'), 'utf8'))).toEqual({ url: 'http://global.invalid/api/board' })
    expect(await vb(['whoami', '--json'], local, undefined, directory)).toMatchObject({ code: 0, stderr: '' })

    expect((await vb(['link', url], local, undefined, root)).code).toBe(0)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.vboard/\n')
  }, 20_000)

  it('links a directory without Git in place', async () => {
    const root = await tmp('vboard-link-')
    expect((await vb(['link', url], {}, undefined, root)).code).toBe(0)
    expect(JSON.parse(await readFile(join(root, '.vboard', 'config.json'), 'utf8'))).toEqual({ url })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('.vboard/\n')
  })

  it('treats only a real .git as a checkout root: a HEAD inside, or a gitdir: file', async () => {
    const parent = await tmp('vboard-link-')
    const child = join(parent, 'child')
    await mkdir(join(parent, '.git'))
    await mkdir(child)
    expect(await vb(['link', url], {}, undefined, child)).toMatchObject({ code: 0, stdout: `linked ${child} to ${url}\n` })
    await writeFile(join(parent, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const other = join(parent, 'other')
    await mkdir(other)
    expect(await vb(['link', url], {}, undefined, other)).toMatchObject({ code: 0, stdout: `linked ${parent} to ${url}\n` })
    const worktree = await tmp('vboard-link-')
    await writeFile(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/x\n')
    await mkdir(join(worktree, 'src'))
    expect(await vb(['link', url], {}, undefined, join(worktree, 'src'))).toMatchObject({ code: 0, stdout: `linked ${worktree} to ${url}\n` })
    const stray = await tmp('vboard-link-')
    await writeFile(join(stray, '.git'), 'not a pointer')
    await mkdir(join(stray, 'src'))
    expect(await vb(['link', url], {}, undefined, join(stray, 'src'))).toMatchObject({ code: 0, stdout: `linked ${join(stray, 'src')} to ${url}\n` })
  }, 20_000)

  it('says a board is behind Vercel Deployment Protection, and passes the bypass secret', async () => {
    const board = testBoard({ url: undefined })
    const walls = {
      redirect: () => new Response(null, { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x' } }),
      html: () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    }
    for (const [kind, wall] of Object.entries(walls)) {
      const seen: (string | null)[] = []
      const protectedBoard = await serve(async (request) => {
        seen.push(request.headers.get('x-vercel-protection-bypass'))
        return request.headers.get('x-vercel-protection-bypass') === 's3cret' ? board.fetch(request) : wall()
      })
      const at = `${protectedBoard.origin}/api/board`
      const line = `error: ${at} is behind Vercel Deployment Protection, and your Vercel login can't see its project: run \`vercel login\` or ask for access, or set VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment Protection → Protection Bypass for Automation)\n`
      // No Vercel login to look the project's bypass up with: no auth.json, no `vercel` on PATH.
      const signedOut = { PATH: '', XDG_DATA_HOME: await tmp('vboard-data-') }
      try {
        expect(await vb(['whoami'], { ...signedOut, VBOARD_URL: at, VBOARD_TOKEN: await personToken('u_julian', at) }), kind).toEqual({ code: 1, stdout: '', stderr: line })
        // Discovery, without a token yet.
        const root = await tmp('vboard-link-')
        expect(await vb(['link', at], signedOut, undefined, root), kind).toEqual({ code: 1, stdout: '', stderr: line })
        expect(await vb(['whoami'], { VBOARD_URL: at, VBOARD_TOKEN: await personToken('u_julian', at), VERCEL_AUTOMATION_BYPASS_SECRET: 'stale' }), kind).toEqual({
          code: 1,
          stdout: '',
          stderr: `error: ${at} is behind Vercel Deployment Protection and rejected VERCEL_AUTOMATION_BYPASS_SECRET; check it against Project → Settings → Deployment Protection → Protection Bypass for Automation\n`,
        })
        seen.length = 0
        const ok = await vb(['whoami', '--json'], { VBOARD_URL: at, VBOARD_TOKEN: await personToken('u_julian', at), VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
        expect(ok, kind).toMatchObject({ code: 0, stderr: '' })
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every((header) => header === 's3cret')).toBe(true)
      } finally {
        await protectedBoard.close()
      }
    }
  }, 30_000)

  it("doesn't wait on a signed-out `vercel` CLI's login flow", async () => {
    const wall = await serve(async () => new Response(null, { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x' } }))
    // A `vercel` that logs each call and, like a signed-out CLI, starts a login flow that never ends.
    const bin = await tmp('vboard-bin-')
    const log = join(bin, 'calls')
    await writeFile(join(bin, 'vercel'), `#!/bin/sh\necho "$*" >> ${log}\nexec ${execFileSync('sh', ['-c', 'command -v sleep']).toString().trim()} 60\n`, { mode: 0o755 })
    try {
      const at = `${wall.origin}/api/board`
      const started = Date.now()
      const result = await vb(['whoami'], { PATH: bin, XDG_DATA_HOME: await tmp('vboard-data-'), VBOARD_URL: at })
      expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining("your Vercel login can't see its project") })
      expect(Date.now() - started).toBeLessThan(20_000)
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['whoami --non-interactive'])
    } finally {
      await wall.close()
    }
  }, 30_000)

  it('keeps its own error for a non-board HTML page, and keeps credentials off other origins', async () => {
    const missing = await serve(async () => new Response('<!DOCTYPE html><h1>404</h1>', { status: 404, headers: { 'content-type': 'text/html' } }))
    try {
      const root = await tmp('vboard-link-')
      expect(await vb(['link', `${missing.origin}/api/board`], {}, undefined, root)).toEqual({
        code: 1, stdout: '', stderr: 'error: 404 Not Found\n',
      })
    } finally {
      await missing.close()
    }

    // A board that moved: same-origin and cross-origin hops are followed, and only the board's origin gets the token and bypass.
    const board = testBoard({ url: undefined })
    const seen = { moved: [] as (string | null)[], board: [] as (string | null)[] }
    const target = await serve(async (request) => {
      seen.board.push(request.headers.get('authorization'), request.headers.get('x-vercel-protection-bypass'))
      return board.fetch(request)
    })
    const moved = await serve(async (request) => {
      const path = new URL(request.url).pathname
      seen.moved.push(request.headers.get('authorization'))
      if (path.startsWith('/old')) return new Response(null, { status: 307, headers: { location: path.replace('/old', '/hop') } })
      return new Response(null, { status: 301, headers: { location: `${target.origin}${path.replace('/hop', '')}` } })
    })
    try {
      const at = `${moved.origin}/old/api/board`
      const token = await personToken('u_julian', `${target.origin}/api/board`)
      const me = await vb(['whoami', '--json'], { VBOARD_URL: at, VBOARD_TOKEN: token, VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
      expect(seen.moved).toEqual([`Bearer ${token}`, `Bearer ${token}`])
      expect(seen.board).toEqual([null, null])
      expect(me.code).toBe(1)
    } finally {
      await Promise.all([moved.close(), target.close()])
    }
  }, 20_000)

  it('lets explicit and environment URLs override the project link', async () => {
    const root = await tmp('vboard-link-')
    await mkdir(join(root, '.vboard'))
    await writeFile(join(root, '.vboard', 'config.json'), JSON.stringify({ url: 'http://project.invalid/api/board' }))
    const fromEnv = await vb(['whoami', '--json'], {}, undefined, root)
    expect(fromEnv.code).toBe(0)
    expect(JSON.parse(fromEnv.stdout).board).toBe(url)
    const explicit = await vb(['whoami', '--url', url, '--json'], { VBOARD_URL: 'http://env.invalid/api/board' }, undefined, root)
    expect(explicit.code).toBe(0)
    expect(JSON.parse(explicit.stdout).board).toBe(url)
  }, 20_000)

  it('stops at a nested Git checkout and falls back to the global board', async () => {
    const root = await tmp('vboard-link-')
    const nested = join(root, 'other-project')
    const global = await tmp('vboard-global-')
    await mkdir(join(root, '.vboard'))
    await writeFile(join(root, '.vboard', 'config.json'), JSON.stringify({ url: 'http://parent.invalid/api/board' }))
    await mkdir(join(nested, '.git'), { recursive: true })
    await writeFile(join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const local = { VBOARD_URL: undefined, XDG_CONFIG_HOME: global }
    expect((await vb(['use', url], local, undefined, nested)).code).toBe(0)
    const me = await vb(['whoami', '--json'], local, undefined, nested)
    expect(me.code).toBe(0)
    expect(JSON.parse(me.stdout).board).toBe(url)
  }, 20_000)

  it('reports a malformed project link instead of using the global board', async () => {
    const root = await tmp('vboard-link-')
    const global = await tmp('vboard-global-')
    await mkdir(join(root, '.vboard'))
    const local = { VBOARD_URL: undefined, XDG_CONFIG_HOME: global }
    expect((await vb(['use', url], local, undefined, root)).code).toBe(0)
    for (const contents of ['{', '{"url":12}', '{"url":"ftp://board.test"}']) {
      await writeFile(join(root, '.vboard', 'config.json'), contents)
      expect(await vb(['whoami'], local, undefined, root)).toMatchObject({
        code: 1,
        stderr: `error: invalid board link at ${join(root, '.vboard', 'config.json')}: expected an http(s) url\n`,
      })
    }
    expect((await vb(['whoami', '--url', url], local, undefined, root)).code).toBe(0)
  }, 20_000)

  it('keeps the link when discovery fails and rejects missing or extra arguments', async () => {
    const root = await tmp('vboard-link-')
    expect((await vb(['link', url], {}, undefined, root)).code).toBe(0)
    const path = join(root, '.vboard', 'config.json')
    const before = await readFile(path, 'utf8')
    const unavailable = await serve(async () => new Response('unavailable', { status: 503 }))
    try {
      expect((await vb(['link', unavailable.origin], {}, undefined, root)).code).toBe(1)
    } finally {
      await unavailable.close()
    }
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await vb(['link'], {}, undefined, root)).toMatchObject({ code: 2, stderr: 'error: usage: vboard link <url>\n' })
    expect(await vb(['link', url, 'dev'], {}, undefined, root)).toMatchObject({ code: 2, stderr: 'error: usage: vboard link <url>\n' })
  }, 20_000)

  it('posts, replies, reacts, labels, and reads a thread', async () => {
    const posted = await vb(['post', 'errors-www', 'deploy failed on a1b2c3', '--label', 'status=open'])
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    const id = posted.stdout.trim()
    expect(id).toMatch(/^\d+$/)

    const reply = await vb(['reply', id, '-', '--as', 'claude'], {}, 'rolled back to d4e5f6\n')
    expect(reply.code).toBe(0)
    expect((await vb(['react', id, '👀'])).code).toBe(0)
    // This board syncs nowhere, so typing shows nowhere, and that's fine.
    expect(await vb(['typing', id])).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(await vb(['typing', id, 'running', 'tests…'])).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect((await vb(['label', id, 'status=investigating'])).code).toBe(0)

    const read = await vb(['read', 'errors-www'])
    expect(read.code).toBe(0)
    expect(read.stdout).toContain(`#${id}  julian`)
    expect(read.stdout).toContain('[status=investigating]')
    expect(read.stdout).toContain('deploy failed on a1b2c3')
    expect(read.stdout).toContain('👀 julian')
    expect(read.stdout).toContain('↳ #')
    expect(read.stdout).toContain('claude via julian')
    expect(read.stdout).toContain('rolled back to d4e5f6')

    const json = await vb(['read', id, '--json'])
    const lines = json.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((m: { text: string }) => m.text)).toEqual(['deploy failed on a1b2c3', 'rolled back to d4e5f6'])
  })

  it('filters by mentions of me, or of a handle', async () => {
    await vb(['post', 'pings', 'hello'])
    await vb(['post', 'pings', 'hey @julian, look', '--as', 'claude'])
    const texts = async (args: string[]) => {
      const { stdout } = await vb(['read', 'pings', ...args, '--json'])
      return stdout.trim().split('\n').map((line) => (JSON.parse(line) as { text: string }).text)
    }
    expect(await texts(['--mentions'])).toEqual(['hey @julian, look'])
    expect(await texts(['--mentions', '@julian'])).toEqual(['hey @julian, look'])
  })

  it('reports who you are', async () => {
    const { stdout, code } = await vb(['whoami', '--as', 'codex'])
    expect(code).toBe(0)
    expect(stdout).toContain('codex via julian (vercel:user:u_julian+codex)')
    expect(stdout).toContain(`board  ${url}`)
  })

  it('picks up the profile of a detected agent', async () => {
    const { stdout } = await vb(['whoami', '--json'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's-1' })
    expect(JSON.parse(stdout)).toMatchObject({ actor: 'vercel:user:u_julian+claude', session: 's-1' })
    const human = await vb(['whoami', '--json', '--human'], { CLAUDECODE: '1' })
    expect(JSON.parse(human.stdout)).toMatchObject({ actor: 'vercel:user:u_julian', profile: null })
  })

  it('waits for a reply, or exits 124 on timeout', async () => {
    const id = (await vb(['post', 'questions', 'anyone?'])).stdout.trim()
    const timedOut = await vb(['wait', '--re', id, '--timeout', '300ms'])
    expect(timedOut).toMatchObject({ code: 124, stderr: 'timed out\n' })

    const waiting = vb(['wait', '--re', id, '--timeout', '10s', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 500))
    await vb(['reply', id, 'me!'])
    const answered = await waiting
    expect(answered.code).toBe(0)
    expect(JSON.parse(answered.stdout).message.text).toBe('me!')
  })

  it('attaches files, shows them, and downloads them', async () => {
    const dir = await tmp('vboard-files-')
    const shot = join(dir, 'after.png')
    await writeFile(shot, Buffer.from([137, 80, 78, 71]))
    const posted = await vb(['post', 'proofs', '--attach', shot])
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    const id = posted.stdout.trim()
    const reply = await vb(['reply', id, 'and the log', '--attach', shot, '--json'])
    const [attachment] = JSON.parse(reply.stdout).attachments
    expect(attachment).toMatchObject({ name: 'after.png', type: 'image/png', size: 4 })

    const read = await vb(['read', id])
    expect(read.stdout).toContain(`📎 after.png · image/png · 4 B · ${attachment.id}`)

    const saved = join(dir, 'copy.png')
    expect(await vb(['download', attachment.id, saved])).toMatchObject({ code: 0, stdout: `${saved}\n` })
    expect(await readFile(saved)).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(await vb(['post', 'proofs', 'x', '--attach', join(dir, 'missing.png')])).toMatchObject({ code: 2, stderr: `error: no such file: ${join(dir, 'missing.png')}\n` })
  }, 20_000) // five CLI runs: a cold start right after install can pass the default 5s

  it('installs turn-end hooks, and the permissions their reminder needs, keeping what else is there', async () => {
    const home = await tmp('vboard-home-')
    const at = { HOME: home, CODEX_HOME: join(home, '.codex') }
    await mkdir(join(home, '.claude'), { recursive: true })
    const settings = join(home, '.claude', 'settings.json')
    const theirs = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [] },
    }
    await writeFile(settings, JSON.stringify(theirs))

    const installed = await vb(['hooks', 'install', 'claude', 'codex'], at)
    expect(installed).toMatchObject({ code: 0, stderr: '' })
    expect(installed.stdout).toContain('Codex: added the turn-end hook')
    // Codex has no command allowlist; its sandbox needs network, so it's told how to allow just the board.
    expect(installed.stdout).toContain("Codex's sandbox has no network by default")
    expect(installed.stdout).toContain(`"${new URL(url).hostname}" = "allow"`)
    expect((await vb(['hooks', 'install', 'claude'], at)).stdout).toContain('Claude Code: already installed')
    const claude = JSON.parse(await readFile(settings, 'utf8'))
    expect(claude.model).toBe('opus')
    expect(claude.hooks.PreToolUse).toEqual([])
    expect(claude.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: expect.stringMatching(/ hook stop --agent claude 2>\/dev\/null \|\| true$/), timeout: 10 }] },
    ])
    const cli = (claude.hooks.Stop[1].hooks[0].command as string).replace(/ hook stop .*$/, '')
    expect(claude.permissions).toEqual({ allow: ['Bash(ls:*)', `Bash(${cli} update:*)`, `Bash(${cli} reply:*)`, `Bash(${cli} read:*)`], deny: ['Bash(rm:*)'] })
    const codex = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'))
    expect(codex.hooks.Stop[0].hooks[0].command).toMatch(/ hook stop --agent codex 2>\/dev\/null \|\| true$/)
    expect((await vb(['hooks', 'status'], at)).stdout).toMatch(/Claude Code: .* hook stop --agent claude .*\|\| true\nCodex: .* hook stop --agent codex .*\|\| true\nCursor: not installed/)

    // Whatever the saved command runs into (say, an older vb without `hook`, which exits 2), it can't fail a turn.
    const stale = join(home, 'bin')
    await mkdir(stale)
    await writeFile(join(stale, 'vb'), '#!/bin/sh\necho "error: unknown command: hook" >&2\nexit 2\n', { mode: 0o755 })
    const ran = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', 'vb hook stop --agent claude 2>/dev/null || true'], { env: { ...env, PATH: `${stale}:${process.env.PATH}` } })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code, stderr }))
      child.stdin.end('{}')
    })
    expect(ran).toEqual({ code: 0, stderr: '' })

    expect((await vb(['hooks', 'uninstall', 'claude'], at)).stdout).toContain('removed')
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual(theirs)
    expect((await vb(['hooks', 'install', 'gemini'], at))).toMatchObject({ code: 2, stderr: 'error: unknown agent: gemini (known: claude, codex, cursor, pi)\n' })
  })

  it('installs the Claude Code hook in CLAUDE_CONFIG_DIR when it is set', async () => {
    const home = await tmp('vboard-home-')
    const config = await tmp('vboard-claude-')
    const at = { HOME: home, CLAUDE_CONFIG_DIR: config }
    expect(await vb(['hooks', 'install', 'claude'], at)).toMatchObject({ code: 0, stderr: '' })
    const settings = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/ hook stop --agent claude /)
    expect(settings.permissions.allow).toHaveLength(3)
    expect(readdirSync(home)).toEqual([])
    expect((await vb(['hooks', 'status'], at)).stdout).toMatch(/Claude Code: .* hook stop --agent claude /)
    expect((await vb(['hooks', 'status'], { HOME: home })).stdout).toMatch(/Claude Code: not installed/)
    expect((await vb(['hooks', 'uninstall', 'claude'], at)).stdout).toContain('removed')
    expect(JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))).toEqual({ hooks: {}, permissions: { allow: [] } })
    expect(readdirSync(home)).toEqual([])
  }, 20_000)

  it("reminds an agent once when its turn didn't update the board, and the agent updates with vb", async () => {
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/hooks'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo })
    // Markers live in the temp directory: fresh session IDs keep runs apart.
    const s1 = `s1-${Date.now()}`
    const claude = { CLAUDE_CODE_SESSION_ID: s1 }
    const stop = (session: string, continuing = false, extra: NodeJS.ProcessEnv = {}) =>
      vb(['hook', 'stop', '--agent', 'claude'], extra, JSON.stringify({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: continuing }))
    const reminds = async (result: Promise<{ stdout: string; code: number }>) => {
      const { stdout, code } = await result
      expect(code).toBe(0)
      return stdout ? (JSON.parse(stdout) as { decision: string; reason: string }) : null
    }
    const work = async () => {
      const { stdout } = await vb(['read', 'work', '--label', 'work=acme/app@feat/hooks', '--json'])
      return stdout.trim() ? stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; re: number | null; text: string; noSync: boolean; labels: Record<string, string>; by: { profile: string; session: string } }) : []
    }

    // A turn that didn't touch the board is reminded once, with the commands to run; the follow-up stops.
    const reminded = await reminds(stop(s1))
    expect(reminded).toMatchObject({ decision: 'block', reason: expect.stringContaining(' update "<summary>"') })
    expect(reminded!.reason).toContain(' update --skip')
    expect(await reminds(stop(s1, true))).toBeNull()

    // The agent updates with vb: the turn's end isn't reminded. The next turn, with no update, is.
    expect(await vb_in(repo, ['update', 'Added the turn-end hook; tests next.'], claude)).toMatchObject({ code: 0, stderr: '' })
    expect(await reminds(stop(s1))).toBeNull()
    expect(await reminds(stop(s1))).not.toBeNull()
    expect(await reminds(stop(s1))).toBeNull() // reminded already this turn
    await vb_in(repo, ['update', '--skip'], claude)
    expect(await reminds(stop(s1))).toBeNull()

    // Another agent's update on the same branch joins the same thread.
    await vb_in(repo, ['update', 'Picked it up in Codex; tests pass.'], { CODEX_THREAD_ID: 't1' })
    const [root, ...replies] = await work()
    expect(root).toMatchObject({ re: null, noSync: true, labels: { work: 'acme/app@feat/hooks', repo: 'acme/app', branch: 'feat/hooks' } })
    expect(replies.map((m) => [m.by.profile, m.by.session, m.text])).toEqual([
      ['claude', s1, 'Added the turn-end hook; tests next.'],
      ['codex', 't1', 'Picked it up in Codex; tests pass.'],
    ])

    // Past a page of messages on the branch, updates still find the thread instead of starting another.
    const rootId = root!.id
    for (let i = 0; i < 501; i++) {
      const posted = await fetch(`${url}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.VBOARD_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ re: rootId, text: `note ${i}`, noSync: true }),
      })
      expect(posted.status).toBe(201)
    }
    // From another session, so the root's stable id can't stand in for finding it.
    expect(await vb_in(repo, ['update', 'Still the same thread.'], { CODEX_THREAD_ID: `t2-${Date.now()}` })).toMatchObject({ code: 0, stderr: '' })
    const { stdout } = await vb(['read', String(rootId), '--json'])
    const thread = stdout.trim().split('\n').map((line) => JSON.parse(line) as { re: number | null; text: string })
    expect(thread).toHaveLength(1 + 2 + 501 + 1) // the root, two updates, the notes, and this one
    expect(thread.at(-1)).toMatchObject({ re: rootId, text: 'Still the same thread.' })

    // Outside a linked project, the hook stays out of the way.
    expect(await reminds(stop(`s2-${Date.now()}`, false, { VBOARD_URL: '' }))).toBeNull()
  }, 60_000)

  it('starts the work thread for a branch whose name is longer than an id may be', async () => {
    const repo = await tmp('vboard-repo-')
    const branch = `feat/${'very-long-branch-name-'.repeat(10)}`
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo })
    expect(await vb_in(repo, ['update', 'First update on a long branch.'])).toMatchObject({ code: 0, stderr: '' })
    expect(await vb_in(repo, ['update', 'Second one, same thread.'])).toMatchObject({ code: 0, stderr: '' })
    const { stdout } = await vb(['read', 'work', '--label', `work=acme/app@${branch}`, '--json'])
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line) as { re: number | null })
    expect(messages.filter((m) => m.re === null)).toHaveLength(1)
    expect(messages).toHaveLength(3)
  })

  it('reminds Cursor with a follow-up message, keyed by project since its shell has no session', async () => {
    const home = await tmp('vboard-home-')
    expect((await vb(['hooks', 'install', 'cursor'], { HOME: home })).stdout).toContain('Cursor: added the turn-end hook')
    expect(JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: expect.stringMatching(/ hook stop --agent cursor 2>\/dev\/null \|\| true$/), timeout: 10 }] },
    })

    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/cursor'], { cwd: repo })
    const stop = (payload: Record<string, unknown>) =>
      vb(['hook', 'stop', '--agent', 'cursor'], {}, JSON.stringify({ conversation_id: `c-${Date.now()}`, workspace_roots: [repo], hook_event_name: 'stop', ...payload }))

    expect(JSON.parse((await stop({ status: 'completed', loop_count: 0 })).stdout)).toEqual({ followup_message: expect.stringContaining(' update "<summary>"') })
    expect((await stop({ status: 'completed', loop_count: 1 })).stdout).toBe('')
    // The agent updates from Cursor's shell, which says only CURSOR_AGENT=1: the project's next turn end isn't reminded.
    expect(await vb_in(repo, ['update', 'Renamed the helper.'], { CURSOR_AGENT: '1' })).toMatchObject({ code: 0, stderr: '' })
    expect((await stop({ status: 'completed', loop_count: 0 })).stdout).toBe('')
    const { stdout } = await vb(['read', 'work', '--label', `work=${basename(repo)}@feat/cursor`, '--json'])
    expect(stdout.trim().split('\n').map((line) => JSON.parse(line)).filter((m) => m.re !== null).map((m) => [m.by.profile, m.text])).toEqual([['cursor', 'Renamed the helper.']])
    // An aborted turn isn't reminded.
    expect((await stop({ status: 'aborted', loop_count: 0 })).stdout).toBe('')

    // Uninstalling removes the file it created.
    expect((await vb(['hooks', 'uninstall', 'cursor'], { HOME: home })).stdout).toContain('removed')
    await expect(readFile(join(home, '.cursor', 'hooks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("reminds Pi through an extension before its run settles, once, and not after it updates with vb", async () => {
    const home = await tmp('vboard-home-')
    const agentDir = join(home, 'pi-agent')
    const at = { HOME: home, PI_CODING_AGENT_DIR: agentDir }
    const file = join(agentDir, 'extensions', 'vboard.ts')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain(`Pi: added the turn-end hook to ${file}`)
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('Pi: already installed')
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toMatch(/^Pi: .* hook stop --agent pi 2>\/dev\/null \|\| true\n$/)

    // Load it as Pi does, with a stand-in for Pi's API, and run its handler as Pi would before settling.
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
    const { default: extension } = await import(file)
    extension({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => (handlers[name] = handler) })
    expect(Object.keys(handlers)).toEqual(['agent_before_settle'])
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/pi'], { cwd: repo })
    const session = `pi-${Date.now()}`
    const ctx = { cwd: repo, sessionManager: { getSessionId: () => session } }
    const settle = (outcome = 'completed') => handlers.agent_before_settle!({ type: 'agent_before_settle', outcome, entries: [], continue: false }, ctx)
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    try {
      // A run that didn't touch the board continues once, with the reminder as a message; the follow-up settles.
      expect(await settle()).toEqual({
        entries: [{ type: 'custom_message', customType: 'vboard', content: expect.stringContaining(' update "<summary>"'), display: true }],
        continue: true,
      })
      expect(await settle()).toBeUndefined()
      // Pi's bash tool exports the session as PI_SESSION_ID: its update counts, so the next run settles freely.
      expect(await vb_in(repo, ['update', 'Taught Pi the hook.'], { PI_CODING_AGENT: 'true', PI_SESSION_ID: session })).toMatchObject({ code: 0, stderr: '' })
      expect(await settle()).toBeUndefined()
      // An aborted run isn't reminded.
      expect(await settle('aborted')).toBeUndefined()
      expect(await settle()).toMatchObject({ continue: true })
    } finally {
      vi.unstubAllEnvs()
    }
    const { stdout } = await vb(['read', 'work', '--label', `work=${basename(repo)}@feat/pi`, '--json'])
    expect(stdout.trim().split('\n').map((line) => JSON.parse(line)).filter((m) => m.re !== null).map((m) => [m.by.profile, m.by.session, m.text])).toEqual([['pi', session, 'Taught Pi the hook.']])

    // It won't overwrite an extension that isn't its own; uninstalling removes only its file.
    expect((await vb(['hooks', 'uninstall', 'pi'], at)).stdout).toContain(`Pi: removed the turn-end hook from ${file}`)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, 'export default () => {}\n')
    expect(await vb(['hooks', 'install', 'pi'], at)).toMatchObject({ code: 1, stderr: `error: ${file} isn't vboard's: move it, then install again\n` })
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toBe('Pi: not installed\n')
    expect(await readFile(file, 'utf8')).toBe('export default () => {}\n')
  }, 30_000)

  it('delivers all of a long read to a reader that falls behind', async () => {
    const post = async (body: unknown) =>
      ((await (await fetch(`${url}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.VBOARD_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).json()) as { message: { id: number } }).message
    const root = await post({ channel: 'long-reads', text: 'a long thread', noSync: true })
    // Well past a pipe's buffer on any OS (Linux's is bigger than macOS's), so a dropped tail shows.
    for (let batch = 0; batch < 15; batch++)
      await Promise.all(Array.from({ length: 100 }, (_, i) => post({ re: root.id, text: `note ${batch * 100 + i} ${'x'.repeat(300)}`, noSync: true })))
    // A reader that waits before reading: what's still queued on the pipe when the command returns must arrive.
    const child = spawn(process.execPath, [CLI, 'read', String(root.id), '--json'], { env })
    child.stdin.end()
    child.stdout.pause()
    setTimeout(() => child.stdout.resume(), 300)
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    const code = await new Promise((resolve) => child.on('close', resolve))
    expect(code).toBe(0)
    expect(stdout.trim().split('\n')).toHaveLength(1501)
  }, 60_000)

  it('lists sources, and reads one only as `sources <key> read <target>`', async () => {
    expect((await vb(['sources'])).stdout.trim()).toBe('no sources: this board has no sync configured')
    const misuse = await vb(['sources', 'slack', '#general'])
    expect(misuse.code).toBe(2)
    expect(misuse.stderr).toContain('usage: vboard sources <key> read')
    const unsynced = await vb(['sources', 'slack', 'read', '#general'])
    expect(unsynced.code).toBe(1)
    expect(unsynced.stderr).toContain('no sync configured')
  })

  it("says so when the board is older than `sources read`, instead of crashing on its discovery document", async () => {
    // An old board answers any unknown GET with its discovery document, 200.
    const old = await serve(async () => Response.json({ version: '0.4.0', sync: [] }))
    try {
      const read = await vb(['sources', 'slack', 'read', '#general'], { VBOARD_URL: `${old.origin}/api/board` })
      expect(read.code).toBe(1)
      expect(read.stderr).toContain("this board can't read sources yet")
    } finally {
      await old.close()
    }
  })

  it('prints one error line and exits 1 on failure, 2 on misuse', async () => {
    expect(await vb(['read', '99999'])).toMatchObject({ code: 1, stderr: 'error: message not found: #99999\n' })
    expect(await vb(['post', 'x', '@nobody'])).toMatchObject({ code: 1, stderr: 'error: unknown mention @nobody\n' })
    expect((await vb(['react', '1', 'not an emoji'])).code).toBe(2)
    expect((await vb(['typing'])).code).toBe(2)
    expect((await vb(['frobnicate'])).code).toBe(2)
    expect((await vb(['inspect', '--port', 'nope'])).code).toBe(2)
    expect((await vb(['stuck', 'retry'])).code).toBe(2)
    expect((await vb(['stuck', 'redo', 'board#1'])).code).toBe(2)
    expect((await vb(['stuck', 'skip', 'board'])).code).toBe(2)
  })

  it("says when nothing is stuck, and when what it's asked to redrive isn't", async () => {
    expect(await vb(['stuck'])).toMatchObject({ code: 0, stdout: 'nothing is stuck\n' })
    expect(await vb(['stuck', 'skip', 'board#1'])).toMatchObject({ code: 0, stdout: "board#1 isn't stuck\n" })
    expect(await vb(['stuck', 'retry', 'nowhere#1'])).toMatchObject({ code: 1, stderr: 'error: no session nowhere on this board\n' })
  })

  it('serves the inspector until Ctrl-C', async () => {
    const child = spawn(process.execPath, [CLI, 'inspect', '--port', '0', '--no-open'], { env })
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
    let stdout = ''
    const address = await new Promise<string>((resolve) =>
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        const found = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)
        if (found) resolve(found[1]!)
      }),
    )
    expect(stdout).toContain(`inspecting ${url} as julian`)
    expect(await (await fetch(address)).text()).toContain('<div id="root"></div>')
    child.kill('SIGINT')
    expect(await exited).toBe(0)
  })
})

describe('cli schedules', () => {
  it('schedules a reply, shows it in the thread, sends it, and cancels a repeat', async () => {
    const queue = fakeQueue()
    const scheduled = await serve(testBoard({ url: undefined, scheduler: queue.scheduler }).fetch)
    const board = `${scheduled.origin}/api/board`
    const as = { VBOARD_URL: board, VBOARD_TOKEN: await personToken('u_julian', board) }
    try {
      const root = (await vb(['post', 'dev', 'PR #12 is open'], as)).stdout.trim()
      const once = await vb(['schedule', root, 'friendly ping: review?', '--in', '1s'], as)
      expect(once).toMatchObject({ code: 0, stderr: '' })
      expect(once.stdout).toMatch(new RegExp(`^⏰ s\\d+  #${root} · once · next in 1s \\(.+\\) · by julian\\n    friendly ping: review\\?\\n$`))
      const repeat = await vb(['schedule', root, 'check prod', '--every', '30m', '--for', '1d', '--json'], as)
      const { id } = JSON.parse(repeat.stdout)

      const before = (await vb(['read', root], as)).stdout
      expect(before).toContain('  ⏰ s1  #')
      expect(before).toContain(`  ⏰ s${id}  #${root} · every 30m · until `)
      expect((await vb(['schedules', root], as)).stdout.match(/^⏰/gm)).toHaveLength(2)

      await new Promise((resolve) => setTimeout(resolve, 1100))
      await queue.fire()
      await vi.waitFor(async () => expect((await vb(['read', root], as)).stdout).toMatch(/↳ #\d+  julian · \d+s ⏰ s1\n {4}friendly ping: review\?/))

      expect((await vb(['schedule', 'cancel', `s${id}`], as)).stdout).toBe(`canceled s${id}\n`)
      expect((await vb(['schedule', 'cancel', `s${id}`], as)).stdout).toBe(`s${id} is already canceled\n`)
      expect((await vb(['schedules', root], as)).stdout).toBe('no pending schedules\n')
      expect((await vb(['schedules', '--all'], as)).stdout).toMatch(/· done · 1 sent · by julian[\s\S]*· canceled · by julian/)

      expect(await vb(['schedule', root, 'when?'], as)).toMatchObject({ code: 2, stderr: 'error: say when: --in 1d, --at <time>, or --every 30m\n' })
      expect((await vb(['schedule', root, 'x', '--at', 'soonish'], as)).code).toBe(2)
    } finally {
      await scheduled.close()
    }
  }, 30_000)

  it('says so when the board has no scheduler', async () => {
    const root = (await vb(['post', 'dev', 'no queue here'])).stdout.trim()
    expect(await vb(['schedule', root, 'later', '--in', '1h'])).toMatchObject({
      code: 1,
      stderr: "error: this board has no scheduler, so it can't schedule messages\n",
    })
  })
})
