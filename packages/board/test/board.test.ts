import { describe, expect, it, vi } from 'vitest'
import { contract } from 'experimental-a2'
import { createServer } from 'experimental-a2/server'
import { z } from 'zod'
import { boardEvents, BOARD_SESSION } from '../src/contract/events.ts'
import { memory } from '../src/store/memory.ts'
import {
  BOARD_URL,
  caller,
  deploymentToken,
  mount,
  personToken,
  PROJECT_ID,
  testAuth,
  testBoard,
  testLocal,
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
  it("is the scheduler's callback for every server behind the board", async () => {
    const answer = new Response(null, { status: 204 })
    let mounted: readonly unknown[] = []
    const board = testBoard({
      scheduler: {
        schedule: async () => {},
        handler: (...servers) => {
          mounted = servers
          return async () => answer
        },
      },
    })
    expect(await board.scheduler(new Request(`${BOARD_URL}/a2/scheduler`, { method: 'POST' }))).toBe(answer)
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

  it('shows no session on what an older board wrote with one: a message, its event, and its author', async () => {
    const store = memory()
    const by = { actor: 'vercel:user:u_julian+claude', principal: 'vercel:user:u_julian', profile: 'claude', session: 'claude-1' }
    const older = createServer({ contract: contract({ name: 'board', events: { ...boardEvents, 'message.posted': boardEvents['message.posted'].extend({ by: z.unknown() }) } }), store: store.log }).session(BOARD_SESSION)
    await older.append({ type: 'actor.seen', payload: { actor: by.actor, kind: 'agent', handle: 'julian/claude', name: 'claude', avatar: null } })
    await older.append({ type: 'message.posted', id: 'old-post', payload: { channel: 'dev', text: 'from a session', re: null, replyTo: null, thread: 'old-post', labels: {}, noSync: true, by, origin: null, from: null } })

    const julian = caller(testBoard({ store }).fetch, await personToken())
    // A write brings the board's tables up to the log.
    await julian('POST', '/messages', { channel: 'elsewhere', text: 'now' })
    const [message] = (await julian('GET', '/messages?channel=dev')).body.messages
    expect(message).toMatchObject({ text: 'from a session' })
    expect(message.by).toEqual({ actor: 'vercel:user:u_julian+claude', principal: 'vercel:user:u_julian', profile: 'claude' })
    const { events } = (await julian('GET', '/events?channel=dev&after=0')).body
    expect(events.map((event: { payload: { by: unknown } }) => event.payload.by)).toEqual([{ actor: 'vercel:user:u_julian+claude', principal: 'vercel:user:u_julian', profile: 'claude' }])
  })

  it('ignores x-board-session, which released vb still sends inside a coding agent: it writes as its verified actor, and keeps none', async () => {
    const { fetch } = testBoard()
    const claude = caller(fetch, await personToken(), { 'x-board-profile': 'claude', 'x-board-session': 'claude-1' })
    const { status, body } = await claude('POST', '/messages', { channel: 'dev', text: 'hi' })
    expect(status).toBe(201)
    expect(body.message.by).toEqual({ actor: 'vercel:user:u_julian+claude', principal: 'vercel:user:u_julian', profile: 'claude' })
    expect((await claude('GET', '/me')).body).not.toHaveProperty('session')
    expect(JSON.stringify((await claude('GET', '/events?channel=dev&after=0')).body)).not.toContain('claude-1')
  })

  it('reads a log an older board wrote events in that board no longer has: account links', async () => {
    const store = memory()
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null }
    const older = createServer({
      contract: contract({
        name: 'board',
        events: {
          ...boardEvents,
          'actor.linked': z.object({ actor: z.string(), to: z.string(), method: z.enum(['code', 'consent']), by: z.unknown() }),
          'actor.unlinked': z.object({ actor: z.string(), by: z.unknown() }),
        },
      }),
      store: store.log,
    }).session(BOARD_SESSION)
    await older.append({ type: 'actor.seen', payload: { actor: 'slack:user:U_JB', kind: 'external', handle: 'jb', name: 'JB', avatar: null } })
    await older.append({ type: 'actor.linked', payload: { actor: 'slack:user:U_JB', to: by.principal, method: 'code', by } })
    await older.append({ type: 'actor.unlinked', payload: { actor: 'slack:user:U_JB', by } })

    const board = testBoard({ store })
    const julian = caller(board.fetch, await personToken(), {})
    await julian('POST', '/messages', { channel: 'dev', text: 'still here' })
    expect((await julian('GET', '/messages?channel=dev')).body.messages).toMatchObject([{ text: 'still here' }])
    expect((await julian('GET', '/actors')).body.actors).toContainEqual(expect.objectContaining({ id: 'slack:user:U_JB', handle: 'jb', kind: 'external' }))
    expect((await julian('GET', '/events?after=0&all=true&wait=0')).status).toBe(200)
  })

  it('identifies a person by the user_id on a development token, and names them by it', async () => {
    const { fetch } = testBoard()
    const call = caller(fetch, await personToken(), {})
    const { body } = await call('GET', '/me')
    expect(body).toMatchObject({
      actor: 'vercel:user:u_julian',
      kind: 'person',
      handle: 'u_julian',
      name: 'u_julian',
    })
  })

  it('names people only by what verified them: a handle or a name they send changes nothing', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'ceo', 'x-board-name': encodeURIComponent('The CEO') })
    const posted = await julian('POST', '/messages', { channel: 'dev', text: 'as I say I am' })
    expect(posted.body.message.author).toEqual({ kind: 'person', handle: 'u_julian', name: 'u_julian', avatar: null, verified: true })
    const claude = caller(fetch, await personToken(), { 'x-board-handle': 'ceo', 'x-board-profile': 'claude' })
    expect((await claude('GET', '/me')).body).toMatchObject({ handle: 'u_julian/claude', name: 'claude', via: { name: 'u_julian', environment: null } })
    expect((await julian('GET', '/actors')).body.actors.map((actor: { handle: string }) => actor.handle)).toEqual(['u_julian'])
  })

  it("names a deployment by its project in every environment, and its environment in its name", async () => {
    const { fetch } = testBoard()
    const preview = caller(fetch, await deploymentToken('support', 'prj_support', 'preview'))
    const posted = await preview('POST', '/messages', { channel: 'dev', text: 'from a preview' })
    expect(posted.body.message.author).toMatchObject({ kind: 'deployment', handle: 'support', name: 'support (preview)', verified: true })
    const agent = caller(fetch, await deploymentToken('support', 'prj_support', 'preview'), { 'x-board-profile': 'helper' })
    expect((await agent('GET', '/me')).body).toMatchObject({ handle: 'support/helper', via: { name: 'support', environment: 'preview' } })
    const production = caller(fetch, await deploymentToken('support', 'prj_support', 'production'))
    expect((await production('POST', '/messages', { channel: 'dev', text: 'from production' })).body.message.author).toMatchObject({ handle: 'support', name: 'support' })
  })

  it('gives a profile its own actor under the same principal', async () => {
    const { fetch } = testBoard()
    const call = caller(fetch, await personToken(), {
      'x-board-profile': 'Claude',
    })
    const { body } = await call('GET', '/me')
    expect(body).toMatchObject({
      actor: 'vercel:user:u_julian+claude',
      principal: 'vercel:user:u_julian',
      kind: 'agent',
      handle: 'u_julian/claude',
      name: 'Claude',
      avatar: null,
    })
  })

  it("takes a profile's avatar from its header's parameter, into the author of what it writes", async () => {
    const { fetch } = testBoard()
    const fixer = caller(fetch, await personToken(), { 'x-board-profile': 'fixer; avatar="https://example.com/fixer.png"' })
    const posted = await fixer('POST', '/messages', { channel: 'dev', text: 'on it' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.author).toMatchObject({ kind: 'agent', handle: 'u_julian/fixer', name: 'fixer', avatar: 'https://example.com/fixer.png' })
    const read = await fixer('GET', `/messages/${posted.body.message.id}`)
    expect(read.body.message.author.avatar).toBe('https://example.com/fixer.png')
    // As RFC 8941 serializes it, with the name as a string, and with a parameter it doesn't know.
    const canonical = caller(fetch, await personToken(), { 'x-board-profile': '"fixer";avatar="https://example.com/2.png";size=2' })
    expect((await canonical('GET', '/me')).body).toMatchObject({ profile: 'fixer', avatar: 'https://example.com/2.png' })
  })

  it('ignores x-board-avatar, which released vb still sends for a person: an avatar comes only with a profile, in its header', async () => {
    const { fetch } = testBoard()
    const post = async (headers: Record<string, string>) => (await caller(fetch, await personToken(), headers)('POST', '/messages', { channel: 'dev', text: 'hi' })).body.message
    expect((await post({ 'x-board-avatar': 'https://example.com/me.png' })).author).toMatchObject({ kind: 'person', handle: 'u_julian', avatar: null })
    expect((await post({ 'x-board-profile': 'fixer', 'x-board-avatar': 'https://example.com/fixer.png' })).author).toMatchObject({ kind: 'agent', name: 'fixer', avatar: null })
    expect((await post({ 'x-board-profile': 'fixer;avatar="https://example.com/2.png"', 'x-board-avatar': 'https://example.com/fixer.png' })).author).toMatchObject({ name: 'fixer', avatar: 'https://example.com/2.png' })
  })

  it('refuses a profile header that is not one, naming the form it takes', async () => {
    const { fetch } = testBoard()
    const as = async (headers: Record<string, string>) => {
      const { status, body } = await caller(fetch, await personToken(), headers)('POST', '/messages', { channel: 'dev', text: 'hi' })
      return [status, body.error?.code, body.error?.message]
    }
    for (const header of ['fixer;avatar=https://example.com/f.png', 'fixer ;avatar="https://example.com/f.png"', 'fixer;avatar="https://example.com/f.png', '1fixer', 'fixer, claude', 'fixer;x=', 'fixer;x=1"a;avatar="https://example.com/f.png"'])
      expect([header, ...(await as({ 'x-board-profile': header })).slice(0, 2)]).toEqual([header, 400, 'invalid_profile'])
    expect((await as({ 'x-board-profile': 'fixer;avatar=https://example.com/f.png' }))[2]).toMatch(/^x-board-profile is a structured header, like fixer;avatar="https:\/\/example\.com\/fixer\.png": /)
    expect(await as({ 'x-board-profile': 'fixer;avatar="ftp://example.com/f.png"' })).toEqual([400, 'invalid_profile', 'avatars must be https URLs (http only on localhost)'])
    expect((await caller(fetch, await personToken())('GET', '/messages?channel=dev')).body.messages).toEqual([])
  })

  it("serves known agents' marks, for an agent to pass as its avatar", async () => {
    const { fetch } = testBoard()
    // A known agent's mark is a URL its caller passes: a profile named for one gets none of its own accord.
    expect((await caller(fetch, await personToken(), { 'x-board-profile': 'pi' })('GET', '/me')).body).toMatchObject({ profile: 'pi', avatar: null })
    const pi = caller(fetch, await personToken(), { 'x-board-profile': 'pi;avatar="https://board.test/api/board/avatars/pi"' })
    expect((await pi('GET', '/me')).body).toMatchObject({ handle: 'u_julian/pi', avatar: 'https://board.test/api/board/avatars/pi' })
    const claude = await fetch(new Request(`${BOARD_URL}/avatars/claude`))
    expect(claude.headers.get('content-type')).toContain('svg')
    expect(await claude.text()).toContain('<path') // the mark, not a letter
    const fxAvatar = await (await fetch(new Request(`${BOARD_URL}/avatars/fx`))).text()
    expect(fxAvatar).toContain('<path') // fx's mark, not its initial
  })

  it('rejects other projects until a grant names them, once g2 no longer names every one', async () => {
    const plain = testBoard()
    await plain.revokeGrant('g2')
    const call = caller(plain.fetch, await deploymentToken())
    expect((await call('GET', '/me')).status).toBe(403)

    const trusted = testBoard()
    await trusted.revokeGrant('g2')
    await trusted.createGrant({ principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { '*': 'all' } })
    const { body } = await caller(trusted.fetch, await deploymentToken())('GET', '/me')
    expect(body).toMatchObject({ actor: 'vercel:project:prj_marketing:production', handle: 'marketing' })
  })

  it("limits a workflow to what its grant's `can` allows", async () => {
    const board = testBoard()
    const { fetch } = board
    await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web', workflow: 'deploy.yml', branch: 'main' }], can: { '*': ['post'] } })
    const call = caller(fetch, await workflowToken())
    const posted = await call('POST', '/messages', { channel: 'errors-www', text: 'deploy failed' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by.principal).toBe('github:repo:123456')
    // `['post']` is write-only: what it can't read answers as if it didn't exist.
    const react = await call('POST', `/messages/${posted.body.message.id}/reactions`, { emoji: 'eyes' })
    expect(react.status).toBe(404)

    const otherWorkflow = caller(fetch, await workflowToken({ workflow_ref: 'acme/web/.github/workflows/evil.yml@refs/heads/x' }))
    expect((await otherWorkflow('GET', '/me')).status).toBe(403)
  })
})

describe('messages', () => {
  it('posts, replies, and reads a thread', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken(), {})

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
      // A channel's last index is a2's own count, which a decimal ID happens to equal.
      { path: 'errors-www', lastIndex: Number(nested.body.message.id), messages: 3, threads: 1 },
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

  it('never fails a write over a mention: a handle no one has, an actor ID the board has never seen, an email', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'), {})
    for (const id of ['u_ada', 'u_ada2']) await caller(fetch, await personToken(id), {})('POST', '/messages', { channel: 'x', text: 'hi' })

    // No one goes by ada or nobody, and the board knows no u_nobody: each is kept as typed.
    for (const text of ['thanks @ada', 'thanks @nobody', 'cc @[vercel:user:u_nobody]', 'cc @[ada@vercel.com]']) {
      const posted = await julian('POST', '/messages', { channel: 'x', text })
      expect([posted.status, posted.body.message.text], text).toEqual([201, text])
    }
    const { id } = (await julian('POST', '/messages', { channel: 'x', text: 'draft' })).body.message
    expect((await julian('POST', `/messages/${id}/edit`, { text: 'thanks @ada and @nobody' })).status).toBe(200)
    expect((await julian('GET', `/messages/${id}`)).body.message.text).toBe('thanks @ada and @nobody')
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
    // People a Vercel login names by user ID, readable here so their handles are.
    const julian = caller(fetch, await personToken('julian'), {})
    const ada = caller(fetch, await personToken('ada'), {})
    await julian('POST', '/messages', { channel: 'www/production', text: 'one', labels: { status: 'open' } })
    await julian('POST', '/messages', { channel: 'www/staging', text: 'two' })
    await ada('POST', '/messages', { channel: 'docs', text: 'hey @julian' })

    const texts = async (query: string) =>
      (await julian('GET', `/messages?${query}`)).body.messages.map((m: { text: string }) => m.text)
    expect(await texts('channel=www/')).toEqual(['one', 'two'])
    expect(await texts('label=status=open')).toEqual(['one'])
    // Julian has written, so Ada's handle for him is stored as the mention of him it is.
    expect(await texts('by=ada')).toEqual(['hey @[vercel:user:julian]'])
    expect(await texts('mentions=me')).toEqual(['hey @[vercel:user:julian]'])
  })

  it('finds mentions by what the text says: a handle, an actor ID, or an email, never in code', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('julian'), {})
    const claude = caller(fetch, await personToken('julian'), { 'x-board-profile': 'claude' })
    const ada = caller(fetch, await personToken('ada'), {})
    await julian('POST', '/messages', { channel: 'docs', text: 'hi' })
    await claude('POST', '/messages', { channel: 'docs', text: 'hi' })
    for (const text of ['@Julian look', 'over to @julian/claude', 'cc @[vercel:user:julian]', 'cc @[vercel:user:julian+claude]', 'ask @[Grace@acme.com]', 'run `@julian`', '@juliana hi'])
      await ada('POST', '/messages', { channel: 'docs', text })

    const texts = async (as: typeof julian, mentions: string) =>
      (await as('GET', `/messages?channel=docs&mentions=${encodeURIComponent(mentions)}`)).body.messages.map((m: { text: string }) => m.text)
    // A handle that names one actor was stored as a mention of them, the same as their ID written out.
    const [byHandle, agentByHandle] = ['@[vercel:user:julian] look', 'over to @[vercel:user:julian+claude]']
    // A person is everyone they are: their handle and ID, and their agents'.
    expect(await texts(ada, 'julian')).toEqual([byHandle, agentByHandle, 'cc @[vercel:user:julian]', 'cc @[vercel:user:julian+claude]'])
    expect(await texts(ada, 'vercel:user:julian')).toEqual(await texts(ada, 'julian'))
    expect(await texts(ada, 'julian/claude')).toEqual([agentByHandle, 'cc @[vercel:user:julian+claude]'])
    expect(await texts(ada, 'grace@acme.com')).toEqual(['ask @[Grace@acme.com]'])
    // Me is my handle and my ID.
    expect(await texts(julian, 'me')).toEqual([byHandle, 'cc @[vercel:user:julian]'])
    expect(await texts(claude, 'me')).toEqual([agentByHandle, 'cc @[vercel:user:julian+claude]'])
  })

  it('filters by source, text, a label key or any of its values, and a thread root\'s labels', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'), {})
    const { body: pr } = await julian('POST', '/messages', {
      channel: 'prs',
      text: 'PR #1: Add filters',
      labels: { pr: 'vercel/board#1', state: 'open' },
    })
    await julian('POST', '/messages', { re: pr.message.id, text: 'Looks FLAKY to me' })
    await julian('POST', '/messages', { channel: 'prs', text: 'PR #2: Draft', labels: { pr: 'vercel/board#2', state: 'draft' } })
    await julian('POST', '/messages', { channel: 'prs', text: 'no labels here' })

    const texts = async (query: string) =>
      (await julian('GET', `/messages?${query}`)).body.messages.map((m: { text: string }) => m.text)
    // A key alone; a root's label reaches its replies.
    expect(await texts('label=pr')).toEqual(['PR #1: Add filters', 'Looks FLAKY to me', 'PR #2: Draft'])
    expect(await texts(`label=${encodeURIComponent('pr=vercel/board#1')}`)).toEqual(['PR #1: Add filters', 'Looks FLAKY to me'])
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
    const julian = caller(fetch, await personToken(), {})
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
    expect(body.events[1].actor).toMatchObject({ id: 'vercel:user:u_julian', name: 'u_julian' })
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

  it('resumes a stream where Last-Event-ID says, and answers a bad cursor before streaming', async () => {
    const { fetch } = testBoard()
    const token = await personToken()
    const julian = caller(fetch, token)
    const one = (await julian('POST', '/messages', { channel: 'x', text: 'one' })).body.message
    await julian('POST', '/messages', { channel: 'x', text: 'two' })
    const controller = new AbortController()
    const response = await fetch(
      new Request(`${BOARD_URL}/events`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'last-event-id': one.id },
        signal: controller.signal,
      }),
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('"text":"two"')) text += decoder.decode((await reader.read()).value)
    expect(text).not.toContain('"text":"one"')
    controller.abort()
    await reader.cancel()

    const bad = await fetch(new Request(`${BOARD_URL}/events?after=nope`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_cursor' } })
  })
})

describe('writes', () => {
  // A2 clones state at every read, so a board's whole messages state costs its size each time.
  it('look the message up once: the check and the write share it', async () => {
    const store = memory()
    let lookups = 0
    const tables = { ...store.tables, message: (id: number) => (lookups++, store.tables.message(id)) }
    const board = testBoard({ store: { ...store, tables } })
    const julian = caller(board.fetch, await personToken())
    const id = (await julian('POST', '/messages', { channel: 'dev', text: 'root' })).body.message.id
    const reads = async (write: () => Promise<{ status: number }>) => {
      lookups = 0
      expect((await write()).status).toBeLessThan(300)
      return lookups
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

describe('its URL', () => {
  it("learns its mount from requests, and none that only makes the path look longer moves it", async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('VERCEL_URL', 'board-abc.vercel.app')
    try {
      const board = testBoard({ url: undefined })
      const at = (path: string, token?: string) =>
        board.fetch(new Request(`https://board-abc.vercel.app${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}))
      // No one's request first: the handler is mounted at /api/board, so this one's path only looks deeper.
      expect((await at('/api/board/x/messages/1')).status).toBe(401)
      await at('/api/board/me', await personToken('u_julian', 'https://board-abc.vercel.app/api/board'))
      expect(board.url).toBe('https://board-abc.vercel.app/api/board')
      // Nor after: wherever it says the mount is, it stays where requests show it is.
      expect((await at('/api/board/elsewhere/deeper/messages/1')).status).toBe(401)
      expect(board.url).toBe('https://board-abc.vercel.app/api/board')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // A board mounted in a server of your own, behind a proxy that passes any Host on.
  const selfHosted = () => {
    const board = mount({ auth: { ...testAuth, local: testLocal } })
    const at = async (host: string, path = '/me') =>
      board.fetch(new Request(`https://${host}/api/board${path}`, { headers: { authorization: `Bearer ${await personToken('u_julian', `https://${host}/api/board`)}` } }))
    return { board, at }
  }

  it("verifies no token in production without url, since a request's sender names its Host", async () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const { board, at } = selfHosted()
      const me = await at('attacker.example')
      expect(me.status).toBe(500)
      expect(await me.json()).toMatchObject({ error: { code: 'no_board_url', hint: expect.stringContaining('board({ url:') } })
      // Nor does discovery tell a client which audience to mint for.
      expect((await board.fetch(new Request('https://attacker.example/api/board'))).status).toBe(500)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('lets a request with no token through to who verifies it in production without url, since there is no audience to check', async () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('NODE_ENV', 'production')
    try {
      // A host whose page signs people in with a cookie of its own.
      const cookied = mount({ authenticate: ({ headers }) => (headers.get('cookie') === 'session=ada' ? { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } : null) })
      const me = await cookied.fetch(new Request('https://board.example/api/board/me', { headers: { cookie: 'session=ada' } }))
      expect(me.status).toBe(200)
      expect(await me.json()).toMatchObject({ principal: 'vercel:user:u_ada' })
      // No one at all is no one: refused as any board refuses them, not for want of a URL.
      expect((await selfHosted().board.fetch(new Request('https://board.example/api/board/me'))).status).toBe(401)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('takes its URL from requests on Vercel, which routes only its own domains to it', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('NODE_ENV', 'production')
    try {
      expect((await selfHosted().at('board-abc.vercel.app')).status).toBe(200)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('takes its URL from requests in development, and says once to set url', async () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('NODE_ENV', 'development')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { at } = selfHosted()
      expect((await at('localhost:3000')).status).toBe(200)
      expect((await at('localhost:3000')).status).toBe(200)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('board({ url })')
    } finally {
      warn.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
