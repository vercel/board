import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { as, fakeMessageboard } from './messageboard.ts'

const API = 'http://localhost'

type Fake = ReturnType<typeof fakeMessageboard>

/** A handle on the fake's board through vercel(), and the paths of the requests it sent under the board. */
function counted(api: Fake, { principal = 'user:u_jb', headers = {} as Record<string, string> } = {}) {
  const sent: string[] = []
  const team = board({
    backend: vercel({
      team: 'team_test',
      api: API,
      fetch: (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        sent.push(`${init.method ?? 'GET'} ${url.pathname.replace(/^\/v\d\/messageboard(\/boards\/[^/]+)?/, '')}`)
        const all = new Headers(init.headers)
        for (const [name, value] of Object.entries(headers)) all.set(name, value)
        return as(api, principal)(input, { ...init, headers: all })
      },
      files: api.files,
    }),
  })
  return { team, sent, feedReads: () => sent.filter((path) => path === 'GET /changes').length }
}

/** A board with `count` channels under `dev/`, a post in each, and one in `ops`. */
async function busy(api: Fake, count: number) {
  const { team } = counted(api)
  for (let i = 0; i < count; i++) await team.post(`dev/c${i}`, { text: `in c${i}` })
  await team.post('ops', { text: 'in ops' })
  return team
}

/** A wait from now, and what's posted once it is waiting. */
async function waited<T>(poll: Promise<T>, then: () => Promise<unknown>): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 150))
  await then()
  return poll
}

describe("vercel(): following several channels on an API that reads the board's feed in one", () => {
  it('follows the whole board with the same few requests however many channels it has', async () => {
    const texts: string[] = []
    const reads: number[] = []
    for (const channels of [3, 30]) {
      const api = fakeMessageboard({ boardFeed: true })
      const writer = await busy(api, channels)
      const { team, feedReads } = counted(api)
      const { events } = await waited(team.poll({ wait: 5 }), () => writer.post('dev/c1', { text: `to ${channels}` }))
      texts.push(...events.map((event) => `${event.message?.channel}: ${event.message?.text}`))
      reads.push(feedReads())
    }

    expect(texts).toEqual(['dev/c1: to 3', 'dev/c1: to 30'])
    expect(reads[1]).toBe(reads[0])
    expect(reads[0]).toBeLessThan(10)
  })

  it('follows a tree: its channel and the ones under it, waiting through what is posted outside it', async () => {
    const api = fakeMessageboard({ boardFeed: true })
    const writer = await busy(api, 3)
    await writer.post('dev', { text: 'in dev' })
    const { team } = counted(api)

    const { events } = await waited(team.poll({ channel: 'dev/', wait: 5 }), async () => {
      await writer.post('ops', { text: 'outside' })
      await writer.post('devops', { text: 'only starts the same' })
      await writer.post('dev', { text: 'the tree itself' })
      await writer.post('dev/c2', { text: 'under it' })
    })
    const rest = await team.poll({ channel: 'dev/', after: events.at(-1)!.cursor })

    expect([...events, ...rest.events].map((event) => event.message?.text)).toEqual(['the tree itself', 'under it'])
  })

  it("reads on from an event's cursor in another process: what came after it, once, and nothing from before", async () => {
    const api = fakeMessageboard({ boardFeed: true })
    const writer = await busy(api, 3)
    const { team } = counted(api)
    const { events } = await waited(team.poll({ wait: 5 }), async () => {
      for (const text of ['one', 'two', 'three']) await writer.post('dev/c0', { text })
    })
    const all = [...events, ...(await team.poll({ after: events.at(-1)!.cursor })).events]
    expect(all.map((event) => event.message?.text)).toEqual(['one', 'two', 'three'])

    const other = counted(api)
    const after = await other.team.poll({ after: all[0]!.cursor })

    expect(after.events.map((event) => event.message?.text)).toEqual(['two', 'three'])
    // The cursor says where the feed is: the other process reads on from there, not from the feed's first change.
    expect(other.feedReads()).toBeLessThanOrEqual(3)
    expect((await counted(api).team.poll({ after: after.events.at(-1)!.cursor })).events).toEqual([])
  })

  it("refuses a tree's cursor for the board, as the API does", async () => {
    const api = fakeMessageboard({ boardFeed: true })
    const writer = await busy(api, 2)
    const { team } = counted(api)
    const { events } = await waited(team.poll({ channel: 'dev/', wait: 5 }), () => writer.post('dev/c0', { text: 'x' }))

    await expect(counted(api).team.poll({ after: events[0]!.cursor })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })
})

describe("vercel(): following several channels where the board's feed isn't for the caller", () => {
  it("follows each channel's feed on an API from before the board's, a request a channel", async () => {
    const api = fakeMessageboard()
    const writer = await busy(api, 6)
    const { team, feedReads } = counted(api)

    const { events } = await waited(team.poll({ wait: 5 }), () => writer.post('dev/c1', { text: 'still heard' }))

    expect(events.map((event) => event.message?.text)).toEqual(['still heard'])
    expect(feedReads()).toBeGreaterThanOrEqual(7)
  })

  it('follows the channels a caller reads when it reads only some, which the API refuses its feed to', async () => {
    const api = fakeMessageboard({ boardFeed: true })
    const writer = await busy(api, 2)
    const { team } = counted(api, { headers: { 'x-board-can': 'dev/=read' } })

    const { events } = await waited(team.poll({ wait: 5 }), async () => {
      await writer.post('ops', { text: 'not its to read' })
      await writer.post('dev/c1', { text: 'its to read' })
    })

    expect(events.map((event) => event.message?.text)).toEqual(['its to read'])
  })
})
