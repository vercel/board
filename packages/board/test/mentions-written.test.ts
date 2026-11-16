import { describe, expect, it } from 'vitest'
import type { CallerRequest, HostPrincipal } from '../src/access/index.ts'
import { caller, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

/** A host's own verifier, which names its people by their tokens: two of them go by `malte`. */
const PEOPLE: Record<string, HostPrincipal> = {
  pt_julian: { id: 'vercel:user:u_julian', kind: 'person', handle: 'julian' },
  pt_ada: { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' },
  pt_malte: { id: 'vercel:user:u_malte', kind: 'person', handle: 'malte' },
  pt_malte2: { id: 'vercel:user:u_malte2', kind: 'person', handle: 'malte' },
}
const hostVerifier = (request: CallerRequest) =>
  PEOPLE[request.credential ?? ''] ?? Response.json({ error: { code: 'unauthorized', message: 'who are you?' } }, { status: 401 })

const ADA = { id: 'vercel:user:u_ada', handle: 'ada', name: 'ada' }
const MALTE = { id: 'vercel:user:u_malte', handle: 'malte', name: 'malte' }
const MALTE2 = { id: 'vercel:user:u_malte2', handle: 'malte', name: 'malte' }

/** A board its people have each written on, so it knows them: `said` is each one's first message. */
async function boardOf(...people: string[]) {
  const board = testBoard({ authenticate: hostVerifier })
  const as = (token: string, headers?: Record<string, string>) => caller(board.fetch, token, headers)
  const said: Record<string, string> = {}
  for (const token of people) said[token] = (await as(token)('POST', '/messages', { channel: 'lobby', text: 'hello' })).body.message.id
  // A message as the board kept it: its thread, read back.
  const text = async (id: string) => {
    const { message, replies } = (await as('pt_julian')('GET', `/messages/${id}`)).body as { message: { id: string; text: string }; replies: { id: string; text: string }[] }
    return [message, ...replies].find((kept) => kept.id === id)?.text
  }
  return { as, said, text }
}

describe('a mention, when it is written', () => {
  it('stores the one actor a handle names as @[actor-id], and answers who', async () => {
    const { as, text } = await boardOf('pt_ada')
    const { status, body } = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: 'hey @ada, look: @Ada' })
    expect(status).toBe(201)
    expect(body.message.text).toBe('hey @[vercel:user:u_ada], look: @[vercel:user:u_ada]')
    expect(body.mentions).toEqual([{ written: '@ada', actor: ADA, candidates: [] }])
    // What it answered is what it kept.
    expect(await text(body.message.id)).toBe('hey @[vercel:user:u_ada], look: @[vercel:user:u_ada]')
  })

  it('keeps a handle no one has as typed, a mention of no one, and says so', async () => {
    const { as, text } = await boardOf('pt_ada')
    const { body } = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: 'cc @nobody' })
    expect(body.mentions).toEqual([{ written: '@nobody', actor: null, candidates: [] }])
    expect(await text(body.message.id)).toBe('cc @nobody')
  })

  it('names everyone who shares a handle, and takes the one who wrote in the thread', async () => {
    const { as, said, text } = await boardOf('pt_malte', 'pt_malte2')
    const fresh = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: '@malte?' })
    expect(fresh.body.message.text).toBe('@malte?')
    expect(fresh.body.mentions).toHaveLength(1)
    expect(fresh.body.mentions[0]).toMatchObject({ written: '@malte', actor: null })
    expect([...fresh.body.mentions[0].candidates].sort((a, b) => a.id.localeCompare(b.id))).toEqual([MALTE, MALTE2])
    // In the thread the second Malte started, it's him.
    const reply = await as('pt_julian')('POST', '/messages', { re: said.pt_malte2, text: '@malte?' })
    expect(reply.body.mentions).toEqual([{ written: '@malte', actor: MALTE2, candidates: [] }])
    expect(await text(reply.body.message.id)).toBe('@[vercel:user:u_malte2]?')
  })

  it("takes the board's own over a platform user who goes by the same handle, even in a thread only the platform user wrote in", async () => {
    const board = testBoard({ authenticate: hostVerifier })
    const as = (token: string) => caller(board.fetch, token)
    await as('pt_ada')('POST', '/messages', { channel: 'lobby', text: 'hello' })
    // A Slack user whose display name is `ada`, as the board's own sync records them, and the thread they started.
    const eve = { actor: 'slack:user:U_EVE', principal: 'slack:user:U_EVE', profile: null }
    await board.session.append({ type: 'actor.seen', payload: { actor: eve.actor, kind: 'external', handle: 'ada', name: 'ada', avatar: null, platform: 'slack' } })
    const [posted] = await board.session.append({
      type: 'message.posted',
      payload: { channel: 'dev', text: 'ping me here', re: null, replyTo: null, thread: 'eve-thread', labels: {}, noSync: false, by: eve, origin: null, from: 'slack' },
    })
    const fresh = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: '@ada?' })
    expect(fresh.body.mentions).toEqual([{ written: '@ada', actor: ADA, candidates: [] }])
    const reply = await as('pt_julian')('POST', '/messages', { re: String(posted!.index), text: '@ada, the deploy key is in the vault' })
    expect(reply.status).toBe(201)
    expect(reply.body.mentions).toEqual([{ written: '@ada', actor: ADA, candidates: [] }])
    expect(reply.body.message.text).toBe('@[vercel:user:u_ada], the deploy key is in the vault')
  })

  it('still names a platform user by a handle only they have', async () => {
    const board = testBoard({ authenticate: hostVerifier })
    await board.session.append({ type: 'actor.seen', payload: { actor: 'slack:user:U_EVE', kind: 'external', handle: 'eve', name: 'Eve', avatar: null, platform: 'slack' } })
    const { body } = await caller(board.fetch, 'pt_julian')('POST', '/messages', { channel: 'dev', text: 'hi @eve' })
    expect(body.message.text).toBe('hi @[slack:user:U_EVE]')
  })

  it('settles the text of an edit the same way', async () => {
    const { as, said, text } = await boardOf('pt_julian', 'pt_ada')
    const { status, body } = await as('pt_julian')('POST', `/messages/${said.pt_julian}/edit`, { text: 'hello @ada and @nobody' })
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      mentions: [
        { written: '@ada', actor: ADA, candidates: [] },
        { written: '@nobody', actor: null, candidates: [] },
      ],
    })
    expect(await text(said.pt_julian!)).toBe('hello @[vercel:user:u_ada] and @nobody')
  })

  it('names only who its caller can see', async () => {
    const { as } = await boardOf('pt_julian')
    // Ada has written only where a caller held to dev can't read.
    await as('pt_ada')('POST', '/messages', { channel: 'secret', text: 'hello' })
    const held = await as('pt_julian', { 'x-board-can': 'dev/=read,post;dev=read,post' })('POST', '/messages', { channel: 'dev', text: '@ada?' })
    expect(held.body.message.text).toBe('@ada?')
    expect(held.body.mentions).toEqual([{ written: '@ada', actor: null, candidates: [] }])
    const free = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: '@ada?' })
    expect(free.body.mentions).toEqual([{ written: '@ada', actor: ADA, candidates: [] }])
  })

  it('settles the text of a schedule when it is made, and of a task and a batch of tasks', async () => {
    const board = testBoard({ authenticate: hostVerifier, scheduler: fakeQueue().scheduler })
    const as = (token: string) => caller(board.fetch, token)
    await as('pt_ada')('POST', '/messages', { channel: 'lobby', text: 'hello' })
    const ada = [{ written: '@ada', actor: ADA, candidates: [] }]
    const scheduled = (await as('pt_julian')('POST', '/schedules', { channel: 'dev', in: '1h', text: 'standup, @ada' })).body
    expect([scheduled.schedule.text, scheduled.mentions]).toEqual(['standup, @[vercel:user:u_ada]', ada])
    const task = (await as('pt_julian')('POST', '/tasks', { channel: 'work', text: 'for @ada' })).body
    expect([task.task.text, task.mentions]).toEqual(['for @[vercel:user:u_ada]', ada])
    // A batch says each handle once, however many of its tasks typed it.
    const batch = (await as('pt_julian')('POST', '/tasks/batch', { channel: 'work', tasks: [{ text: 'one for @ada' }, { text: 'two for @ada and @nobody' }] })).body
    expect(batch.tasks.map((made: { text: string }) => made.text)).toEqual(['one for @[vercel:user:u_ada]', 'two for @[vercel:user:u_ada] and @nobody'])
    expect(batch.mentions).toEqual([...ada, { written: '@nobody', actor: null, candidates: [] }])
  })

  it("keeps a handle as typed where its ID would take the text past what a message holds, and never refuses it for that", async () => {
    const { as, text } = await boardOf('pt_ada')
    // 10,000 characters as typed: Ada's ID in place of her handle would make it longer.
    const written = `${'x'.repeat(9_995)} @ada`
    const { status, body } = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: written })
    expect([status, body.message.text === written]).toEqual([201, true])
    expect(body.mentions).toEqual([{ written: '@ada', actor: null, candidates: [ADA] }])
    expect(await text(body.message.id)).toBe(written)
  })

  it('says of a retry what the message its first try made mentions, not what the handle would now', async () => {
    const { as } = await boardOf()
    // No one goes by ada yet, so the first try keeps the handle as typed.
    const first = (await as('pt_julian')('POST', '/messages', { channel: 'dev', text: 'over to @ada', id: 'once' })).body
    expect([first.message.text, first.mentions]).toEqual(['over to @ada', [{ written: '@ada', actor: null, candidates: [] }]])
    // Ada writes, and the same post is sent again: it's the first one's message that comes back.
    await as('pt_ada')('POST', '/messages', { channel: 'lobby', text: 'hello' })
    const again = (await as('pt_julian')('POST', '/messages', { channel: 'dev', text: 'over to @ada', id: 'once' })).body
    expect([again.message.id, again.message.text]).toEqual([first.message.id, 'over to @ada'])
    expect(again.mentions).toEqual([{ written: '@ada', actor: null, candidates: [ADA] }])
  })

  it('says nothing of a text that types no handle: an exact mention, an email, code', async () => {
    const { as, text } = await boardOf('pt_ada')
    const written = 'cc @[vercel:user:u_ada] and @[ada@acme.com], run `@ada`, or mail ada@acme.com'
    const { body } = await as('pt_julian')('POST', '/messages', { channel: 'dev', text: written })
    expect(body).not.toHaveProperty('mentions')
    expect(await text(body.message.id)).toBe(written)
  })
})
