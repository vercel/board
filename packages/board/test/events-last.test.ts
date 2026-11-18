import { describe, expect, it } from 'vitest'
import { testBoard } from './harness.ts'

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
