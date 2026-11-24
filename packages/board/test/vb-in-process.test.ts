import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vb, type Claims, type HeldClaim } from '../src/cli/embedded.ts'
import { caller, personToken, testBoard, BOARD_URL } from './harness.ts'

// vb() on a handle over HTTP to an in-process board: the CLI's commands, output, and exit codes,
// with files from its options. The CLI itself runs through the same code (cli*.test.ts).
// With `stall.on`, its board never answers, whatever the request's signal says, and `stall.seen` keeps those requests.
// With `stall.bodies`, a file's download answers, and its bytes never come; with `stall.breaks`, its connection drops after one byte.
type Stall = { on: boolean; seen: Request[]; bodies?: boolean; breaks?: boolean }
async function handle(stall: Stall = { on: false, seen: [] }, served = testBoard()) {
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

/** What a failed `--json` call said, on stderr. */
const failure = (ran: { stderr: string }) => JSON.parse(ran.stderr) as { reason: string }

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
    // Or an option one command reads its own way is put first: --claim takes a value until `tasks` is found
    // and none after, so read that way `delete` would be the command. What was found is what runs, or nothing does.
    const moved = await vb(team, ['--claim', 'delete', 'tasks', first], { refuse: ['delete'] })
    expect(moved).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^error: Put --claim after tasks\./) })
    const posted = await vb(team, ['--claim', 'post', 'tasks', 'made it through'], { refuse: ['post'] })
    expect(posted).toMatchObject({ code: 2, stdout: '' })
    expect(JSON.parse((await vb(team, ['read', 'dev', '--text', 'made it through', '--json'])).stdout).threads).toEqual([])
    expect((await vb(team, ['channels', '--json'])).stdout).not.toContain('"tasks"')
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
    expect((await vb(team, ['help'])).stdout).toMatch(/^board \S+: your Vercel team's message board/)
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
    expect(await vb(team, ['post', 'dev', 'x', '--attach', '/work/shot.png'])).toMatchObject({ code: 2, stderr: "error: --attach and --file can't read files here: pass readFile in vb()'s options.\n" })
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
    // A host that refuses as Node does, with EEXIST, gets the CLI's own answer.
    const full = { writeFile: async () => Promise.reject(Object.assign(new Error('taken'), { code: 'EEXIST' })) }
    const refused = await vb(team, ['download', root.attachments[0].id, '--json'], full)
    expect(refused.code).toBe(2)
    expect(JSON.parse(refused.stderr)).toMatchObject({ reason: 'file_exists' })
    const piped = await vb(team, ['post', 'dev', '-', '--no-sync'], { stdin: 'from stdin\n' })
    expect(JSON.parse((await vb(team, ['read', piped.stdout.trim(), '--json'])).stdout).message.text).toBe('from stdin')
    // --file reads through readFile too: the sandbox's files, not this machine's.
    const notes = { readFile: async (path: string) => (path === '/work/note.md' ? new TextEncoder().encode('from the sandbox\n') : null) }
    const written = await vb(team, ['post', 'dev', '--file', '/work/note.md', '--no-sync'], notes)
    expect(JSON.parse((await vb(team, ['read', written.stdout.trim(), '--json'])).stdout).message.text).toBe('from the sandbox')
  })

  it('makes a plan of tasks from a file its readFile hands it, or from its stdin', async () => {
    const team = await handle()
    const plan = JSON.stringify([{ key: 'fix', text: 'fix the export', labels: { step: 'fix' } }, { text: 'review the fix', needs: [{ key: 'fix' }] }])
    const files = { readFile: async (path: string) => (path === '/work/plan.json' ? new TextEncoder().encode(plan) : null) }
    const made = await vb(team, ['tasks', 'create', 'work', '--file', '/work/plan.json', '--idempotency-key', 'plan-1'], files)
    expect(made).toMatchObject({ code: 0, stderr: '' })
    const [fix, review] = made.stdout.split('\n').filter(Boolean).map((row) => /^#(\S+)/.exec(row)![1]!)
    expect(made.stdout.replace(/ +/g, ' ')).toBe(`#${fix} ready fix the export step=fix\n#${review} waiting review the fix needs #${fix}\n`)
    // The same key again is the same tasks, and a file that isn't there is said as any is.
    expect((await vb(team, ['tasks', 'create', 'work', '--file', '/work/plan.json', '--idempotency-key', 'plan-1'], files)).stdout).toBe(made.stdout)
    expect(await vb(team, ['tasks', 'create', 'work', '--file', '/work/missing.json'], files)).toMatchObject({ code: 2, stderr: "error: Can't read /work/missing.json. There's no such file.\n" })
    // From its stdin, as one document.
    const piped = await vb(team, ['tasks', 'create', 'piped', '--file', '-', '--json'], { stdin: plan })
    expect(piped).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(piped.stdout).tasks.map((root: { text: string; channel: string; task: { state: string } }) => [root.text, root.channel, root.task.state])).toEqual([['fix the export', 'piped', 'ready'], ['review the fix', 'piped', 'waiting']])
    expect(JSON.parse((await vb(team, ['tasks', '--state', 'all', '--json'])).stdout).tasks).toHaveLength(4)
  })

  it('works a task over several calls on one handle, which keeps its claim, and runs no command', async () => {
    const served = testBoard()
    const stall: Stall = { on: false, seen: [] }
    const team = await handle(stall, served)
    const id = (await vb(team, ['tasks', 'create', 'work', 'fix CVE-123 in acme/web', '--label', 'step=fix', '--no-sync'])).stdout.trim()
    expect(await vb(team, ['tasks', 'work'])).toEqual({ code: 0, stdout: `#${id}  ready      fix CVE-123 in acme/web         step=fix\n`, stderr: '' })
    const claimed = await vb(team, ['tasks', 'claim', '--ready', 'work', '--label', 'step=fix', '--json'])
    expect(claimed).toMatchObject({ code: 0, stderr: '' })
    // The claim, for the program that called: its token stays with the handle that claimed.
    const { claim, task } = JSON.parse(claimed.stdout) as { claim: Record<string, unknown>; task: { id: string } }
    expect(task.id).toBe(id)
    expect(Object.keys(claim).sort()).toEqual(['epoch', 'until'])
    // Another handle on the same board, the same person's even, holds none.
    const other = await handle(undefined, served)
    expect(await vb(other, ['tasks', 'complete', id, 'not mine'])).toEqual({ code: 1, stdout: '', stderr: `error: You hold no claim on task #${id} as yourself.\n\n  Claim it:\n    vb tasks claim ${id}\n` })
    expect(await vb(team, ['tasks', 'renew', id, '--json'])).toMatchObject({ code: 0, stderr: '' })
    expect(await vb(team, ['tasks', 'complete', id, 'fixed in a1b2c3'])).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
    expect(JSON.parse((await vb(team, ['read', id, '--json'])).stdout).message.task).toMatchObject({ state: 'completed', result: 'fixed in a1b2c3' })
    // Settled, the handle holds it no longer.
    expect((await vb(team, ['tasks', 'release', id])).stderr).toMatch(/^error: You hold no claim on task/)

    // A claim is its profile's on a handle too: taken with --as, it isn't the handle's own.
    const reviewed = (await vb(team, ['tasks', 'create', 'work', 'review the fix', '--no-sync'])).stdout.trim()
    expect(await vb(team, ['tasks', 'claim', reviewed, '--as', 'reviewer'])).toMatchObject({ code: 0, stderr: '' })
    expect((await vb(team, ['tasks', 'complete', reviewed])).stderr).toBe(`error: You hold no claim on task #${reviewed} as yourself.\n\n  Claim it:\n    vb tasks claim ${reviewed}\n`)
    expect(await vb(team, ['tasks', 'complete', reviewed, 'reviewed', '--as', 'Reviewer'])).toEqual({ code: 0, stdout: `completed ${reviewed}\n`, stderr: '' })

    // What a task waits for is set through the handle too: the tasks named, or nothing.
    const tagged = (await vb(team, ['tasks', 'create', 'work', 'tag the release', '--no-sync'])).stdout.trim()
    const shipped = (await vb(team, ['tasks', 'create', 'work', 'ship it', '--no-sync'])).stdout.trim()
    expect(await vb(team, ['tasks', 'needs', shipped, tagged])).toEqual({ code: 0, stdout: `${shipped} needs #${tagged}\n`, stderr: '' })
    expect(JSON.parse((await vb(team, ['read', shipped, '--json'])).stdout).message.task).toMatchObject({ state: 'waiting', needs: [tagged] })
    expect(await vb(team, ['tasks', 'needs', shipped, '--none'])).toEqual({ code: 0, stdout: `${shipped} needs nothing\n`, stderr: '' })
    expect(JSON.parse((await vb(team, ['read', shipped, '--json'])).stdout).message.task).toMatchObject({ state: 'ready', needs: [] })

    // What the board holds of a task is its own to say, and the command says what it was doing with the board's words under it.
    const held = (await vb(team, ['tasks', 'create', 'work', 'a long build', '--no-sync', '--claim'])).stdout.split('  ')[0]!.slice(1)
    const over = async (args: string[], lines: string[]) => expect(await vb(team, args), args.slice(0, 2).join(' ')).toEqual({ code: 2, stdout: '', stderr: `${lines.join('\n')}\n` })
    const note = 'x'.repeat(1001)
    await over(['tasks', 'block', held, 'approve the deploy?', '--kind', 'k'.repeat(65)], [`error: Can't block task #${held}.`, '  kind: a kind is up to 64 lowercase letters, numbers, and _.-'])
    await over(['tasks', 'create', 'work', 'after them all', ...Array.from({ length: 21 }, (_, n) => ['--needs', String(9000 + n)]).flat()], ["error: Can't create a task in work.", '  needs: a task waits for at most 20 tasks'])
    await over(['tasks', 'claim', '--ready', 'work', ...Array.from({ length: 33 }, (_, n) => ['--from', `vercel:user:u_${n}`]).flat()], ["error: Can't claim a task in work.", '  from: a claim takes tasks from at most 32 owners'])
    await over(['tasks', 'needs', shipped, ...Array.from({ length: 21 }, (_, n) => String(9000 + n))], [`error: Can't change what task #${shipped} needs.`, '  needs: a task waits for at most 20 tasks'])
    // A result or reason over what a task keeps is refused before it's sent, with where the rest goes.
    const long = async (verb: string, what: string, rest: string) =>
      expect(await vb(team, ['tasks', verb, held, note])).toEqual({
        code: 1,
        stdout: '',
        stderr: `error: Can't ${verb} task #${held}. A task's ${what} is at most 1,000 characters, and this one is 1,001.\n\n  Reply the full ${rest} in the task's thread, then run this again with a line or two:\n    vb reply ${held} -\n`,
      })
    await long('complete', 'result', 'report')
    await long('fail', 'reason', 'detail')
    await long('cancel', 'reason', 'detail')
    // A root's text is a message's: what to do with the long part, where a task takes it.
    expect(await vb(team, ['tasks', 'create', 'work', 'x'.repeat(10_001)])).toEqual({
      code: 1,
      stdout: '',
      stderr: "error: Can't create a task in work. A message's text is at most 10,000 characters.\n\n  Keep it short, and reply to the task with the long part in a file with --attach\n",
    })
    expect(await vb(team, ['tasks', 'complete', held, 'x'.repeat(1000)])).toEqual({ code: 0, stdout: `completed ${held}\n`, stderr: '' })

    // It runs no command on the machine it's called from, and a wait holds every later call: only with a signal.
    const next = (await vb(team, ['tasks', 'create', 'work', 'run the tests', '--no-sync'])).stdout.trim()
    expect(await vb(team, ['tasks', 'run', next, '--', 'true'])).toEqual({ code: 2, stdout: '', stderr: "error: tasks run isn't available in-process: it runs a command on this machine.\n" })
    expect(JSON.parse((await vb(team, ['read', next, '--json'])).stdout).message.task.state).toBe('ready')
    expect(await vb(team, ['tasks', 'claim', '--ready', 'work', '--label', 'step=never', '--wait', '1m'])).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/pass a signal/) })
    const controller = new AbortController()
    const waiting = vb(team, ['tasks', 'claim', '--ready', 'work', '--label', 'step=never', '--wait', '1m'], { signal: controller.signal })
    controller.abort()
    expect(await waiting).toEqual({ code: 0, stdout: '', stderr: '' })

    // A claim taken by a call with a signal is the handle's: later calls renew and settle it, with a signal or without.
    const bounded = () => ({ signal: AbortSignal.timeout(30_000) })
    expect(await vb(team, ['tasks', 'claim', next], bounded())).toMatchObject({ code: 0, stderr: '' })
    expect(await vb(team, ['tasks', 'renew', next], bounded())).toMatchObject({ code: 0, stderr: '' })
    expect(await vb(team, ['tasks', 'release', next])).toEqual({ code: 0, stdout: `released ${next}\n`, stderr: '' })

    // Any other task command its signal stops says so, and one that writes says it may have landed: a list doesn't.
    stall.on = true
    const stoppedWhile = async (argv: string[]) => {
      const stopping = new AbortController()
      const running = vb(team, [...argv, '--json'], { signal: stopping.signal })
      setTimeout(() => stopping.abort(), 20)
      const ran = await running
      return { code: ran.code, ...(JSON.parse(ran.stderr) as { reason: string; message: string; hint?: string }) }
    }
    expect(await stoppedWhile(['tasks', 'claim', next])).toMatchObject({ code: 130, reason: 'canceled', message: `Stopped before it could claim task #${next}.`, hint: expect.stringMatching(/may have happened/) })
    expect(await stoppedWhile(['tasks', 'unblock', next])).toMatchObject({ code: 130, reason: 'canceled', hint: expect.stringMatching(/may have happened/) })
    const listing = await stoppedWhile(['tasks', 'work'])
    expect(listing).toMatchObject({ code: 130, reason: 'canceled', message: 'Stopped before it could list tasks in work.' })
    expect(listing.hint).toBeUndefined()
    stall.on = false
    expect(JSON.parse((await vb(team, ['read', next, '--json'])).stdout).message.task.state).toBe('ready')
  })

  it('keeps claims in the store its caller passes, so a call on another handle settles them', async () => {
    const served = testBoard()
    // What a caller keeps in KV or a file: it outlives the handle, the process, and the instance.
    const kept = new Map<string, HeldClaim>()
    const claims = (profile: string | null): Claims => ({
      get: async (task) => kept.get(`${profile}:${task}`) ?? null,
      put: async (task, claim) => void kept.set(`${profile}:${task}`, claim),
      drop: async (task) => void kept.delete(`${profile}:${task}`),
    })
    const first = await handle(undefined, served)
    const id = (await vb(first, ['tasks', 'create', 'work', 'fix CVE-123 in acme/web', '--no-sync'])).stdout.trim()
    const claimed = await vb(first, ['tasks', 'claim', id, '--lease', '5m', '--json'], { claims })
    expect(claimed).toMatchObject({ code: 0, stderr: '' })
    const [stored] = [...kept.values()]
    expect([...kept.keys()]).toEqual([`null:${id}`])
    // The token goes to the store and never to stdout.
    expect(claimed.stdout).not.toContain(stored!.token)

    // A fresh handle without the store holds nothing; with it, it renews and settles the claim.
    const next = await handle(undefined, served)
    expect((await vb(next, ['tasks', 'complete', id, 'fixed'])).stderr).toMatch(/^error: You hold no claim on task/)
    expect(await vb(next, ['tasks', 'renew', id, '--lease', '10m'], { claims })).toMatchObject({ code: 0, stderr: '' })
    expect(Date.parse(kept.get(`null:${id}`)!.until)).toBeGreaterThan(Date.parse(stored!.until))
    // The store is asked per profile: a claim taken as yourself isn't the reviewer's.
    expect((await vb(next, ['tasks', 'complete', id, 'fixed', '--as', 'reviewer'], { claims })).stderr).toMatch(/^error: You hold no claim on task .* as reviewer\./)
    expect(await vb(next, ['tasks', 'complete', id, 'fixed in a1b2c3'], { claims })).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
    expect(JSON.parse((await vb(next, ['read', id, '--json'])).stdout).message.task).toMatchObject({ state: 'completed', result: 'fixed in a1b2c3' })
    // Settled, the claim leaves the store.
    expect(kept.size).toBe(0)

    // A claim the board says is lost leaves the store too.
    const lost = (await vb(first, ['tasks', 'create', 'work', 'rotate the keys', '--no-sync'])).stdout.trim()
    expect(await vb(first, ['tasks', 'claim', lost, '--as', 'rotator'], { claims })).toMatchObject({ code: 0, stderr: '' })
    expect([...kept.keys()]).toEqual([`rotator:${lost}`])
    expect(await vb(first, ['tasks', 'cancel', lost, 'superseded'])).toMatchObject({ code: 0, stderr: '' })
    expect((await vb(next, ['tasks', 'complete', lost, 'rotated', '--as', 'rotator'], { claims })).stderr).toMatch(/^error: Lost the claim on task/)
    expect(kept.size).toBe(0)
  })

  it('takes a token from its caller, so any call with it settles the claim, with no store', async () => {
    const served = testBoard()
    const token = createHmac('sha256', 'a caller secret').update('run 7f3a9c').digest('base64url')
    const first = await handle(undefined, served)
    const id = (await vb(first, ['tasks', 'create', 'work', 'fix CVE-123 in acme/web', '--no-sync'])).stdout.trim()
    const claimed = await vb(first, ['tasks', 'claim', id, '--lease', '5m', '--json'], { claimToken: token })
    expect(claimed).toMatchObject({ code: 0, stderr: '' })
    expect(claimed.stdout).not.toContain(token)
    const { claim } = JSON.parse(claimed.stdout) as { claim: { epoch: number; until: string } }

    // Claimed again with its token, on another handle, the task answers the claim it has: same epoch, same lease.
    const next = await handle(undefined, served)
    const again = await vb(next, ['tasks', 'claim', id, '--json'], { claimToken: token })
    expect(again).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(again.stdout).claim).toEqual(claim)
    // Without it, or with another, the task is someone else's.
    expect(failure(await vb(next, ['tasks', 'claim', id, '--json'], { claimToken: 'b'.repeat(43) }))).toMatchObject({ reason: 'task_claimed' })
    expect((await vb(next, ['tasks', 'complete', id, 'not mine'])).stderr).toMatch(/^error: You hold no claim on task/)
    expect(failure(await vb(next, ['tasks', 'complete', id, 'not mine', '--json'], { claimToken: 'b'.repeat(43) }))).toMatchObject({ reason: 'claim_lost' })

    // Any call with the token renews and settles it.
    expect(await vb(next, ['tasks', 'renew', id, '--lease', '10m'], { claimToken: token })).toMatchObject({ code: 0, stderr: '' })
    expect(await vb(await handle(undefined, served), ['tasks', 'complete', id, 'fixed in a1b2c3'], { claimToken: token })).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
    expect(JSON.parse((await vb(next, ['read', id, '--json'])).stdout).message.task).toMatchObject({ state: 'completed', result: 'fixed in a1b2c3' })
    expect((await vb(next, ['tasks', 'release', id], { claimToken: token })).stderr).toMatch(/^error: You hold no claim on task/)

    // The next ready task, too.
    const ready = (await vb(first, ['tasks', 'create', 'work', 'review the fix', '--label', 'step=review', '--no-sync'])).stdout.trim()
    expect(await vb(first, ['tasks', 'claim', '--ready', 'work', '--label', 'step=review'], { claimToken: token })).toMatchObject({ code: 0, stderr: '' })
    expect(await vb(next, ['tasks', 'fail', ready, 'needs a database'], { claimToken: token })).toEqual({ code: 0, stdout: `failed ${ready}\n`, stderr: '' })

    // A task made with its claim carries the token too.
    const made = (await vb(first, ['tasks', 'create', 'work', 'ship it', '--claim', '--no-sync'], { claimToken: token })).stdout.split('  ')[0]!.slice(1)
    expect(await vb(next, ['tasks', 'complete', made, 'shipped'], { claimToken: token })).toEqual({ code: 0, stdout: `completed ${made}\n`, stderr: '' })

    // A token any backend takes: 32 bytes in base64url.
    expect(failure(await vb(first, ['tasks', 'claim', ready, '--json'], { claimToken: 'run-7f3a9c' }))).toMatchObject({ reason: 'invalid_arguments' })
  })
})
