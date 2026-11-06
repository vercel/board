import { describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { createBoardClient } from '../src/client/client.ts'
import { ATTACHMENT_BYTES_MAX } from '../src/contract/files.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { conformance } from '../src/conformance/index.ts'
import { compileAccess, type Can } from '../src/server/access.ts'
import type { Caller } from '../src/server/backend.ts'
import type { Middleware } from '../src/server/middleware.ts'
import { as, fakeMessageboard } from './messageboard.ts'

const API = 'http://localhost'

/** A handle on the fake's board through vercel(), as `principal`. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }) })

const ADA = { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada', name: 'Ada' } as const
/** The project's own deployment, as its agent calls the board it runs with that deployment's token. */
const FACTORY = { id: 'vercel:project:prj_pong:production', kind: 'deployment', handle: 'factory', name: 'factory' } as const

/**
 * A vercel() board that serves its callers over HTTP, as the factory's does, with `middleware`:
 * `factory` is the project itself (its deployment's token), `ada` anyone else. `via` is a handle on
 * it as one of them, and `client` a client as one of them that reaches Vercel's storage itself.
 */
function gateway(api: ReturnType<typeof fakeMessageboard>, middleware: Middleware[]) {
  const callers = { factory: FACTORY, ada: ADA }
  const pong = board({
    backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
    url: 'https://pong.example/api/board',
    authenticate: async (request) => callers[request.headers.get('authorization')?.replace(/^Bearer /, '') as keyof typeof callers] ?? null,
    access: [() => 'all'],
    middleware,
  })
  const via = (name: keyof typeof callers) =>
    board({
      backend: http('https://pong.example/api/board', {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers)
          headers.set('authorization', `Bearer ${name}`)
          return pong.fetch(new Request(input, { ...init, headers }))
        },
      }),
    }).as(null)
  const client = (name: keyof typeof callers) =>
    createBoardClient({ url: 'https://pong.example/api/board', token: name, fetch: ((input, init) => pong.fetch(new Request(input, init))) as typeof fetch, storeFetch: api.files })
  return { pong, via, client }
}

/** A caller board() verified, with `can`: what a board with an `access` passes its backend. Ada by default. */
const verified = (can: Can, who: { id: string; kind: string; handle: string; name: string } = ADA) =>
  ({
    identity: {
      principal: { id: who.id, access: compileAccess(can), expiresAt: null },
      author: { actor: who.id, principal: who.id, profile: null, session: null },
      actor: { id: who.id, kind: who.kind, handle: who.handle, name: who.name, avatar: null },
    },
    origin: { via: null },
  }) as unknown as Caller

describe('vercel()', () => {
  it("passes the conformance kit's core, attachments, and watchers, and fails what sync needs of Vercel's API", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api), { withToken: () => handleOn(api) })
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
      'schedules: keeps noSync on a schedule, so its sends stay off every platform': 'failed',
      // Vercel's API keeps neither grants nor tokens in the protocol's shapes yet.
      'grants: grants a project, lists it, takes the same grant again as one, and revokes it': 'failed',
      "grants: changes a grant's can when it's set again": 'failed',
      "grants: grants a GitHub repository's workflows, and another team's project": 'failed',
      'grants: keeps two environments of one project as two grants, and revokes one without the other': 'failed',
      'tokens: mints a token, shows its secret only then, lists it, and revokes it': 'failed',
      "tokens: lets a token do what its can says, as whoever minted it, and nothing once it's revoked": 'failed',
      'attachments: takes a file, posts it, and gives it back': 'passed',
      'watchers: matches a registered tail, hands the match to a pull, and takes its ack': 'passed',
      'watchers: wakes by path only where its discovery says so, and only a Vercel project': 'passed',
      "sync: keeps sync's records: an import as a platform author, its lookups by platform ID, a receipt, and where it's synced": 'failed',
      "sync: queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'failed',
      'sync: hands a sync each message change as a match of its @sync watcher': 'failed',
      'sync: keeps noSync on a post and a reply, so sync sends neither': 'failed',
    })
  }, 30_000)

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

  it('makes a channel in the API before anything posts to it, once, and only for a caller that reads and posts there', async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    expect(await team.createChannel('dev/alerts')).toEqual({ channel: { path: 'dev/alerts' }, created: true })
    expect(await team.createChannel('dev/alerts')).toMatchObject({ created: false })
    // One a post made, or another handle, is there already.
    await team.post('ops', { text: 'hi' })
    expect(await team.createChannel('ops')).toMatchObject({ created: false })
    expect(await handleOn(api, 'user:u_ada').createChannel('dev/alerts')).toMatchObject({ created: false })

    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
    const signal = new AbortController().signal
    await expect(backend.createChannel(verified({ 'feedback/': ['post'] }), { path: 'feedback/acme' }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.createChannel(verified({ 'dev/': ['read'] }), { path: 'dev/web' }, signal)).rejects.toMatchObject({ status: 403 })
    expect(await backend.createChannel(verified({ 'dev/': ['read', 'post'] }), { path: 'dev/web' }, signal)).toMatchObject({ created: true })
    // What it refused never reached the API: the board's own general, and what it made.
    expect((await team.channels()).map((c) => c.path).sort()).toEqual(['dev/alerts', 'dev/web', 'general', 'ops'])
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

  it("keeps a verified caller to its grants, which the API can't check for it", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api, 'project:prj_pong:production')
    const dev = await team.post('dev', { text: 'dev' })
    const ops = await team.post('ops', { text: 'ops' })
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
    const ada = verified({ 'dev/': ['read', 'post'] })
    const signal = new AbortController().signal
    const read = async (query: object) => (await backend.messages(ada, query as never, signal)).messages.map((m) => m.text)
    expect(await read({})).toEqual(['dev'])
    expect(await read({ channel: 'ops' })).toEqual([])
    expect((await backend.channels(ada, {}, signal)).channels.map((c) => c.path)).toEqual(['dev'])
    await expect(backend.message(ada, { id: ops.id }, signal)).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
    await expect(backend.post(ada, { channel: 'ops', text: 'hi' } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.post(ada, { re: ops.id, text: 'hi' } as never, signal)).rejects.toMatchObject({ status: 404 })
    await expect(backend.post(ada, { channel: 'dev', text: 'hi', labels: { state: 'open' } } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.react(ada, { id: dev.id, emoji: 'eyes' }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.label(ada, { id: dev.id, set: { state: 'open' } }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.events(ada, { channel: 'ops' } as never, signal)).resolves.toMatchObject({ events: [] })
    await backend.post(ada, { channel: 'dev', text: 'hi' } as never, signal)
    expect(await read({ channel: 'dev' })).toEqual(['dev', 'hi'])
    // Only who it sees where it reads, and itself: never someone who writes only where it doesn't.
    await handleOn(api, 'user:u_ops').post('ops', { text: 'ops only' })
    const ids = async (caller: Caller) => (await backend.actors(caller, {}, signal)).actors.map((a) => a.id).sort()
    expect(await ids(ada)).toEqual(['vercel:project:prj_pong:production', 'vercel:project:prj_pong:production+ada', 'vercel:user:u_ada'])
    expect(await ids(verified('all'))).toContain('vercel:user:u_ops')
  })

  it("gives a verified caller a file only through a message it reads, and none once that message is deleted", async () => {
    const api = fakeMessageboard()
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const ada = verified({ 'dev/': ['read'] })
    const signal = new AbortController().signal
    const upload = async () => (await backend.upload(project, { data: new TextEncoder().encode('log'), name: 'a.log', type: 'text/plain' }, signal)).attachment
    const unposted = await upload()
    await expect(backend.attachment(ada, { id: unposted.id }, signal)).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' })
    const file = await upload()
    const { message } = await backend.post(project, { channel: 'dev', text: '', attachments: [file.id] } as never, signal)
    await expect(backend.attachment(ada, { id: file.id }, signal)).resolves.toMatchObject({ attachment: { id: file.id } })
    await backend.delete(project, { id: message.id }, signal)
    await expect(backend.attachment(project, { id: file.id }, signal)).resolves.toMatchObject({ attachment: { id: file.id } })
    await expect(backend.attachment(ada, { id: file.id }, signal)).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' })
  })

  it("refuses a verified caller's post or reply with files, which could only be the project's", async () => {
    const api = fakeMessageboard()
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const ada = verified({ 'dev/': ['read', 'post'] })
    const signal = new AbortController().signal
    const { attachment: file } = await backend.upload(project, { data: new TextEncoder().encode('log'), name: 'a.log', type: 'text/plain' }, signal)
    const { message: root } = await backend.post(project, { channel: 'dev', text: 'root' } as never, signal)
    await expect(backend.post(ada, { channel: 'dev', text: '', attachments: [file.id] } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.post(ada, { re: root.id, text: '', attachments: [file.id] } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.attachment(ada, { id: file.id }, signal)).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' })
    await expect(backend.post(project, { re: root.id, text: '', attachments: [file.id] } as never, signal)).resolves.toMatchObject({ message: { attachments: [{ id: file.id }] } })
  })

  it('lets a caller that is the project upload files, past a request straight to storage, and post them, and refuses anyone else', async () => {
    const api = fakeMessageboard()
    // Any middleware has board() look up a post's files first, as the caller, before they're posted.
    const screened: string[][] = []
    const { client } = gateway(api, [
      async ({ write, next }) => {
        if (write.kind === 'post') screened.push(write.attachments.map((file) => file.name))
        await next()
      },
    ])
    const factory = client('factory')
    const log = await factory.upload({ data: new TextEncoder().encode('log'), name: 'a.log' })
    // Bigger than a request takes: the client sends it to Vercel's storage on the URL the API signs.
    const video = new Uint8Array(ATTACHMENT_BYTES_MAX + 1).fill(7)
    const after = await factory.upload({ data: video, name: 'after.mp4', type: 'video/mp4' })
    expect(api.requests.filter((r) => r.endsWith('/complete'))).toHaveLength(2)
    const posted = await factory.post('dev', { text: 'before and after', attachments: [log.id, after.id] })
    expect(posted.attachments.map((file) => file.id)).toEqual([log.id, after.id])
    expect(screened).toEqual([['a.log', 'after.mp4']])
    expect(Buffer.from(await (await factory.download(after.id)).arrayBuffer()).equals(Buffer.from(video))).toBe(true)
    // Anyone else would be uploading and posting the project's files.
    const ada = client('ada')
    await expect(ada.upload({ data: new TextEncoder().encode('log'), name: 'b.log' })).rejects.toMatchObject({ status: 403 })
    await expect(ada.upload({ data: video, name: 'big.mp4', type: 'video/mp4' })).rejects.toMatchObject({ status: 403 })
    const unposted = await factory.upload({ data: new TextEncoder().encode('mine'), name: 'c.log' })
    // Its file isn't one Ada may have: as missing to her as one that isn't there.
    await expect(ada.post('dev', { text: 'not mine', attachments: [unposted.id] })).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' })
  })

  it("refuses a direct upload without its bytes' SHA-256, which Vercel's API signs the upload for, and anyone else finishing the project's", async () => {
    const backend = vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'project:prj_pong:production') })
    const project = { self: null, origin: { via: { kind: 'client', name: null } } } as Caller
    const signal = new AbortController().signal
    const file = { name: 'big.mp4', type: 'video/mp4', size: 5 * 1024 * 1024 }
    await expect(backend.uploadStart(project, file, signal)).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
    const ticket = await backend.uploadStart(project, { ...file, sha256: `${'A'.repeat(43)}=` }, signal)
    await expect(backend.uploadFinish(verified('all'), { id: ticket.id }, signal)).rejects.toMatchObject({ status: 403 })
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

  it("makes the team's board the first time a person uses it, and tells a project it needs a grant", async () => {
    const pong = handleOn(fakeMessageboard({ boardId: null }), 'project:prj_pong:production')
    await expect(pong.post('dev', { text: 'hello' })).rejects.toMatchObject({ status: 404, code: 'no_board' })
    const api = fakeMessageboard({ boardId: null })
    await handleOn(api).post('dev', { text: 'hello' })
    expect(api.requests.filter((r) => r === 'POST /boards/default')).toHaveLength(1)
    expect((await handleOn(api).messages({ channel: 'dev' })).messages.map((m) => m.text)).toEqual(['hello'])
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

  it('lets a verified caller that is the project edit, delete, schedule, and cancel where it posts, and nowhere else', async () => {
    const api = fakeMessageboard()
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
    const pong = handleOn(api, 'project:prj_pong:production')
    const dev = await pong.post('dev', { text: 'dev' })
    const ops = await pong.post('ops', { text: 'ops' })
    const secret = await pong.post('secret', { text: 'secret' })
    const inDev = await pong.as('claude').schedule({ re: dev.id }, { text: 'dev later', in: '1h' })
    const inOps = await pong.schedule({ re: ops.id }, { text: 'ops later', in: '1h' })
    const inSecret = await pong.schedule({ re: secret.id }, { text: 'secret later', in: '1h' })
    const factory = verified({ 'dev/': ['read', 'post'], ops: ['read'] }, FACTORY)
    const signal = new AbortController().signal
    // What the project wrote, under any of its profiles, where the caller posts.
    await backend.edit(factory, { id: dev.id, text: 'dev, edited' }, signal)
    expect((await pong.thread(dev.id)).message.text).toBe('dev, edited')
    const { schedule } = await backend.schedule(factory, { re: dev.id, text: 'mine', in: '1h' } as never, signal)
    expect(schedule).toMatchObject({ re: dev.id, by: { principal: FACTORY.id, profile: 'factory' } })
    await expect(backend.cancelSchedule(factory, { id: inDev.id }, signal)).resolves.toMatchObject({ canceled: true })
    const reply = await pong.reply(dev.id, { text: 'a reply' })
    await backend.delete(factory, { id: reply.id }, signal)
    expect((await pong.thread(dev.id)).replies[0]).toMatchObject({ id: reply.id, deleted: true })
    // Where it only reads, 403; where it can't read, as missing as anything else there.
    await expect(backend.edit(factory, { id: ops.id, text: 'no' }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.delete(factory, { id: ops.id }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.schedule(factory, { re: ops.id, text: 'no', in: '1h' } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.schedule(factory, { channel: 'ops', text: 'no', in: '1h' } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.cancelSchedule(factory, { id: inOps.id }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.edit(factory, { id: secret.id, text: 'no' }, signal)).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
    await expect(backend.cancelSchedule(factory, { id: inSecret.id }, signal)).rejects.toMatchObject({ status: 404, code: 'schedule_not_found' })
    expect((await pong.thread(ops.id)).message.text).toBe('ops')
    expect(api.schedules.get(inOps.id)?.state).toBe('pending')
    // And it lists only the schedules where it reads.
    expect((await backend.schedules(factory, {}, signal)).schedules.map((s) => s.id)).toEqual([inOps.id, schedule.id])
    expect((await backend.schedules(factory, { re: secret.id }, signal)).schedules).toEqual([])
  })

  it('refuses any other caller it serves an edit, delete, schedule, or cancel, which would change what the project wrote for others', async () => {
    const api = fakeMessageboard()
    const backend = vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') })
    const pong = handleOn(api, 'project:prj_pong:production')
    const dev = await pong.post('dev', { text: 'dev' })
    const later = await pong.schedule({ re: dev.id }, { text: 'later', in: '1h' })
    const ada = verified('all')
    const signal = new AbortController().signal
    await expect(backend.edit(ada, { id: dev.id, text: 'no' }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.delete(ada, { id: dev.id }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.schedule(ada, { re: dev.id, text: 'no', in: '1h' } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.cancelSchedule(ada, { id: later.id }, signal)).rejects.toMatchObject({ status: 403 })
    expect((await pong.thread(dev.id)).message).toMatchObject({ text: 'dev', deleted: false })
    expect([...api.schedules.values()].map((s) => [s.id, s.state])).toEqual([[later.id, 'pending']])
    // It still posts, reacts, and reads them, as the project.
    await expect(backend.post(ada, { re: dev.id, text: 'a reply' } as never, signal)).resolves.toMatchObject({ message: { by: { profile: 'ada' } } })
    expect((await backend.schedules(ada, {}, signal)).schedules.map((s) => s.id)).toEqual([later.id])
  })

  it("runs board()'s middleware on an edit by a caller that is the project, and refuses anyone else's before it", async () => {
    const api = fakeMessageboard()
    const screened: string[] = []
    const { via } = gateway(api, [
      async ({ write, next }) => {
        screened.push(`${write.kind} ${write.text}`)
        await next({ text: write.text.toUpperCase() })
      },
    ])
    const factory = via('factory')
    const { id } = await factory.post('dev', { text: 'hello' })
    await factory.edit(id, 'edited')
    await expect(via('ada').edit(id, 'sneaky')).rejects.toMatchObject({ status: 403 })
    expect(screened).toEqual(['post hello', 'edit edited'])
    expect((await factory.thread(id)).message.text).toBe('EDITED')
  })

  it("screens a schedule's message through board()'s middleware when it's made, since Vercel's API posts its sends", async () => {
    const api = fakeMessageboard()
    const screened: string[] = []
    const { pong, via } = gateway(api, [
      async ({ write, respond, next }) => {
        screened.push(`${write.kind} ${write.channel} ${write.text}`)
        // As the factory's memory judge does: a note it rejects never lands.
        if (write.channel.startsWith('memory/')) return respond('Memory note not saved: rejected')
        await next({ text: write.text.toUpperCase() })
      },
    ])
    const root = await pong.post('dev', { text: 'root' })
    const own = await pong.schedule({ re: root.id }, { text: 'check in', in: '1h' })
    const agent = await via('factory').schedule({ re: root.id }, { text: 'check later', in: '2h' })
    expect([own.id, agent.id].map((id) => api.schedules.get(id)?.text)).toEqual(['CHECK IN', 'CHECK LATER'])
    await expect(via('factory').schedule('memory/notes', { text: 'remember this', in: '1m' })).rejects.toMatchObject({ status: 422, code: 'dropped' })
    await expect(pong.schedule('memory/notes', { text: 'and this', in: '1m' })).rejects.toMatchObject({ status: 422, code: 'dropped' })
    expect(api.schedules.size).toBe(2)
    expect(screened).toEqual(['post dev root', 'post dev check in', 'post dev check later', 'post memory/notes remember this', 'post memory/notes and this'])
  })

  it('refuses watchers for a caller it serves, which would replace the deployment\'s own', async () => {
    const backend = vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'project:prj_pong:production') })
    const signal = new AbortController().signal
    await expect(backend.register(verified('all'), { url: null, watch: { w: { tail: 'general' } } } as never, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.matches(verified('all'), {}, signal)).rejects.toMatchObject({ status: 403 })
  })

  it("sends grants and tokens to Vercel's API as the protocol has them, which answers what it doesn't keep yet", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    await expect(jb.createGrant({ issuer: 'github', claims: { repository: 'acme/web' }, can: { 'ci/': ['post'] } })).rejects.toMatchObject({ status: 404 })
    await expect(jb.createToken({ name: 'widget', can: { 'feedback/': ['post'] } })).rejects.toMatchObject({ status: 404 })
    expect(api.requests).toEqual(expect.arrayContaining(['POST /boards/brd_test/grants', 'POST /boards/brd_test/tokens']))
  })

  it("refuses a caller it serves grants and tokens, which would act as whoever its credentials are", async () => {
    // A person's credentials, which Vercel's API lets change grants: only the board's own code may use them for it.
    const backend = vercel({ team: 'team_test', api: API, fetch: as(fakeMessageboard(), 'user:u_jb') })
    const signal = new AbortController().signal
    await expect(backend.createGrant(verified('all'), { issuer: 'vercel', claims: { project_id: 'prj_x', environment: 'production' } }, signal)).rejects.toMatchObject({ status: 403 })
    await expect(backend.createToken(verified('all'), { name: 'x' }, signal)).rejects.toMatchObject({ status: 403 })
  })
})
