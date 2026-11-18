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

  it("tells that refusal by its code: a 403 with another, whatever it says, is the read's own failure", async () => {
    const api = fakeMessageboard({ boardFeed: true })
    await busy(api, 2)
    const refusing = (code: string) =>
      board({
        backend: vercel({
          team: 'team_test',
          api: API,
          fetch: (input, init = {}) => {
            const url = new URL(input instanceof Request ? input.url : String(input))
            // The board's feed, which names no channel, refused in the API's words under `code`.
            if (url.pathname.endsWith('/changes') && !url.searchParams.has('channelId') && !url.searchParams.has('channel'))
              return Promise.resolve(Response.json({ error: { code, message: "You can't read every channel of this board, so you can't read its feed across channels: read a channel's." } }, { status: 403 }))
            return as(api, 'user:u_jb')(input, init)
          },
          files: api.files,
        }),
      })

    await expect(refusing('forbidden').poll({ wait: 1 })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(refusing('feed_needs_every_channel').poll({ wait: 1 })).resolves.toMatchObject({ events: [] })
  })
})

describe("vercel(): a thread's replies in a range", () => {
  /** A thread of a root and `count` replies, and the ID of each message. */
  async function thread(api: Fake, count: number) {
    const { team } = counted(api)
    const root = await team.post('dev', { text: 'root' })
    const ids = [root.id]
    for (let i = 1; i <= count; i++) ids.push((await team.reply(root.id, { text: `reply ${i}` })).id)
    return ids
  }
  const texts = (read: { message: { text: string }; replies: { text: string }[] }) => [read.message.text, ...read.replies.map((reply) => reply.text)]
  const threadReads = (sent: string[]) => sent.filter((path) => /^GET \/threads\/[^/]+\/messages$/.test(path)).length

  it.each([
    ['an API that reads a range', { threadRanges: true }, 1],
    ['an API from before ranges, where the whole thread is read and cut', {}, 4],
  ])('answers the root and the replies after a message, the newest, or the first after it, on %s', async (_api, options, pages) => {
    const api = fakeMessageboard(options)
    const ids = await thread(api, 120)
    const { team, sent } = counted(api)

    expect(texts(await team.thread(ids[0]!, { after: ids[118]! }))).toEqual(['root', 'reply 119', 'reply 120'])
    expect(texts(await team.thread(ids[5]!, { limit: 2 }))).toEqual(['root', 'reply 119', 'reply 120'])
    expect(texts(await team.thread(ids[0]!, { after: ids[3]!, limit: 2 }))).toEqual(['root', 'reply 4', 'reply 5'])
    expect(texts(await team.thread(ids[0]!, { after: ids[0]!, limit: 1 }))).toEqual(['root', 'reply 1'])
    // Each read of the range is one page where the API cuts it, and every page of the thread where it doesn't.
    expect(threadReads(sent) / 4).toBeLessThanOrEqual(pages)
    if (pages === 1) expect(threadReads(sent)).toBe(4)
  })

  it('answers a short thread whole when asked for more replies than it has', async () => {
    const api = fakeMessageboard({ threadRanges: true })
    const ids = await thread(api, 2)

    expect(texts(await counted(api).team.thread(ids[0]!, { limit: 10 }))).toEqual(['root', 'reply 1', 'reply 2'])
  })

  it("refuses a message of another thread as where to read on from", async () => {
    const api = fakeMessageboard({ threadRanges: true })
    const [ids, other] = [await thread(api, 1), await thread(api, 1)]

    await expect(counted(api).team.thread(ids[0]!, { after: other[1]! })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })
})

describe("vercel(): the board's channels, a page at a time", () => {
  const paths = (page: { channels: { path: string }[] }) => page.channels.map((channel) => channel.path)
  const lists = (sent: string[]) => sent.filter((path) => path === 'GET /channels').length

  it.each([
    ['an API that pages them and lists them by a prefix', { channelPages: true }],
    ['an API from before either, which lists them all', {}],
  ])('lists the channels under a prefix by name, and reads on from a page to the last, on %s', async (_api, options) => {
    const api = fakeMessageboard(options)
    await busy(api, 5)
    const { team } = counted(api)

    const first = await team.channels({ prefix: 'dev/', limit: 2 })
    const second = await team.channels({ prefix: 'dev/', limit: 2, after: first.next! })
    const last = await team.channels({ prefix: 'dev/', limit: 2, after: second.next! })

    expect([paths(first), paths(second), paths(last)]).toEqual([['dev/c0', 'dev/c1'], ['dev/c2', 'dev/c3'], ['dev/c4']])
    expect(last.next).toBeNull()
    expect(paths(await team.channels({ prefix: 'ops' }))).toEqual(['ops'])
    expect(paths(await team.channels({ prefix: 'nope/' }))).toEqual([])
  })

  it.each([
    ['an API that pages them', { channelPages: true }],
    ['an API from before pages', {}],
  ])('lists every channel once across its pages, with no prefix, on %s', async (_api, options) => {
    const api = fakeMessageboard(options)
    await busy(api, 5)
    const { team } = counted(api)
    const all: string[] = []
    let after: string | undefined
    do {
      const page = await team.channels({ limit: 3, ...(after ? { after } : {}) })
      expect(page.channels.length).toBeLessThanOrEqual(3)
      all.push(...paths(page))
      after = page.next ?? undefined
    } while (after)

    expect(all.sort()).toEqual(['dev/c0', 'dev/c1', 'dev/c2', 'dev/c3', 'dev/c4', 'general', 'ops'])
  })

  it('asks the API for the page alone where it pages them, and not for every channel', async () => {
    const api = fakeMessageboard({ channelPages: true })
    await busy(api, 5)
    const { team, sent } = counted(api)

    await team.channels({ prefix: 'dev/', limit: 2 })

    expect(lists(sent)).toBe(1)
  })

  it("refuses a page's next for a list it isn't of", async () => {
    const api = fakeMessageboard({ channelPages: true })
    await busy(api, 5)
    const { team } = counted(api)
    const { next } = await team.channels({ prefix: 'dev/', limit: 2 })

    await expect(team.channels({ prefix: 'ops', after: next! })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
    await expect(team.channels({ after: 'made-up' })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })
})

describe("vercel(): a feed's newest events (`last`)", () => {
  const texts = (events: { type: string; message?: { text: string } }[]) => events.filter((event) => event.type === 'message.posted').map((event) => event.message?.text)

  it("reads the board's, a tree's and a channel's in one request each, however many channels there are", async () => {
    const reads: number[] = []
    for (const channels of [3, 30]) {
      const api = fakeMessageboard({ boardFeed: true, feedLast: true, inlineActors: true, channelNames: true })
      const writer = await busy(api, channels)
      await writer.post('dev/c1', { text: 'again in c1' })
      const { team, feedReads } = counted(api)

      expect(texts((await team.poll({ last: 3 })).events)).toEqual([`in c${channels - 1}`, 'in ops', 'again in c1'])
      expect(texts((await team.poll({ channel: 'dev/', last: 2 })).events)).toEqual([`in c${channels - 1}`, 'again in c1'])
      expect(texts((await team.poll({ channel: 'dev/c1', last: 5 })).events)).toEqual(['in c1', 'again in c1'])
      reads.push(feedReads())
    }

    // Once to learn the API has the board's feed for this caller, and a read each.
    expect(reads).toEqual([4, 4])
  })

  it("names the channels of the board's newest events from one list of them, not a request each", async () => {
    const requests: number[] = []
    for (const channels of [3, 30]) {
      const api = fakeMessageboard({ boardFeed: true, feedLast: true, inlineActors: true, channelNames: true, channelPages: true })
      await busy(api, channels)
      const { team, sent } = counted(api)

      const { events } = await team.poll({ last: 100 })

      expect(new Set(events.map((event) => event.message?.channel)).size).toBe(channels + 1)
      expect(sent.filter((path) => path.startsWith('GET /channels/'))).toEqual([])
      requests.push(sent.length)
    }

    expect(requests[1]).toBe(requests[0])
  })

  it('goes on from the cursor it answers, and from an event\'s own, with nothing missed or repeated', async () => {
    const api = fakeMessageboard({ boardFeed: true, feedLast: true })
    const writer = await busy(api, 3)
    const { team } = counted(api)

    for (const channel of [undefined, 'dev/', 'ops']) {
      const page = await team.poll({ ...(channel ? { channel } : {}), last: 2 })
      const text = `after the read of ${channel ?? 'the board'}`
      await writer.post(channel === 'dev/' ? 'dev/c0' : 'ops', { text })
      expect(texts((await team.poll({ ...(channel ? { channel } : {}), after: page.cursor })).events)).toEqual([text])
      expect(texts((await team.poll({ ...(channel ? { channel } : {}), after: page.events[0]!.cursor })).events)).toEqual([...texts(page.events.slice(1)), text])
    }
  })

  it("refuses it on an API from before `last`, once asked, and still follows the feed", async () => {
    const api = fakeMessageboard({ boardFeed: true })
    const writer = await busy(api, 3)
    const { team, sent } = counted(api)

    await expect(team.poll({ last: 5 })).rejects.toMatchObject({ status: 501, code: 'not_supported', message: expect.stringContaining('without `last`') })
    const asked = sent.length
    await expect(team.poll({ channel: 'ops', last: 5 })).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    expect(sent.length).toBe(asked)
    const { events } = await waited(team.poll({ wait: 5 }), () => writer.post('ops', { text: 'still live' }))
    expect(texts(events)).toEqual(['still live'])
  })

  it("refuses several channels' where the API has no feed across them for the caller, without reading each channel's", async () => {
    for (const [options, headers] of [
      [{ feedLast: true }, {}],
      [{ feedLast: true, boardFeed: true }, { 'x-board-can': 'dev/=read' }],
    ] as const) {
      const api = fakeMessageboard(options)
      await busy(api, 30)
      const { team, feedReads } = counted(api, { headers })

      await expect(team.poll({ last: 5 })).rejects.toMatchObject({ status: 501, code: 'not_supported', message: expect.stringContaining("read one channel's") })
      await expect(team.poll({ channel: 'dev/', last: 5 })).rejects.toMatchObject({ status: 501, code: 'not_supported' })
      expect(feedReads()).toBe(1)
      expect(texts((await team.poll({ channel: 'dev/c1', last: 5 })).events)).toEqual(['in c1'])
    }
  })

  it('refuses the board\'s when the API stops reading it for the caller between its asking and the read', async () => {
    const api = fakeMessageboard({ boardFeed: true, feedLast: true })
    await busy(api, 2)
    const team = board({
      backend: vercel({
        team: 'team_test',
        api: API,
        fetch: (input, init = {}) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname.endsWith('/changes') && url.searchParams.has('last') && !url.searchParams.has('channelId') && !url.searchParams.has('channel'))
            return Promise.resolve(Response.json({ error: { code: 'feed_needs_every_channel', message: "You can't read every channel of this board, so you can't read its feed across channels: read a channel's." } }, { status: 403 }))
          return as(api, 'user:u_jb')(input, init)
        },
        files: api.files,
      }),
    })

    await expect(team.poll({ last: 5 })).rejects.toMatchObject({ status: 501, code: 'not_supported' })
    await expect(team.poll({ wait: 0 })).resolves.toMatchObject({ events: [] })
  })

  it('takes no `after` or `wait` with it', async () => {
    const api = fakeMessageboard({ boardFeed: true, feedLast: true })
    const team = await busy(api, 1)
    const { cursor } = await team.poll({ channel: 'ops' })

    await expect(team.poll({ channel: 'ops', last: 5, after: cursor })).rejects.toMatchObject({ status: 400 })
    await expect(team.poll({ channel: 'ops', last: 5, wait: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(team.poll({ channel: 'ops', last: 101 })).rejects.toMatchObject({ status: 400 })
  })
})

describe("vercel(): a tree's follower behind other channels' events", () => {
  const texts = (events: { type: string; message?: { text: string } }[]) => events.filter((event) => event.type === 'message.posted').map((event) => event.message?.text)

  /** A tree's follower at the feed's end, then 23 events in another channel and one in the tree, on an API that passes over 5 a read. */
  async function behind() {
    const api = fakeMessageboard({ boardFeed: true, feedStretch: 5, inlineActors: true, channelNames: true })
    const writer = await busy(api, 2)
    const follower = counted(api)
    const { cursor } = await follower.team.poll({ channel: 'dev/' })
    for (let i = 0; i < 23; i++) await writer.post('ops', { text: `elsewhere ${i}` })
    await writer.post('dev/c1', { text: 'in the tree' })
    return { ...follower, cursor }
  }

  it('reads on at once through the empty pages the API answers short of its end, to the event it waits for', async () => {
    const { team, cursor, feedReads } = await behind()
    const before = feedReads()
    const started = Date.now()

    const { events } = await team.poll({ channel: 'dev/', after: cursor, wait: 20 })

    expect(texts(events)).toEqual(['in the tree'])
    // 24 events at 5 a read: five reads, one after another, with no wait between them.
    expect({ reads: feedReads() - before, withinASecond: Date.now() - started < 1000 }).toEqual({ reads: 5, withinASecond: true })
  })

  it('answers where it got to when it reads without a wait, so the next read goes on from there', async () => {
    const { team, cursor } = await behind()
    const seen: (string | undefined)[] = []
    let after = cursor
    let polls = 0

    while (seen.length === 0 && polls++ < 10) {
      const page = await team.poll({ channel: 'dev/', after })
      expect(page.cursor).not.toBe(after)
      after = page.cursor
      seen.push(...texts(page.events))
    }

    expect({ seen, polls }).toEqual({ seen: ['in the tree'], polls: 5 })
  })

  it('wakes for an event in the tree that comes after others outside it', async () => {
    const api = fakeMessageboard({ boardFeed: true, feedStretch: 5, inlineActors: true, channelNames: true })
    const writer = await busy(api, 2)
    const { team } = counted(api)

    const { events } = await waited(team.poll({ channel: 'dev/', wait: 10 }), async () => {
      for (let i = 0; i < 12; i++) await writer.post('ops', { text: `elsewhere ${i}` })
      await writer.post('dev/c0', { text: 'in the tree' })
    })

    expect(texts(events)).toEqual(['in the tree'])
  })
})

describe("vercel(): the cursors of the board's feed", () => {
  it("reads on from any event's cursor with exactly the events after it", async () => {
    const api = fakeMessageboard({ boardFeed: true, feedLast: true, inlineActors: true, channelNames: true })
    const writer = await busy(api, 2)
    const { id } = await writer.post('dev/c0', { text: 'to edit' })
    await writer.edit(id, 'edited')
    const { team } = counted(api)
    const named = (events: { type: string; message?: { id: string } }[]) => events.map((event) => `${event.type} ${event.message?.id}`)

    const { events } = await team.poll({ all: true, last: 100 })

    expect(new Set(events.map((event) => event.cursor)).size).toBe(events.length)
    for (const [i, event] of events.entries()) expect(named((await team.poll({ all: true, after: event.cursor })).events)).toEqual(named(events.slice(i + 1)))
  })

  it('takes `wait=0` with `last` on the API, and no wait above it', async () => {
    const api = fakeMessageboard({ boardFeed: true, feedLast: true })
    await busy(api, 1)
    const ask = (query: string) => as(api, 'user:u_jb')(`${API}/v1/messageboard/boards/brd_test/changes?teamId=team_test&${query}`)

    expect((await ask('last=2&wait=0')).status).toBe(200)
    expect((await ask('last=2&wait=1')).status).toBe(400)
  })
})
