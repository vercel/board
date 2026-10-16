import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileAccess } from '../src/server/access.ts'
import { readableLinks } from '../src/server/feed.ts'
import { foldSchedules } from '../src/server/schedules.ts'
import { githubActions, vercelProject } from '../src/server/index.ts'
import type { MessagesState } from '../src/contract/reducers.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard, workflowToken } from './harness.ts'
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
    expect((await front('GET', '/me')).body).toMatchObject({ principal: 'vercel:project:prj_marketing:production', access: { 'feedback/': ['post'] } })
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
})
