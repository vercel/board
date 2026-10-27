import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serve } from './http.ts'
import { personToken, testBoard, workflowToken } from './harness.ts'
import { githubActions } from '../src/access/index.ts'
import { CLI, env, server, tmp, url, useBoard, vb } from './cli-harness.ts'
import { fakeQueue } from './queue.ts'

useBoard()

const OLD_THREADS = "error: this board can't list threads: update board where the board is deployed\n"

describe('cli', () => {
  it('links a checkout from a subdirectory, ignores the link, and reads it from other subdirectories', async () => {
    const root = await tmp('board-link-')
    const directory = join(root, 'packages', 'app')
    const global = await tmp('board-global-')
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: /worktree')
    await writeFile(join(root, '.gitignore'), 'node_modules')
    await mkdir(join(global, 'board'))
    await writeFile(join(global, 'board', 'config.json'), JSON.stringify({ url: 'http://global.invalid/api/board' }))
    const local = { BOARD_URL: undefined, XDG_CONFIG_HOME: global }

    expect(await vb(['link', `${url}/`], local, undefined, directory)).toMatchObject({
      code: 0, stderr: '', stdout: `linked ${root} to ${url}\n`,
    })
    expect(JSON.parse(await readFile(join(root, '.board', 'config.json'), 'utf8'))).toEqual({ url })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.board/\n')
    expect(JSON.parse(await readFile(join(global, 'board', 'config.json'), 'utf8'))).toEqual({ url: 'http://global.invalid/api/board' })
    expect(await vb(['whoami', '--json'], local, undefined, directory)).toMatchObject({ code: 0, stderr: '' })

    expect((await vb(['link', url], local, undefined, root)).code).toBe(0)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.board/\n')
  }, 20_000)

  it("shows a message's control characters as pictures, so they never drive the terminal, and keeps them as they are in --json", async () => {
    // A retitle, a screen clear, and a carriage return that would write over the line.
    const text = 'look \u001b]0;pwned\u0007\u001b[2Jhere\r\nand\rthere \u009b31m'
    const { id } = JSON.parse((await vb(['post', 'terminal', '--json', '--', text])).stdout)
    for (const read of [await vb(['read', 'terminal']), await vb(['read', id])]) {
      expect(read.code).toBe(0)
      expect(read.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
      expect(read.stdout).toContain('look ␛]0;pwned␇␛[2Jhere')
    }
    expect((await vb(['read', id])).stdout).toContain('and␍there \ufffd31m')
    expect(JSON.parse((await vb(['read', id, '--json'])).stdout.trim().split('\n')[0]!).text).toBe(text)
  })

  it('links a directory without Git in place', async () => {
    const root = await tmp('board-link-')
    // Unlinked, with no saved board: it says how to get one.
    const unlinked = { BOARD_URL: undefined, XDG_CONFIG_HOME: await tmp('board-global-') }
    expect(await vb(['whoami'], unlinked, undefined, root)).toEqual({
      code: 1, stdout: '', stderr: 'error: no board URL: run `board link <url>`, set BOARD_URL, run `board use <url>`, or `board serve` for a local one\n',
    })
    expect((await vb(['link', url], {}, undefined, root)).code).toBe(0)
    expect(JSON.parse(await readFile(join(root, '.board', 'config.json'), 'utf8'))).toEqual({ url })
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('.board/\n')
  })

  it('treats only a real .git as a checkout root: a HEAD inside, or a gitdir: file', async () => {
    const parent = await tmp('board-link-')
    const child = join(parent, 'child')
    await mkdir(join(parent, '.git'))
    await mkdir(child)
    expect(await vb(['link', url], {}, undefined, child)).toMatchObject({ code: 0, stdout: `linked ${child} to ${url}\n` })
    await writeFile(join(parent, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const other = join(parent, 'other')
    await mkdir(other)
    expect(await vb(['link', url], {}, undefined, other)).toMatchObject({ code: 0, stdout: `linked ${parent} to ${url}\n` })
    const worktree = await tmp('board-link-')
    await writeFile(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/x\n')
    await mkdir(join(worktree, 'src'))
    expect(await vb(['link', url], {}, undefined, join(worktree, 'src'))).toMatchObject({ code: 0, stdout: `linked ${worktree} to ${url}\n` })
    const stray = await tmp('board-link-')
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
      const signedOut = { PATH: '', XDG_DATA_HOME: await tmp('board-data-') }
      try {
        expect(await vb(['whoami'], { ...signedOut, BOARD_URL: at, BOARD_TOKEN: await personToken('u_julian', at) }), kind).toEqual({ code: 1, stdout: '', stderr: line })
        // Discovery, without a token yet.
        const root = await tmp('board-link-')
        expect(await vb(['link', at], signedOut, undefined, root), kind).toEqual({ code: 1, stdout: '', stderr: line })
        expect(await vb(['whoami'], { BOARD_URL: at, BOARD_TOKEN: await personToken('u_julian', at), VERCEL_AUTOMATION_BYPASS_SECRET: 'stale' }), kind).toEqual({
          code: 1,
          stdout: '',
          stderr: `error: ${at} is behind Vercel Deployment Protection and rejected VERCEL_AUTOMATION_BYPASS_SECRET; check it against Project → Settings → Deployment Protection → Protection Bypass for Automation\n`,
        })
        seen.length = 0
        const ok = await vb(['whoami', '--json'], { BOARD_URL: at, BOARD_TOKEN: await personToken('u_julian', at), VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
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
    const bin = await tmp('board-bin-')
    const log = join(bin, 'calls')
    await writeFile(join(bin, 'vercel'), `#!/bin/sh\necho "$*" >> ${log}\nexec ${execFileSync('sh', ['-c', 'command -v sleep']).toString().trim()} 60\n`, { mode: 0o755 })
    try {
      const at = `${wall.origin}/api/board`
      const started = Date.now()
      const result = await vb(['whoami'], { PATH: bin, XDG_DATA_HOME: await tmp('board-data-'), BOARD_URL: at })
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
      const root = await tmp('board-link-')
      expect(await vb(['link', `${missing.origin}/api/board`], {}, undefined, root)).toEqual({
        code: 1, stdout: '', stderr: `error: no board at ${missing.origin}/api/board (404)\n`,
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
      const me = await vb(['whoami', '--json'], { BOARD_URL: at, BOARD_TOKEN: token, VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' })
      expect(seen.moved).toEqual([`Bearer ${token}`, `Bearer ${token}`])
      expect(seen.board).toEqual([null, null])
      expect(me.code).toBe(1)
    } finally {
      await Promise.all([moved.close(), target.close()])
    }
  }, 20_000)

  it('lets explicit and environment URLs override the project link', async () => {
    const root = await tmp('board-link-')
    await mkdir(join(root, '.board'))
    await writeFile(join(root, '.board', 'config.json'), JSON.stringify({ url: 'http://project.invalid/api/board' }))
    const fromEnv = await vb(['whoami', '--json'], {}, undefined, root)
    expect(fromEnv.code).toBe(0)
    expect(JSON.parse(fromEnv.stdout).board).toBe(url)
    const explicit = await vb(['whoami', '--url', url, '--json'], { BOARD_URL: 'http://env.invalid/api/board' }, undefined, root)
    expect(explicit.code).toBe(0)
    expect(JSON.parse(explicit.stdout).board).toBe(url)
  }, 20_000)

  it('stops at a nested Git checkout and falls back to the global board', async () => {
    const root = await tmp('board-link-')
    const nested = join(root, 'other-project')
    const global = await tmp('board-global-')
    await mkdir(join(root, '.board'))
    await writeFile(join(root, '.board', 'config.json'), JSON.stringify({ url: 'http://parent.invalid/api/board' }))
    await mkdir(join(nested, '.git'), { recursive: true })
    await writeFile(join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const local = { BOARD_URL: undefined, XDG_CONFIG_HOME: global }
    expect((await vb(['use', url], local, undefined, nested)).code).toBe(0)
    const me = await vb(['whoami', '--json'], local, undefined, nested)
    expect(me.code).toBe(0)
    expect(JSON.parse(me.stdout).board).toBe(url)
  }, 20_000)

  it('reports a malformed project link instead of using the global board', async () => {
    const root = await tmp('board-link-')
    const global = await tmp('board-global-')
    await mkdir(join(root, '.board'))
    const local = { BOARD_URL: undefined, XDG_CONFIG_HOME: global }
    expect((await vb(['use', url], local, undefined, root)).code).toBe(0)
    for (const contents of ['{', '{"url":12}', '{"url":"ftp://board.test"}']) {
      await writeFile(join(root, '.board', 'config.json'), contents)
      expect(await vb(['whoami'], local, undefined, root)).toMatchObject({
        code: 1,
        stderr: `error: invalid board link at ${join(root, '.board', 'config.json')}: expected an http(s) url\n`,
      })
    }
    expect((await vb(['whoami', '--url', url], local, undefined, root)).code).toBe(0)
  }, 20_000)

  it('keeps the link when discovery fails and rejects missing or extra arguments', async () => {
    const root = await tmp('board-link-')
    expect((await vb(['link', url], {}, undefined, root)).code).toBe(0)
    const path = join(root, '.board', 'config.json')
    const before = await readFile(path, 'utf8')
    const unavailable = await serve(async () => new Response('unavailable', { status: 503 }))
    try {
      expect((await vb(['link', unavailable.origin], {}, undefined, root)).code).toBe(1)
    } finally {
      await unavailable.close()
    }
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await vb(['link'], {}, undefined, root)).toMatchObject({ code: 2, stderr: 'error: usage: board link <url>\n' })
    expect(await vb(['link', url, 'dev'], {}, undefined, root)).toMatchObject({ code: 2, stderr: 'error: usage: board link <url>\n' })
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

    const read = await vb(['read', id])
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

  it('posts a mention of a handle no one has as plain text, and warns', async () => {
    const posted = await vb(['post', 'unknown-mentions', 'ping @tk about it'])
    expect(posted).toMatchObject({ code: 0, stderr: 'warning: @tk matches no one on the board, so it stays plain text and notifies no one\n' })
    const id = posted.stdout.trim()
    const reply = await vb(['reply', id, '@tk and @tk2, see `@code`'])
    expect(reply).toMatchObject({ code: 0, stderr: 'warning: @tk and @tk2 match no one on the board, so they stay plain text and notify no one\n' })
    expect(await vb(['edit', id, 'ping @tk3'])).toMatchObject({ code: 0, stderr: expect.stringContaining('@tk3 matches no one') })
    const lines = (await vb(['read', id, '--json'])).stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((m: { text: string; mentions: string[] }) => [m.text, m.mentions])).toEqual([
      ['ping @tk3', []],
      ['@tk and @tk2, see `@code`', []],
    ])
    expect(await vb(['post', 'unknown-mentions', 'no mentions here'])).toMatchObject({ code: 0, stderr: '' })
  })

  it('posts to a message ID as a reply in its thread, labels and all', async () => {
    const id = (await vb(['post', 'post-replies', 'export is broken'])).stdout.trim()
    const reply = await vb(['post', id, 'fixed in a1b2c3', '--label', 'step=fix', '--json'])
    expect(reply.code).toBe(0)
    expect(JSON.parse(reply.stdout)).toMatchObject({ re: id, channel: 'post-replies', text: 'fixed in a1b2c3', labels: { step: 'fix' } })
    expect((await vb(['post', `#${id}`, 'and deployed'])).code).toBe(0)
    const lines = (await vb(['read', id, '--json'])).stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((m: { text: string }) => m.text)).toEqual(['export is broken', 'fixed in a1b2c3', 'and deployed'])
    expect(await vb(['post', id, 'x', '--sync', 'slack:#incidents'])).toMatchObject({ code: 2, stderr: 'error: --sync attaches whole threads: post to a channel, or use vb sync <id> <target>\n' })
  })

  it('reads a channel as thread summaries, counting threads, and says so when the channel does not exist', async () => {
    const first = (await vb(['post', 'open-work', 'flaky test in ci\nsecond line', '--label', 'state=open'])).stdout.trim()
    const second = (await vb(['post', 'open-work', 'docs typo'])).stdout.trim()
    for (const n of [1, 2, 3]) expect((await vb(['reply', second, `note ${n}`, '--as', 'claude'])).code).toBe(0)
    expect((await vb(['reply', first, 'still flaky'])).code).toBe(0)

    const read = await vb(['read', 'open-work', '--limit', '1'])
    expect(read).toMatchObject({ code: 0, stderr: '' })
    expect(read.stdout).toMatch(new RegExp(`^open-work · 1 thread · cursor \\d+\n\n#${first}  julian · \\d+s  \\[state=open\\]\n      flaky test in ci …\n      1 reply · last #\\d+ julian · \\d+s\n$`))

    const all = await vb(['read', 'open-work'])
    expect(all.stdout).toContain(`#${second}  julian`)
    expect(all.stdout).toMatch(/3 replies · last #\d+ claude via julian · \d+s/)
    expect(all.stdout.indexOf(`#${second}`)).toBeLessThan(all.stdout.indexOf(`#${first}`))

    const json = await vb(['read', 'open-work', '--json'])
    const lines = json.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((t: { message: { id: string }; replies: number; last: { text: string } }) => [t.message.id, t.replies, t.last.text])).toEqual([
      [second, 3, 'note 3'],
      [first, 1, 'still flaky'],
    ])

    const open = await vb(['read', 'open-work', '--label', 'state=open', '--json'])
    expect(open.stdout.trim().split('\n').map((line) => JSON.parse(line).message.id)).toEqual([first])
    // Across channels, each summary names its channel; with no filter, that's every thread.
    expect((await vb(['read', '--label', 'state=open'])).stdout).toContain(`#${first}  open-work  julian`)
    expect((await vb(['read'])).stdout).toMatch(/^all channels · \d+ threads · cursor \d+\n/)
    // One of a thing is one, not ones.
    const lone = (await vb(['post', 'lone-work', 'just me'])).stdout.trim()
    expect((await vb(['channels'])).stdout).toContain(`\nlone-work  1 thread · 1 message · last #${lone}\n`)

    // Filters on a thread keep its root and the replies that match.
    const narrowed = await vb(['read', second, '--by', '@julian/claude', '--text', 'note 2', '--json'])
    expect(narrowed.stdout.trim().split('\n').map((line) => JSON.parse(line).text)).toEqual(['docs typo', 'note 2'])
    const byLabel = await vb(['read', first, '--label', 'state=open', '--by', '@julian/claude'])
    expect(byLabel.stdout).toContain('flaky test in ci')
    expect(byLabel.stdout).not.toContain('still flaky')

    // A reaction from someone who hasn't written in the thread shows their name, not their actor ID.
    expect((await vb(['react', first, 'eyes', '--as', 'codex'])).code).toBe(0)
    expect((await vb(['read', first])).stdout).toContain('👀 codex via julian')

    // A typo'd channel is an error, not an empty read; an empty read in a real channel isn't.
    expect(await vb(['read', 'open-wrok'])).toMatchObject({ code: 1, stdout: '', stderr: 'error: no channel open-wrok: board channels lists them\n' })
    expect(await vb(['read', 'open-work', '--text', 'nothing like this'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^open-work · 0 threads · cursor \d+\n$/) })
    expect(await vb(['read', 'open-work', '--messages'])).toMatchObject({ code: 2 })
  }, 20_000)

  it('filters by mentions of me, or of a handle', async () => {
    await vb(['post', 'pings', 'hello'])
    await vb(['post', 'pings', 'hey @julian, look', '--as', 'claude'])
    const texts = async (args: string[]) => {
      const { stdout } = await vb(['read', 'pings', ...args, '--json'])
      return stdout.trim().split('\n').map((line) => (JSON.parse(line) as { message: { text: string } }).message.text)
    }
    expect(await texts(['--mentions'])).toEqual(['hey @julian, look'])
    expect(await texts(['--mentions', '@julian'])).toEqual(['hey @julian, look'])
  })

  it('filters by author, with or without the @', async () => {
    await vb(['post', 'authors', 'from julian'])
    await vb(['post', 'authors', 'from claude', '--as', 'claude'])
    const texts = async (args: string[]) => {
      const { stdout } = await vb(['read', 'authors', ...args, '--json'])
      return stdout.trim().split('\n').map((line) => (JSON.parse(line) as { message: { text: string } }).message.text)
    }
    // A person is everyone they are, their agents included (#113).
    expect(await texts(['--by', 'julian'])).toEqual(['from julian', 'from claude'])
    expect(await texts(['--by', '@julian'])).toEqual(['from julian', 'from claude'])
    expect(await texts(['--by', '@julian/claude'])).toEqual(['from claude'])
  })

  it('reports who you are', async () => {
    const { stdout, code } = await vb(['whoami', '--as', 'codex'])
    expect(code).toBe(0)
    expect(stdout).toContain('codex via julian (vercel:user:u_julian+codex)')
    expect(stdout).toContain(`board   ${url}\nsource  BOARD_TOKEN\ntoken   expires in `)
    // Full access goes without saying.
    expect(stdout).not.toContain('can ')
  })

  it('says what a token can do when it is less than everything', async () => {
    const board = await serve(
      testBoard({ access: [githubActions({ repository: 'basehub-ai/www', can: { 'ci/': ['read', 'post'], feedback: ['post'], 'ci/secret': [] } })] }).fetch,
    )
    try {
      const { stdout, code } = await vb(['whoami'], { BOARD_URL: `${board.origin}/api/board`, BOARD_TOKEN: await workflowToken() })
      expect(code).toBe(0)
      expect(stdout).toContain('basehub-ai/www (github:repo:123456)\n')
      expect(stdout).toContain('source  BOARD_TOKEN\n')
      expect(stdout).toMatch(/\ncan     ci\/        read post\n        ci\/secret  nothing\n        feedback   post\n$/)
      // --json carries the same facts.
      const json = await vb(['whoami', '--json'], { BOARD_URL: `${board.origin}/api/board`, BOARD_TOKEN: await workflowToken() })
      expect(JSON.parse(json.stdout)).toMatchObject({ source: 'BOARD_TOKEN', can: { 'ci/': ['read', 'post'], 'ci/secret': [], feedback: ['post'] } })
    } finally {
      await board.close()
    }
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
    const dir = await tmp('board-files-')
    const shot = join(dir, 'after.png')
    await writeFile(shot, Buffer.from([137, 80, 78, 71]))
    const posted = await vb(['post', 'proofs', '--attach', shot])
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    const id = posted.stdout.trim()
    const reply = await vb(['reply', id, 'and the log', '--attach', shot, '--json'])
    const [attachment] = JSON.parse(reply.stdout).attachments
    expect(attachment).toMatchObject({ name: 'after.png', type: 'image/png', size: 4 })

    const read = await vb(['read', id])
    expect(read.stdout).toContain(`file after.png · image/png · 4 B · ${attachment.id}`)

    const saved = join(dir, 'copy.png')
    expect(await vb(['download', attachment.id, saved])).toMatchObject({ code: 0, stdout: `${saved}\n` })
    expect(await readFile(saved)).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(await vb(['post', 'proofs', 'x', '--attach', join(dir, 'missing.png')])).toMatchObject({ code: 2, stderr: `error: no such file: ${join(dir, 'missing.png')}\n` })
  }, 20_000) // five CLI runs: a cold start right after install can pass the default 5s

  it('downloads an attachment whose id starts with "-", which reads like a flag', async () => {
    // Boards minted one in 64 of these before they stopped: they're still out there.
    const id = '-Pj4-Pj4-Pj4-Pj4-Pj4-A'
    const files = await serve(async (request) =>
      new URL(request.url).pathname === `/api/board/attachments/${id}`
        ? new Response('the log', {
            headers: { 'content-type': 'text/plain', 'content-disposition': `inline; filename*=UTF-8''run.log` },
          })
        : Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 }),
    )
    try {
      const dir = await tmp('board-dash-')
      const board = `${files.origin}/api/board`
      const saved = join(dir, 'copy.log')
      expect(await vb(['download', id, saved, '--url', board])).toEqual({ code: 0, stdout: `${saved}\n`, stderr: '' })
      expect(await readFile(saved, 'utf8')).toBe('the log')
      expect(await vb(['--url', board, 'download', id], {}, undefined, dir)).toEqual({ code: 0, stdout: 'run.log\n', stderr: '' })
      expect(await vb(['download', '--url', board, '--', id, '-'])).toEqual({ code: 0, stdout: 'the log', stderr: '' })
      // Only `download`'s id reads that way: a flag nothing knows is still misuse.
      expect(await vb(['download', '--nope', saved, '--url', board])).toMatchObject({ code: 2 })
      expect(await vb(['read', id, '--url', board])).toMatchObject({ code: 2 })
    } finally {
      await files.close()
    }
  }, 20_000)


  it('delivers all of a long read to a reader that falls behind', async () => {
    const root = (await vb(['post', 'long-reads', 'a long thread', '--no-sync', '--json'])).stdout
    const id = (JSON.parse(root) as { id: number }).id
    expect((await vb(['reply', String(id), `note ${'x'.repeat(300)}`, '--no-sync'])).code).toBe(0)
    // The thread, as the board would send it with 1,500 replies: well past a pipe's buffer on any OS
    // (Linux's is bigger than macOS's), so a dropped tail shows. Posting that many takes the board half a minute.
    const long = await serve(async (request) => {
      const { pathname, search } = new URL(request.url)
      const response = await fetch(`${server.origin}${pathname}${search}`, { headers: request.headers })
      if (pathname !== `/api/board/messages/${id}`) return response
      const thread = (await response.json()) as { replies: { id: number }[] }
      const [reply] = thread.replies
      thread.replies = Array.from({ length: 1500 }, (_, i) => ({ ...reply!, id: reply!.id + i }))
      return Response.json(thread)
    })
    try {
      // A reader that waits before reading: what's still queued on the pipe when the command returns must arrive.
      const child = spawn(process.execPath, [CLI, 'read', String(id), '--json'], {
        env: { ...env, BOARD_URL: `${long.origin}/api/board` },
      })
      child.stdin.end()
      child.stdout.pause()
      setTimeout(() => child.stdout.resume(), 300)
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      const code = await new Promise((resolve) => child.on('close', resolve))
      expect(code).toBe(0)
      expect(stdout.trim().split('\n')).toHaveLength(1501)
    } finally {
      await long.close()
    }
  })

  it('lists sources, and reads one only as `sources <key> read <target>`', async () => {
    expect((await vb(['sources'])).stdout.trim()).toBe('no sources: this board has no sync configured')
    const misuse = await vb(['sources', 'slack', '#general'])
    expect(misuse.code).toBe(2)
    expect(misuse.stderr).toContain('usage: board sources <key> read')
    // Only the board that runs a sync entry reads its source.
    const unsynced = await vb(['sources', 'slack', 'read', '#general'])
    expect(unsynced).toMatchObject({ code: 1, stderr: "error: this board doesn't run sync entry slack: read it where its sync runs\n" })
    const unjoined = await vb(['sources', 'slack', 'join', '#general'])
    expect(unjoined).toMatchObject({ code: 1, stderr: "error: this board doesn't run sync entry slack: join it where its sync runs\n" })
  })

  it('says so when the board is older than thread summaries, instead of crashing on its discovery document', async () => {
    // An old board answers any unknown GET with its discovery document, 200.
    const old = await serve(async () => Response.json({ version: '0.4.0', sync: [] }))
    try {
      const threads = await vb(['read', 'errors-www'], { BOARD_URL: `${old.origin}/api/board` })
      expect(threads).toMatchObject({ code: 1, stderr: OLD_THREADS })
    } finally {
      await old.close()
    }
  })

  it('says so when the board is older than reading links, instead of crashing on its discovery document', async () => {
    const old = await serve(async () => Response.json({ version: '0.16.0', sync: [] }))
    try {
      const read = await vb(['read', 'https://acme.slack.com/archives/C1/p1727000000123456'], { BOARD_URL: `${old.origin}/api/board` })
      expect(read).toMatchObject({ code: 1, stderr: "error: this board can't read links: update board where the board is deployed\n" })
    } finally {
      await old.close()
    }
  })

  it('says so when a board with a basePath is older than thread summaries, instead of its 404', async () => {
    // Under a basePath, an old board answers an unknown route with a 404 instead.
    const old = await serve(async (request) =>
      Response.json({ error: { code: 'not_found', message: `no route: GET ${new URL(request.url).pathname}` } }, { status: 404 }),
    )
    try {
      expect(await vb(['read', 'errors-www'], { BOARD_URL: `${old.origin}/api/board` })).toMatchObject({ code: 1, stderr: OLD_THREADS })
    } finally {
      await old.close()
    }
  })

  it('checks that the board speaks the protocol, a group at a time', async () => {
    // The whole protocol, schedules included, so a board with a scheduler.
    const scheduled = await serve(testBoard({ url: undefined, scheduler: fakeQueue().scheduler }).fetch)
    const board = `${scheduled.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    try {
      const run = await vb(['conformance'], as)
      expect(run).toMatchObject({ code: 0, stderr: '' })
      expect(run.stdout).toMatch(/^core\n  passed   says in its discovery where it is\n  passed   posts a message, and reads it back by its ID\n/)
      expect(run.stdout).toContain('\n\nschedules\n  passed   schedules a reply')
      expect(run.stdout).toContain('\n\nwatchers\n  passed   matches a registered tail')
      expect(run.stdout).toMatch(/\n\n\d+ passed\n$/)
      expect(JSON.parse((await vb(['conformance', '--json', '--channel', 'conformance/json'], as)).stdout)).toMatchObject({ ok: true })
    } finally {
      await scheduled.close()
    }
    // Without one, the board keeps no schedules, and says so: the kit reports them as not kept here.
    const partial = await vb(['conformance'])
    expect(partial.code).toBe(0)
    expect(partial.stdout).toContain(
      '\n\nschedules\n  skipped  schedules a reply, lists it, and cancels it\n           not kept here: this board has no scheduler: pass `scheduler` to `a2()` to send later\n',
    )
    expect(partial.stdout).toMatch(/\n\n\d+ passed, 1 skipped\n$/)
    expect(await vb(['conformance', 'extra'])).toMatchObject({ code: 2, stderr: 'error: usage: board conformance [--channel <c>]\n' })
  })

  it('prints one error line and exits 1 on failure, 2 on misuse', async () => {
    expect(await vb(['read', '99999'])).toMatchObject({ code: 1, stderr: 'error: message not found: #99999\n' })
    // An ID this board never hands out names what was asked for, not what it was read as.
    expect(await vb(['read', '#nope'])).toMatchObject({ code: 1, stderr: 'error: message not found: #nope\n' })
    expect(await vb(['schedule', 'cancel', 'snope'])).toMatchObject({ code: 1, stderr: 'error: schedule not found: snope\n' })
    expect((await vb(['react', '1', 'not an emoji'])).code).toBe(2)
    expect((await vb(['typing'])).code).toBe(2)
    expect((await vb(['frobnicate'])).code).toBe(2)
    expect((await vb(['inspect', '--port', 'nope'])).code).toBe(2)
  })

  it('says a removed command is gone whatever flags it carries, and names an unknown option', async () => {
    // board 0.8's turn-end hook told agents to run `vb update --skip` or `vb update "<summary>"`.
    const gone = "error: `vb update` is gone: reply in the thread you're working in (vb reply <id>), or post where it fits (vb post <channel>)\n"
    expect(await vb(['update', '--skip'])).toMatchObject({ code: 2, stdout: '', stderr: gone })
    expect(await vb(['update', 'Fixed the flaky test'])).toMatchObject({ code: 2, stdout: '', stderr: gone })
    expect(await vb(['read', 'dev', '--frob'])).toMatchObject({ code: 2, stdout: '', stderr: 'error: unknown option: --frob (run `board help`; text starting with - goes after --, as in -- "--frob")\n' })
    expect(await vb(['post', 'dev', '-1'])).toMatchObject({ code: 2, stdout: '', stderr: 'error: unknown option: -1 (run `board help`; text starting with - goes after --, as in -- "-1")\n' })
    // `update` here is a channel, not the removed command.
    expect((await vb(['--mentions', 'read', 'update'])).stderr).not.toContain('is gone')
  })

  it('says `vb stuck` is gone, and where its dead letters are', async () => {
    expect(await vb(['stuck', 'retry', 'board#1'])).toMatchObject({
      code: 2,
      stderr: "error: `vb stuck` is gone: a board on a2() keeps its dead letters in A2, on the backend's `servers`\n",
    })
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
