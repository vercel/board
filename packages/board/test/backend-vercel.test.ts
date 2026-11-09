import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { ATTACHMENT_BYTES_MAX } from '../src/contract/files.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { vercel as nodeVercel } from '../src/backend-vercel/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { boardEvents } from '../src/contract/events.ts'
import { watchersHash } from '../src/server/registry.ts'
import type { Authenticate } from '../src/access/index.ts'
import { compileAccess } from '../src/server/access.ts'
import type { Caller } from '../src/server/backend.ts'
import type { Middleware } from '../src/server/middleware.ts'
import type { Watcher } from '../src/server/watcher.ts'
import { slack } from '../src/sync/slack.ts'
import { channels, render } from '../src/sync/fn.ts'
import { as, fakeMessageboard } from './messageboard.ts'
import { fakePlatform } from './sync-fixtures.ts'

const API = 'http://localhost'

/** A handle on the fake's board through vercel(), as `principal`. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }) })

/** The same handle, narrowed with `x-board-can` as a proxy holding the credential sends it, which Vercel's API doesn't read yet. */
const narrowedOn =
  (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  (can: string) =>
    board({
      backend: vercel({
        team: 'team_test',
        api: API,
        fetch: (input, init) => {
          const request = new Request(input, init)
          request.headers.set('x-board-can', can)
          return as(api, principal)(request)
        },
        files: api.files,
      }),
    })

/** Someone a host's verifier would name: a request from her is still no one's this board serves. */
const ADA = { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } as const

/** The project's own board on Vercel's, as its deployment runs it, with `middleware`: what board() serves is its own code. */
const PONG_URL = 'https://pong.example/api/board'
function pongBoard(api: ReturnType<typeof fakeMessageboard>, middleware: Middleware[] = [], options: { authenticate?: Authenticate } = {}) {
  return board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }), url: PONG_URL, middleware, ...options })
}

/** Every match a handle's registration has, each acked as it's pulled: a thread's next waits for the ack before it. */
async function drain(handle: ReturnType<typeof handleOn>) {
  const all: Awaited<ReturnType<typeof handle.matches>> = []
  for (let pulled = await handle.matches({}); pulled.length > 0; pulled = await handle.matches({})) {
    for (const match of pulled) {
      await handle.ack(match.id, { lease: match.lease })
    }
    all.push(...pulled)
  }
  return all
}

describe('vercel()', () => {
  it("passes the conformance kit's core, schedules, grants, and attachments for a person, and skips what Vercel's API takes only from a deployment, and GitHub grants", async () => {
    const api = fakeMessageboard()
    // The API looks names up, so the grants checks name a project, a repository, a viewer, and an app its team has.
    // A board token is its board's, so the handle it's sent on names the board.
    const withToken = (secret: string) => board({ backend: vercel({ team: 'team_test', api: API, board: 'brd_test', fetch: as(api, secret), files: api.files }) })
    const report = await conformance(handleOn(api), { withToken, withCan: narrowedOn(api), principals: { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com', app: 'ship' } })
    const statuses = Object.fromEntries(report.checks.map((check) => [`${check.group}: ${check.name}`, check.status]))
    expect(statuses).toEqual({
      'core: says in its discovery where it is': 'passed',
      'core: posts a message, and reads it back by its ID': 'passed',
      "core: puts a reply in its root's thread": 'passed',
      'core: labels a message only while its labels are as the write says, one of any that race': 'passed',
      'core: edits and deletes a message only at the revision it was read at, which only edits and deletes change': 'passed',
      "core: replies after a message only while it's the thread's newest, one of any that race": 'passed',
      'core: posts once for a client ID, however many times it is sent': 'passed',
      'core: raises the version with each edit, reaction, and label': 'passed',
      "core: matches a label on the message or its thread's root": 'passed',
      'core: drops a deleted message from what its labels find': 'passed',
      'core: reads a channel after a cursor or a message ID, oldest first': 'passed',
      'core: lists threads, each with its reply count and latest reply': 'passed',
      'core: reads events after a cursor, each with a cursor of its own': 'passed',
      'core: holds a long-poll open until the next event': 'passed',
      'core: deletes a message, leaving a tombstone': 'passed',
      'core: lists the channel and you in it': 'passed',
      // Vercel's API doesn't read x-board-can yet: a narrowed caller gets its whole access.
      'core: narrows a caller to what its x-board-can says': 'failed',
      // Neither registers for a person, narrowed or not.
      "watchers: refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking": 'skipped',
      "sync: refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox": 'skipped',
      'core: creates a channel only once: one a post made is there already': 'passed',
      'core: answers 404 for an ID that names nothing': 'passed',
      'core: answers 400 for a request that does not validate': 'passed',
      'schedules: schedules a reply, lists it, and cancels it': 'passed',
      'schedules: keeps noSync on a schedule, so its sends stay off every platform': 'passed',
      'grants: grants a principal, lists it, and revokes it': 'passed',
      'grants: makes another grant for the same principals, and changes one by its ID': 'passed',
      "grants: keeps a grant's can as written, a pattern with no permissions included": 'passed',
      'grants: lets the most specific pattern decide, then the closest principal there, and adds up ties': 'passed',
      'grants: lets everyone narrow what something else lets in, and lets no one in itself': 'skipped',
      'grants: caps a person by their team role, so a viewer reads but neither posts nor manages': 'passed',
      'grants: names an app by its slug or client ID, keeps it by client ID, and every app as a group': 'passed',
      'grants: takes manage at each pattern a grant names to change it, and at * to list them': 'skipped',
      "grants: lets no token grant past its own can, even where everyone's grant closes it": 'skipped',
      'grants: lets no token let anyone in where everyone gets more than the token has': 'skipped',
      'grants: lets a member grant on a pattern after a lock under it': 'skipped',
      'grants: lets a project on another team in, in its environments': 'skipped',
      'tokens: mints a token, shows its secret only then, lists it, and revokes it': 'skipped',
      "tokens: lets a token do what its can says, as whoever minted it, and nothing once it's revoked": 'skipped',
      'attachments: takes a file, posts it, and gives it back': 'passed',
      'watchers: matches a registered tail, hands the match to a pull, and takes its ack': 'skipped',
      'watchers: wakes by path only where its discovery says so, and only a Vercel project': 'skipped',
      "sync: keeps sync's records: an import as a platform author, its lookups by platform ID, a receipt, and where it's synced": 'skipped',
      "sync: queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'skipped',
      'sync: hands a sync each message change as a match of its @sync watcher': 'skipped',
      'sync: keeps noSync on a post and a reply, so sync sends neither': 'passed',
    })
    // It leaves the grants as it found them.
    expect([...api.grants.keys()]).toEqual(['g1', 'g2', 'g3'])
  }, 30_000)

  it('answers only wake-ups and webhooks: it verifies no request, and none reaches the API, while its own code writes as the project', async () => {
    const api = fakeMessageboard()
    const authenticate = vi.fn(async () => ADA)
    const pong = pongBoard(api, [], { authenticate })
    const nothing = { error: { code: 'not_found', message: `${PONG_URL} answers only wake-ups and webhooks` } }
    for (const [method, path, body] of [
      ['GET', '/', undefined],
      ['GET', '/me', undefined],
      ['GET', '/messages', undefined],
      ['POST', '/messages', { channel: 'dev', text: 'hi' }],
      ['POST', '/attachments/uploads', { name: 'big.mp4', type: 'video/mp4', size: 10_000_000 }],
      ['POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }] }],
      ['POST', '/inbox/slack', { events: [] }],
    ] as const) {
      const response = await pong.fetch(
        new Request(`${PONG_URL}${path}`, {
          method,
          headers: { authorization: 'Bearer ada', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      expect([`${method} ${path}`, response.status, await response.json()]).toEqual([`${method} ${path}`, 404, nothing])
    }
    expect(authenticate).not.toHaveBeenCalled()
    expect(api.requests).toEqual([])
    expect((await pong.post('dev', 'from the app')).by.principal).toBe('vercel:project:prj_pong:production')
  })

  it("refuses a reply after a message in another thread, which as a sequence would name one in its own", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { id: root } = await julian.post('dev', { text: 'hi' })
    const { id: other } = await julian.post('dev', { text: 'another' })
    await expect(julian.reply(root, { text: 'hello', after: other })).rejects.toMatchObject({ status: 400, code: 'invalid_after' })
    expect((await julian.thread(root)).replies).toEqual([])
    // A retry of one that landed gets it back, whatever its `after` says now.
    const landed = await julian.reply(root, { text: 'hello', id: 'hello-1', after: root })
    expect((await julian.reply(root, { text: 'hello', id: 'hello-1', after: other })).id).toBe(landed.id)
    expect((await julian.thread(root)).replies.map((m) => m.id)).toEqual([landed.id])
  })

  it("names a person by their Vercel username and name, and an agent by its profile under them, as the API does", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const { id } = await julian.post('dev', { text: 'hi' })
    await julian.as('claude').reply(id, { text: 'hello' })
    const { message, replies } = await julian.thread(id)
    expect(message.author).toMatchObject({ kind: 'person', handle: 'julian', name: 'Julián Benegas' })
    expect(replies[0]!.author).toMatchObject({ kind: 'agent', handle: 'julian/claude', name: 'claude' })
    // Someone who first writes after the names were read is named too.
    await handleOn(api, 'user:u_ada').reply(id, { text: 'me too' })
    expect((await julian.thread(id)).replies[1]!.author).toMatchObject({ handle: 'ada', name: 'Ada Lovelace' })
  })

  it('names someone after a read of the names fails, and every message of someone new in one read', async () => {
    const api = fakeMessageboard()
    let failing = true
    // The list of names answers 503 once.
    const flaky: typeof fetch = async (input, init) => {
      if (failing && new URL(String(input)).pathname.endsWith('/actors')) {
        failing = false
        return Response.json({ error: { code: 'unavailable', message: 'try again' } }, { status: 503 })
      }
      return as(api, 'user:u_jb')(input, init)
    }
    const julian = board({ backend: vercel({ team: 'team_test', api: API, fetch: flaky }) })
    const { id } = await julian.post('dev', { text: 'hi' })
    expect(failing).toBe(false)
    expect((await julian.thread(id)).message.author).toMatchObject({ handle: 'julian', name: 'Julián Benegas' })
    // Someone new, several times: each of their messages, read side by side, is named.
    const ada = handleOn(api, 'user:u_ada')
    for (const text of ['one', 'two', 'three']) await ada.post('dev', { text })
    const { messages } = await julian.messages({ channel: 'dev' })
    expect(messages.filter((message) => message.by.principal === 'vercel:user:u_ada').map((message) => message.author?.handle)).toEqual(['ada', 'ada', 'ada'])
  })

  it('shows a renamed person by their new name once they write again and a few minutes pass', async () => {
    const accounts = { u_jb: { username: 'julian', name: 'Julián Benegas' } }
    const api = fakeMessageboard({ accounts })
    const julian = handleOn(api)
    const { id } = await julian.post('dev', { text: 'hi' })
    expect((await julian.thread(id)).message.author).toMatchObject({ handle: 'julian' })
    // The API records the new name when they next write.
    accounts.u_jb = { username: 'jules', name: 'Jules Benegas' }
    await julian.reply(id, { text: 'renamed' })
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(Date.now() + 6 * 60_000)
      expect((await julian.thread(id)).message.author).toMatchObject({ handle: 'jules', name: 'Jules Benegas' })
    } finally {
      clock.mockRestore()
    }
  })

  it('writes as the project a deployment is, per environment, and as an agent with its profile', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const { id } = await pong.post('pings', { text: 'ping' })
    const reply = await pong.as('claude').reply(id, { text: 'pong', labels: { kind: 'task' } })
    const { message, replies } = await pong.thread(id)
    expect(message).toMatchObject({ channel: 'pings', by: { principal: 'vercel:project:prj_pong:production', profile: null }, author: { kind: 'deployment', handle: 'prj_pong' } })
    expect(replies).toMatchObject([{ id: reply.id, re: id, labels: { kind: 'task' }, by: { actor: 'vercel:project:prj_pong:production+claude', profile: 'claude' }, author: { kind: 'agent', handle: 'claude' } }])
    // `me` is who the handle writes as, its profile included.
    expect((await pong.as('claude').messages({ channel: 'pings', by: 'me' })).messages.map((m) => m.id)).toEqual([reply.id])
    expect((await pong.messages({ channel: 'pings', by: 'me' })).messages.map((m) => m.id)).toEqual([id])
    // A preview is someone else.
    const preview = handleOn(api, 'project:prj_pong:preview')
    expect((await preview.me()).principal).toBe('vercel:project:prj_pong:preview')
  })

  it('reads and lists schedules by a handle as the board shows it, a person covering their agents', async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const root = await julian.post('dev', { text: 'mine' })
    const claude = await julian.as('claude').reply(root.id, { text: 'from claude' })
    const hers = await ada.reply(root.id, { text: 'from ada' })
    const scheduled = await julian.as('claude').schedule({ re: root.id }, { text: 'later', in: '1h' })
    await ada.schedule({ re: root.id }, { text: 'hers later', in: '1h' })
    const ids = async (by: string) => (await ada.messages({ channel: 'dev', by })).messages.map((m) => m.id)
    expect(await ids('julian')).toEqual([root.id, claude.id])
    expect(await ids('julian/claude')).toEqual([claude.id])
    expect(await ids('Ada')).toEqual([hers.id])
    expect(await ids('nobody')).toEqual([])
    expect((await ada.messages({ by: 'julian/claude' })).messages.map((m) => m.id)).toEqual([claude.id])
    expect((await ada.schedules({ by: 'julian/claude' })).map((s) => s.id)).toEqual([scheduled.id])
  })

  it("reads the names again at most once for a `--by` value nobody goes by, until they're read anyway", async () => {
    const api = fakeMessageboard()
    const reads: string[] = []
    const fetch = as(api, 'user:u_jb')
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/actors')) reads.push(request.url)
      return fetch(input, init)
    }) as typeof globalThis.fetch
    const julian = board({ backend: vercel({ team: 'team_test', api: API, fetch: counted, files: api.files }) })
    const root = await julian.as('claude').post('dev', { text: 'from claude' })
    expect((await julian.messages({ channel: 'dev', by: 'julian/claude' })).messages.map((m) => m.id)).toEqual([root.id])
    const before = reads.length
    // A profile name isn't a handle: it matches without the names, read again once.
    for (let i = 0; i < 3; i++) expect((await julian.messages({ channel: 'dev', by: 'claude' })).messages.map((m) => m.id)).toEqual([root.id])
    expect(reads.length - before).toBe(1)
  })

  it('reads a channel and the channels under it, and finds threads by a label', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('dev', { text: 'one' })
    const two = await team.post('dev/web', { text: 'two', labels: { state: 'open' } })
    await team.post('ops', { text: 'three' })
    expect((await team.messages({ channel: 'dev/' })).messages.map((m) => m.text)).toEqual(['one', 'two'])
    expect((await team.threads({ channel: 'dev/', label: { state: 'open' } })).threads.map((t) => t.message.id)).toEqual([two.id])
  })

  it("lists channels by path, sorted, with none of the counts the API doesn't keep", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('ops', { text: 'one' })
    await team.post('dev/web', { text: 'two' })
    await team.reply((await team.post('dev/web', { text: 'three' })).id, { text: 'four' })
    expect(await team.channels()).toEqual([{ path: 'dev/web' }, { path: 'general' }, { path: 'ops' }])
  })

  it('makes a channel in the API before anything posts to it, once', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    expect(await team.createChannel('dev/alerts')).toEqual({ channel: { path: 'dev/alerts' }, created: true })
    expect(await team.createChannel('dev/alerts')).toMatchObject({ created: false })
    // One a post made, or another handle, is there already.
    await team.post('ops', { text: 'hi' })
    expect(await team.createChannel('ops')).toMatchObject({ created: false })
    expect(await handleOn(api, 'user:u_ada').createChannel('dev/alerts')).toMatchObject({ created: false })
    // The board's own general, and what it made: each once.
    expect((await team.channels()).map((c) => c.path).sort()).toEqual(['dev/alerts', 'general', 'ops'])
  })

  it("lists a busy channel's threads from the API's thread list, reading only the roots and latest replies it shows", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const roots = []
    for (let i = 0; i < 60; i++) roots.push(await team.post('busy', { text: `thread ${i}` }))
    await team.reply(roots[59]!.id, { text: 'latest' })
    api.requests.length = 0
    const { threads, cursor } = await team.threads({ channel: 'busy', limit: 5 })
    expect(threads.map((t) => t.message.text)).toEqual(['thread 55', 'thread 56', 'thread 57', 'thread 58', 'thread 59'])
    expect(threads.at(-1)).toMatchObject({ replies: 1, last: { text: 'latest' } })
    // One page of the thread list, and a root (and the one latest reply) for each thread it shows.
    expect(api.requests.filter((r) => /\/threads$/.test(r))).toHaveLength(1)
    expect(api.requests.filter((r) => /\/threads\/[^/]+\/messages$/.test(r))).toEqual([])
    expect(api.requests.filter((r) => /\/messages\/msg_/.test(r))).toHaveLength(6)
    // Read on from the cursor, it stops at the first thread that hasn't moved since.
    const later = await team.post('busy', { text: 'thread 60' })
    api.requests.length = 0
    expect((await team.threads({ channel: 'busy', after: cursor })).threads.map((t) => t.message.id)).toEqual([later.id])
    expect(api.requests.filter((r) => /\/threads$/.test(r))).toHaveLength(1)
  })

  it("uploads its own code's files, one bigger than a request straight to Vercel's storage, and posts them through board()'s middleware", async () => {
    const api = fakeMessageboard()
    // Any middleware has board() look up a post's files first, before they're posted.
    const screened: string[][] = []
    const pong = pongBoard(api, [
      async ({ write, next }) => {
        if (write.kind === 'post') screened.push(write.attachments.map((file) => file.name))
        await next()
      },
    ])
    // The handle sends a file bigger than a request takes to the URL the API signs, with plain fetch.
    vi.stubGlobal('fetch', api.files)
    try {
      const log = await pong.upload({ data: new TextEncoder().encode('log'), name: 'a.log' })
      const video = new Uint8Array(ATTACHMENT_BYTES_MAX + 1).fill(7)
      const after = await pong.upload({ data: video, name: 'after.mp4', type: 'video/mp4' })
      expect(api.requests.filter((r) => r.endsWith('/complete'))).toHaveLength(2)
      const posted = await pong.post('dev', { text: 'before and after', attachments: [log.id, after.id] })
      expect(posted.attachments.map((file) => file.id)).toEqual([log.id, after.id])
      expect(screened).toEqual([['a.log', 'after.mp4']])
      expect(Buffer.from(await (await pong.download(after.id)).arrayBuffer()).equals(Buffer.from(video))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("refuses a direct upload without its bytes' SHA-256, which Vercel's API signs the upload for", async () => {
    const backend = vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'project:prj_pong:production') })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const signal = new AbortController().signal
    const file = { name: 'big.mp4', type: 'video/mp4', size: 5 * 1024 * 1024 }
    await expect(backend.uploadStart(project, file, signal)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    expect(await backend.uploadStart(project, { ...file, sha256: `${'A'.repeat(43)}=` }, signal)).toMatchObject({ id: expect.any(String), url: expect.any(String) })
  })

  it("reads one channel from the API's message list and feed, with cursors another process resumes", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const first = await team.post('busy', { text: 'one' })
    await team.reply(first.id, { text: 'two' })
    await team.post('busy', { text: 'three' })
    api.requests.length = 0
    const latest = await team.messages({ channel: 'busy', limit: 2 })
    expect(latest.messages.map((m) => m.text)).toEqual(['two', 'three'])
    expect(latest.cursor).toMatch(/^c1\./)
    // One page of the channel's messages: no thread is read message by message.
    expect(api.requests.filter((r) => r.endsWith('/messages'))).toEqual(['GET /boards/brd_test/messages'])
    // A cursor is the API's, so a handle in another process, which keeps no positions, goes on from it.
    const other = handleOn(api)
    await other.post('busy', { text: 'four' })
    expect((await other.messages({ channel: 'busy', after: latest.cursor })).messages.map((m) => m.text)).toEqual(['four'])
    const events = await other.poll({ channel: 'busy', after: latest.cursor })
    expect(events.events.map((e) => [e.type, e.message?.text])).toEqual([['message.posted', 'four']])
    expect((await other.poll({ channel: 'busy', after: events.cursor })).events).toEqual([])
  })

  it("reads the latest across channels from each channel's page at once, with a cursor the feed goes on from", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const first = await team.post('dev', { text: 'dev one' })
    await team.post('ops', { text: 'ops one' })
    await team.reply(first.id, { text: 'dev reply' })
    await team.post('web', { text: 'web one' })
    await team.post('ops', { text: 'ops two' })
    const channels = (await team.channels()).length
    api.requests.length = 0
    const latest = await team.messages({ limit: 4 })
    expect(latest.messages.map((m) => m.text)).toEqual(['ops one', 'dev reply', 'web one', 'ops two'])
    // One page of each channel's messages, at once: no thread is read message by message.
    expect(api.requests.filter((r) => r === 'GET /boards/brd_test/messages')).toHaveLength(channels)
    expect(api.requests.filter((r) => r.includes('/threads/') || r.endsWith('/changes'))).toEqual([])
    // The feed goes on from what it read: the next post, and nothing it already had.
    await team.post('dev', { text: 'later' })
    expect((await team.poll({ after: latest.cursor })).events.map((e) => e.message?.text)).toEqual(['later'])
  })

  it('answers across channels with every message newer than the oldest it has, where a channel has more than one page', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('quiet', { text: 'quiet before' })
    for (let i = 1; i <= 130; i++) await team.post('busy', { text: `m${i}` })
    await team.post('quiet', { text: 'quiet after' })
    // The API lists busy's newest 100, back to m31. Quiet's older message would sit past m1 to m30,
    // which the read never saw, as if nothing came between: so it stops at m31.
    const latest = await team.messages({ limit: 200 })
    expect(latest.messages.map((m) => m.text)).toEqual([...Array.from({ length: 100 }, (_, i) => `m${i + 31}`), 'quiet after'])
  }, 30_000)

  it("makes the team's board the first time a person uses it, and tells a project it needs a grant", async () => {
    const pong = handleOn(fakeMessageboard({ boardId: null }), 'project:prj_pong:production')
    await expect(pong.post('dev', { text: 'hello' })).rejects.toMatchObject({
      status: 403,
      code: 'board_not_granted',
      message: "this project has no access to the team's board (prj_pong, production).",
      hint: "Grant it: vb grants create --project prj_pong --environment production --can '*=read,post,react,label'",
    })
    const api = fakeMessageboard({ boardId: null })
    await handleOn(api).post('dev', { text: 'hello' })
    expect(api.requests.filter((r) => r === 'POST /boards/default')).toHaveLength(1)
    expect((await handleOn(api).messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['hello'])
  })

  it('says what the API says its credentials may do, and until when, and what any it lets in may when it says neither', async () => {
    const said = async (handle: ReturnType<typeof handleOn>) => {
      const { can, expiresAt } = await handle.me()
      return { can, expiresAt }
    }
    const everything = { can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] }, expiresAt: null }
    // A person may do what their team role lets them; a project, what any credentials the API lets in may.
    const api = fakeMessageboard({ roles: { u_jb: 'owner', u_ada: 'viewer' } })
    expect(await said(handleOn(api, 'user:u_jb'))).toEqual(everything)
    expect(await said(handleOn(api, 'user:u_ada'))).toEqual({ can: { '*': ['read', 'react'] }, expiresAt: null })
    expect(await said(handleOn(api, 'project:prj_pong:production'))).toEqual({ can: { '*': ['read', 'post', 'react', 'label'] }, expiresAt: null })
    for (const role of ['member', 'developer'] as const) expect(await said(handleOn(fakeMessageboard({ roles: { u_jb: role } })))).toEqual(everything)
    // Credentials it says less of, and until when, as it will of board tokens: board's own permissions, as it gives them.
    const expiresAt = Date.now() + 59 * 60_000
    const narrowed = fakeMessageboard({ me: { 'user:u_jb': { can: { 'pings/': ['read', 'post'], 'dev/': ['read', 'fly'] }, expiresAt } } })
    expect(await said(handleOn(narrowed))).toEqual({ can: { 'pings/': ['read', 'post'], 'dev/': ['read'] }, expiresAt: new Date(expiresAt).toISOString() })
    // As board's own me says it: a pattern board can't read dropped, so the summary compiles, what
    // each permission implies, as label does read, and a pattern left with nothing left out.
    const odd = fakeMessageboard({ me: { 'user:u_jb': { can: { 'dev*': ['label'], ops: ['label'], 'ci/': ['fly'] }, expiresAt: null } } })
    const { can } = await said(handleOn(odd))
    expect(can).toEqual({ ops: ['read', 'label'] })
    expect(compileAccess(can).summary()).toEqual(can)
    // Epoch seconds, as a JWT's exp, aren't 1970: under 10^12, a number is read as seconds.
    const seconds = Math.floor(expiresAt / 1000)
    const jwtStyle = fakeMessageboard({ me: { 'user:u_jb': { can: { '*': ['read'] }, expiresAt: seconds } } })
    expect((await said(handleOn(jwtStyle))).expiresAt).toBe(new Date(seconds * 1000).toISOString())
    // An API that says neither, as before it sent them: what any credentials it lets in may do, with no expiry.
    expect(await said(handleOn(fakeMessageboard({ me: false }), 'user:u_jb'))).toEqual({ can: { '*': ['read', 'post', 'react', 'label'] }, expiresAt: null })
  })

  it("sends a board token you set, in Node, ahead of VERCEL_TOKEN and the deployment's OIDC token", async () => {
    for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
    const api = fakeMessageboard({ tokens: { k7Qe2mXa9vLp: 'user:u_ada' } })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const who = async () => (await board({ backend: nodeVercel() }).me()).principal
    try {
      vi.stubEnv('VERCEL_TOKEN', 'project:prj_pong:production')
      expect(await who()).toBe('vercel:project:prj_pong:production')
      vi.stubEnv('BOARD_TOKEN', 'k7Qe2mXa9vLp')
      expect(await who()).toBe('vercel:user:u_ada')
      // On a deployment, with no VERCEL_TOKEN: its OIDC token, which isn't one here, is never read.
      vi.stubEnv('VERCEL_TOKEN', '')
      vi.stubEnv('VERCEL', '1')
      vi.stubEnv('VERCEL_OIDC_TOKEN', 'not-an-oidc-token')
      expect(await who()).toBe('vercel:user:u_ada')
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  describe('a board by its name', () => {
    /** A handle on the team's board named `name`, through vercel(), as `principal`. */
    const named = (api: ReturnType<typeof fakeMessageboard>, name: string, principal = 'user:u_jb') =>
      board({ name, backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal) }) })
    const lookups = (api: ReturnType<typeof fakeMessageboard>, request: string) => api.requests.filter((made) => made === request).length

    it('uses the board with that name, whatever its case, apart from the default board, and looks it up once', async () => {
      const api = fakeMessageboard({ boards: [{ name: 'Security', id: 'brd_sec' }] })
      const security = named(api, 'security')
      await security.post('dev', { text: 'rotate the keys' })
      await security.post('dev', { text: 'done' })
      expect(lookups(api, 'GET /boards')).toBe(1)
      expect((await named(api, 'SECURITY').messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['rotate the keys', 'done'])
      expect((await handleOn(api).messages({ channel: 'dev' })).messages).toEqual([])
      expect(await security.discovery()).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_sec?teamId=team_test` })
      // The default board is named General, so its name finds it too.
      expect(await named(api, 'general').discovery()).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_test?teamId=team_test` })
    })

    it('makes the board the first time its project uses it, granted to that project in its environment', async () => {
      const api = fakeMessageboard()
      await named(api, 'security', 'project:prj_pong:production').post('dev', { text: 'from pong' })
      expect(lookups(api, 'POST /boards/ensure')).toBe(1)
      // Another process of the project finds it, and makes nothing.
      await named(api, 'security', 'project:prj_pong:production').post('dev', { text: 'again' })
      expect(lookups(api, 'POST /boards/ensure')).toBe(1)
      // It's the team's: a person reads it.
      expect((await named(api, 'security').messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['from pong', 'again'])
      // The project's preview isn't granted it, and is told who fixes that.
      await expect(named(api, 'security', 'project:prj_pong:preview').post('dev', { text: 'from a preview' })).rejects.toMatchObject({
        status: 403,
        code: 'board_not_granted',
        origin: 'handle',
        message: 'this project has no access to board security (prj_pong, preview).',
        hint: "Grant it: vb grants create --project prj_pong --environment preview --name security --can '*=read,post,react,label'",
      })
    })

    it('makes the board for a person too, by default, once, as the team sees it', async () => {
      const api = fakeMessageboard()
      await named(api, 'security').post('dev', { text: 'rotate the keys' })
      // Another process finds it by its name, and makes nothing more.
      await named(api, 'security').post('dev', { text: 'done' })
      expect(lookups(api, 'POST /boards/ensure')).toBe(1)
      // It's the team's: someone else reads it by its name.
      expect((await named(api, 'security', 'user:u_ada').messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['rotate the keys', 'done'])
    })

    it('makes none for a caller that says ensure: false, and says there is none it can see', async () => {
      const api = fakeMessageboard()
      const found = (principal: string) => board({ name: 'security', ensure: false, backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal) }) })
      for (const principal of ['user:u_jb', 'project:prj_pong:production'])
        await expect(found(principal).post('dev', { text: 'hi' })).rejects.toMatchObject({
          status: 404,
          code: 'no_board',
          origin: 'handle',
          message: 'no board named security on this team, or none you can see.',
        })
      expect(lookups(api, 'POST /boards/ensure')).toBe(0)
    })

    it("says a name is another board's that you can't see, and makes none", async () => {
      const api = fakeMessageboard({ boards: [{ name: 'vault', id: 'brd_vault', members: ['u_ada'] }] })
      const ensured = board({ name: 'Vault', ensure: true, backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'user:u_jb') }) })
      await expect(ensured.post('dev', { text: 'hi' })).rejects.toMatchObject({
        status: 409,
        code: 'board_name_taken',
        origin: 'handle',
        message: 'the board name Vault is taken.',
        hint: 'Pick another name, or ask whoever can see it for access.',
      })
      // Its member still reads it, and nothing was posted there.
      expect((await named(api, 'vault', 'user:u_ada').messages({ channel: 'dev' })).messages).toEqual([])
    })

    it('takes ensure only with a name', () => {
      expect(() => board({ ensure: true, backend: vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'user:u_jb') }) })).toThrow('ensure makes the board `name` names: pass name too')
    })

    it('takes the first board the API lists for a name an older board shares, and makes none', async () => {
      // The API lists the oldest first: here the default board, General, made before brd_old.
      const api = fakeMessageboard({ boards: [{ name: 'general', id: 'brd_old', granted: ['prj_pong:production'] }] })
      for (const principal of ['user:u_jb', 'project:prj_pong:production']) await named(api, 'General', principal).post('dev', { text: `from ${principal}` })
      expect((await handleOn(api).messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['from user:u_jb', 'from project:prj_pong:production'])
      expect(lookups(api, 'POST /boards/ensure')).toBe(0)
    })

    it("takes another team's board by its team and name, or that team's default board by its team alone", async () => {
      const api = fakeMessageboard({ slug: 'acme', boards: [{ name: 'security' }] })
      const teams: (string | null)[] = []
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { searchParams } = new URL(String(input instanceof Request ? input.url : input))
        teams.push(searchParams.get('slug') ?? searchParams.get('teamId'))
        return as(api, 'user:u_jb')(input, init)
      }) as typeof globalThis.fetch
      await board({ team: 'acme', name: 'security', backend: vercel({ api: API, fetch }) }).post('dev', { text: 'for acme security' })
      await board({ team: 'acme', backend: vercel({ api: API, fetch }) }).post('dev', { text: "on acme's default board" })
      expect(new Set(teams)).toEqual(new Set(['acme']))
      expect((await handleOn(api).messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(["on acme's default board"])
      expect((await named(api, 'security').messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['for acme security'])
      // vercel()'s own team is board()'s, or nothing binds.
      board({ team: 'acme', backend: vercel({ team: 'acme', api: API, fetch }) })
      expect(() => board({ team: 'acme', backend: vercel({ team: 'team_test', api: API, fetch }) })).toThrow('name the team once')
      // Its own board ID wins over the name, as the CLI's URL form passes it.
      const byId = board({ name: 'nope', backend: vercel({ board: 'brd_test', team: 'acme', api: API, fetch }) })
      expect((await byId.messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(["on acme's default board"])
    })
  })

  it("says the team's ID in its discovery, though it's named by its slug", async () => {
    const api = fakeMessageboard({ slug: 'acme' })
    const team = board({ backend: vercel({ team: 'acme', api: API, fetch: as(api, 'user:u_jb') }) })
    expect(await team.discovery()).toMatchObject({ team_id: 'team_test' })
  })

  it("reads past the API's page of 100 after a cursor, as many as a read asks for", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('busy', { text: 'm0' })
    const { cursor } = await team.messages({ channel: 'busy' })
    // The API's own cursor, so the read is the one-channel one.
    expect(cursor).toMatch(/^c1\./)
    for (let i = 1; i <= 130; i++) await team.post('busy', { text: `m${i}` })
    const after = await team.messages({ channel: 'busy', after: cursor, limit: 120 })
    expect(after.messages.map((m) => m.text)).toEqual(Array.from({ length: 120 }, (_, i) => `m${i + 1}`))
    // From the newest, it's the API's one page: it lists no further back.
    expect((await team.messages({ channel: 'busy', limit: 120 })).messages).toHaveLength(100)
  }, 30_000)

  it("waits on every channel's feed at once for a read across channels, asking nothing more until one answers", async () => {
    const api = fakeMessageboard()
    const changes: number[] = []
    const fetching = as(api, 'user:u_jb')
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith('/changes')) changes.push(Date.now())
      return fetching(input, init)
    }) as typeof fetch
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: counted, files: api.files }) })
    for (const channel of ['dev', 'ops', 'web']) await team.post(channel, { text: `hi ${channel}` })
    const { cursor } = await team.poll({})
    const waiting = team.poll({ after: cursor, wait: 5 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const settled = changes.length
    // Idle, the API hears nothing more: each channel's long-poll holds.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(changes.length).toBe(settled)
    const posted = Date.now()
    await team.post('ops', { text: 'later' })
    const page = await waiting
    expect(page.events.map((event) => event.message?.text)).toEqual(['later'])
    expect(Date.now() - posted).toBeLessThan(1000)
  }, 15_000)

  it('reads every channel at most once a second across channels, however busy the board, when the filter matches nothing', async () => {
    const api = fakeMessageboard()
    let changes = 0
    const fetching = as(api, 'user:u_jb')
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input instanceof Request ? input.url : input)).pathname.endsWith('/changes')) changes++
      return fetching(input, init)
    }) as typeof fetch
    const team = board({ backend: vercel({ team: 'team_test', api: API, fetch: counted, files: api.files }) })
    for (const channel of ['dev', 'ops', 'web']) await team.post(channel, { text: `hi ${channel}` })
    const channels = (await team.channels()).length
    const { cursor } = await team.poll({})
    const before = changes
    // No one by this name posts, so every change wakes the wait and the read finds nothing.
    const waiting = team.poll({ after: cursor, by: 'nobody', wait: 5 })
    const busy = setInterval(() => void team.post('ops', { text: 'busy' }), 50)
    const page = await waiting.finally(() => clearInterval(busy))
    expect(page.events).toEqual([])
    // A wait on each channel, which wakes at once, then a read of each every second for 5 seconds:
    // 1 + 6, and 1 to spare for a slow runner, where the first wake can miss its second. Waiting at
    // every wake, as each second's read did before it fell back, is 5 + 6.
    expect(changes - before).toBeLessThanOrEqual(channels * (1 + 6 + 1))
  }, 15_000)

  it('finds an older thread by labels the API can only filter after it lists, and refuses a cursor it can’t read', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.post('dev', { text: 'open one', labels: { state: 'open' } })
    for (let i = 0; i < 5; i++) await team.post('dev', { text: `plain ${i}` })
    const { threads } = await team.threads({ channel: 'dev', label: { state: 'open|wip' }, limit: 2 })
    expect(threads.map((thread) => thread.message.text)).toEqual(['open one'])
    await expect(team.messages({ channel: 'dev', after: '!!' })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  it('leaves a deleted root out of every read by its labels, though the API still lists it by them', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    const open = { state: 'open' }
    const kept = await team.post('dev', { text: 'kept', labels: open })
    const keptReply = await team.reply(kept.id, { text: 'under kept' })
    const gone = await team.post('dev/web', { text: 'gone', labels: open })
    const goneReply = await team.reply(gone.id, { text: 'under gone' })
    const { cursor } = await team.poll({ label: open })
    await team.delete(gone.id)
    // The newest thread its labels find is the deleted one: a page of one fills past it.
    expect((await team.threads({ channel: 'dev/', label: open, limit: 1 })).threads.map((t) => t.message.text)).toEqual(['kept'])
    expect((await team.messages({ channel: 'dev/', label: open })).messages.map((m) => m.text)).toEqual(['kept', 'under kept'])
    await team.edit(goneReply.id, 'under gone, edited')
    await team.edit(keptReply.id, 'under kept, edited')
    const { events } = await team.poll({ label: open, after: cursor })
    expect(events.filter((event) => event.type === 'message.edited').map((event) => event.message?.text)).toEqual(['under kept, edited'])
  })

  it("registers a production deployment's watchers by its path, and runs what they matched when it's woken", async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            ran.push(event.message!.text)
            await own.reply(event.message!.id, { text: 'pong' })
          },
        },
      },
    })
    await pong.me()
    while (!api.registrations.has('vercel:project:prj_pong:production')) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' })
    await handleOn(api).post('pings', { text: 'ping' })
    const wake = () => pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' })).then((response) => response.json())
    await expect(wake()).resolves.toEqual({ ran: 1 })
    expect(ran).toEqual(['ping'])
    // Its reply is its own watcher's, which never wakes it.
    await expect(wake()).resolves.toEqual({ ran: 0 })
    // A wake-up carries back the hash it registered with: with the current one, nothing registers again.
    const registered = () => api.requests.filter((request) => request.startsWith('PUT ') && request.endsWith('/watchers')).length
    const before = registered()
    const { hash } = api.registrations.get('vercel:project:prj_pong:production')!
    await pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST', headers: { 'x-board-watchers': hash } }))
    expect(registered()).toBe(before)
  })

  it("keeps the registration a call starts running after the response, through Vercel's waitUntil", async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const kept: Promise<unknown>[] = []
    const context = Symbol.for('@vercel/request-context')
    Reflect.set(globalThis, context, { get: () => ({ waitUntil: (task: Promise<unknown>) => void kept.push(task) }) })
    onTestFinished(() => void Reflect.deleteProperty(globalThis, context))
    const api = fakeMessageboard()
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: { pings: { tail: 'pings', run: async () => {} } },
    })
    await pong.me()
    // A function can freeze once it answers, so what the call started is handed to the platform to finish.
    expect(kept.length).toBeGreaterThan(0)
    await Promise.all(kept)
    expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' })
  })

  it('registers a deployment off Vercel with no url, and pulls what its watchers match, with its env pulled too', async () => {
    // What `vercel env pull` writes to .env.local, and `vercel dev` sets: a dev server, which stays up.
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:development') })
    onTestFinished(() => backend.close())
    const pong = board({
      backend,
      url: 'https://pong.example/api/board',
      watch: {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            await own.reply(event.message!.id, 'pong')
          },
        },
      },
    })
    await pong.me()
    // With no path, and no url, which the API refuses: it pulls.
    await vi.waitFor(() => expect(api.registrations.has('vercel:project:prj_pong:development')).toBe(true))
    expect(api.registrations.get('vercel:project:prj_pong:development')!.path).toBeUndefined()
    // Nothing wakes it: it pulls the match itself.
    const ping = await handleOn(api, 'user:u_ada').post('pings', 'ping')
    await vi.waitFor(() => expect(ran).toEqual(['ping']))
    await vi.waitFor(async () => expect((await pong.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:project:prj_pong:development+pings']]))
  })

  it('registers its path from a custom environment and a preview with no branch, and never pulls on its own there', async () => {
    onTestFinished(() => void vi.unstubAllEnvs())
    for (const [environment, env] of [
      ['staging', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', VERCEL_GIT_COMMIT_REF: '' }],
      // A `vercel deploy` preview: it names no branch, and the API wakes that deployment itself.
      ['preview', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' }],
    ] as const) {
      for (const [name, value] of Object.entries({ VERCEL: '1', ...env })) vi.stubEnv(name, value)
      const api = fakeMessageboard()
      const ran: string[] = []
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, `project:prj_pong:${environment}`) })
      onTestFinished(() => backend.close())
      const pong = board({ backend, url: 'https://pong-abc123.vercel.app/api/board', watch: { pings: { tail: 'pings', run: async ({ event }) => void ran.push(event.message!.text) } } })
      await pong.me()
      await vi.waitFor(() => expect(api.registrations.has(`vercel:project:prj_pong:${environment}`)).toBe(true))
      expect(api.registrations.get(`vercel:project:prj_pong:${environment}`)).toMatchObject({ path: '/api/board' })
      expect(api.registrations.get(`vercel:project:prj_pong:${environment}`)!.branch).toBeUndefined()
      await handleOn(api, 'user:u_ada').post('pings', 'ping')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect([environment, ran, api.requests.filter((request) => request.includes('/watchers/matches'))]).toEqual([environment, [], []])
    }
  })

  it('never pulls on its own on Vercel, even with a registration nothing wakes', async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
    onTestFinished(() => backend.close())
    // A URL that isn't https, so no path comes of it: the registration it asks for would pull, off Vercel.
    const pong = board({ backend, url: 'http://pong.internal/api/board', watch: { pings: { tail: 'pings', run: async ({ event }) => void ran.push(event.message!.text) } } })
    const registered = await pong.fetch(new Request('http://pong.internal/api/board/watchers', { method: 'POST' }))
    expect(await registered.json()).toMatchObject({ url: null })
    await handleOn(api, 'user:u_ada').post('pings', 'ping')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(ran).toEqual([])
    expect(api.requests.filter((request) => request.includes('/watchers/matches'))).toEqual([])
  })

  it('never sends Vercel\'s API a url to wake, and the API takes none', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await expect(pong.register({ url: 'https://pong.example/api/board', watch: {} })).rejects.toMatchObject({ status: 400, code: 'invalid_request', origin: 'handle' })
    expect(api.requests.filter((request) => request.startsWith('PUT '))).toEqual([])
    const sent = await as(api, 'project:prj_pong:production')(`${API}/v1/messageboard/boards/brd_test/watchers?teamId=team_test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://pong.example/api/board', watch: {} }),
    })
    expect(sent.status).toBe(400)
    expect(api.registrations.size).toBe(0)
  })

  describe("a person's watchers", () => {
    /** A board run as `principal`, as `next dev` on a laptop runs one, with its watchers in config. */
    function personal(api: ReturnType<typeof fakeMessageboard>, watch: Record<string, Watcher>, principal = 'user:u_jb') {
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, principal) })
      onTestFinished(() => backend.close())
      return { backend, team: board({ backend, url: 'http://localhost:3000/api/board', watch }) }
    }
    /** Until its tails have read the head of the feed: what's posted after that, they run. */
    const following = (api: ReturnType<typeof fakeMessageboard>) => vi.waitFor(() => expect(api.requests.some((request) => request.endsWith('/changes'))).toBe(true))

    it('run in this process as tails from the head, registering nothing, and never on their own writes', async () => {
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const ran: string[] = []
      const { team } = personal(api, {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            await own.reply(event.message!.id, 'pong')
          },
        },
      })
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(ran).toEqual(['ping']))
      await vi.waitFor(async () => expect((await team.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:user:u_jb+pings']]))
      // The next post comes after its reply in the feed: by then the reply was seen, and ran nothing.
      await ada.post('pings', 'ping again')
      await vi.waitFor(() => expect(ran).toEqual(['ping', 'ping again']))
      expect(api.registrations.size).toBe(0)
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })

    it('run as tails in a dev server with its env pulled, which says VERCEL=1 in development', async () => {
      for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
      onTestFinished(() => void vi.unstubAllEnvs())
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const { ran, watch } = pinger()
      const { team } = personal(api, watch)
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(ran).toEqual(['ping']))
      await vi.waitFor(async () => expect((await team.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:user:u_jb+pings']]))
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })

    it('try a run that throws again, and post its reply once', async () => {
      const api = fakeMessageboard()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => errors.mockRestore())
      let tries = 0
      const { team } = personal(api, {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            await own.reply(event.message!.id, 'pong')
            if (++tries === 1) throw new Error('down')
          },
        },
      }, 'app:oac_1')
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(tries).toBe(2), { timeout: 5_000 })
      expect((await team.thread(ping.id)).replies.map((reply) => reply.text)).toEqual(['pong'])
    })

    /** A pings watcher that replies pong, and what it ran on. */
    const pinger = () => {
      const ran: string[] = []
      const watch: Record<string, Watcher> = {
        pings: {
          tail: 'pings',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            await own.reply(event.message!.id, 'pong')
          },
        },
      }
      return { ran, watch }
    }
    const registrations = (api: ReturnType<typeof fakeMessageboard>) => api.requests.filter((request) => request.startsWith('PUT ') && request.endsWith('/watchers')).length

    it('run as tails with a board token you set in Node, its project\'s included, never trying to register', async () => {
      for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
      onTestFinished(() => {
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
      })
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'deploy' })
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
      vi.stubEnv('VERCEL_ORG_ID', 'team_test')
      vi.stubEnv('BOARD_TOKEN', secret)
      const { ran, watch } = pinger()
      const backend = nodeVercel({ board: 'brd_test' })
      onTestFinished(() => backend.close())
      const team = board({ backend, url: 'https://pong.example/api/board', watch })
      await team.me()
      await following(api)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(ran).toEqual(['ping']))
      await vi.waitFor(async () => expect((await team.thread(ping.id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['pong', 'vercel:project:prj_pong:production+pings']]))
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })

    it("run as tails once Vercel's API refuses a project's board token in a fetch, which registers once and never again", async () => {
      const api = fakeMessageboard()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => errors.mockRestore())
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'deploy' })
      const { ran, watch } = pinger()
      const backend = vercel({ team: 'team_test', api: API, board: 'brd_test', fetch: as(api, secret) })
      onTestFinished(() => backend.close())
      const team = board({ backend, url: 'http://localhost:3000/api/board', watch })
      await team.me()
      await following(api)
      expect(registrations(api)).toBe(1)
      const ping = await ada.post('pings', 'ping')
      await vi.waitFor(() => expect(ran).toEqual(['ping']))
      await vi.waitFor(async () => expect((await team.thread(ping.id)).replies.map((reply) => reply.text)).toEqual(['pong']))
      // Not on a wake-up, a registration asked for, or a later use once the wait between tries is over.
      const wake = await team.fetch(new Request('http://localhost:3000/api/board/wake', { method: 'POST', headers: { 'x-board-watchers': 'stale' } }))
      expect(await wake.json()).toEqual({ ran: 0 })
      const asked = await team.fetch(new Request('http://localhost:3000/api/board/watchers', { method: 'POST' }))
      expect(asked.status).toBe(403)
      await expect(backend.registerWatchers()).rejects.toMatchObject({ code: 'watchers_need_project' })
      const clock = vi.spyOn(Date, 'now')
      onTestFinished(() => clock.mockRestore())
      const at = Date.now()
      clock.mockReturnValue(at + 60_000)
      await team.me()
      clock.mockRestore()
      await ada.post('pings', 'ping again')
      await vi.waitFor(() => expect(ran).toEqual(['ping', 'ping again']))
      // A board that pulls on its own stops trying too: its next try would have come after a second.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(registrations(api)).toBe(1)
    })

    it("start no tails on a deployment whose credentials aren't its own, a board token's or VERCEL_TOKEN's", async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => {
        errors.mockRestore()
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
      })
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'ci' })
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
      for (const [name, value, options] of [
        ['BOARD_TOKEN', secret, { board: 'brd_test' }],
        ['VERCEL_TOKEN', 'user:u_jb', {}],
      ] as const) {
        for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
        for (const [key, set] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_ORG_ID: 'team_test', [name]: value })) vi.stubEnv(key, set)
        const { ran, watch } = pinger()
        const backend = nodeVercel(options)
        onTestFinished(() => backend.close())
        const team = board({ backend, url: 'https://pong.vercel.app/api/board', watch })
        await team.me()
        await ada.post('pings', `ping with ${name}`)
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect([name, ran]).toEqual([name, []])
      }
      // Neither read the feed or asked to register.
      expect(api.requests.filter((request) => request.endsWith('/changes') || request.includes('/watchers'))).toEqual([])
    })

    it("answer a wake-up with nothing run and a registration with watchers_need_project, asking the API nothing", async () => {
      const api = fakeMessageboard()
      const { backend, team } = personal(api, { pings: { tail: 'pings', run: async () => {} } })
      const wake = await team.fetch(new Request('http://localhost:3000/api/board/wake', { method: 'POST' }))
      expect(await wake.json()).toEqual({ ran: 0 })
      const registering = await team.fetch(new Request('http://localhost:3000/api/board/watchers', { method: 'POST' }))
      expect([registering.status, (await registering.json()).error.code]).toEqual([403, 'watchers_need_project'])
      await expect(backend.registerWatchers()).rejects.toMatchObject({ status: 403, code: 'watchers_need_project', origin: 'handle' })
      expect(api.requests.filter((request) => request.includes('/watchers'))).toEqual([])
    })
  })

  it("passes the conformance kit's sync as a project, through Vercel's API's sync routes, but for a narrowed caller's", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api, 'project:prj_pong:production'), { withCan: narrowedOn(api, 'project:prj_pong:production') })
    expect(Object.fromEntries(report.checks.filter((check) => check.group === 'sync').map((check) => [check.name, check.status]))).toEqual({
      "keeps sync's records: an import as a platform author, its lookups by platform ID, a receipt, and where it's synced": 'passed',
      "queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'passed',
      'hands a sync each message change as a match of its @sync watcher': 'passed',
      'keeps noSync on a post and a reply, so sync sends neither': 'passed',
      // Vercel's API doesn't read x-board-can yet, so a narrowed caller keeps sync's records.
      "refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox": 'failed',
    })
  }, 30_000)

  it("passes the conformance kit's watchers as a project too, registering a path on its own project, but for a narrowed caller's", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api, 'project:prj_pong:production'), { withCan: narrowedOn(api, 'project:prj_pong:production') })
    // Vercel's API doesn't read x-board-can yet, so a narrowed caller registers its project's watchers.
    expect(report.checks.filter((check) => check.group === 'watchers').map((check) => check.status)).toEqual(['passed', 'passed', 'failed'])
  }, 30_000)

  it('registers a path on its own project on Vercel, which the API wakes through its Deployment Protection', async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    try {
      const api = fakeMessageboard()
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
      board({ backend, url: 'https://pong.vercel.app/api/board', watch: { ping: { tail: 'pings', run: async () => {} } } })
      expect(await backend.registerWatchers()).toMatchObject({ path: '/api/board' })
      expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ path: '/api/board' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('registers again on a later use when its first registration fails', async () => {
    const api = fakeMessageboard()
    let failing = true
    const flaky: typeof fetch = async (input, init) => {
      if (failing && init?.method === 'PUT') {
        failing = false
        return Response.json({ error: { code: 'unavailable', message: 'try again' } }, { status: 503 })
      }
      return as(api, 'project:prj_pong:production')(input, init)
    }
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: flaky }),
      url: 'https://pong.example/api/board',
      watch: { pings: { tail: 'pings', run: async () => {} } },
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clock = vi.spyOn(Date, 'now')
    try {
      await pong.me()
      await vi.waitFor(() => expect(failing).toBe(false))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(api.registrations.size).toBe(0)
      // Not on every request while it's failing: once the wait between tries is over.
      const at = Date.now()
      clock.mockReturnValue(at + 11_000)
      await pong.me()
      await vi.waitFor(() => expect(api.registrations.has('vercel:project:prj_pong:production')).toBe(true))
    } finally {
      clock.mockRestore()
      errors.mockRestore()
    }
  })

  it("turns a tail into the API's filter, and refuses what the API can't match", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api, 'project:prj_pong:production')
    await team.register({ url: null, watch: { open: { tail: 'dev/ --label status=open|draft --text "is failing"' }, mine: { tail: 'general --by me' } } })
    expect(api.registrations.get('vercel:project:prj_pong:production')?.watch).toEqual({
      open: { filter: { channelTree: 'dev', text: 'is failing', labels: [{ key: 'status', values: ['open', 'draft'] }] } },
      mine: { filter: { channelIds: ['general'], authors: ['vercel:project:prj_pong:production'] } },
    })
    for (const tail of ['general --mentions @ada', 'general --source slack'])
      await expect(team.register({ url: null, watch: { w: { tail } } })).rejects.toMatchObject({ status: 400, code: 'bad_watcher' })
  })

  it('schedules a thread and a reply in the API, in its times, and each send says which schedule posted it', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const before = Date.now()
    const reply = await pong.as('claude').schedule({ re: root.id }, { text: 'check in', in: '1h', every: '30m', for: '7d', noSync: true })
    const kept = api.schedules.get(reply.id)!
    expect(kept).toMatchObject({ threadId: root.thread, every: 30 * 60_000, text: 'check in' })
    expect(kept.firstAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(kept.until).toBe(kept.firstAt + 7 * 86_400_000)
    expect(reply).toMatchObject({ channel: 'pings', re: root.id, every: 30 * 60_000, times: null, sent: 0, state: 'pending', canceled: null, by: { actor: 'vercel:project:prj_pong:production+claude', profile: 'claude' }, author: { kind: 'agent', handle: 'claude' } })
    expect(reply.until).toBe(new Date(kept.until!).toISOString())
    const thread = await pong.schedule('standup', { text: 'standup', every: '1d', times: 3, labels: { kind: 'standup' } })
    expect(api.schedules.get(thread.id)).toMatchObject({ labels: { kind: 'standup' }, times: 3 })
    expect(api.schedules.get(thread.id)!.firstAt).toBeGreaterThanOrEqual(before + 86_400_000)
    // A send is the creator's post, marked as the schedule's: what tells a watcher its own check-in from its other posts.
    const sent = api.send(reply.id)
    const { replies } = await pong.thread(root.id)
    expect(replies).toMatchObject([{ id: sent, text: 'check in', schedule: { id: reply.id, n: 0 }, by: { profile: 'claude' } }])
    expect((await pong.schedules({ re: root.id }))[0]).toMatchObject({ id: reply.id, sent: 1, last: sent })
    const started = api.send(thread.id)
    expect((await pong.thread(started)).message).toMatchObject({ channel: 'standup', text: 'standup', labels: { kind: 'standup' }, schedule: { id: thread.id, n: 0 } })
    expect((await pong.thread(root.id)).message.schedule).toBeUndefined()
  })

  it('lists pending schedules by thread, channel, and creator, across short pages, and every one with `all`', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const mine = await pong.schedule({ re: root.id }, { text: 'mine', in: '1h' })
    const claude = await pong.as('claude').schedule({ re: root.id }, { text: 'claude', in: '1h' })
    const elsewhere = await pong.schedule('ops', { text: 'ops', in: '1h' })
    const done = await pong.schedule('ops', { text: 'once', in: '1m' })
    api.send(done.id)
    const ids = async (query: object) => (await pong.schedules(query as never)).map((s) => s.id).sort()
    expect(await ids({})).toEqual([mine.id, claude.id, elsewhere.id].sort())
    expect(await ids({ re: root.id })).toEqual([mine.id, claude.id].sort())
    expect(await ids({ channel: 'ops' })).toEqual([elsewhere.id])
    expect(await ids({ channel: 'nowhere' })).toEqual([])
    expect(await ids({ by: 'claude' })).toEqual([claude.id])
    // A principal covers its agents; `me` is the actor alone.
    expect(await ids({ by: 'vercel:project:prj_pong:production' })).toEqual([mine.id, claude.id, elsewhere.id].sort())
    expect((await pong.as('claude').schedules({ by: 'me' })).map((s) => s.id)).toEqual([claude.id])
    expect(await ids({ all: true })).toEqual([mine.id, claude.id, elsewhere.id, done.id].sort())
    expect((await pong.schedules({ all: true })).find((s) => s.id === done.id)).toMatchObject({ state: 'done', next: null, sent: 1 })
  })

  it('cancels a schedule once, as the API answers it, and shows who did', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    const later = await pong.schedule({ re: root.id }, { text: 'later', in: '1d' })
    const first = await pong.cancelSchedule(later.id)
    expect(first).toMatchObject({ canceled: true, schedule: { state: 'canceled', next: null, canceled: { reason: 'canceled', by: { actor: 'vercel:project:prj_pong:production' } } } })
    expect(await pong.cancelSchedule(later.id)).toMatchObject({ canceled: false, schedule: { state: 'canceled' } })
    // Its team turning Messageboard off stops it as a lost grant does, by no one in particular.
    const off = await pong.schedule({ re: root.id }, { text: 'off', in: '1d' })
    Object.assign(api.schedules.get(off.id)!, { state: 'canceled', nextAt: null, canceled: { at: Date.now(), reason: 'disabled' } })
    expect((await pong.schedules({ all: true })).find((s) => s.id === off.id)?.canceled).toEqual({ reason: 'revoked', by: { actor: 'board:schedule', principal: 'board:schedule', profile: null, session: null } })
    await expect(handleOn(api, 'user:u_ada').cancelSchedule(off.id)).rejects.toMatchObject({ status: 403, code: 'schedule_not_owned' })
    await expect(pong.cancelSchedule('sch_missing')).rejects.toMatchObject({ status: 404, code: 'schedule_not_found' })
  })

  it("refuses what the API can't schedule: files, and labels on a reply", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const root = await pong.post('pings', { text: 'root' })
    await expect(pong.schedule({ re: root.id }, { text: 'labeled', in: '1h', labels: { kind: 'task' } })).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const signal = new AbortController().signal
    const { attachment } = await backend.upload(project, { data: new TextEncoder().encode('log'), name: 'a.log', type: 'text/plain' }, signal)
    await expect(backend.schedule(project, { channel: 'pings', text: 'file', in: '1h', attachments: [attachment.id] } as never, signal)).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    expect(api.schedules.size).toBe(0)
  })

  it("runs board()'s middleware on its own code's edit", async () => {
    const api = fakeMessageboard()
    const screened: string[] = []
    const pong = pongBoard(api, [
      async ({ write, next }) => {
        screened.push(`${write.kind} ${write.text}`)
        await next({ text: write.text.toUpperCase() })
      },
    ])
    const { id } = await pong.post('dev', { text: 'hello' })
    await pong.edit(id, 'edited')
    expect(screened).toEqual(['post hello', 'edit edited'])
    expect((await pong.thread(id)).message.text).toBe('EDITED')
  })

  it("screens a schedule's message through board()'s middleware when it's made, since Vercel's API posts its sends", async () => {
    const api = fakeMessageboard()
    const screened: string[] = []
    const pong = pongBoard(api, [
      async ({ write, respond, next }) => {
        screened.push(`${write.kind} ${write.channel} ${write.text}`)
        // As the factory's memory judge does: a note it rejects never lands.
        if (write.channel.startsWith('memory/')) return respond('Memory note not saved: rejected')
        await next({ text: write.text.toUpperCase() })
      },
    ])
    const root = await pong.post('dev', { text: 'root' })
    const own = await pong.schedule({ re: root.id }, { text: 'check in', in: '1h' })
    const agent = await pong.as('claude').schedule({ re: root.id }, { text: 'check later', in: '2h' })
    expect([own.id, agent.id].map((id) => api.schedules.get(id)?.text)).toEqual(['CHECK IN', 'CHECK LATER'])
    await expect(pong.as('claude').schedule('memory/notes', { text: 'remember this', in: '1m' })).rejects.toMatchObject({ status: 422, code: 'dropped' })
    await expect(pong.schedule('memory/notes', { text: 'and this', in: '1m' })).rejects.toMatchObject({ status: 422, code: 'dropped' })
    expect(api.schedules.size).toBe(2)
    expect(screened).toEqual(['post dev root', 'post dev check in', 'post dev check later', 'post memory/notes remember this', 'post memory/notes and this'])
  })

  it("answers the API's own sync refusals with the board's codes", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const ping = handleOn(api, 'project:prj_ping:production')
    const julian = handleOn(api)
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'linear:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const event = { kind: 'message' as const, channel: 'linear:C1', thread: 'linear:C1:1', subthread: null, message: '1', isRoot: true, text: 'hi', context: null, author }
    await expect(pong.inboxPush('slack', [{ id: 'e1', event, raw: null }])).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    await expect(ping.syncImport({ op: 'seen', author: { ...author, id: 'slack:user:U1' } })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(julian.register({ url: null, watch: {}, sync: [{ key: 'linear', platform: 'linear' }] })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    // A conflict or a write too big, on sync's routes and nowhere else.
    const refusing = (path: RegExp, status: number, code: string) =>
      handleOn({ ...api, fetch: async (input: RequestInfo | URL, init?: RequestInit) => (path.test(new URL(new Request(input, init).url).pathname) ? Response.json({ error: { code, message: code } }, { status }) : api.fetch(input, init)) }, 'project:prj_pong:production')
    const origin = { thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    await expect(refusing(/\/sync\/imports$/, 413, 'mutation_too_large').syncImport({ op: 'post', author: { ...author, id: 'slack:user:U1' }, from: 'slack', channel: 'general', text: 'hi', origin })).rejects.toMatchObject({ status: 413, code: 'too_large' })
    await expect(refusing(/\/sync\/receipts$/, 409, 'operation_conflict').syncReceipt({ kind: 'thread', message: 'msg_00000000-0000-0000-0000-000000000000_1', target: 'slack:C1', targetKind: 'channel', cause: 'request' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    await expect(refusing(/\/threads$/, 403, 'foreign_author').post('general', { text: 'hi' })).rejects.toMatchObject({ status: 403, code: 'foreign_author' })
  })

  it("names the sync a platform user's edit, delete, or reaction came through as its from, and none for one a sync makes as the user", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const origin = { thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    const { message } = await pong.syncImport({ op: 'post', author, from: 'slack', channel: 'general', text: 'from slack', origin })
    await pong.syncImport({ op: 'edit', author, from: 'slack', origin, text: 'edited on slack' })
    await pong.syncImport({ op: 'react', author, from: 'slack', origin, emoji: 'eyes' })
    await handleOn(api).react(message!, 'tada')
    // A sync callback's own write as the user syncs out everywhere, Slack included.
    await pong.syncImport({ op: 'edit', author, from: null, message: message!, text: 'edited by the sync, as Julián' })
    await pong.syncImport({ op: 'delete', author, from: 'slack', origin })
    expect((await drain(pong)).map((match) => [match.event.type, (match.event.payload as { from: string | null }).from])).toEqual([
      ['message.posted', 'slack'],
      ['message.edited', 'slack'],
      ['reaction.added', 'slack'],
      ['reaction.added', null],
      ['message.edited', null],
      ['message.deleted', 'slack'],
    ])
  })

  it("syncs Slack through the engine from its first webhook, a file as a link to it on Slack, and a board reply back to Slack", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'general' })) },
    })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    s.served.set('https://files.slack.test/shot.png', png)
    // The deployment's first request: nothing has registered its sync key with the API yet.
    const webhook = await pong.fetch(
      new Request(`${PONG_URL}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message', threadId: 'slack:C1:300', id: '300', text: 'the export page', user: 'U_ADA',
          files: [{ name: 'shot.png', mimeType: 'image/png', url: 'https://files.slack.test/shot.png', size: png.byteLength }],
        }),
      }),
    )
    expect(webhook.status).toBe(200)
    const julian = handleOn(api)
    await vi.waitFor(async () => {
      const { messages } = await julian.messages({ channel: 'general' })
      expect(messages.map((message) => [message.from, message.text, message.attachments])).toEqual([
        ['slack', "the export page\n\n📎 [shot.png](https://files.slack.test/shot.png) (7 B) didn't come over: Vercel's board takes no files from sync yet", []],
      ])
    })
    // Vercel's API keeps no file for it.
    expect(api.requests.filter((request) => request.includes('/attachments'))).toEqual([])
    const [root] = (await julian.messages({ channel: 'general' })).messages
    await julian.reply(root!.id, { text: 'looking' })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([['slack:C1:300', expect.stringContaining('looking')]]))
  })

  it('reads, joins, and shows typing on Slack through its own sync, which has the app to do it with', async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const web = {
      conversations: {
        list: async () => ({}),
        info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: channel === 'C1' ? 'general' : 'random', is_member: channel === 'C1' } }),
        history: async () => ({ messages: [{ ts: '1700000000.000100', user: 'U_ADA', text: 'deploy is red' }] }),
        join: async () => ({}),
      },
      users: { info: async () => ({ user: { real_name: 'Ada' } }) },
    }
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter, client: async () => web as never, join: true }, channels({ C1: 'general' })) },
    })
    expect(await pong.readSource('slack', 'C1')).toMatchObject({ channel: 'C1', name: 'general', messages: [{ author: 'Ada', text: 'deploy is red' }] })
    expect(await pong.joinSource('slack', 'C2')).toEqual({ channel: 'C2', name: 'random', joined: true })
    await pong.fetch(
      new Request(`${PONG_URL}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'the export page', user: 'U_ADA' }),
      }),
    )
    const [root] = await vi.waitUntil(async () => {
      const { messages } = await handleOn(api).messages({ channel: 'general' })
      return messages.length > 0 && messages
    })
    await pong.typing(root!.id)
    expect(s.typing).toEqual(['slack:C1:300'])
  })

  it("edits a Slack copy when a label its renderer shows changes, a label taken off included", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files })
    const pong = board({
      backend,
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter }, render(({ message }) => `[${message.labels.state ?? '-'}] ${message.text}`, channels({ C1: 'general' }))) },
    })
    await backend.registerWatchers()
    const wake = () => pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    const julian = handleOn(api)
    const pr = await julian.post('general', { text: 'PR #1', labels: { state: 'draft' } })
    await wake()
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '[draft] PR #1' })]))
    await julian.label(pr.id, { set: { state: 'merged' } })
    await wake()
    await vi.waitFor(() => expect(s.edits.map((edit) => edit.text)).toEqual([JSON.stringify({ markdown: '[merged] PR #1' })]))
    await julian.label(pr.id, { unset: ['state'] })
    await wake()
    await vi.waitFor(() => expect(s.edits.map((edit) => edit.text)).toEqual([JSON.stringify({ markdown: '[merged] PR #1' }), JSON.stringify({ markdown: '[-] PR #1' })]))
  })

  it("hands a thread's new target to the sync that owns its key as thread.synced, about the thread's root", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const ping = handleOn(api, 'project:prj_ping:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    await ping.register({ url: null, watch: {}, sync: [{ key: 'linear', platform: 'linear' }] })
    const root = await pong.post('general', { text: 'sync me' })
    await pong.reply(root.id, { text: 'a reply' })
    await pong.syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C1', targetKind: 'channel', cause: 'request' })
    const synced = (await drain(pong)).filter((match) => match.event.type === 'thread.synced')
    expect(synced.map((match) => [match.watcher, match.event.message?.id])).toEqual([['@sync', root.id]])
    const payload = boardEvents['thread.synced'].parse(synced[0]!.event.payload)
    expect(payload).toMatchObject({ thread: root.thread, target: 'slack:C1', kind: 'channel', cause: 'request', by: { actor: 'vercel:project:prj_pong:production' } })
    expect((await drain(ping)).filter((match) => match.event.type === 'thread.synced')).toEqual([])
  })

  it('filters its config watchers by --source, which the API can’t match, and a read by where its messages came from', async () => {
    const api = fakeMessageboard()
    const ran: string[] = []
    const run = (watcher: string) => async ({ event }: { event: { message?: { text: string } | null } }) => {
      ran.push(`${watcher}: ${event.message!.text}`)
    }
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: { imported: { tail: 'general --source slack', run: run('imported') }, written: { tail: 'general --source board', run: run('written') } },
    })
    await pong.me()
    while (!api.registrations.has('vercel:project:prj_pong:production')) await new Promise((resolve) => setTimeout(resolve, 5))
    const ping = handleOn(api, 'project:prj_ping:production')
    await ping.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    await ping.syncImport({ op: 'post', author, from: 'slack', channel: 'general', text: 'from slack', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    await handleOn(api).post('general', { text: 'on the board' })
    await pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' }))
    expect(ran.sort()).toEqual(['imported: from slack', 'written: on the board'])
    const read = async (from: string) => (await handleOn(api).messages({ channel: 'general', from })).messages.map((message) => message.text)
    expect(await read('slack')).toEqual(['from slack'])
    expect(await read('board')).toEqual(['on the board'])
    // A thread read finds the threads with a message from there, as a read of messages does.
    const threads = async (from: string) => (await handleOn(api).threads({ channel: 'general', from })).threads.map((thread) => thread.message.text)
    expect(await threads('slack')).toEqual(['from slack'])
    expect(await threads('board')).toEqual(['on the board'])
  })

  it("reads one channel's inbox events from as many as the API lists, so another channel's newer ones don't crowd them out", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    const pushed = (channel: string, message: string) => ({ id: `${channel}/${message}`, event: { kind: 'message' as const, channel, thread: `${channel}:1`, subthread: null, message, isRoot: true, text: 'hi', context: null, author }, raw: null })
    await pong.inboxPush('slack', [pushed('slack:C1', '1'), pushed('slack:C2', '1'), pushed('slack:C2', '2')])
    expect((await pong.inbox('slack', { channel: 'slack:C1', limit: 1 })).map((entry) => entry.id)).toEqual(['slack:C1/1'])
    expect((await pong.inbox('slack', { limit: 2 })).map((entry) => entry.id)).toEqual(['slack:C2/2', 'slack:C2/1'])
  })

  it('hashes a registration with its sync entries, as a board on http() does', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const watch = { w: { tail: 'general' } }
    await pong.register({ url: null, watch })
    expect(api.registrations.get('vercel:project:prj_pong:production')!.hash).toBe(watchersHash(watch))
    await pong.register({ url: null, watch, sync: [{ key: 'slack', platform: 'slack' }] })
    expect(api.registrations.get('vercel:project:prj_pong:production')!.hash).toBe(watchersHash(watch, [{ key: 'slack', platform: 'slack' }]))
  })

  it("refuses a project it names by name that turns out to be the run's own, after one grant it revokes", async () => {
    const api = fakeMessageboard()
    await handleOn(api).createGrant({ principals: [{ kind: 'project', project: 'web', environments: ['production'] }], can: { '*': 'all' } })
    const before = [...api.grants.keys()]
    // web's own deployment names web: only the API knows that's prj_web, so the kit asks it with a grant that changes nothing for the run.
    await expect(conformance(handleOn(api, 'project:prj_web:production'), { principals: { project: 'web', repository: 'acme/api' } })).rejects.toThrow(
      "principals.project is this run's own project, web (prj_web)",
    )
    expect([...api.grants.keys()]).toEqual(before)
  })

  it("fails a board whose team role lets a viewer post, in the conformance kit's viewer check", async () => {
    const api = fakeMessageboard()
    const real = as(api, 'user:u_jb')
    // The API, but its explain lets the viewer post.
    const posting: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const response = await real(request)
      if (!new URL(request.url).pathname.endsWith('/grants/explain')) return response
      const text = (await response.text()).replace('"can":["read","react"]', '"can":["read","post","react"]')
      return new Response(text, { status: response.status, headers: response.headers })
    }
    const handle = board({ backend: vercel({ team: 'team_test', api: API, fetch: posting, files: api.files }) })
    const report = await conformance(handle, { principals: { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com' } })
    expect(report.checks.find((check) => check.name.startsWith('caps a person by their team role'))).toMatchObject({
      status: 'failed',
      detail: 'what a viewer may do with a grant of all: expected read, and neither post nor manage, got ["read","post","react"]',
    })
  })

  it('keeps an app run in while it checks apps, so it revokes all it made', async () => {
    const api = fakeMessageboard()
    await handleOn(api).createGrant({ principals: [{ kind: 'app', app: 'deploy' }], can: { '*': 'all' } })
    const before = [...api.grants.keys()]
    const report = await conformance(handleOn(api, 'app:oac_2'), { principals: { project: 'prj_board', repository: 'acme/api', app: 'ship' } })
    expect(report.checks.find((check) => check.name.startsWith('names an app'))).toMatchObject({ status: 'passed' })
    expect([...api.grants.keys()]).toEqual(before)
  })

  it("gives back what Vercel's API refuses under the grant rules as the board's, grant_forbidden", async () => {
    const pong = handleOn(fakeMessageboard(), 'project:prj_pong:production')
    await expect(pong.grants()).rejects.toMatchObject({ status: 403, code: 'grant_forbidden', origin: 'board' })
    await expect(pong.createGrant({ principals: [{ kind: 'everyone' }], can: { 'dev/': [] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden', message: expect.stringContaining('takes manage') })
  })

  it("sends grants to Vercel's API as people name their principals, and gives back what it answers, IDs and names", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    expect(await jb.grants()).toEqual([
      { id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' }, capped: true, by: null, at: null },
      { id: 'g2', principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label'] }, capped: false, by: null, at: null },
      { id: 'g3', principals: [{ kind: 'all-apps' }], can: { '*': ['read', 'post', 'react', 'label'] }, capped: false, by: null, at: null },
    ])
    const { grant } = await jb.createGrant({
      principals: [
        { kind: 'user', email: 'ada@acme.com' },
        { kind: 'project', project: 'web', environments: ['production'] },
        { kind: 'app', app: 'ship' },
      ],
      can: { 'security/': 'all' },
    })
    expect(grant.principals).toEqual([
      { kind: 'user', userId: 'u_ada', email: 'ada@acme.com' },
      { kind: 'project', projectId: 'prj_web', name: 'web', environments: ['production'], teamId: 'team_test' },
      { kind: 'app', clientId: 'oac_1', name: 'ship' },
    ])
    // A project it names already gets the new environments.
    const joined = await jb.updateGrant(grant.id, { add: [{ kind: 'project', project: 'prj_web', environments: ['preview'] }] })
    expect(joined.grant.principals[1]).toEqual({ kind: 'project', projectId: 'prj_web', name: 'web', environments: ['production', 'preview'], teamId: 'team_test' })
    const updated = await jb.updateGrant(grant.id, { add: [{ kind: 'user', email: 'bob@acme.com' }], remove: [{ kind: 'project', project: 'web' }, { kind: 'app', app: 'oac_1' }] })
    expect(updated.grant.principals.map((principal) => ('userId' in principal ? principal.userId : principal.kind))).toEqual(['u_ada', 'u_bob'])
    expect(await jb.explain('security/incidents', { user: 'bob@acme.com' })).toEqual({
      channel: 'security/incidents',
      pattern: 'security/',
      over: ['*'],
      level: 'principal',
      grants: [updated.grant],
      rule: null,
      capped: null,
      can: ['read', 'post', 'react', 'label', 'sync', 'manage'],
    })
    // A viewer's role caps what g1 gives them.
    expect(await jb.explain('dev', { user: 'val@acme.com' })).toMatchObject({ pattern: '*', level: 'group', grants: [{ id: 'g1' }], capped: 'viewer', can: ['read', 'react'] })
    // An app on the team, by its slug: g3 lets every one in.
    expect(await jb.explain('dev', { app: 'ship' })).toMatchObject({ pattern: '*', level: 'group', grants: [{ id: 'g3' }], can: ['read', 'post', 'react', 'label'] })
    // No grant names a repository's runs or an issuer, so neither is explained: an app stands in for them.
    for (const principal of [{ github: 'acme/web', workflow: 'ci.yml' }, { oidc: 'https://gitlab.com', claims: { project_id: '42' } }])
      await expect(jb.explain('ci', principal)).rejects.toMatchObject({
        status: 400,
        code: 'unsupported_principal',
        origin: 'handle',
        message: "Vercel's board explains no GitHub or OIDC caller: no grant names one.",
        hint: 'Explain the app an OIDC exchange policy issues tokens for: --app <slug>.',
      })
    expect((await jb.revokeGrant(grant.id)).revoked).toBe(true)
    expect(api.requests).toEqual(
      expect.arrayContaining([
        'POST /boards/brd_test/grants',
        `PATCH /boards/brd_test/grants/${grant.id}`,
        'GET /boards/brd_test/grants/explain',
        `POST /boards/brd_test/grants/${grant.id}/revoke`,
      ]),
    )
  })

  it("refuses a grant naming a GitHub run or an OIDC issuer, made or added, saying an app stands in for it", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const refusal = {
      status: 400,
      code: 'unsupported_principal',
      origin: 'handle',
      message: "Vercel's board takes no GitHub or OIDC principals in a grant.",
      hint: 'Grant an app that an OIDC exchange policy issues tokens for: --app <slug>.',
    }
    for (const principal of [{ kind: 'github', repository: 'acme/web' }, { kind: 'oidc', issuer: 'https://gitlab.com', claims: { project_id: '42' } }] as const)
      await expect(jb.createGrant({ principals: [principal], can: { 'ci/': ['post'] } })).rejects.toMatchObject(refusal)
    const { grant } = await jb.createGrant({ principals: [{ kind: 'app', app: 'ship' }], can: { 'ci/': ['post'] } })
    await expect(jb.updateGrant(grant.id, { add: [{ kind: 'github', repository: 'acme/web' }] })).rejects.toMatchObject(refusal)
    expect((await jb.grants()).find((found) => found.id === grant.id)?.principals).toEqual([{ kind: 'app', clientId: 'oac_1', name: 'ship' }])
  })

  it("gives back grants' and tokens' times as the protocol has them, though the API answers milliseconds", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const before = Date.now()
    const { grant } = await jb.createGrant({ principals: [{ kind: 'user', email: 'ada@acme.com' }], can: { 'ci/': ['read'] } })
    expect(Date.parse(grant.at!)).toBeGreaterThanOrEqual(before)
    expect(grant.at).toBe(new Date(Date.parse(grant.at!)).toISOString())
    expect((await jb.grants()).find((listed) => listed.id === grant.id)?.at).toBe(grant.at)
    expect((await jb.explain('ci', { user: 'ada@acme.com' })).grants).toMatchObject([{ id: grant.id, at: grant.at }])
    expect((await jb.updateGrant(grant.id, { can: { 'ci/': ['read', 'post'] } })).grant.at).toMatch(/^\d{4}-\d\d-\d\dT/)
    const pong = handleOn(api, 'project:prj_pong:production')
    const { token } = await pong.createToken({ name: 'ci', can: { 'ci/': ['post'] }, expires: '1d' })
    expect(token.at).toBe(new Date(Date.parse(token.at)).toISOString())
    expect(Date.parse(token.expiresAt) - Date.parse(token.at)).toBe(86_400_000)
    expect(await pong.tokens()).toMatchObject([{ id: token.id, at: token.at, expiresAt: token.expiresAt }])
  })
})

describe("board tokens on Vercel's API", () => {
  /** A handle on a board that sends `secret`, by the board's ID, as a board token reaches its board. */
  const holding = (api: ReturnType<typeof fakeMessageboard>, secret: string, id = 'brd_test') =>
    board({ backend: vercel({ team: 'team_test', api: API, board: id, fetch: as(api, secret), files: api.files }) })
  /** What the API answers to a request vercel() never makes: a replayed operation ID, or a scope board's schema refuses first. */
  const raw = async (api: ReturnType<typeof fakeMessageboard>, bearer: string, method: string, path: string, body?: unknown) => {
    const response = await as(api, bearer)(`${API}/v1/messageboard${path}?teamId=team_test`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }

  it('shows a secret once, sends it as it is, and answers a retried mint 409 token_already_minted', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const { secret } = await pong.createToken({ name: 'ci' })
    expect(JSON.stringify(await pong.tokens())).not.toContain(secret)
    expect((await holding(api, secret).me()).principal).toBe('vercel:project:prj_pong:production')
    const mint = { operationId: 'op_1', name: 'ci' }
    expect((await raw(api, 'project:prj_pong:production', 'POST', '/boards/brd_test/tokens', mint)).status).toBe(200)
    expect(await raw(api, 'project:prj_pong:production', 'POST', '/boards/brd_test/tokens', mint)).toMatchObject({ status: 409, body: { error: { code: 'token_already_minted' } } })
  })

  it("answers 401 invalid_token for a token that's unknown, revoked, or expired", async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const [revoked, expired] = await Promise.all(['revoked', 'expired'].map((name) => pong.createToken({ name })))
    await pong.revokeToken(revoked!.token.id)
    api.tokens.get(expired!.token.id)!.expiresAt = Date.now() - 1
    for (const secret of ['not-a-token', revoked!.secret, expired!.secret])
      await expect(holding(api, secret).me()).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
  })

  it("answers 404 board_not_found on a board that isn't the token's, and says plainly that it reaches no team route", async () => {
    const api = fakeMessageboard({ boards: [{ name: 'Security', id: 'brd_sec' }] })
    const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'ci' })
    await expect(holding(api, secret, 'brd_sec').messages({ channel: 'dev' })).rejects.toMatchObject({ status: 404, code: 'board_not_found' })
    expect(await raw(api, secret, 'GET', '/boards')).toMatchObject({ status: 403, body: { error: { code: 'board_token_scope' } } })
    // Finding the team's board is a team route.
    const unnamed = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, secret), files: api.files }) })
    await expect(unnamed.messages({ channel: 'dev' })).rejects.toMatchObject({
      status: 403,
      code: 'board_token_scope',
      origin: 'handle',
      message: 'a board token reaches only its own board, by its ID.',
    })
  })

  it('posts a new thread with a post-only token, in a channel it can neither read nor make, and names that channel', async () => {
    const api = fakeMessageboard()
    const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'ci', can: { 'ci/': ['post'] } })
    const ci = holding(api, secret)
    // The API makes ci on its first post, as a board does, though this token couldn't make it itself.
    const posted = await ci.post('ci', { text: 'build green', labels: { run: '42' } })
    expect(posted).toMatchObject({ channel: 'ci', text: 'build green', labels: { run: '42' }, re: null, by: { principal: 'vercel:project:prj_pong:production' } })
    // Someone who reads ci sees it there.
    expect((await handleOn(api).thread(posted.id)).message).toMatchObject({ id: posted.id, channel: 'ci', text: 'build green' })
  })

  it("gets back a post-only token's retried post as it sent it, though the API answers a replay with IDs only", async () => {
    const api = fakeMessageboard()
    const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'ci', can: { 'ci/': ['post'] } })
    const ci = holding(api, secret)
    const first = await ci.post('ci', { id: 'run-42', text: 'build green', labels: { run: '42' } })
    const again = await ci.post('ci', { id: 'run-42', text: 'build green', labels: { run: '42' } })
    expect(again).toMatchObject({ id: first.id, thread: first.thread, channel: 'ci', text: 'build green', labels: { run: '42' }, re: null, by: first.by, author: first.author })
    // It's the one post: the retry made no other.
    expect((await handleOn(api).messages({ channel: 'ci' })).messages.map((message) => message.id)).toEqual([first.id])
  })

  it('names the channel a retried post landed in, not the one the retry names', async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const first = await jb.post('dev', { id: 'once', text: 'hi' })
    expect(await jb.post('ops', { id: 'once', text: 'hi' })).toMatchObject({ id: first.id, channel: 'dev' })
  })

  it('starts a thread in one call to the API, in a channel new or not, for a reader and a post-only token alike', async () => {
    const api = fakeMessageboard()
    const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'ci', can: { 'ci/': ['post'] } })
    const jb = handleOn(api)
    const ci = holding(api, secret)
    const before = api.requests.length
    for (const [handle, channel] of [[jb, 'ops'], [jb, 'ops'], [ci, 'ci'], [ci, 'ci']] as const) expect(await handle.post(channel, { text: 'hi' })).toMatchObject({ channel })
    // Neither looks the channel up, makes it, or lists channels to name it.
    expect(api.requests.slice(before).filter((request) => /\/(channels|threads)/.test(request))).toEqual(Array(4).fill('POST /boards/brd_test/threads'))
  })

  it('mints a token for a day unless it asks for longer, and for a week at most', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const lives = ({ token }: { token: { at: string; expiresAt: string } }) => Date.parse(token.expiresAt) - Date.parse(token.at)
    expect(lives(await pong.createToken({ name: 'ci' }))).toBe(86_400_000)
    expect(lives(await pong.createToken({ name: 'week', expires: '7d' }))).toBe(7 * 86_400_000)
    await expect(pong.createToken({ name: 'longer', expires: '8d' })).rejects.toMatchObject({ status: 400, code: 'invalid_expires' })
    // One that isn't a duration, as the API answers it.
    expect(await raw(api, 'project:prj_pong:production', 'POST', '/boards/brd_test/tokens', { operationId: 'op_soon', name: 'soon', expires: 'soon' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_expires' } } })
    expect([...api.tokens.values()].map((minted) => minted.name)).toEqual(['ci', 'week'])
  })

  it('says what a token may do, and until when', async () => {
    const api = fakeMessageboard()
    const { token, secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'ci', can: { 'dev/': ['read'] }, expires: '1h' })
    expect(await holding(api, secret).me()).toMatchObject({ can: { 'dev/': ['read'] }, expiresAt: token.expiresAt })
    expect(Date.parse(token.expiresAt) - Date.parse(token.at)).toBe(3_600_000)
  })

  it("runs the conformance kit on a project's board token, which mints its own, and skips watchers, which only a deployment's own credentials register", async () => {
    const api = fakeMessageboard()
    // A project that manages the board, so the grants checks that mint tokens run too.
    await handleOn(api).createGrant({ principals: [{ kind: 'project', project: 'prj_pong', environments: ['production'] }], can: { '*': 'all' } })
    const { secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'conformance' })
    const principals = { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com' }
    const report = await conformance(holding(api, secret), { withToken: (minted) => holding(api, minted), principals: { ...principals, app: 'ship' } })
    // Its tokens, minted from its own, check what a token may grant, naming the app it's given. Only the
    // check that needs a caller nothing lets in, which a repository's runs are, skips.
    const github = 'this board takes no GitHub or OIDC principals in a grant'
    const unchecked = (checks: typeof report.checks) =>
      checks.filter((check) => check.group === 'grants' && check.status !== 'passed').map(({ name, status, detail }) => ({ name, status, detail }))
    const always = [
      { name: 'lets a member grant on a pattern after a lock under it', status: 'skipped', detail: expect.any(String) },
      { name: 'lets a project on another team in, in its environments', status: 'skipped', detail: expect.any(String) },
    ]
    expect(unchecked(report.checks)).toEqual([{ name: 'lets everyone narrow what something else lets in, and lets no one in itself', status: 'skipped', detail: github }, ...always])
    // Given no app, the checks that grant to someone else name the repository, which Vercel's API refuses.
    const appless = await conformance(holding(api, secret), { withToken: (minted) => holding(api, minted), principals })
    expect(unchecked(appless.checks).filter((check) => check.detail === github).map((check) => check.name)).toEqual([
      'makes another grant for the same principals, and changes one by its ID',
      'lets everyone narrow what something else lets in, and lets no one in itself',
      "lets no token grant past its own can, even where everyone's grant closes it",
      'lets no token let anyone in where everyone gets more than the token has',
    ])
    expect(report.checks.filter((check) => check.group === 'watchers').map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: 'skipped', detail: 'only a deployment registers watchers here' },
      { status: 'skipped', detail: 'only a deployment registers watchers here' },
      { status: 'skipped', detail: "this run can't call the board with an x-board-can header" },
    ])
    // Every core and tokens check passes, but the narrowed caller's, which this run can't send the header for.
    expect(report.checks.filter((check) => check.group === 'core' || check.group === 'tokens').map((check) => [check.name, check.status]).filter(([, status]) => status !== 'passed')).toEqual([['narrows a caller to what its x-board-can says', 'skipped']])
  }, 30_000)

  it("says plainly that only a deployment's own credentials register watchers, to a person, an app, and a board token", async () => {
    const api = fakeMessageboard()
    const { secret: projects } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'deploy' })
    for (const handle of [handleOn(api), handleOn(api, 'app:oac_1'), holding(api, projects)])
      await expect(handle.register({ url: null, watch: { open: { tail: 'dev/' } } })).rejects.toMatchObject({
        status: 403,
        code: 'watchers_need_project',
        origin: 'handle',
        message: "Vercel's API takes watchers only from a deployment's own credentials.",
        hint: expect.stringContaining("Watchers in board()'s config run in this process instead."),
      })
    expect(api.registrations.size).toBe(0)
    // A pull, an ack, and a listing the API refuses the same way say the same.
    const refusing = board({
      backend: vercel({
        team: 'team_test', api: API, board: 'brd_test',
        fetch: async (input, init) => (/\/watchers/.test(new URL(new Request(input, init).url).pathname) ? Response.json({ error: { code: 'watchers_need_project', message: 'no' } }, { status: 403 }) : as(api, 'user:u_jb')(input, init)),
      }),
    })
    for (const attempt of [refusing.matches({}), refusing.ack('mat_1', { lease: 'l' }), refusing.watchers()])
      await expect(attempt).rejects.toMatchObject({ status: 403, code: 'watchers_need_project', origin: 'handle', message: "Vercel's API takes watchers only from a deployment's own credentials." })
  })

  it("mints for deployments and tokens, and says plainly to people and apps that only a deployment mints", async () => {
    const api = fakeMessageboard()
    const { token, secret } = await handleOn(api, 'project:prj_pong:production').createToken({ name: 'deploy' })
    expect(token.by).toBe('vercel:project:prj_pong:production')
    expect((await holding(api, secret).createToken({ name: 'child' })).token.parent).toBe(token.id)
    for (const principal of ['user:u_jb', 'user:u_ada', 'app:oac_1'])
      await expect(handleOn(api, principal).createToken({ name: 'ci' })).rejects.toMatchObject({
        status: 403,
        code: 'unsupported_principal',
        origin: 'handle',
        message: "Vercel's board mints board tokens only for a deployment.",
        hint: "Mint it from a deployment, with its OIDC token, or from a board token.",
      })
    expect([...api.tokens.values()].map((minted) => minted.name)).toEqual(['deploy', 'child'])
  })

  it("holds a token to its can in grants, as its minter's grants are", async () => {
    const api = fakeMessageboard()
    // A grant lets the project manage everywhere; its token only reads, and posts in ci/.
    await handleOn(api).createGrant({ principals: [{ kind: 'project', project: 'prj_pong', environments: ['production'] }], can: { '*': 'all' } })
    const pong = handleOn(api, 'project:prj_pong:production')
    const { secret } = await pong.createToken({ name: 'ci', can: { '*': ['read'], 'ci/': ['read', 'post'] } })
    const token = holding(api, secret)
    await expect(token.grants()).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
    await expect(token.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
    expect((await pong.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).grant.id).toEqual(expect.any(String))
    // Nor grant over a spot it's kept out of.
    const kept = holding(api, (await pong.createToken({ name: 'ci', can: { '*': 'all', 'ci/secret/': [] } })).secret)
    await expect(kept.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
    expect((await kept.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/open/': ['read'] } })).grant.id).toEqual(expect.any(String))
  })

  it('lists and revokes, for a token, only itself and the tokens made from it, and answers a bad scope 400 invalid_scope', async () => {
    const api = fakeMessageboard()
    const pong = handleOn(api, 'project:prj_pong:production')
    const parent = await pong.createToken({ name: 'parent' })
    const sibling = await pong.createToken({ name: 'sibling' })
    const child = await holding(api, parent.secret).createToken({ name: 'child' })
    const ids = async (handle: ReturnType<typeof board>) => (await handle.tokens()).map((listed) => listed.id).sort()
    expect(await ids(holding(api, parent.secret))).toEqual([parent.token.id, child.token.id].sort())
    expect(await ids(holding(api, child.secret))).toEqual([child.token.id])
    await expect(holding(api, parent.secret).revokeToken(sibling.token.id)).rejects.toMatchObject({ status: 404, code: 'token_not_found' })
    expect(await holding(api, parent.secret).revokeToken(child.token.id)).toEqual({ revoked: true })
    // The project sees what acts as it.
    expect(await ids(pong)).toEqual([parent.token.id, sibling.token.id].sort())
    expect(await raw(api, 'project:prj_pong:production', 'POST', '/boards/brd_test/tokens', { operationId: 'op_2', name: 'ci', can: { 'dev/': ['fly'] } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_scope' } } })
  })
})
