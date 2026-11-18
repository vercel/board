import { describe, expect, it } from 'vitest'
import { testBoard } from './harness.ts'
import { carried } from '../src/server/carried.ts'
import type { BoardEventView } from '../src/api/routes.ts'

const texts = (events: { type: string; message?: { text: string } }[]) => events.filter((event) => event.type === 'message.posted').map((event) => event.message?.text)

describe("a feed's newest events (`last`)", () => {
  it("answers the board's, a tree's and a channel's newest, oldest first", async () => {
    const team = testBoard()
    for (const [channel, text] of [['dev', 'one'], ['dev/web', 'two'], ['ops', 'three'], ['dev', 'four']] as const) await team.post(channel, { text })

    expect(texts((await team.poll({ last: 3 })).events)).toEqual(['two', 'three', 'four'])
    expect(texts((await team.poll({ channel: 'dev/', last: 2 })).events)).toEqual(['two', 'four'])
    expect(texts((await team.poll({ channel: 'ops', last: 5 })).events)).toEqual(['three'])
  })

  it('goes on from the cursor it answers with what comes next, and from an event\'s own with what came after it', async () => {
    const team = testBoard()
    for (const text of ['one', 'two', 'three']) await team.post('dev', { text })
    const page = await team.poll({ last: 2 })
    await team.post('ops', { text: 'four' })

    expect(texts(page.events)).toEqual(['two', 'three'])
    expect(texts((await team.poll({ after: page.cursor })).events)).toEqual(['four'])
    expect(texts((await team.poll({ after: page.events[0]!.cursor })).events)).toEqual(['three', 'four'])
  })

  it('shows a message as its last event here left it, with every event (`all`)', async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'first words' })
    await team.edit(id, 'last words')

    const { events } = await team.poll({ all: true, last: 10 })

    expect(events.at(-1)).toMatchObject({ type: 'message.edited', message: { id, text: 'last words' } })
  })

  it('counts what matches, looking back past a page of the log for it', async () => {
    const team = testBoard()
    await team.post('dev', { text: 'the one in dev' })
    for (let i = 0; i < 230; i++) await team.post('ops', { text: `in ops ${i}` })

    expect(texts((await team.poll({ channel: 'dev', last: 1 })).events)).toEqual(['the one in dev'])
    expect(texts((await team.poll({ last: 2 })).events)).toEqual(['in ops 228', 'in ops 229'])
  })

  it('answers nothing, and where the feed is, on a board with no events', async () => {
    const team = testBoard()
    const page = await team.poll({ last: 5 })
    await team.post('dev', { text: 'the first' })

    expect(page.events).toEqual([])
    expect(texts((await team.poll({ after: page.cursor })).events)).toEqual(['the first'])
  })

  it('takes no `after` or `wait`, and 100 at most', async () => {
    const team = testBoard()
    const { cursor } = await team.poll()

    await expect(team.poll({ last: 5, after: cursor })).rejects.toMatchObject({ status: 400 })
    await expect(team.poll({ last: 5, wait: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(team.poll({ last: 101 })).rejects.toMatchObject({ status: 400 })
  })

  it('starts a stream of events with them, then follows', async () => {
    const team = testBoard()
    for (const text of ['one', 'two', 'three']) await team.post('dev', { text })
    const controller = new AbortController()
    const seen: (string | undefined)[] = []

    for await (const event of team.events({ last: 2 }, { signal: controller.signal })) {
      seen.push(event.message?.text)
      if (seen.length === 2) await team.post('dev', { text: 'four' })
      if (seen.length === 3) controller.abort()
    }

    expect(seen).toEqual(['two', 'three', 'four'])
  })
})

describe("a feed's newest events, each with its message as it is now", () => {
  const texts = (events: { type: string; message?: { text: string } }[]) => events.filter((event) => event.type === 'message.posted').map((event) => event.message?.text)
  const raw = async (team: ReturnType<typeof testBoard>) => (await team.request('/events?all=true&last=20')).text()
  const posted = (body: string) => (JSON.parse(body) as { events: { type: string }[] }).events.find((event) => event.type === 'message.posted')

  it('answers no text of a message deleted since: its tombstone, in the response itself', async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'secret words' })
    await team.delete(id)

    const body = await raw(team)

    expect(body).not.toContain('secret words')
    expect(posted(body)).toMatchObject({ message: { id, deleted: true } })
  })

  it('answers what an edited message says now, and not what it said', async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'first words' })
    await team.edit(id, 'last words')

    const body = await raw(team)

    expect(body).not.toContain('first words')
    expect(posted(body)).toMatchObject({ payload: { text: 'last words' }, message: { id, text: 'last words' } })
  })

  it('leaves out an event a filter on text found by what its message no longer says', async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'the falcon landed' })
    await team.post('dev', { text: 'a falcon again' })
    await team.delete(id)

    expect(texts((await team.poll({ text: 'falcon', last: 10 })).events)).toEqual(['a falcon again'])
  })
})

describe("a feed's newest events, with nothing their messages no longer carry", () => {
  type Events = { events: { type: string; payload: Record<string, unknown> }[] }
  const raw = async (team: ReturnType<typeof testBoard>) => (await team.request('/events?all=true&last=50')).text()
  const send = (team: ReturnType<typeof testBoard>, path: string, body: object) =>
    team.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) })

  it('answers a label change with the values its message still carries, in the response itself', async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'labelled' })
    await team.label(id, { set: { stage: 'value-since-replaced', kind: 'value-since-removed' } })
    await team.label(id, { set: { stage: 'value-it-has' } })
    await team.label(id, { unset: ['kind'] })
    const gone = await team.post('dev', { text: 'to delete' })
    await team.label(gone.id, { set: { stage: 'value-of-a-deleted-message' } })
    await team.delete(gone.id)

    const body = await raw(team)

    for (const value of ['value-since-replaced', 'value-since-removed', 'value-of-a-deleted-message']) expect(body).not.toContain(value)
    expect((JSON.parse(body) as Events).events.filter((event) => event.type === 'labels.changed').map((event) => event.payload.set)).toEqual([{}, { stage: 'value-it-has' }, {}, {}])
  })

  it('leaves out a reaction since removed, and answers one that is there', async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'reacted to' })
    await team.react(id, 'eyes')
    await team.react(id, 'eyes', { remove: true })
    await team.react(id, 'tada')

    const reactions = (JSON.parse(await raw(team)) as Events).events.filter((event) => event.type.startsWith('reaction.'))

    expect(reactions.map((event) => event.type)).toEqual(['reaction.added'])
  })

  it("leaves out a task's hold once it's lifted, and its reason with it", async () => {
    const team = testBoard()
    const { task } = (await (await send(team, '/tasks', { channel: 'work', text: 'ship it' })).json()) as { task: { id: string } }
    expect((await send(team, `/tasks/${task.id}/block`, { reason: 'reason-of-a-hold-since-lifted' })).ok).toBe(true)
    expect(await raw(team)).toContain('reason-of-a-hold-since-lifted')
    expect((await send(team, `/tasks/${task.id}/unblock`, {})).ok).toBe(true)

    expect(await raw(team)).not.toContain('reason-of-a-hold-since-lifted')
  })
})

describe('what an event says that its message no longer carries', () => {
  it("is looked for among the message's own reactions, labels and failed deliveries, whatever text names them", async () => {
    const team = testBoard()
    const { id } = await team.post('dev', { text: 'here' })
    const { message } = await team.thread(id)
    // What a board from before emoji were checked may still hold: the name of something every object inherits.
    const about = (type: string, payload: Record<string, unknown>) => ({ cursor: '1', type, createdAt: message.createdAt, payload: { id, ...payload }, message }) as unknown as BoardEventView

    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(carried(about('reaction.added', { emoji: name, by: message.by }))).toBeNull()
      expect(carried(about('message.sync_failed', { target: name, error: 'refused' }))).toBeNull()
      expect(carried(about('labels.changed', { set: { [name]: 'value' }, unset: [] }))).toMatchObject({ payload: { set: {} } })
    }
  })
})
