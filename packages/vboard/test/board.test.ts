import { describe, expect, it, vi } from 'vitest'
import { messagesReducer } from '../src/contract/reducers.ts'
import { githubActions, vercelProject } from '../src/server/index.ts'
import {
  BOARD_URL,
  caller,
  deploymentToken,
  personToken,
  PROJECT_ID,
  testBoard,
  workflowToken,
} from './harness.ts'

describe('discovery', () => {
  it('tells clients which project to mint tokens for', async () => {
    const { fetch } = testBoard()
    const response = await fetch(new Request(BOARD_URL))
    expect(await response.json()).toMatchObject({
      url: BOARD_URL,
      audience: BOARD_URL,
      project_id: PROJECT_ID,
      team_id: 'team_test',
    })
  })
})

describe('scheduler', () => {
  it("is the scheduler's callback for every server behind the board", () => {
    const callback = async () => new Response(null, { status: 204 })
    let mounted: readonly unknown[] = []
    const board = testBoard({
      scheduler: {
        schedule: async () => {},
        handler: (...servers) => {
          mounted = servers
          return callback
        },
      },
    })
    expect(board.scheduler).toBe(callback)
    expect(mounted).toEqual(board.servers)
  })

  it('answers 404 when the board has none', async () => {
    const response = await testBoard().scheduler(new Request(`${BOARD_URL}/a2/scheduler`, { method: 'POST' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { message: 'this board has no scheduler' } })
  })
})

describe('auth', () => {
  it('rejects requests without a token', async () => {
    const { fetch } = testBoard()
    const response = await fetch(new Request(`${BOARD_URL}/channels`))
    expect(response.status).toBe(401)
  })

  it('rejects a token minted for another board', async () => {
    const { fetch } = testBoard()
    const call = caller(fetch, await personToken('u_julian', 'https://elsewhere.test/api/board'))
    expect((await call('GET', '/me')).status).toBe(401)
  })

  it('reads agents the log recorded with their old kind, profile, as agents', async () => {
    const board = testBoard()
    await board.session.append({
      type: 'actor.seen',
      payload: { actor: 'vercel:user:u_ada+claude', kind: 'profile', handle: 'ada/claude', name: 'claude', avatar: null },
    })
    const call = caller(board.fetch, await personToken())
    const { body } = await call('GET', '/actors')
    expect(body.actors).toContainEqual(expect.objectContaining({ id: 'vercel:user:u_ada+claude', kind: 'agent' }))
  })

  it('identifies a person by the user_id on a development token', async () => {
    const { fetch } = testBoard()
    const call = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
    const { body } = await call('GET', '/me')
    expect(body).toMatchObject({
      actor: 'vercel:user:u_julian',
      kind: 'person',
      handle: 'julian',
    })
  })

  it('gives a profile its own actor under the same principal', async () => {
    const { fetch } = testBoard()
    const call = caller(fetch, await personToken(), {
      'x-board-handle': 'julian',
      'x-board-profile': 'Claude',
    })
    const { body } = await call('GET', '/me')
    expect(body).toMatchObject({
      actor: 'vercel:user:u_julian+claude',
      principal: 'vercel:user:u_julian',
      kind: 'agent',
      handle: 'julian/claude',
      name: 'Claude',
      avatar: `${BOARD_URL}/avatars/claude`,
    })
  })

  it("shows a person's own name and avatar, and an agent's mark", async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken(), {
      'x-board-handle': 'julian',
      'x-board-name': encodeURIComponent('Julián Benegas'),
      'x-board-avatar': 'https://vercel.com/api/www/avatar/abc123?s=128',
    })
    expect((await julian('GET', '/me')).body).toMatchObject({
      kind: 'person',
      handle: 'julian',
      name: 'Julián Benegas',
      avatar: 'https://vercel.com/api/www/avatar/abc123?s=128',
    })
    const pi = caller(fetch, await personToken(), { 'x-board-handle': 'julian', 'x-board-profile': 'pi' })
    expect((await pi('GET', '/me')).body).toMatchObject({ handle: 'julian/pi', avatar: `${BOARD_URL}/avatars/pi` })
    const claude = await fetch(new Request(`${BOARD_URL}/avatars/claude`))
    expect(claude.headers.get('content-type')).toContain('svg')
    expect(await claude.text()).toContain('<path') // the mark, not a letter
  })

  it('rejects other projects unless access lists them', async () => {
    const call = caller(testBoard().fetch, await deploymentToken())
    expect((await call('GET', '/me')).status).toBe(403)

    const trusted = testBoard({ access: [vercelProject({ project: 'marketing', can: 'all' })] })
    const { body } = await caller(trusted.fetch, await deploymentToken())('GET', '/me')
    expect(body).toMatchObject({ actor: 'vercel:project:prj_marketing:production', handle: 'marketing' })
  })

  it('limits a workflow to what `can` allows', async () => {
    const { fetch } = testBoard({
      access: [
        githubActions({ repository: 'basehub-ai/www', workflow: '.github/workflows/deploy.yml', can: ['post'] }),
      ],
    })
    const call = caller(fetch, await workflowToken())
    const posted = await call('POST', '/messages', { channel: 'errors-www', text: 'deploy failed' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by.principal).toBe('github:repo:123456')
    // `['post']` is write-only: what it can't read answers as if it didn't exist.
    const react = await call('POST', `/messages/${posted.body.message.id}/reactions`, { emoji: 'eyes' })
    expect(react.status).toBe(404)

    const otherWorkflow = caller(fetch, await workflowToken({ workflow_ref: 'basehub-ai/www/.github/workflows/evil.yml@refs/heads/x' }))
    expect((await otherWorkflow('GET', '/me')).status).toBe(403)
  })
})

describe('messages', () => {
  it('posts, replies, and reads a thread', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = await julian('POST', '/messages', { channel: 'errors-www', text: 'deploy failed' })
    expect(root.status).toBe(201)
    const rootId = root.body.message.id
    const reply = await julian('POST', '/messages', { re: rootId, text: 'rolled back' })
    const nested = await julian('POST', '/messages', { re: reply.body.message.id, text: 'fixed' })
    expect(nested.body.message).toMatchObject({ re: rootId, replyTo: reply.body.message.id, channel: 'errors-www' })

    const thread = await julian('GET', `/messages/${nested.body.message.id}`)
    expect(thread.body.message.id).toBe(rootId)
    expect(thread.body.replies.map((m: { text: string }) => m.text)).toEqual(['rolled back', 'fixed'])

    const channels = await julian('GET', '/channels')
    expect(channels.body.channels).toEqual([
      { path: 'errors-www', lastIndex: nested.body.message.id, messages: 3, threads: 1 },
    ])
  })

  it('uses a client id to make retries idempotent', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const first = await julian('POST', '/messages', { channel: 'x', text: 'once', id: 'retry-1' })
    const again = await julian('POST', '/messages', { channel: 'x', text: 'once', id: 'retry-1' })
    expect(again.body.message.id).toBe(first.body.message.id)
    const { body } = await julian('GET', '/messages?channel=x')
    expect(body.messages).toHaveLength(1)
  })

  it('resolves mentions to actor IDs and rejects unknown or ambiguous ones', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'), { 'x-board-handle': 'julian' })
    const ada = caller(fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    await ada('POST', '/messages', { channel: 'x', text: 'hi' })

    const posted = await julian('POST', '/messages', { channel: 'x', text: 'thanks @ada, not `@nobody`' })
    expect(posted.body.message.mentions).toEqual(['vercel:user:u_ada'])

    const unknown = await julian('POST', '/messages', { channel: 'x', text: '@nobody' })
    expect(unknown.body.error.code).toBe('unknown_mention')

    const otherAda = caller(fetch, await personToken('u_ada2'), { 'x-board-handle': 'ada' })
    await otherAda('POST', '/messages', { channel: 'x', text: 'me too' })
    const ambiguous = await julian('POST', '/messages', { channel: 'x', text: '@ada' })
    expect(ambiguous.body.error).toMatchObject({ code: 'ambiguous_mention' })
    expect(ambiguous.body.error.message).toContain('@[vercel:user:u_ada]')

    const exact = await julian('POST', '/messages', { channel: 'x', text: '@[vercel:user:u_ada2]' })
    expect(exact.body.message.mentions).toEqual(['vercel:user:u_ada2'])
  })

  it('edits, reacts, labels, and tombstones', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'))
    const ada = caller(fetch, await personToken('u_ada'))
    const { body } = await julian('POST', '/messages', { channel: 'x', text: 'draft' })
    const id = body.message.id

    expect((await ada('POST', `/messages/${id}/edit`, { text: 'hijack' })).status).toBe(403)
    await julian('POST', `/messages/${id}/edit`, { text: 'final' })
    await ada('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })
    await ada('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })
    await julian('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })
    await julian('POST', `/messages/${id}/labels`, { set: { status: 'open', owner: 'ada' } })
    await julian('POST', `/messages/${id}/labels`, { unset: ['owner'] })

    let read = await julian('GET', `/messages/${id}`)
    expect(read.body.message).toMatchObject({
      text: 'final',
      reactions: { eyes: ['vercel:user:u_ada', 'vercel:user:u_julian'] },
      labels: { status: 'open' },
    })
    expect(read.body.message.editedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    await julian('POST', `/messages/${id}/delete`)
    read = await julian('GET', `/messages/${id}`)
    expect(read.body.message).toMatchObject({ deleted: true, text: '', reactions: {} })
    expect((await julian('POST', `/messages/${id}/edit`, { text: 'zombie' })).status).toBe(400)
  })

  it('filters by channel subtree, label, author, and mentions', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'), { 'x-board-handle': 'julian' })
    const ada = caller(fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    await julian('POST', '/messages', { channel: 'www/production', text: 'one', labels: { status: 'open' } })
    await julian('POST', '/messages', { channel: 'www/staging', text: 'two' })
    await ada('POST', '/messages', { channel: 'docs', text: 'hey @julian' })

    const texts = async (query: string) =>
      (await julian('GET', `/messages?${query}`)).body.messages.map((m: { text: string }) => m.text)
    expect(await texts('channel=www/')).toEqual(['one', 'two'])
    expect(await texts('label=status=open')).toEqual(['one'])
    expect(await texts('by=ada')).toEqual(['hey @julian'])
    expect(await texts('mentions=me')).toEqual(['hey @julian'])
  })

  it('filters by source, text, a label key or any of its values, and a thread root\'s labels', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'), { 'x-board-handle': 'julian' })
    const { body: pr } = await julian('POST', '/messages', {
      channel: 'prs',
      text: 'PR #1: Add filters',
      labels: { pr: 'basehub-ai/vboard#1', state: 'open' },
    })
    await julian('POST', '/messages', { re: pr.message.id, text: 'Looks FLAKY to me' })
    await julian('POST', '/messages', { channel: 'prs', text: 'PR #2: Draft', labels: { pr: 'basehub-ai/vboard#2', state: 'draft' } })
    await julian('POST', '/messages', { channel: 'prs', text: 'no labels here' })

    const texts = async (query: string) =>
      (await julian('GET', `/messages?${query}`)).body.messages.map((m: { text: string }) => m.text)
    // A key alone; a root's label reaches its replies.
    expect(await texts('label=pr')).toEqual(['PR #1: Add filters', 'Looks FLAKY to me', 'PR #2: Draft'])
    expect(await texts(`label=${encodeURIComponent('pr=basehub-ai/vboard#1')}`)).toEqual(['PR #1: Add filters', 'Looks FLAKY to me'])
    expect(await texts(`label=${encodeURIComponent('state=open|draft')}&text=pr%20%23`)).toEqual(['PR #1: Add filters', 'PR #2: Draft'])
    expect(await texts('label=pr&text=flaky')).toEqual(['Looks FLAKY to me'])
    expect(await texts('from=board&text=no%20labels')).toEqual(['no labels here'])
    expect(await texts('from=slack')).toEqual([])
    expect((await julian('GET', '/messages?label=Bad=1')).status).toBe(400)
  })
})

describe('events', () => {
  it('long-polls: returns waiting matches at once, else waits for the next one', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const first = await julian('POST', '/messages', { channel: 'x', text: 'one' })

    const backlog = await julian('GET', '/events?after=0&channel=x')
    expect(backlog.body.events.map((e: { type: string }) => e.type)).toEqual(['message.posted'])

    const waiting = julian('GET', `/events?after=${backlog.body.cursor}&channel=x&wait=5`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await julian('POST', '/messages', { channel: 'y', text: 'elsewhere' })
    await julian('POST', '/messages', { re: first.body.message.id, text: 'two' })
    const { body } = await waiting
    expect(body.events).toHaveLength(1)
    expect(body.events[0].message.text).toBe('two')
  })

  it('delivers label changes to subscribers whose view a message enters or leaves', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'x', text: 'pr', labels: { state: 'open' } })
    const start = (await julian('GET', '/events?after=0&label=state=open')).body.cursor

    await julian('POST', `/messages/${body.message.id}/labels`, { set: { state: 'merged' } })
    const left = await julian('GET', `/events?after=${start}&label=state=open`)
    expect(left.body.events).toHaveLength(1)
    expect(left.body.events[0].message.labels).toEqual({ state: 'merged' })

    const unrelated = await julian('GET', `/events?after=${left.body.cursor}&label=state=open&wait=0`)
    expect(unrelated.body.events).toHaveLength(0)
  })

  it("tails a PR's conversation by its label, and says who did what", async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
    const { body: pr } = await julian('POST', '/messages', { channel: 'prs', text: 'PR #1', labels: { pr: 'x/y#1' } })
    const start = (await julian('GET', '/events?label=pr%3Dx%2Fy%231&wait=0')).body.cursor
    await julian('POST', '/messages', { channel: 'prs', text: 'elsewhere' })
    await julian('POST', '/messages', { re: pr.message.id, text: 'a comment on the PR' })
    await julian('POST', `/messages/${pr.message.id}/reactions`, { emoji: 'eyes' })
    const { body } = await julian('GET', `/events?after=${start}&label=pr%3Dx%2Fy%231`)
    expect(body.events.map((e: { type: string; message: { text: string } }) => [e.type, e.message.text])).toEqual([
      ['message.posted', 'a comment on the PR'],
      ['reaction.added', 'PR #1'],
    ])
    expect(body.events[1].actor).toMatchObject({ id: 'vercel:user:u_julian', name: 'julian' })
  })

  it('streams server-sent events from a cursor', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    await julian('POST', '/messages', { channel: 'x', text: 'one' })

    const controller = new AbortController()
    const response = await fetch(
      new Request(`${BOARD_URL}/events?after=0`, {
        headers: { authorization: `Bearer ${await personToken()}`, accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    )
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
    }
    await readUntil('"text":"one"')
    await julian('POST', '/messages', { channel: 'x', text: 'two' })
    await readUntil('"text":"two"')
    expect(text).toMatch(/id: \d+\nevent: board\ndata: /)
    controller.abort()
    await reader.cancel()
  })
})

describe('writes', () => {
  // A2 clones state at every read, so a board's whole messages state costs its size each time.
  it('read the messages state once: the check and the write share it', async () => {
    const board = testBoard()
    const julian = caller(board.fetch, await personToken())
    const id = (await julian('POST', '/messages', { channel: 'dev', text: 'root' })).body.message.id
    const state = vi.spyOn(board.session, 'state')
    const reads = async (write: () => Promise<{ status: number }>) => {
      state.mockClear()
      expect((await write()).status).toBeLessThan(300)
      return state.mock.calls.filter(([reducer]) => reducer === messagesReducer).length
    }
    expect({
      react: await reads(() => julian('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })),
      label: await reads(() => julian('POST', `/messages/${id}/labels`, { set: { kind: 'bug' } })),
      reply: await reads(() => julian('POST', '/messages', { re: id, text: 'on it' })),
      edit: await reads(() => julian('POST', `/messages/${id}/edit`, { text: 'root, edited' })),
      root: await reads(() => julian('POST', '/messages', { channel: 'dev', text: 'another' })),
    }).toEqual({ react: 1, label: 1, reply: 1, edit: 1, root: 0 })
  })
})
