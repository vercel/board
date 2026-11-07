import { describe, expect, it, vi } from 'vitest'
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
import { slack } from '../src/sync/slack.ts'
import { channels, render } from '../src/sync/fn.ts'
import { as, fakeMessageboard } from './messageboard.ts'
import { fakePlatform } from './sync-fixtures.ts'

const API = 'http://localhost'

/** A handle on the fake's board through vercel(), as `principal`. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }) })

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
  it("passes the conformance kit's core, schedules, grants, attachments, and watchers, and skips sync for a person, whom Vercel's API lets sync nowhere", async () => {
    const api = fakeMessageboard()
    // The API looks names up, so the grants checks name a project, a repository, a viewer, and an app its team has.
    // A board token is its board's, so the handle it's sent on names the board.
    const withToken = (secret: string) => board({ backend: vercel({ team: 'team_test', api: API, board: 'brd_test', fetch: as(api, secret), files: api.files }) })
    const report = await conformance(handleOn(api), { withToken, principals: { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com', app: 'ship' } })
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
      'core: creates a channel only once: one a post made is there already': 'passed',
      'core: answers 404 for an ID that names nothing': 'passed',
      'core: answers 400 for a request that does not validate': 'passed',
      'schedules: schedules a reply, lists it, and cancels it': 'passed',
      'schedules: keeps noSync on a schedule, so its sends stay off every platform': 'passed',
      'grants: grants a principal, lists it, and revokes it': 'passed',
      'grants: makes another grant for the same principals, and changes one by its ID': 'passed',
      "grants: keeps a grant's can as written, a pattern with no permissions included": 'passed',
      'grants: lets the most specific pattern decide, then the closest principal there, and adds up ties': 'passed',
      'grants: lets everyone narrow what something else lets in, and lets no one in itself': 'passed',
      'grants: caps a person by their team role, so a viewer reads but neither posts nor manages': 'passed',
      'grants: names an app by its slug or client ID, keeps it by client ID, and every app as a group': 'passed',
      'grants: takes manage at each pattern a grant names to change it, and at * to list them': 'passed',
      "grants: lets no token grant past its own can, even where everyone's grant closes it": 'passed',
      'grants: lets no token let anyone in where everyone gets more than the token has': 'passed',
      'grants: lets a member grant on a pattern after a lock under it': 'skipped',
      'grants: lets a project on another team in, in its environments': 'skipped',
      'tokens: mints a token, shows its secret only then, lists it, and revokes it': 'passed',
      "tokens: lets a token do what its can says, as whoever minted it, and nothing once it's revoked": 'passed',
      'attachments: takes a file, posts it, and gives it back': 'passed',
      'watchers: matches a registered tail, hands the match to a pull, and takes its ack': 'passed',
      'watchers: wakes by path only where its discovery says so, and only a Vercel project': 'passed',
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

  it("registers its own watchers where it's woken, and runs what they matched when it is", async () => {
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
    expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ url: 'https://pong.example/api/board' })
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

  it("passes the conformance kit's sync as a project, through Vercel's API's sync routes", async () => {
    const report = await conformance(handleOn(fakeMessageboard(), 'project:prj_pong:production'))
    expect(Object.fromEntries(report.checks.filter((check) => check.group === 'sync').map((check) => [check.name, check.status]))).toEqual({
      "keeps sync's records: an import as a platform author, its lookups by platform ID, a receipt, and where it's synced": 'passed',
      "queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'passed',
      'hands a sync each message change as a match of its @sync watcher': 'passed',
      'keeps noSync on a post and a reply, so sync sends neither': 'passed',
    })
  }, 30_000)

  it("passes the conformance kit's watchers as a project too, registering a path on its own project", async () => {
    const report = await conformance(handleOn(fakeMessageboard(), 'project:prj_pong:production'))
    expect(report.checks.filter((check) => check.group === 'watchers').map((check) => check.status)).toEqual(['passed', 'passed'])
  }, 30_000)

  it('registers a path on its own project on Vercel, which the API wakes through its Deployment Protection', async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    try {
      const api = fakeMessageboard()
      const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
      board({ backend, url: 'https://pong.vercel.app/api/board', watch: { ping: { tail: 'pings', run: async () => {} } } })
      expect(await backend.registerWatchers()).toMatchObject({ url: null, path: '/api/board' })
      expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ url: null, path: '/api/board' })
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
      await vi.waitFor(() => expect(api.registrations.get('vercel:project:prj_pong:production')).toMatchObject({ url: 'https://pong.example/api/board' }))
    } finally {
      clock.mockRestore()
      errors.mockRestore()
    }
  })

  it("turns a tail into the API's filter, and refuses what the API can't match", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.register({ url: null, watch: { open: { tail: 'dev/ --label status=open|draft --text "is failing"' }, mine: { tail: 'general --by me' } } })
    expect(api.registrations.get('vercel:user:u_jb')?.watch).toEqual({
      open: { filter: { channelTree: 'dev', text: 'is failing', labels: [{ key: 'status', values: ['open', 'draft'] }] }, when: 'matches' },
      mine: { filter: { channelIds: ['general'], authors: ['vercel:user:u_jb'] }, when: 'matches' },
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

  it("syncs Slack through the engine from its first webhook, a file as an attachment on the board, and a board reply back to Slack", async () => {
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
        ['slack', 'the export page', [{ id: expect.any(String), name: 'shot.png', type: 'image/png', size: png.byteLength }]],
      ])
    })
    const [root] = (await julian.messages({ channel: 'general' })).messages
    // Anyone who reads the board reads the file, not only the project that uploaded it.
    expect(new Uint8Array(await (await julian.download(root!.attachments![0]!.id)).arrayBuffer())).toEqual(png)
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
    const watch = { w: { tail: 'general', when: 'matches' as const } }
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
        { kind: 'github', repository: 'acme/web', workflow: 'ci.yml' },
        { kind: 'app', app: 'ship' },
      ],
      can: { 'security/': 'all' },
    })
    expect(grant.principals).toEqual([
      { kind: 'user', userId: 'u_ada', email: 'ada@acme.com' },
      { kind: 'project', projectId: 'prj_web', name: 'web', environments: ['production'], teamId: 'team_test' },
      { kind: 'github', repositoryId: '700001', repository: 'acme/web', workflow: 'ci.yml' },
      { kind: 'app', clientId: 'oac_1', name: 'ship' },
    ])
    // A project it names already gets the new environments.
    const joined = await jb.updateGrant(grant.id, { add: [{ kind: 'project', project: 'prj_web', environments: ['preview'] }] })
    expect(joined.grant.principals[1]).toEqual({ kind: 'project', projectId: 'prj_web', name: 'web', environments: ['production', 'preview'], teamId: 'team_test' })
    const updated = await jb.updateGrant(grant.id, { add: [{ kind: 'user', email: 'bob@acme.com' }], remove: [{ kind: 'project', project: 'web' }, { kind: 'app', app: 'oac_1' }] })
    expect(updated.grant.principals.map((principal) => ('userId' in principal ? principal.userId : principal.kind))).toEqual(['u_ada', 'github', 'u_bob'])
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
    // Its grant lets the run in, and says nothing of ci.
    expect(await jb.explain('ci', { github: 'acme/web', workflow: 'ci.yml' })).toMatchObject({ pattern: null, level: null, grants: [], can: [] })
    await jb.createGrant({ principals: [{ kind: 'oidc', issuer: 'https://gitlab.com', claims: { project_id: '42' } }], can: { 'ci/': ['post'] } })
    expect(await jb.explain('ci', { oidc: 'https://gitlab.com', claims: { project_id: '42' } })).toMatchObject({ pattern: 'ci/', level: 'principal', can: ['post'] })
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
    const { token } = await jb.createToken({ name: 'ci', can: { 'ci/': ['post'] }, expires: '1d' })
    expect(token.at).toBe(new Date(Date.parse(token.at)).toISOString())
    expect(Date.parse(token.expiresAt) - Date.parse(token.at)).toBe(86_400_000)
    expect(await jb.tokens()).toMatchObject([{ id: token.id, at: token.at, expiresAt: token.expiresAt }])
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

  it("runs the conformance kit on a board token, and skips watchers, which a board token can't register yet", async () => {
    const api = fakeMessageboard()
    const { secret } = await handleOn(api).createToken({ name: 'conformance' })
    const report = await conformance(holding(api, secret), { withToken: (minted) => holding(api, minted) })
    expect(report.checks.filter((check) => check.group === 'watchers').map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: 'skipped', detail: "a board token can't register watchers yet" },
      { status: 'skipped', detail: "a board token can't register watchers yet" },
    ])
    expect(report.checks.filter((check) => check.group === 'core' || check.group === 'tokens').every((check) => check.status === 'passed')).toBe(true)
  })

  it('shows a secret once, sends it as it is, and answers a retried mint 409 token_already_minted', async () => {
    const api = fakeMessageboard()
    const ada = handleOn(api, 'user:u_ada')
    const { secret } = await ada.createToken({ name: 'ci' })
    expect(JSON.stringify(await ada.tokens())).not.toContain(secret)
    expect((await holding(api, secret).me()).principal).toBe('vercel:user:u_ada')
    const mint = { operationId: 'op_1', name: 'ci' }
    expect((await raw(api, 'user:u_ada', 'POST', '/boards/brd_test/tokens', mint)).status).toBe(200)
    expect(await raw(api, 'user:u_ada', 'POST', '/boards/brd_test/tokens', mint)).toMatchObject({ status: 409, body: { error: { code: 'token_already_minted' } } })
  })

  it("answers 401 invalid_token for a token that's unknown, revoked, expired, or whose person left the team", async () => {
    const api = fakeMessageboard()
    const ada = handleOn(api, 'user:u_ada')
    const [revoked, expired, left] = await Promise.all(['revoked', 'expired', 'left'].map((name) => ada.createToken({ name })))
    await ada.revokeToken(revoked!.token.id)
    api.tokens.get(expired!.token.id)!.expiresAt = Date.now() - 1
    expect((await holding(api, left!.secret).me()).principal).toBe('vercel:user:u_ada')
    api.leave('u_ada')
    for (const secret of ['not-a-token', revoked!.secret, expired!.secret, left!.secret])
      await expect(holding(api, secret).me()).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
  })

  it("answers 404 board_not_found on a board that isn't the token's, and says plainly that it reaches no team route", async () => {
    const api = fakeMessageboard({ boards: [{ name: 'Security', id: 'brd_sec' }] })
    const { secret } = await handleOn(api).createToken({ name: 'ci' })
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

  it('says what a token may do, and until when', async () => {
    const api = fakeMessageboard()
    const { token, secret } = await handleOn(api).createToken({ name: 'ci', can: { 'dev/': ['read'] }, expires: '1h' })
    expect(await holding(api, secret).me()).toMatchObject({ can: { 'dev/': ['read'] }, expiresAt: token.expiresAt })
    expect(Date.parse(token.expiresAt) - Date.parse(token.at)).toBe(3_600_000)
  })

  it("says plainly that a board token can't register watchers yet", async () => {
    const api = fakeMessageboard()
    const { secret } = await handleOn(api).createToken({ name: 'ci' })
    await expect(holding(api, secret).register({ url: null, watch: { open: { tail: 'dev/' } } })).rejects.toMatchObject({
      status: 403,
      code: 'board_token_unsupported',
      origin: 'handle',
      message: "a board token can't register watchers yet.",
    })
    expect(api.registrations.size).toBe(0)
  })

  it("mints for people, deployments, and tokens, and answers 403 unsupported_principal to apps and development tokens that carry a person", async () => {
    const api = fakeMessageboard()
    const { token, secret } = await handleOn(api).createToken({ name: 'ci' })
    expect((await holding(api, secret).createToken({ name: 'child' })).token.parent).toBe(token.id)
    expect((await handleOn(api, 'project:prj_pong:production').createToken({ name: 'deploy' })).token.by).toBe('vercel:project:prj_pong:production')
    for (const principal of ['app:oac_1', 'user:u_jb:development'])
      await expect(handleOn(api, principal).createToken({ name: 'ci' })).rejects.toMatchObject({ status: 403, code: 'unsupported_principal' })
  })

  it("holds a token to its can in grants, as its minter's grants and role are", async () => {
    const api = fakeMessageboard()
    // Ada is a member, who manages everywhere; her token only reads, and posts in ci/.
    const { secret } = await handleOn(api, 'user:u_ada').createToken({ name: 'ci', can: { '*': ['read'], 'ci/': ['read', 'post'] } })
    const token = holding(api, secret)
    await expect(token.grants()).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
    await expect(token.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
    expect((await handleOn(api, 'user:u_ada').createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).grant.id).toEqual(expect.any(String))
    // Nor grant over a spot it's kept out of.
    const kept = holding(api, (await handleOn(api, 'user:u_ada').createToken({ name: 'ci', can: { '*': 'all', 'ci/secret/': [] } })).secret)
    await expect(kept.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
    expect((await kept.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/open/': ['read'] } })).grant.id).toEqual(expect.any(String))
    // An owner's token too.
    const owners = holding(api, (await handleOn(api, 'user:u_jb').createToken({ name: 'ci', can: { '*': ['read'] } })).secret)
    await expect(owners.createGrant({ principals: [{ kind: 'user', email: 'bob@acme.com' }], can: { 'ci/': ['read'] } })).rejects.toMatchObject({ status: 403, code: 'grant_forbidden' })
  })

  it('lists and revokes, for a token, only itself and the tokens made from it, and answers a bad scope 400 invalid_scope', async () => {
    const api = fakeMessageboard()
    const ada = handleOn(api, 'user:u_ada')
    const parent = await ada.createToken({ name: 'parent' })
    const sibling = await ada.createToken({ name: 'sibling' })
    const child = await holding(api, parent.secret).createToken({ name: 'child' })
    const ids = async (handle: ReturnType<typeof board>) => (await handle.tokens()).map((listed) => listed.id).sort()
    expect(await ids(holding(api, parent.secret))).toEqual([parent.token.id, child.token.id].sort())
    expect(await ids(holding(api, child.secret))).toEqual([child.token.id])
    await expect(holding(api, parent.secret).revokeToken(sibling.token.id)).rejects.toMatchObject({ status: 404, code: 'token_not_found' })
    expect(await holding(api, parent.secret).revokeToken(child.token.id)).toEqual({ revoked: true })
    // Ada sees what acts as her.
    expect(await ids(ada)).toEqual([parent.token.id, sibling.token.id].sort())
    expect(await raw(api, 'user:u_ada', 'POST', '/boards/brd_test/tokens', { operationId: 'op_2', name: 'ci', can: { 'dev/': ['fly'] } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_scope' } } })
  })
})
