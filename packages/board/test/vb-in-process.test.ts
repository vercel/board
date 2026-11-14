import { describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vb } from '../src/cli/embedded.ts'
import { caller, personToken, testBoard, BOARD_URL } from './harness.ts'

// vb() on a handle over HTTP to an in-process board: the CLI's commands, output, and exit codes,
// with files from its options. The CLI itself runs through the same code (cli*.test.ts).
// With `stall.on`, its board never answers, whatever the request's signal says, and `stall.seen` keeps those requests.
// With `stall.bodies`, a file's download answers, and its bytes never come; with `stall.breaks`, its connection drops after one byte.
type Stall = { on: boolean; seen: Request[]; bodies?: boolean; breaks?: boolean }
async function handle(stall: Stall = { on: false, seen: [] }) {
  const served = testBoard()
  const token = await personToken('u_ada', BOARD_URL)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    request.headers.set('authorization', `Bearer ${token}`)
    if (stall.on) return stall.seen.push(request), new Promise<never>(() => {})
    const response = await served.fetch(request)
    const download = request.method === 'GET' && new URL(request.url).pathname.includes('/attachments/')
    if (download && stall.bodies) return new Response(new ReadableStream({ start() {} }), { status: response.status, headers: response.headers })
    if (download && stall.breaks)
      return new Response(new ReadableStream({ start: (body) => (body.enqueue(new Uint8Array([1])), body.error(new Error('connection reset'))) }), { status: response.status, headers: response.headers })
    return response
  }) as typeof globalThis.fetch
  return board({ backend: http(BOARD_URL, { fetch }) }).as(null)
}

describe('vb()', () => {
  it('posts, replies, and reads a thread as the CLI prints it', async () => {
    const team = await handle()
    const posted = await vb(team, ['post', 'dev', 'the build is red', '--no-sync'])
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    const id = posted.stdout.trim()
    expect(id).toMatch(/^\d+$/)
    expect((await vb(team, ['reply', id, 'on it', '--no-sync'])).code).toBe(0)
    expect((await vb(team, ['label', id, 'kind=bug'])).code).toBe(0)
    const read = await vb(team, ['read', `#${id}`])
    expect(read.code).toBe(0)
    expect(read.stdout).toMatch(new RegExp(`^#${id} .*\\[kind=bug\\]\\n\\s+the build is red\\n\\s+↳ #\\d+ .*\\n\\s+on it\\n$`))
    const thread = JSON.parse((await vb(team, ['read', id, '--json'])).stdout)
    expect([thread.message, ...thread.replies].map((m: { text: string }) => m.text)).toEqual(['the build is red', 'on it'])
    expect((await vb(team, ['read', 'dev', '--text', 'build'])).stdout).toMatch(/^dev · 1 thread · cursor/)
  })

  it("takes the Vercel CLI's short letters and aliases, and refuses an alias as the command it is", async () => {
    const team = await handle()
    for (const text of ['one', 'two']) await vb(team, ['post', 'dev', text, '--no-sync'])
    expect(JSON.parse((await vb(team, ['read', 'dev', '-n', '1', '--json'])).stdout).threads).toHaveLength(1)
    const first = (await vb(team, ['post', 'dev', 'gone soon', '--no-sync'])).stdout.trim()
    // A caller that doesn't delete doesn't by another name either.
    expect(await vb(team, ['rm', first], { refuse: ['delete'] })).toEqual({ code: 2, stdout: '', stderr: "error: delete isn't available here.\n" })
    // However its flags are grouped: -a and -n with its value, before the command.
    expect(await vb(team, ['-an', '1', 'delete', first], { refuse: ['delete'] })).toEqual({ code: 2, stdout: '', stderr: "error: delete isn't available here.\n" })
    expect(JSON.parse((await vb(team, ['read', first, '--json'])).stdout).message.deleted).toBe(false)
    expect((await vb(team, ['rm', first])).code).toBe(0)
    expect(JSON.parse((await vb(team, ['read', first, '--json'])).stdout).message.deleted).toBe(true)
    const second = (await vb(team, ['post', 'dev', 'gone too', '--no-sync'])).stdout.trim()
    expect((await vb(team, ['del', second])).code).toBe(0)
    expect(JSON.parse((await vb(team, ['read', second, '--json'])).stdout).message.deleted).toBe(true)
  })

  it('says what the CLI says when something is wrong, with its exit codes', async () => {
    const team = await handle()
    expect(await vb(team, ['read', 'dve'])).toMatchObject({ code: 1, stdout: '', stderr: expect.stringMatching(/^error: Couldn't find channel dve\.\n/) })
    expect(await vb(team, ['label', '1', 'nope'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Labels look like key=value, and nope isn't one\.\n/) })
    expect(await vb(team, ['frobnicate'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Unknown command frobnicate for vb\.\n/) })
    expect((await vb(team, ['read', '--bogus'])).stderr).toMatch(/^error: Unknown option --bogus for vb read\./)
    // With --json, the same failure as a document, for the program that called it.
    const typo = await vb(team, ['read', 'dve', '--json'])
    expect(typo).toMatchObject({ code: 1, stdout: '' })
    expect(JSON.parse(typo.stderr)).toMatchObject({ status: 'error', reason: 'channel_not_found', next: [{ argv: ['vb', 'channels'] }] })
    expect((await vb(team, ['help'])).stdout).toMatch(/^board \S+: a message board/)
    // --help is help, never the command it's on: that command's page.
    const id = (await vb(team, ['post', 'dev', 'keep me', '--no-sync'])).stdout.trim()
    for (const flag of ['--help', '-h']) expect((await vb(team, ['delete', id, flag])).stdout).toMatch(/^usage: board delete <id>( \[options\])?\n/)
    expect(JSON.parse((await vb(team, ['read', id, '--json'])).stdout).message.deleted).toBe(false)
  })

  it("refuses what's the CLI's: another board or handle, and the commands about its machine", async () => {
    const team = await handle()
    expect(await vb(team, ['read', '--url', 'https://elsewhere.test/api/board'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/--url doesn't apply/) })
    // tail and wait hold every later call: only with a signal to stop them.
    for (const args of [['tail', 'dev'], ['wait', 'dev'], ['--as', 'triage', 'tail', 'dev'], ['--timeout', '1m', 'wait']])
      expect(await vb(team, args)).toMatchObject({ code: 2, stderr: expect.stringMatching(/pass a signal/) })
    for (const args of [['--as', 'x', 'tail', 'dev'], ['--mentions', 'tail', 'dev'], ['--mentions', '@ada', 'tail', 'dev']])
      expect(await vb(team, args, { signal: new AbortController().signal, refuse: ['tail'] })).toEqual({ code: 2, stdout: '', stderr: "error: tail isn't available here.\n" })
    expect((await vb(team, ['read', 'dev', '--text', 'tail'], { refuse: ['tail'] })).stderr).not.toMatch(/isn't available here/)
    // Its caller's signal is how a call there ends: 0, and nothing more, for tail and wait alike.
    for (const command of ['tail', 'wait']) {
      const controller = new AbortController()
      const stopped = vb(team, [command, 'dev'], { signal: controller.signal })
      controller.abort()
      expect(await stopped).toEqual({ code: 0, stdout: '', stderr: '' })
    }
    expect(await vb(team, ['channels'])).toMatchObject({ code: 0, stdout: 'no channels yet\n' })
    for (const command of ['whoami', 'serve', 'hooks', 'inspect'])
      expect(await vb(team, [command])).toMatchObject({ code: 2, stderr: expect.stringMatching(new RegExp(`${command} isn't available in-process`)) })
  })

  it("ends any command's requests with its signal, and runs the next call", async () => {
    const stall: Stall = { on: false, seen: [] }
    const team = await handle(stall)
    const id = (await vb(team, ['post', 'dev', 'before the outage', '--no-sync'])).stdout.trim()
    stall.on = true
    // A deadline bounds a read the board never answers: 1, and the call after it runs.
    const read = vb(team, ['read', id, '--json'], { signal: AbortSignal.timeout(50) })
    const next = vb(team, ['read', id, '--json'])
    const timedOut = await read
    expect(timedOut).toMatchObject({ code: 1, stdout: '' })
    expect(JSON.parse(timedOut.stderr)).toMatchObject({ reason: 'timeout' })
    expect(stall.seen.length).toBeGreaterThan(0)
    expect(stall.seen.every((request) => request.signal.aborted)).toBe(true)
    stall.on = false
    expect(JSON.parse((await next).stdout).message.text).toBe('before the outage')
    // Stopped any other way, it's canceled (130), and a write says it may have landed.
    stall.on = true
    const controller = new AbortController()
    const reply = vb(team, ['reply', id, 'on it', '--no-sync', '--json'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const stopped = await reply
    expect(stopped.code).toBe(130)
    expect(JSON.parse(stopped.stderr)).toMatchObject({ reason: 'canceled', hint: expect.stringMatching(/may have happened/) })
    stall.on = false
    // A download whose bytes stall ends too.
    const files = { readFile: async () => new Uint8Array([1, 2, 3]), writeFile: async () => {} }
    const shot = (await vb(team, ['post', 'dev', 'proof', '--attach', '/work/shot.png', '--no-sync'], files)).stdout.trim()
    const attachment = JSON.parse((await vb(team, ['read', shot, '--json'])).stdout).message.attachments[0].id
    stall.bodies = true
    expect(await vb(team, ['download', attachment, '/work/copy.png'], { ...files, signal: AbortSignal.timeout(50) })).toMatchObject({ code: 1 })
    stall.bodies = false
    // One whose connection drops fails, as it does without a signal: never a short file that looks whole.
    stall.breaks = true
    expect((await vb(team, ['download', attachment, '/work/copy.png'], { ...files, signal: AbortSignal.timeout(5000) })).code).toBe(1)
    stall.breaks = false
    // A signal that never fires changes nothing.
    expect(await vb(team, ['read', 'dev', '--text', 'outage'], { signal: new AbortController().signal })).toMatchObject({ code: 0, stdout: expect.stringMatching(/^dev · 1 thread/) })
  })

  it('sends nothing for a call whose signal fired while it waited its turn, on a backend that ignores signals', async () => {
    const kept = testBoard()
    const id = (await vb(kept, ['post', 'dev', 'the build is red', '--no-sync'])).stdout.trim()
    const late = await vb(kept, ['reply', id, 'too late', '--no-sync'], { signal: AbortSignal.abort() })
    expect(late.code).toBe(130)
    expect(JSON.parse((await vb(kept, ['read', id, '--json'])).stdout).replies).toEqual([])
    expect((await vb(kept, ['reply', id, 'on time', '--no-sync'])).code).toBe(0)
    expect(JSON.parse((await vb(kept, ['read', id, '--json'])).stdout).replies).toMatchObject([{ text: 'on time' }])
  })

  it.each([false, true])("posts each of a watcher's writes through vb(), with a signal or without (%s)", async (withSignal) => {
    const replies: string[][] = []
    const served = testBoard({
      watch: {
        triage: {
          tail: 'firehose',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted' || event.message!.re !== null) return
            const opts = withSignal ? { signal: AbortSignal.timeout(5000) } : {}
            await vb(own, ['reply', event.message!.id, 'first', '--no-sync'], opts)
            await vb(own, ['reply', event.message!.id, 'second', '--no-sync'], opts)
            replies.push((await own.thread(event.message!.id)).replies.map((reply) => reply.text))
          },
        },
      },
    })
    const ada = caller(served.fetch, await personToken('u_ada', BOARD_URL), {})
    await ada('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    await vi.waitFor(() => expect(replies).toEqual([['first', 'second']]))
  })

  it('attaches and downloads through its readFile and writeFile, and - reads its stdin', async () => {
    const team = await handle()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const saved = new Map<string, Uint8Array>()
    const files = {
      readFile: async (path: string) => (path === '/work/shot.png' ? png : null),
      writeFile: async (path: string, data: Uint8Array) => void saved.set(path, data),
    }
    expect(await vb(team, ['post', 'dev', 'x', '--attach', '/work/shot.png'])).toMatchObject({ code: 2, stderr: "error: --attach and --text-file can't read files here: pass readFile in vb()'s options.\n" })
    expect(await vb(team, ['post', 'dev', 'x', '--attach', '/work/missing.png'], files)).toMatchObject({ code: 2, stderr: "error: Can't attach /work/missing.png. There's no such file.\n" })
    const id = (await vb(team, ['post', 'dev', 'proof', '--attach', '/work/shot.png', '--no-sync'], files)).stdout.trim()
    const root = JSON.parse((await vb(team, ['read', id, '--json'])).stdout).message
    expect(root.attachments).toMatchObject([{ name: 'shot.png', size: png.byteLength }])
    expect(await vb(team, ['download', root.attachments[0].id, '/work/copy.png'], files)).toMatchObject({ code: 0, stdout: '/work/copy.png\n' })
    expect(saved.get('/work/copy.png')).toEqual(png)
    // Saved by the attachment's name, the host is told not to replace a file; given a path, it may.
    const writes: { path: string; exclusive: boolean }[] = []
    const host = {
      writeFile: async (path: string, _data: Uint8Array, options?: { exclusive?: boolean }) =>
        void writes.push({ path, exclusive: options?.exclusive === true }),
    }
    expect(await vb(team, ['download', root.attachments[0].id], host)).toMatchObject({ code: 0, stdout: 'shot.png\n' })
    expect(await vb(team, ['download', root.attachments[0].id, '/work/copy.png'], host)).toMatchObject({ code: 0 })
    expect(writes).toEqual([
      { path: 'shot.png', exclusive: true },
      { path: '/work/copy.png', exclusive: false },
    ])
    const piped = await vb(team, ['post', 'dev', '-', '--no-sync'], { stdin: 'from stdin\n' })
    expect(JSON.parse((await vb(team, ['read', piped.stdout.trim(), '--json'])).stdout).message.text).toBe('from stdin')
    // --text-file reads through readFile too: the sandbox's files, not this machine's.
    const notes = { readFile: async (path: string) => (path === '/work/note.md' ? new TextEncoder().encode('from the sandbox\n') : null) }
    const written = await vb(team, ['post', 'dev', '--text-file', '/work/note.md', '--no-sync'], notes)
    expect(JSON.parse((await vb(team, ['read', written.stdout.trim(), '--json'])).stdout).message.text).toBe('from the sandbox')
  })
})
