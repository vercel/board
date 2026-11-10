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
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'

const API = 'http://localhost'

/** A handle on the fake's board through vercel(), as `principal`. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }) })

/** The same handle, with `headers` on every request, as `vb conformance` sends them to Vercel's API. */
const withHeadersOn =
  (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  (headers: Record<string, string>) =>
    board({
      backend: vercel({
        team: 'team_test',
        api: API,
        // In init, where as() reads them: a Request's own headers it would drop.
        fetch: (input, init = {}) => {
          const sent = new Headers(init.headers)
          for (const [name, value] of Object.entries(headers)) sent.set(name, value)
          return as(api, principal)(input, { ...init, headers: sent })
        },
        files: api.files,
      }),
    })

/** The checks of who writes: what a run with headers of its own checks. */
const IDENTITY = [
  'core: takes a profile and its avatar as one x-board-profile header, and shows both on what it writes',
  "core: ignores x-board-avatar, which x-board-profile's avatar parameter replaced",
  'core: ignores x-board-session: who writes is the principal and its profile',
  'core: shows no session on a message, its event, or you',
]

/** Someone a host's verifier would name: a request from her is still no one's this board serves. */
const ADA = { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } as const

/** The project's own board on Vercel's, as its deployment runs it, with `middleware`: what board() serves is its own code. */
const PONG_URL = 'https://pong.example/api/board'
const WEB_URL = 'https://web.example/api/board'
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
    const report = await conformance(handleOn(api), { withHeaders: withHeadersOn(api), principals: { project: 'prj_web', repository: 'acme/api', viewer: 'val@acme.com', app: 'ship' } })
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
      "core: matches text anywhere in a message's own, in any case, as it reads now": 'passed',
      'core: reads events after a cursor, each with a cursor of its own': 'passed',
      'core: holds a long-poll open until the next event': 'passed',
      'core: deletes a message, leaving a tombstone': 'passed',
      'core: lists the channel and you in it': 'passed',
      'core: narrows a caller to what its x-board-can says': 'passed',
      // It reads x-board-profile as a name alone, and an avatar from x-board-avatar.
      [IDENTITY[0]!]: 'failed',
      'core: lets a profile change only its own messages, and its principal all of them': 'passed',
      [IDENTITY[1]!]: 'failed',
      // It keeps a session on actors, which vercel() maps no view of.
      [IDENTITY[2]!]: 'passed',
      [IDENTITY[3]!]: 'passed',
      "watchers: refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking": 'passed',
      // A person keeps no sync's records, narrowed or not.
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
      'grants: takes manage at each pattern a grant names to change it, and at * to list them': 'passed',
      "grants: lets no caller narrowed with x-board-can grant past its can, even where everyone's grant closes it": 'passed',
      'grants: lets no caller narrowed with x-board-can let anyone in where everyone gets more than it has': 'passed',
      'grants: lets a member grant on a pattern after a lock under it': 'skipped',
      'grants: lets a project on another team in, in its environments': 'skipped',
      'schemas: lists the built-in schemas first, and reads a schema by its ID': 'passed',
      'schemas: registers a schema version once: the same definition again changes nothing, and another is refused': 'passed',
      "schemas: refuses a built-in's name, and a definition it couldn't check a value against": 'passed',
      'schemas: carries a block in a message, checked against the schema its fence names': 'passed',
      'schemas: refuses a caller narrowed with x-board-can a schema, and lets it read them': 'passed',
      'attachments: takes a file, posts it, and gives it back': 'passed',
      'watchers: matches a registered tail, hands the match to a pull, and takes its ack': 'skipped',
      'watchers: wakes by path only where its discovery says so, and only a Vercel project': 'skipped',
      "sync: keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced": 'skipped',
      "sync: queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'skipped',
      "sync: takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one": 'skipped',
      'sync: hands a sync each message change as a match of its @sync watcher': 'skipped',
      'sync: keeps noSync on a post and a reply, so sync sends neither': 'passed',
    })
    // It leaves the grants as it found them.
    expect([...api.grants.keys()]).toEqual(['g1', 'g2', 'g3'])
  }, 30_000)

  it("passes the conformance kit's checks of who writes against an API that reads them as board's protocol has it, and says how today's fails", async () => {
    const statuses = (report: Awaited<ReturnType<typeof conformance>>) =>
      report.checks.filter((check) => IDENTITY.includes(`${check.group}: ${check.name}`)).map((check) => [check.status, check.detail ?? null])
    const conforming = fakeMessageboard({ protocolProfile: true })
    expect(statuses(await conformance(handleOn(conforming), { withHeaders: withHeadersOn(conforming) }))).toEqual(IDENTITY.map(() => ['passed', null]))
    const today = fakeMessageboard()
    expect(statuses(await conformance(handleOn(today), { withHeaders: withHeadersOn(today) }))).toEqual([
      // It takes the whole header as the profile's name.
      ['failed', expect.stringMatching(/^the profile its header names: expected "conformance-[0-9a-f]{8}", got "conformance-[0-9a-f]{8}; avatar=\\"https:\/\/example\.com\/conformance\.png\\""$/)],
      // It shows the avatar x-board-avatar names, which board's protocol reads from the profile's header alone.
      ['failed', `the avatar of a profile whose header names none, whatever x-board-avatar says: expected null, got "https://example.com/conformance.png"`],
      // It keeps a session, which vercel() maps no view of.
      ['passed', null],
      ['passed', null],
    ])
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

  it("leaves a channel path's length to Vercel's API: a path the board takes but the API doesn't fails with the API's error", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    await julian.post(`ops/${'a'.repeat(76)}`, 'fits')
    await expect(julian.post(`ops/${'a'.repeat(77)}`, 'too long for the API')).rejects.toMatchObject({ status: 400, code: 'invalid_channel_name' })
  })

  it("leaves a message's length to Vercel's API: text over its limit fails with the API's error, on a post, a reply, and an edit", async () => {
    const api = fakeMessageboard()
    const julian = handleOn(api)
    const tooLong = { status: 400, code: 'invalid_message' }
    await expect(julian.post('dev', 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    const { id: root } = await julian.post('dev', 'hi')
    await expect(julian.reply(root, 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    await expect(julian.edit(root, 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    const thread = await julian.thread(root)
    expect([thread.message.text, thread.replies]).toEqual(['hi', []])
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

  it("sends an agent's avatar as Vercel's API reads it today: its name alone in x-board-profile, and the avatar in x-board-avatar", async () => {
    const api = fakeMessageboard()
    const sent: Headers[] = []
    const recording: typeof fetch = async (input, init) => {
      sent.push(new Headers(init?.headers))
      return as(api, 'user:u_jb')(input, init)
    }
    const julian = board({ backend: vercel({ team: 'team_test', api: API, fetch: recording, files: api.files }) })
    const fixer = await julian.as({ name: 'fixer', avatar: 'https://example.com/fixer.png' }).post('dev', { text: 'on it' })
    expect(fixer.by.actor).toBe('vercel:user:u_jb+fixer')
    expect(sent.at(-1)!.get('x-board-profile')).toBe('fixer')
    expect(sent.at(-1)!.get('x-board-avatar')).toBe('https://example.com/fixer.png')
    expect(sent.some((headers) => headers.has('x-board-session'))).toBe(false)
  })

  it("shows no session where the API keeps one, as it did for clients that sent it", async () => {
    const api = fakeMessageboard()
    // An older client, which sent its session with every request.
    const older: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-board-session', 'claude-1')
      return as(api, 'user:u_jb')(input, { ...init, headers })
    }
    const root = await board({ backend: vercel({ team: 'team_test', api: API, fetch: older, files: api.files }) }).as('claude').post('dev', { text: 'from a session' })
    const julian = handleOn(api)
    const { message } = await julian.thread(root.id)
    expect(message.by).toEqual({ actor: 'vercel:user:u_jb+claude', principal: 'vercel:user:u_jb', profile: 'claude' })
    expect((await julian.as('claude').me())).not.toHaveProperty('session')
  })

  it('names someone after a read of the names fails, and every message of someone new in one read', async () => {
    const api = fakeMessageboard()
    let failing = true
    // The list of names fails once.
    const flaky: typeof fetch = async (input, init) => {
      if (failing && new URL(String(input)).pathname.endsWith('/actors')) {
        failing = false
        return Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
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

  it("writes as the project a deployment is, per environment, and as an agent with its profile, each shown by the project's name or its ID", async () => {
    for (const [projectIdHandles, production, preview] of [
      [false, { handle: 'pong', name: 'pong' }, { handle: 'pong', name: 'pong (preview)' }],
      // An API that names a deployment by its ID names pong nowhere.
      [true, { handle: 'prj_pong', name: 'prj_pong' }, { handle: 'prj_pong@preview', name: 'prj_pong@preview' }],
    ] as const) {
      const api = fakeMessageboard({ projectIdHandles })
      const pong = handleOn(api, 'project:prj_pong:production')
      const { id } = await pong.post('pings', { text: 'ping' })
      const reply = await pong.as('claude').reply(id, { text: 'pong', labels: { kind: 'task' } })
      // A preview is someone else, of the same project.
      const previewed = handleOn(api, 'project:prj_pong:preview')
      expect(await previewed.me()).toMatchObject({ principal: 'vercel:project:prj_pong:preview', kind: 'deployment', ...preview })
      await previewed.reply(id, { text: 'from a preview' })
      const { message, replies } = await handleOn(api).thread(id)
      expect(message).toMatchObject({ channel: 'pings', by: { principal: 'vercel:project:prj_pong:production', profile: null }, author: { kind: 'deployment', ...production } })
      expect(replies).toMatchObject([
        { id: reply.id, re: id, labels: { kind: 'task' }, by: { actor: 'vercel:project:prj_pong:production+claude', profile: 'claude' }, author: { kind: 'agent', handle: 'claude', via: { name: production.handle, environment: 'production' } } },
        { text: 'from a preview', author: { kind: 'deployment', ...preview } },
      ])
      const actors = await handleOn(api).actors()
      expect(['vercel:project:prj_pong:production', 'vercel:project:prj_pong:preview'].map((at) => actors.find((actor) => actor.id === at))).toMatchObject([production, preview])
      // `me` is who the handle writes as, its profile included.
      expect((await pong.as('claude').messages({ channel: 'pings', by: 'me' })).messages.map((m) => m.id)).toEqual([reply.id])
      expect((await pong.messages({ channel: 'pings', by: 'me' })).messages.map((m) => m.id)).toEqual([id])
    }
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
    expect(await said(handleOn(api, 'project:prj_pong:production'))).toEqual({ can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, expiresAt: null })
    for (const role of ['member', 'developer'] as const) expect(await said(handleOn(fakeMessageboard({ roles: { u_jb: role } })))).toEqual(everything)
    // Credentials it says less of, and until when: board's own permissions, as it gives them.
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

  it("says what the board's grants leave its credentials there, a channel they close included", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api, 'user:u_jb')
    const all = ['read', 'post', 'react', 'label', 'sync', 'manage']
    await jb.createGrant({ principals: [{ kind: 'everyone' }], can: { 'security/': [] } })
    await jb.createGrant({ principals: [{ kind: 'project', project: 'pong', environments: ['production'] }], can: { 'ci/': ['read', 'post'] } })
    expect((await jb.me()).can).toEqual({ '*': all, 'security/': [] })
    expect((await handleOn(api, 'project:prj_pong:production').me()).can).toEqual({
      '*': ['read', 'post', 'react', 'label', 'sync'],
      'ci/': ['read', 'post'],
      'security/': [],
    })
  })

  it('asks its board what its credentials may do there, and tells a project the board shuts out that it needs a grant', async () => {
    const api = fakeMessageboard()
    await handleOn(api, 'user:u_jb').me()
    expect(api.requests.filter((request) => request.endsWith('/me'))).toEqual(['GET /boards/brd_test/me'])
    await expect(handleOn(fakeMessageboard({ boardId: null }), 'project:prj_pong:production').me()).rejects.toMatchObject({ status: 403, code: 'board_not_granted' })
  })

  it('sends VERCEL_TOKEN in Node, and never BOARD_TOKEN, which is for a board at a URL', async () => {
    for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
    const api = fakeMessageboard({ tokens: { k7Qe2mXa9vLp: 'user:u_ada' } })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
    vi.stubEnv('VERCEL_ORG_ID', 'team_test')
    const who = async () => (await board({ backend: nodeVercel() }).me()).principal
    try {
      vi.stubEnv('BOARD_TOKEN', 'k7Qe2mXa9vLp')
      vi.stubEnv('VERCEL_TOKEN', 'project:prj_pong:production')
      expect(await who()).toBe('vercel:project:prj_pong:production')
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

  it("says the board's name in its discovery, and none to a caller who may not read the board", async () => {
    const api = fakeMessageboard({ boards: [{ name: 'Security', id: 'brd_sec' }] })
    expect(await handleOn(api).discovery()).toMatchObject({ name: 'General' })
    const security = board({ name: 'security', backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'user:u_jb') }) })
    expect(await security.discovery()).toMatchObject({ name: 'Security' })
    // Found as the team's default, by a caller who only posts: where it is, and no name.
    const poster = await withHeadersOn(api)({ 'x-board-can': 'dev/=post' }).discovery()
    expect(poster).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_test?teamId=team_test` })
    expect(poster).not.toHaveProperty('name')
    // A handle narrowed with a can asks as it's narrowed: the name is for one that reads somewhere.
    const team = handleOn(api)
    expect(await team.as('fixer', { can: { 'dev/': ['read'] } }).discovery()).toMatchObject({ name: 'General' })
    // One that reads nowhere gets none, whatever the API would answer: the board isn't read for it.
    const reads = () => api.requests.filter((made) => made === 'GET /boards/brd_test').length
    const asked = reads()
    expect(await team.as('fixer', { can: { 'dev/': ['post'] } }).discovery()).not.toHaveProperty('name')
    expect(await team.as('fixer', { can: {} }).discovery()).not.toHaveProperty('name')
    expect(reads()).toBe(asked)
    // One on a board named by its ID still learns where it is, and no name it may not read.
    const onSecurity = board({ backend: vercel({ team: 'team_test', board: 'brd_sec', api: API, fetch: as(api, 'user:u_jb') }) })
    expect(await onSecurity.discovery()).toMatchObject({ name: 'Security' })
    const posting = await onSecurity.as('fixer', { can: { 'dev/': ['post'] } }).discovery()
    expect(posting).toMatchObject({ url: `${API}/v1/messageboard/boards/brd_sec?teamId=team_test` })
    expect(posting).not.toHaveProperty('name')
    // Named by its ID, it's read either way, so a credential that's narrowed itself is told it can't.
    const byId = board({ backend: vercel({ team: 'team_test', board: 'brd_sec', api: API, fetch: (input, init = {}) => as(api, 'user:u_jb')(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-board-can': 'dev/=post' } }) }) })
    await expect(byId.discovery()).rejects.toMatchObject({ status: 403 })
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

  // On Vercel's board the match happens in Vercel's API, and nothing in vercel() filters a watcher's
  // own events: this pins the API's fake to the rule the API follows, and that a match it hands out runs.
  it("runs a watcher on the check-in it scheduled itself, which the API's fake matches as Vercel's API should", async () => {
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard()
    const ran: string[] = []
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production') }),
      url: 'https://pong.example/api/board',
      basePath: '/api/board',
      watch: {
        ci: {
          tail: 'builds',
          run: async ({ event, board: own }) => {
            if (event.type !== 'message.posted') return
            ran.push(event.message!.text)
            if (event.message!.schedule) await own.reply(event.message!.id, { text: 'still red' })
            else await own.schedule({ re: event.message!.id }, { text: 'check on CI', in: '5m' })
          },
        },
      },
    })
    await pong.me()
    while (!api.registrations.has('vercel:project:prj_pong:production')) await new Promise((resolve) => setTimeout(resolve, 5))
    const root = await handleOn(api).post('builds', { text: 'the build is red' })
    const wake = () => pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' })).then((response) => response.json())
    await expect(wake()).resolves.toEqual({ ran: 1 })
    // The API posts the check-in when it's due, as the watcher that scheduled it: its own write, and it still wakes it.
    const [schedule] = await pong.schedules({ re: root.id })
    api.send(schedule!.id)
    await expect(wake()).resolves.toEqual({ ran: 1 })
    expect(ran).toEqual(['the build is red', 'check on CI'])
    const { replies } = await pong.thread(root.id)
    expect(replies.map((reply) => [reply.text, reply.by.actor])).toEqual([
      ['check on CI', 'vercel:project:prj_pong:production+ci'],
      ['still red', 'vercel:project:prj_pong:production+ci'],
    ])
    // The reply it then wrote is its own too, and wakes nothing.
    await expect(wake()).resolves.toEqual({ ran: 0 })
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

    it("start no tails on a deployment whose credentials aren't its own: VERCEL_TOKEN's", async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => {
        errors.mockRestore()
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
      })
      const api = fakeMessageboard()
      const ada = handleOn(api, 'user:u_ada')
      await ada.post('pings', 'before it started')
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
      for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
      for (const [key, set] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_ORG_ID: 'team_test', VERCEL_TOKEN: 'user:u_jb' })) vi.stubEnv(key, set)
      const { ran, watch } = pinger()
      const backend = nodeVercel()
      onTestFinished(() => backend.close())
      const team = board({ backend, url: 'https://pong.vercel.app/api/board', watch })
      await team.me()
      await ada.post('pings', 'ping with VERCEL_TOKEN')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(ran).toEqual([])
      // It neither read the feed nor asked to register.
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

  it("passes the conformance kit's sync as a project, through Vercel's API's sync routes", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api, 'project:prj_pong:production'), { withHeaders: withHeadersOn(api, 'project:prj_pong:production') })
    expect(Object.fromEntries(report.checks.filter((check) => check.group === 'sync').map((check) => [check.name, check.status]))).toEqual({
      "keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced": 'passed',
      "queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked": 'passed',
      "takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one": 'passed',
      'hands a sync each message change as a match of its @sync watcher': 'passed',
      'keeps noSync on a post and a reply, so sync sends neither': 'passed',
      "refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox": 'passed',
    })
  }, 30_000)

  it("passes the conformance kit's watchers as a project too, registering a path on its own project", async () => {
    const api = fakeMessageboard()
    const report = await conformance(handleOn(api, 'project:prj_pong:production'), { withHeaders: withHeadersOn(api, 'project:prj_pong:production') })
    expect(report.checks.filter((check) => check.group === 'watchers').map((check) => check.status)).toEqual(['passed', 'passed', 'passed'])
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
        return Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
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
    expect((await pong.schedules({ all: true })).find((s) => s.id === off.id)?.canceled).toEqual({ reason: 'revoked', by: { actor: 'board:schedule', principal: 'board:schedule', profile: null } })
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

  it("screens a sync's edit by board ID of its user's own message, from an API that names imports by the platform user alone", async () => {
    const api = fakeMessageboard({ externalImports: true })
    const screened: string[] = []
    const pong = pongBoard(api, [
      async ({ write, next }) => {
        screened.push(`${write.kind} ${write.text}`)
        await next({ text: write.text.toUpperCase() })
      },
    ])
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    const origin = { thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    const { message } = await pong.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'general', text: 'from slack', origin })
    expect((await pong.thread(message!)).message.by.actor).toBe('slack:user:U_ADA')
    await pong.syncImport({ op: 'edit', author: ada, from: null, message: message!, text: 'edited by the sync, as Ada' })
    expect(screened).toEqual(['post from slack', 'edit edited by the sync, as Ada'])
    expect((await pong.thread(message!)).message.text).toBe('EDITED BY THE SYNC, AS ADA')
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
    await expect(ping.syncImport({ op: 'post', author: { ...author, id: 'slack:user:U1' }, from: 'slack', channel: 'general', text: 'hi' })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
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

  it("shows a project's import as the platform user through that project, in its environment, with its key's platform, as the API names them", async () => {
    const api = fakeMessageboard()
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })
    const malte = { id: 'slack-eu:user:U_MALTE', handle: 'malte', name: 'Malte', avatar: null, isBot: false }
    await preview.syncImport({ op: 'post', author: malte, from: 'slack-eu', channel: 'general', text: 'ship it', origin: { thread: 'slack-eu:C1:1', subthread: null, message: '1', context: null } })
    const julian = handleOn(api)
    await julian.post('general', { text: 'on the board' })
    const { messages } = await julian.messages({ channel: 'general' })
    expect(messages.map((message) => [message.text, message.by, message.author])).toEqual([
      [
        'ship it',
        { actor: 'vercel:project:prj_pong:preview+slack-eu:user:U_MALTE', principal: 'vercel:project:prj_pong:preview', profile: 'slack-eu:user:U_MALTE' },
        { id: 'vercel:project:prj_pong:preview+slack-eu:user:U_MALTE', kind: 'external', handle: 'pong/malte', name: 'Malte', avatar: null, via: { name: 'pong', environment: 'preview' }, platform: 'slack', verified: true },
      ],
      ['on the board', { actor: 'vercel:user:u_jb', principal: 'vercel:user:u_jb', profile: null }, expect.not.objectContaining({ via: expect.anything() })],
    ])
    expect((await julian.actors()).find((actor) => actor.id.endsWith('+slack-eu:user:U_MALTE'))).toMatchObject({ name: 'Malte', via: { name: 'pong', environment: 'preview' }, platform: 'slack' })
    // A profile name covers that agent of anyone's, but a platform user is only ever themselves.
    expect((await julian.messages({ channel: 'general', by: 'slack-eu:user:U_MALTE' })).messages).toEqual([])
  })

  it("imports through a sync key not named for its platform, its users named for the key", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { 'slack-eu': slack({ adapter: s.adapter }, channels({ C1: 'general' })) },
    })
    const webhook = await pong.fetch(new Request(`${PONG_URL}/webhooks/slack-eu`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'hej', user: 'U_ADA', name: 'Ada' }) }))
    expect(webhook.status).toBe(200)
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.messages({ channel: 'general' })).messages).toHaveLength(1))
    const [message] = (await julian.messages({ channel: 'general' })).messages
    expect([message!.by.actor, message!.from, message!.author?.platform]).toEqual(['vercel:project:prj_pong:production+slack-eu:user:U_ADA', 'pong/slack-eu', 'slack'])
  })

  it("puts an import's handle under its project's name, typable, from an API that names them as their platform does", async () => {
    const api = fakeMessageboard({ platformHandles: true })
    // The second project's name isn't one the API knows.
    for (const [principal, key] of [['project:prj_pong:preview', 'slack'], ['project:prj_unnamed:production', 'slack-eu']] as const) {
      const project = handleOn(api, principal)
      await project.register({ url: null, watch: {}, sync: [{ key, platform: 'slack' }] })
      const author = { id: `${key}:user:U_MALTE`, handle: 'Malte Ubl', name: 'Malte Ubl', avatar: null, isBot: false }
      await project.syncImport({ op: 'post', author, from: key, channel: 'general', text: 'hi' })
    }
    const julian = handleOn(api)
    const handles = (await julian.messages({ channel: 'general' })).messages.map((message) => message.author?.handle)
    expect(handles).toEqual(['pong/malte-ubl', 'prj_unnamed/malte-ubl'])
    expect((await julian.actors()).filter((actor) => actor.id.includes('+slack')).map((actor) => actor.handle).sort()).toEqual(['pong/malte-ubl', 'prj_unnamed/malte-ubl'])
  })

  it('fits a handle from the API in the 128 characters a handle holds, however long the API named it', async () => {
    const api = fakeMessageboard({ platformHandles: true })
    const pong = handleOn(api, 'project:prj_pong:production')
    await pong.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    // One with a slash is as the API names imports, under a project: this one ran long.
    for (const [id, handle] of [['slack:user:U_SLASH', `team/${'b'.repeat(200)}`], ['slack:user:U_PLAIN', 'c'.repeat(200)]] as const)
      await pong.syncImport({ op: 'post', author: { id, handle, name: 'Long', avatar: null, isBot: false }, from: 'slack', channel: 'general', text: 'hi' })
    const handles = (await handleOn(api).messages({ channel: 'general' })).messages.map((message) => message.author?.handle)
    expect(handles).toEqual([`team/${'b'.repeat(123)}`, `pong/${'c'.repeat(123)}`])
  })

  it('shows an import as the platform user alone, as before, from an API that names them so', async () => {
    const api = fakeMessageboard({ externalImports: true })
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const malte = { id: 'slack:user:U_MALTE', handle: 'malte', name: 'Malte', avatar: null, isBot: false }
    await preview.syncImport({ op: 'post', author: malte, from: 'slack', channel: 'general', text: 'ship it' })
    const [message] = (await handleOn(api).messages({ channel: 'general' })).messages
    expect([message!.by, message!.author]).toEqual([
      { actor: 'slack:user:U_MALTE', principal: 'slack:user:U_MALTE', profile: null },
      { id: 'slack:user:U_MALTE', kind: 'external', handle: 'malte', name: 'Malte', avatar: null, verified: true },
    ])
  })

  it("mentions a platform user natively only from the sync that speaks for them, under the key it imported them through", async () => {
    const api = fakeMessageboard()
    const s = fakePlatform('slack')
    // The documented renderer: a root mentions its owner where the platform can.
    const owner = render(({ message, label, mentionOf }) => {
      const who = message.labels.owner ? mentionOf(message.labels.owner) : null
      return who ? `${message.text} · ${who}` : `**${label}**: ${message.text}`
    }, channels({ C1: 'general' }))
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter }, owner) },
    })
    // A preview held the key first and spoke for "Ada" under it, then let it go.
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    await preview.syncImport({ op: 'post', author: { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }, from: 'slack', channel: 'random', text: 'hi' })
    await preview.register({ url: null, watch: {}, sync: [] })
    // Production's own Slack brings Ada in under the same key.
    await pong.fetch(new Request(`${PONG_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', threadId: 'slack:C1:300', id: '300', text: 'hi', user: 'U_ADA', name: 'Ada' }) }))
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.messages({ channel: 'general' })).messages).toHaveLength(1))
    expect((await julian.actors()).map((actor) => actor.id).filter((id) => id.endsWith('+slack:user:U_ADA')).sort()).toEqual([
      'vercel:project:prj_pong:preview+slack:user:U_ADA',
      'vercel:project:prj_pong:production+slack:user:U_ADA',
    ])
    await julian.post('general', { text: 'yours', labels: { owner: 'vercel:project:prj_pong:production+slack:user:U_ADA' } })
    await julian.post('general', { text: 'not yours', labels: { owner: 'vercel:project:prj_pong:preview+slack:user:U_ADA' } })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() =>
      expect(s.channelPosts.map((post) => JSON.parse(post.text).markdown).sort()).toEqual(['**Julián Benegas**: not yours', 'yours · <@U_ADA>']),
    )
  })

  it("posts to Slack under the names the API gives, which it checked: a person as themselves", async () => {
    const api = fakeMessageboard()
    const posted: Record<string, unknown>[] = []
    const client = {
      conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}), replies: async () => ({ messages: [] }) },
      chat: { postMessage: async (args: Record<string, unknown>) => (posted.push(args), { ts: '1700000000.000200' }) },
      auth: { test: async () => ({ response_metadata: { scopes: ['chat:write.customize'] } }) },
      users: { info: async () => ({}) },
    }
    const s = fakePlatform('slack', (adapter) => {
      withSlackClient(client, false)(adapter)
      Object.assign(adapter, {
        formatConverter: { toSlackPayload: (message: { markdown: string }) => ({ markdown_text: message.markdown }) },
        decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }),
      })
    })
    const pong = board({
      backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }),
      url: PONG_URL,
      basePath: '/api/board',
      sync: { slack: slack({ adapter: s.adapter, client: async () => client as never }, channels({ C1: 'general' })) },
    })
    // Its first request registers its sync, which sees what's posted after.
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await handleOn(api).post('general', { text: 'the deploy is red' })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await vi.waitFor(() => expect(posted.map(({ username, markdown_text }) => [username, markdown_text])).toEqual([['Julián Benegas', 'the deploy is red']]))
  })

  it("resolves mentions as each project's sync posts, against its own users: two syncs' Maltes, and an email its Slack knows", async () => {
    const api = fakeMessageboard()
    const lookupByEmail = vi.fn(async ({ email }: { email: string }) => {
      if (email !== 'ada@vercel.com') throw new Error('users_not_found')
      return { user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada' } } }
    })
    const client = { conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) }, users: { info: async () => ({}), lookupByEmail } }
    const pongSlack = fakePlatform('slack', withSlackClient(client, false))
    const webSlack = fakePlatform('slack')
    const project = (principal: string, url: string, sync: NonNullable<Parameters<typeof board>[0]>['sync']) =>
      board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }), url, basePath: '/api/board', sync })
    const pong = project('project:prj_pong:production', PONG_URL, { slack: slack({ adapter: pongSlack.adapter, client: async () => client as never }, channels({ C1: 'general' })) })
    const web = project('project:prj_web:production', WEB_URL, { webchat: slack({ adapter: webSlack.adapter }, channels({ C9: 'general' })) })
    // Each one's Slack brings in its own Malte.
    const webhook = (deployment: typeof pong, url: string, key: string, body: object) =>
      deployment.fetch(new Request(`${url}/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', ...body }) }))
    await webhook(pong, PONG_URL, 'slack', { threadId: 'slack:C1:300', id: '300', text: 'hi', user: 'U_M1', name: 'malte' })
    await webhook(web, WEB_URL, 'webchat', { threadId: 'slack:C9:400', id: '400', text: 'hej', user: 'U_M2', name: 'malte' })
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.messages({ channel: 'general' })).messages).toHaveLength(2))
    await julian.post('general', { text: '@malte have a look, @pong/malte and @web/malte, cc @[ada@vercel.com]' })
    await pong.fetch(new Request(`${PONG_URL}/wake`, { method: 'POST' }))
    await web.fetch(new Request(`${WEB_URL}/wake`, { method: 'POST' }))
    const posted = (platform: typeof pongSlack) => platform.channelPosts.map((post) => JSON.parse(post.text).markdown).filter((text: string) => text.includes('have a look'))
    await vi.waitFor(() => expect([posted(pongSlack), posted(webSlack)]).toEqual([
      ['**Julián Benegas**: <@U_M1> have a look, <@U_M1> and @web/malte, cc <@U_ADA>'],
      ['**Julián Benegas**: <@U_M2> have a look, @pong/malte and <@U_M2>, cc ada@vercel.com'],
    ]))
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
        ['pong/slack', 'the export page', [{ id: expect.any(String), name: 'shot.png', type: 'image/png', size: png.byteLength }]],
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
    // Its project's preview syncs Slack: a key of its own project's, which it names bare.
    const preview = handleOn(api, 'project:prj_pong:preview')
    await preview.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const author = { id: 'slack:user:U1', handle: 'jb', name: 'Julián', avatar: null, isBot: false }
    await preview.syncImport({ op: 'post', author, from: 'slack', channel: 'general', text: 'from slack', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    await handleOn(api).post('general', { text: 'on the board' })
    await pong.fetch(new Request('https://pong.example/api/board/wake', { method: 'POST' }))
    expect(ran.sort()).toEqual(['imported: from slack', 'written: on the board'])
    // A person names it by its project.
    const read = async (from: string) => (await handleOn(api).messages({ channel: 'general', from })).messages.map((message) => message.text)
    expect(await read('pong/slack')).toEqual(['from slack'])
    expect(await read('board')).toEqual(['on the board'])
    // A thread read finds the threads with a message from there, as a read of messages does.
    const threads = async (from: string) => (await handleOn(api).threads({ channel: 'general', from })).threads.map((thread) => thread.message.text)
    expect(await threads('pong/slack')).toEqual(['from slack'])
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

  it("refuses a project it names by name that turns out to be the run's own: by its handle, or after one grant it revokes where the API names it by ID", async () => {
    for (const [projectIdHandles, refusal] of [
      [false, "principals.project is this run's own project, web: "],
      // Only the API knows web is prj_web, so the kit asks it with a grant that changes nothing for the run.
      [true, "principals.project is this run's own project, web (prj_web)"],
    ] as const) {
      const api = fakeMessageboard({ projectIdHandles })
      await handleOn(api).createGrant({ principals: [{ kind: 'project', project: 'web', environments: ['production'] }], can: { '*': 'all' } })
      const before = [...api.grants.keys()]
      await expect(conformance(handleOn(api, 'project:prj_web:production'), { principals: { project: 'web', repository: 'acme/api' } })).rejects.toThrow(refusal)
      expect([...api.grants.keys()]).toEqual(before)
    }
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
      { id: 'g2', principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, capped: false, by: null, at: null },
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

  it("gives back grants' times as the protocol has them, though the API answers milliseconds", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const before = Date.now()
    const { grant } = await jb.createGrant({ principals: [{ kind: 'user', email: 'ada@acme.com' }], can: { 'ci/': ['read'] } })
    expect(Date.parse(grant.at!)).toBeGreaterThanOrEqual(before)
    expect(grant.at).toBe(new Date(Date.parse(grant.at!)).toISOString())
    expect((await jb.grants()).find((listed) => listed.id === grant.id)?.at).toBe(grant.at)
    expect((await jb.explain('ci', { user: 'ada@acme.com' })).grants).toMatchObject([{ id: grant.id, at: grant.at }])
    expect((await jb.updateGrant(grant.id, { can: { 'ci/': ['read', 'post'] } })).grant.at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })
})

describe("each project's sync keys on Vercel's API", () => {
  const NAMES = { prj_support: 'support', prj_www: 'www' }
  const SUPPORT_URL = 'https://support.example/api/board'
  const PREVIEW_URL = 'https://support-git-fix.example/api/board'
  const WWW_URL = 'https://www.example/api/board'

  /** A deployment of a project on the fake's board, with `options`: its board, its backend, and what it asked the API, as `METHOD /path` under its board. */
  function deployment(api: ReturnType<typeof fakeMessageboard>, principal: string, url: string, options: Pick<NonNullable<Parameters<typeof board>[0]>, 'sync' | 'watch'>) {
    const asked: string[] = []
    const fetch = as(api, principal)
    const backend = vercel({
      team: 'team_test',
      api: API,
      files: api.files,
      fetch: (input, init) => {
        const request = new Request(input, init)
        asked.push(`${request.method} ${new URL(request.url).pathname.replace(/^\/v1\/messageboard(\/boards\/[^/]+)?/, '')}`)
        return fetch(input, init)
      },
    })
    onTestFinished(() => backend.close())
    const team = board({ backend, url, basePath: '/api/board', ...options })
    const webhook = (key: string, body: object) =>
      team.fetch(new Request(`${url}/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', ...body }) }))
    return { team, backend, asked, webhook, wake: () => team.fetch(new Request(`${url}/wake`, { method: 'POST' })) }
  }
  const markdown = (posts: { text: string }[]) => posts.map((post) => JSON.parse(post.text).markdown as string)

  it("syncs a key two projects each call slack for each, the board's posts to both Slacks, and one's import to the other's, never back", async () => {
    const api = fakeMessageboard({ projects: NAMES })
    const getPermalink = async ({ channel, message_ts }: { channel: string; message_ts: string }) => ({ permalink: `https://acme.slack.com/archives/${channel}/p${message_ts.replace('.', '')}` })
    const client = { conversations: { list: async () => ({}), info: async () => ({}), join: async () => ({}) }, chat: { getPermalink } }
    const supportSlack = fakePlatform('slack', withSlackClient(client, false))
    const wwwSlack = fakePlatform('slack', withSlackClient(client, false))
    const support = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: supportSlack.adapter }, channels({ C_SUP: 'general' })) } })
    const www = deployment(api, 'project:prj_www:production', WWW_URL, { sync: { slack: slack({ adapter: wwwSlack.adapter }, channels({ C_WWW: 'general' })) } })
    await support.backend.registerWatchers()
    await www.backend.registerWatchers()
    const julian = handleOn(api)
    const root = await julian.post('general', { text: 'checkout is down' })
    await Promise.all([support.wake(), www.wake()])
    await vi.waitFor(() => expect([markdown(supportSlack.channelPosts), markdown(wwwSlack.channelPosts)]).toEqual([['**Julián Benegas**: checkout is down'], ['**Julián Benegas**: checkout is down']]))
    // Ada answers in www's Slack thread: www imports it, and support's Slack gets it.
    const webhook = await www.webhook('slack', { threadId: `slack:C_WWW:${wwwSlack.channelPosts[0]!.id}`, id: '500', text: 'on it', user: 'U_ADA', name: 'Ada' })
    expect(webhook.status).toBe(200)
    await vi.waitFor(async () => expect((await julian.thread(root.id)).replies.map((reply) => reply.text)).toEqual(['on it']))
    await Promise.all([support.wake(), www.wake()])
    await vi.waitFor(() =>
      expect(supportSlack.posts.map((post) => [post.threadId, JSON.parse(post.text).markdown])).toEqual([[`slack:C_SUP:${supportSlack.channelPosts[0]!.id}`, '**Ada via www (slack)**: on it']]),
    )
    expect(wwwSlack.posts).toEqual([])
    // Each names its own project's key bare, and the other's by its project; a person names both by theirs.
    const from = async (team: { thread(id: string): Promise<{ replies: { from: string | null }[] }> }) => (await team.thread(root.id)).replies.map((reply) => reply.from)
    expect([await from(www.team), await from(support.team), await from(julian)]).toEqual([['slack'], ['www/slack'], ['www/slack']])
    // Only its own sync, which has the app, links its copies.
    // Each binds its target as it starts the thread, so they come in whichever order the two did.
    const targets = async (team: typeof julian) => (await team.sync(root.id)).targets.map(({ key, target, url }) => [key, target, url]).sort(([a], [b]) => a!.localeCompare(b!))
    expect(await targets(support.team)).toEqual([
      ['slack', 'slack:C_SUP', `https://acme.slack.com/archives/C_SUP/p${supportSlack.channelPosts[0]!.id}`],
      ['www/slack', 'www/slack:C_WWW', null],
    ])
    // Support has imported no one, but its deployment wrote as itself, by its project's name.
    expect(await targets(julian)).toEqual([
      ['support/slack', 'support/slack:C_SUP', null],
      ['www/slack', 'www/slack:C_WWW', null],
    ])
  })

  it("names another project by the handle its deployments and their agents go by, else by what its users say, else by its ID", async () => {
    for (const [projectIdHandles, keys] of [
      [false, ['support/slack', 'www/slack']],
      // An API that names a deployment by its ID, and its profiles under that, names support nowhere, and www on the user it imported.
      [true, ['prj_support/slack', 'www/slack']],
    ] as const) {
      const api = fakeMessageboard({ projects: NAMES, projectIdHandles })
      const support = handleOn(api, 'project:prj_support:production')
      const www = handleOn(api, 'project:prj_www:production')
      for (const project of [support, www]) await project.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
      const julian = handleOn(api)
      const root = await julian.post('general', { text: 'checkout is down' })
      // Support binds the thread through its sync, as a profile of its deployment, www as its deployment, and www brings Ada's reply in.
      await support.as('sync').syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C_SUP', targetKind: 'channel', cause: 'request' })
      await www.syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C_WWW:1', targetKind: 'thread', cause: 'request' })
      const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
      await www.syncImport({ op: 'post', author: ada, from: 'slack', re: root.id, text: 'on it', origin: { thread: 'slack:C_WWW:1', subthread: null, message: '2', context: null } })
      expect((await julian.sync(root.id)).targets.map((target) => target.key)).toEqual(keys)
      expect((await julian.thread(root.id)).replies.map((reply) => reply.from)).toEqual(['www/slack'])
      expect((await support.thread(root.id)).replies.map((reply) => reply.from)).toEqual(['www/slack'])
    }
  })

  it("says another project's deployment holds a key by its project's name, where the API names it", async () => {
    for (const [projectIdHandles, holder] of [
      [false, 'www (production)'],
      [true, 'prj_www (production)'],
    ] as const) {
      const api = fakeMessageboard({ projects: NAMES, projectIdHandles })
      await handleOn(api, 'project:prj_www:production').post('general', { text: 'deployed' })
      const said = vi.spyOn(console, 'info').mockImplementation(() => {})
      const fetch = as(api, 'project:prj_support:production')
      // An API that says a key of support's is another project's deployment's.
      const backend = vercel({
        team: 'team_test',
        api: API,
        fetch: async (input, init) => {
          const request = new Request(input, init)
          const response = await fetch(input, init)
          if (request.method !== 'PUT' || !new URL(request.url).pathname.endsWith('/watchers')) return response
          const elsewhere = [{ key: 'slack', platform: 'slack', owner: 'vercel:project:prj_www:production', environment: 'production' }]
          return Response.json({ ...(await response.json()), sync: [], elsewhere })
        },
      })
      board({ backend, url: SUPPORT_URL, basePath: '/api/board', sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
      await backend.registerWatchers()
      backend.close()
      expect(said.mock.calls).toEqual([[`[board] slack is synced by ${holder}`]])
      said.mockRestore()
    }
  })

  it("runs nothing through a key production holds from a preview, whose watchers run, and says once who has it", async () => {
    const api = fakeMessageboard({ projects: NAMES })
    const productionSlack = fakePlatform('slack')
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: productionSlack.adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    const said = vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => said.mockRestore())
    const previewSlack = fakePlatform('slack')
    const offered: string[] = []
    const ran: string[] = []
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, {
      sync: {
        slack: slack({ adapter: previewSlack.adapter }, async (sync) => void offered.push(sync.direction)),
        // A key of its own, which has the API hand it every post on the board.
        alerts: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_ALERTS: 'alerts' })),
      },
      watch: { seen: { tail: 'general', run: async ({ event }) => void ran.push(event.message!.text) } },
    })
    // Slack's webhook is answered, and nothing of it lands: the adapter never reads it.
    const read = vi.spyOn(previewSlack.adapter, 'handleWebhook')
    const webhook = await preview.webhook('slack', { threadId: 'slack:C_SUP:300', id: '300', text: 'to the preview', user: 'U_ADA', name: 'Ada' })
    expect(webhook.status).toBe(200)
    expect(read).not.toHaveBeenCalled()
    await handleOn(api).post('general', { text: 'deploy failed' })
    await Promise.all([production.wake(), preview.wake()])
    await vi.waitFor(() => expect(markdown(productionSlack.channelPosts)).toEqual(['**Julián Benegas**: deploy failed']))
    await vi.waitFor(() => expect(ran).toEqual(['deploy failed']))
    // It registers again once its last registration is old: still not its key, and nothing more to say.
    const now = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 60_000)
    onTestFinished(() => vi.mocked(Date.now).mockRestore())
    await preview.backend.registerWatchers()
    await preview.wake()
    expect(preview.asked.filter((asked) => asked === 'PUT /watchers').length).toBeGreaterThan(1)
    expect(offered).toEqual([])
    expect([previewSlack.channelPosts, previewSlack.posts]).toEqual([[], []])
    expect(preview.asked.filter((asked) => /\/sync\/(imports|receipts|inbox\/slack)/.test(asked))).toEqual([])
    expect((await handleOn(api).messages({ channel: 'general' })).messages.map((message) => message.text)).toEqual(['deploy failed'])
    expect(said.mock.calls).toEqual([['[board] slack is synced by production']])
  })

  it("posts a deployment to Slack under its project's name, keeping its environment whole when the name is cut to fit", async () => {
    const project = `www-${'x'.repeat(86)}`
    const api = fakeMessageboard({ projects: { ...NAMES, prj_www: project } })
    const posted: Record<string, unknown>[] = []
    const client = {
      conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
      chat: { postMessage: async (args: Record<string, unknown>) => (posted.push(args), { ts: `1700000000.00010${posted.length}` }) },
      auth: { test: async () => ({ response_metadata: { scopes: ['chat:write', 'chat:write.customize'] } }) },
    }
    const s = fakePlatform('slack', (adapter) => {
      withSlackClient(client, false)(adapter)
      Object.assign(adapter, {
        formatConverter: { toSlackPayload: (message: { markdown: string }) => ({ markdown_text: message.markdown }) },
        decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }),
      })
    })
    const support = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: s.adapter, client: async () => client as never }, channels({ C_SUP: 'general' })) } })
    await support.backend.registerWatchers()
    for (const environment of ['preview', 'production']) await handleOn(api, `project:prj_www:${environment}`).post('general', { text: environment })
    await support.wake()
    await vi.waitFor(() => expect(posted).toHaveLength(2))
    // The two roots go out side by side: each by what it says.
    const by = Object.fromEntries(posted.map(({ username, markdown_text }) => [markdown_text as string, username as string]))
    expect(by.preview).toMatch(/^www-x+… \(preview\)$/)
    expect(by.production).toMatch(/^www-x+…$/)
    for (const username of Object.values(by)) expect(Array.from(username).length).toBeLessThanOrEqual(80)
  })

  it("stops syncing a key production takes from it moments after it registered, at the first call the API refuses", async () => {
    // On Vercel, where each registers its path and never pulls on its own: only what the test does registers.
    for (const [name, value] of Object.entries({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '', VERCEL_GIT_COMMIT_REF: '' })) vi.stubEnv(name, value)
    onTestFinished(() => void vi.unstubAllEnvs())
    const api = fakeMessageboard({ projects: NAMES })
    const said = vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => said.mockRestore())
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, { sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
    await preview.backend.registerWatchers()
    expect(api.registrations.get('vercel:project:prj_support:preview')?.sync).toEqual([{ key: 'slack', platform: 'slack' }])
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    // The preview still holds slack as far as it knows: the API's refusal of its webhook's event tells it otherwise.
    const body = { threadId: 'slack:C_SUP:300', id: '300', text: 'to the preview', user: 'U_ADA', name: 'Ada' }
    expect((await preview.webhook('slack', body)).status).toBe(200)
    expect(preview.asked.filter((asked) => asked === 'PUT /watchers')).toHaveLength(2)
    expect(said.mock.calls).toEqual([['[board] slack is synced by production']])
    // From then on it asks the API nothing through the key.
    const asked = preview.asked.length
    expect((await preview.webhook('slack', { ...body, id: '301' })).status).toBe(200)
    expect(preview.asked.slice(asked).filter((call) => /\/sync\//.test(call))).toEqual([])
    expect((await handleOn(api).messages({ channel: 'general' })).messages).toEqual([])
  })

  it("takes no other project's thread an API hands it under a key of its own name", async () => {
    // An API that hands a thread's binding to every registrant of its key, and lists every target of a thread.
    const api = fakeMessageboard({ projects: NAMES, unscopedSync: true })
    const supportSlack = fakePlatform('slack')
    const support = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: supportSlack.adapter }, channels({ C_SUP: 'general' })) } })
    await support.backend.registerWatchers()
    const www = handleOn(api, 'project:prj_www:production')
    await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    // A thread in a channel support doesn't mirror, which www syncs to its own Slack.
    const root = await handleOn(api).post('random', { text: 'checkout is down' })
    await www.syncReceipt({ kind: 'thread', message: root.id, target: 'slack:C_WWW', targetKind: 'channel', cause: 'request' })
    await support.wake()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect([supportSlack.channelPosts, supportSlack.posts]).toEqual([[], []])
    expect(support.asked.filter((asked) => asked === 'POST /sync/receipts')).toEqual([])
  })

  it("delivers to no target under a key another deployment holds, though an API lists it", async () => {
    const api = fakeMessageboard({ projects: NAMES, unscopedSync: true })
    const productionSlack = fakePlatform('slack')
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: productionSlack.adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    const previewSlack = fakePlatform('slack')
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, {
      sync: {
        slack: slack({ adapter: previewSlack.adapter }, channels({ C_SUP: 'general' })),
        // A key of its own, which has the API hand it every post on the board.
        alerts: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_ALERTS: 'alerts' })),
      },
    })
    await preview.backend.registerWatchers()
    const julian = handleOn(api)
    const root = await julian.post('general', { text: 'deploy failed' })
    await production.wake()
    await vi.waitFor(() => expect(markdown(productionSlack.channelPosts)).toEqual(['**Julián Benegas**: deploy failed']))
    await julian.reply(root.id, { text: 'rolled back' })
    await Promise.all([production.wake(), preview.wake()])
    await vi.waitFor(() => expect(markdown(productionSlack.posts)).toEqual(['**Julián Benegas**: rolled back']))
    await preview.wake()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect([previewSlack.channelPosts, previewSlack.posts]).toEqual([[], []])
  })

  it("finds another project's imports by its name, though the filter was made before the project imported anything", async () => {
    const api = fakeMessageboard({ projects: NAMES })
    const julian = handleOn(api)
    await julian.post('general', { text: 'before www syncs' })
    const read = async () => (await julian.messages({ channel: 'general', from: 'www/slack' })).messages.map((message) => message.text)
    // Twice, so the names it reads are kept, and nothing in them is www.
    expect([await read(), await read()]).toEqual([[], []])
    const www = handleOn(api, 'project:prj_www:production')
    await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    await www.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'general', text: 'checkout is down', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
    expect(await read()).toEqual(['checkout is down'])
  })

  it("takes a deployment by the name it shows for --by, a watcher's included, on an API that names it by its ID too", async () => {
    for (const projectIdHandles of [false, true]) {
      const api = fakeMessageboard({ projects: NAMES, projectIdHandles })
      const www = handleOn(api, 'project:prj_www:production')
      await www.register({ url: null, watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
      // An import of www's names it, wherever the API names its deployments by their IDs.
      const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
      await www.syncImport({ op: 'post', author: ada, from: 'slack', channel: 'random', text: 'hi', origin: { thread: 'slack:C1:1', subthread: null, message: '1', context: null } })
      const root = await www.post('general', { text: 'deployed' })
      await handleOn(api, 'project:prj_www:preview').reply(root.id, { text: 'deployed a preview' })
      await handleOn(api).post('general', { text: 'not www' })
      const julian = handleOn(api)
      expect((await julian.thread(root.id)).message.author).toMatchObject({ handle: 'www' })
      expect((await julian.messages({ channel: 'general', by: 'www' })).messages.map((message) => message.text)).toEqual(['deployed', 'deployed a preview'])
      const pong = handleOn(api, 'project:prj_pong:production')
      await pong.register({ url: null, watch: { deploys: { tail: 'general --by www' } } })
      expect(api.registrations.get('vercel:project:prj_pong:production')!.watch.deploys!.filter.authors!.sort()).toEqual(['vercel:project:prj_www:preview', 'vercel:project:prj_www:production'])
    }
  })

  it("syncs every key it registered against an API from before each project had its own, which refuses a second registrant's, and names each target its own", async () => {
    const api = fakeMessageboard({ projects: NAMES, boardWideKeys: true })
    const s = fakePlatform('slack')
    const production = deployment(api, 'project:prj_support:production', SUPPORT_URL, { sync: { slack: slack({ adapter: s.adapter }, channels({ C_SUP: 'general' })) } })
    await production.backend.registerWatchers()
    const preview = deployment(api, 'project:prj_support:preview', PREVIEW_URL, { sync: { slack: slack({ adapter: fakePlatform('slack').adapter }, channels({ C_SUP: 'general' })) } })
    await expect(preview.backend.registerWatchers()).rejects.toMatchObject({ status: 409, code: 'sync_key_taken' })
    expect((await production.webhook('slack', { threadId: 'slack:C_SUP:300', id: '300', text: 'from slack', user: 'U_ADA', name: 'Ada' })).status).toBe(200)
    const julian = handleOn(api)
    await vi.waitFor(async () => expect((await julian.messages({ channel: 'general' })).messages.map((message) => message.text)).toEqual(['from slack']))
    const root = await julian.post('general', { text: 'deploy failed' })
    await production.wake()
    await vi.waitFor(() => expect(markdown(s.channelPosts)).toEqual(['**Julián Benegas**: deploy failed']))
    // Its targets name no project: each is the reader's own.
    expect((await julian.sync(root.id)).targets.map(({ key, target }) => [key, target])).toEqual([['slack', 'slack:C_SUP']])
  })
})

describe("callers on Vercel's API", () => {
  /** Pong's deployment, through an API that answers its posts with IDs only, as it answers a caller that may post in a channel but not read it. */
  const postOnly = (api: ReturnType<typeof fakeMessageboard>) => {
    const idsOnly = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await as(api, 'project:prj_pong:production')(input, init)
      const { pathname } = new URL(new Request(input, init).url)
      if (!response.ok || !/\/(threads|posts\/[^/]+)$/.test(pathname)) return response
      const { thread, message } = (await response.json()) as { thread: { id: string }; message: { id: string; threadId: string; sequence: number } }
      return Response.json({ thread: { id: thread.id }, message: { id: message.id, threadId: message.threadId, sequence: message.sequence } })
    }) as typeof fetch
    return board({ backend: vercel({ team: 'team_test', api: API, fetch: idsOnly, files: api.files }) })
  }

  it("answers 401 invalid_token for credentials Vercel's API doesn't take", async () => {
    await expect(handleOn(fakeMessageboard(), 'not-a-token').me()).rejects.toMatchObject({ status: 401, code: 'invalid_token' })
  })

  it("gets back a post-only caller's post and its retry as it sent them, though the API answers each with IDs only", async () => {
    const api = fakeMessageboard()
    const ci = postOnly(api)
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

  it('starts a thread in one call to the API, in a channel new or not, for a reader and a post-only caller alike', async () => {
    const api = fakeMessageboard()
    const ci = postOnly(api)
    const jb = handleOn(api)
    const before = api.requests.length
    for (const [handle, channel] of [[jb, 'ops'], [jb, 'ops'], [ci, 'ci'], [ci, 'ci']] as const) expect(await handle.post(channel, { text: 'hi' })).toMatchObject({ channel })
    // Neither looks the channel up, makes it, or lists channels to name it.
    expect(api.requests.slice(before).filter((request) => /\/(channels|threads)/.test(request))).toEqual(Array(4).fill('POST /boards/brd_test/threads'))
  })

  it("says plainly that only a deployment's own credentials register watchers, to a person and an app", async () => {
    const api = fakeMessageboard()
    for (const handle of [handleOn(api), handleOn(api, 'app:oac_1')])
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
})

describe('a request the API puts off', () => {
  /** Julian on a board whose API answers `refuse(request)`'s response instead of its own, when it gives one. */
  const throttled = (refuse: (url: URL, init: RequestInit | undefined, answer: () => Promise<Response>) => Promise<Response | null> | Response | null) => {
    const api = fakeMessageboard()
    const inner = as(api, 'user:u_jb')
    const sent: { method: string; path: string; at: number }[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      sent.push({ method: init?.method ?? 'GET', path: url.pathname, at: Date.now() })
      return (await refuse(url, init, () => inner(input, init))) ?? inner(input, init)
    }
    return { api, sent, julian: board({ backend: vercel({ team: 'team_test', api: API, fetch, files: api.files }) }) }
  }
  const tooMany = (retryAfter = '60') => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': retryAfter } })
  const busy = () => Response.json({ error: { code: 'board_busy', message: 'retry shortly' } }, { status: 503, headers: { 'retry-after': '2' } })
  const posts = (sent: { method: string; path: string }[]) => sent.filter(({ method, path }) => method === 'POST' && path.endsWith('/threads'))
  const timers = () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
  }

  it('waits and posts once when the API says 429, well inside the minute it asks for', async () => {
    timers()
    let refusals = 2
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') && refusals-- > 0 ? tooMany() : null))
    const posting = julian.post('dev', { text: 'hi' })
    // A second, then two, each with up to as much again: both waits are over within six.
    await vi.advanceTimersByTimeAsync(6000)
    const { id } = await posting
    expect(posts(sent)).toHaveLength(3)
    const { threads } = await julian.threads({ channel: 'dev' })
    expect(threads.map((thread) => thread.message.id)).toEqual([id])
  })

  it("doesn't send again before a second has passed", async () => {
    timers()
    let refusals = 1
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') && refusals-- > 0 ? tooMany() : null))
    const posting = julian.post('dev', { text: 'hi' })
    await vi.advanceTimersByTimeAsync(999)
    expect(posts(sent)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1001)
    await posting
    expect(posts(sent)).toHaveLength(2)
  })

  it('posts once when the API wrote the message and then answered 503', async () => {
    timers()
    let failing = true
    const { julian } = throttled(async (url, init, answer) => {
      if (!failing || init?.method !== 'POST' || !url.pathname.endsWith('/threads')) return null
      failing = false
      // The write lands, and its answer is lost.
      await answer()
      return busy()
    })
    const posting = julian.post('dev', { text: 'once' })
    await vi.advanceTimersByTimeAsync(2000)
    const { id } = await posting
    const { threads } = await julian.threads({ channel: 'dev' })
    expect(threads.map((thread) => thread.message.id)).toEqual([id])
  })

  it("gives up with the API's own error after five tries", async () => {
    timers()
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/threads') ? tooMany() : null))
    const posting = julian.post('dev', { text: 'hi' }).catch((error: unknown) => error)
    // 1 + 2 + 4 + 8 seconds, each with up to as much again.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await posting).toMatchObject({ status: 429, code: 'rate_limited' })
    expect(posts(sent)).toHaveLength(5)
  })

  it("answers a 503 at once for a write the API couldn't tell it had seen", async () => {
    const { julian, sent } = throttled((url, init) => (init?.method === 'POST' && url.pathname.endsWith('/complete') ? busy() : null))
    await expect(julian.upload({ data: new TextEncoder().encode('log'), name: 'a.log' })).rejects.toMatchObject({ status: 503 })
    expect(sent.filter(({ path }) => path.endsWith('/complete'))).toHaveLength(1)
  })
})

describe('naming the authors on a page', () => {
  /** Julian reading a board he and Ada wrote on, and every request for actors his reads made. */
  const reading = async (options: Parameters<typeof fakeMessageboard>[0] = {}) => {
    const api = fakeMessageboard(options)
    for (const principal of ['user:u_ada', 'user:u_jb']) await handleOn(api, principal).post('dev', { text: `from ${principal}` })
    const inner = as(api, 'user:u_jb')
    const asked: string[][] = []
    const lists: string[][] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actors')) (url.searchParams.has('id') ? asked : lists).push(url.searchParams.getAll('id'))
      return inner(input, init)
    }
    return { asked, lists, julian: board({ backend: vercel({ team: 'team_test', api: API, fetch }) }) }
  }
  const handles = (messages: { author?: { handle: string } | null }[]) => messages.map((message) => message.author?.handle).sort()

  it('asks the API for them by ID in one request, and never for its whole list', async () => {
    const { julian, asked, lists } = await reading()
    const { messages } = await julian.messages({ channel: 'dev' })
    expect(handles(messages)).toEqual(['ada', 'julian'])
    expect(asked.map((ids) => [...ids].sort())).toEqual([['vercel:user:u_ada', 'vercel:user:u_jb']])
    expect(lists).toEqual([])
    // Whom it has named, it doesn't ask for again.
    await julian.messages({ channel: 'dev' })
    expect(asked).toHaveLength(1)
  })

  it('names them from the whole list on an API that answers no actors by ID, and asks by ID once', async () => {
    const { julian, asked, lists } = await reading({ actorsById: false })
    expect(handles((await julian.messages({ channel: 'dev' })).messages)).toEqual(['ada', 'julian'])
    expect(asked).toHaveLength(1)
    expect(lists).toHaveLength(1)
    expect(handles((await julian.messages({ channel: 'dev' })).messages)).toEqual(['ada', 'julian'])
    expect(asked).toHaveLength(1)
    expect(lists).toHaveLength(1)
  })
})
