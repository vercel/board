import { describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.default.ts'
import { createBoardClient } from '../src/client/client.ts'
import { board, type EventsState, type ExplainPrincipal } from '../src/server/index.default.ts'

// What a UI on a handle needs beside the data: whether the feed is connected, the permission
// names a grant takes, and the type of the principal `explain` asks about.

const URL_ = 'https://board.example/api/board'
const event = { cursor: '2', type: 'channel.created', createdAt: '2026-10-01T00:00:00.000Z', payload: { channel: 'dev', by: { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null } } }

const down = (): Response => {
  throw new TypeError('fetch failed')
}

/**
 * A board elsewhere, as its `/events` behaves: `scripted` answers come first, in turn. After them
 * a poll that asks without waiting is answered at once with nothing new, and one that waits, or a
 * stream, is held open until it's aborted: a quiet board. `waits` is what each poll asked for.
 */
function remote(scripted: (() => Response)[] = []) {
  const waits: (string | null)[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const stream = new Headers(init?.headers).get('accept') === 'text/event-stream'
    if (!stream) waits.push(url.searchParams.get('wait'))
    const answer = scripted.shift()
    if (answer) return answer()
    if (!stream && (url.searchParams.get('wait') ?? '0') === '0') return Response.json({ events: [], cursor: url.searchParams.get('after') ?? '1' })
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  }) as typeof globalThis.fetch
  return { fetch, waits }
}

/** Follows `events` until the test stops it, keeping what `onState` hears and what arrives. */
function follow(events: (opts: { signal: AbortSignal; onState: (state: EventsState) => void }) => AsyncGenerator<unknown>) {
  const states: EventsState[] = []
  const seen: unknown[] = []
  const stop = new AbortController()
  const done = (async () => {
    for await (const one of events({ signal: stop.signal, onState: (state) => states.push(state) })) seen.push(one)
  })().catch(() => {})
  return { states, seen, stop: () => (stop.abort(), done) }
}

describe('events, told whether it is connected', () => {
  it("is live as soon as the board answers, on a quiet board too, and hears nothing before", async () => {
    const { fetch, waits } = remote()
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.states).toEqual(['live']))
    // The first poll asked without waiting, which is how it knew; the one held open now waits for news.
    await vi.waitFor(() => expect(waits).toEqual(['0', '25']))
    await feed.stop()
    expect(feed.states).toEqual(['live'])
  })

  it('is retrying while polls fail, and live again as soon as the board is back, not a long-poll later', async () => {
    const { fetch, waits } = remote([down, down])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    // Each change once: a board that can't be reached is never live, and the second failure isn't news.
    await vi.waitFor(() => expect(feed.states).toEqual(['retrying', 'live']), { timeout: 5000 })
    // Every poll until the board answered asked without waiting; the retry wasn't held for a quiet board's 25 seconds.
    await vi.waitFor(() => expect(waits).toEqual(['0', '0', '0', '25']))
    await feed.stop()
  }, 10_000)

  it('asks without waiting again after a feed that was live fails', async () => {
    const quiet = () => Response.json({ events: [], cursor: '1' })
    const { fetch, waits } = remote([quiet, down])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    // The held poll drops; the retry is answered at once, though the board has nothing new to say.
    await vi.waitFor(() => expect(feed.states).toEqual(['live', 'retrying', 'live']), { timeout: 5000 })
    await vi.waitFor(() => expect(waits).toEqual(['0', '25', '0', '25']))
    await feed.stop()
  }, 10_000)

  it('yields the events an answer carries, and goes on from its cursor', async () => {
    const { fetch } = remote([() => Response.json({ events: [event], cursor: '2' })])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.seen).toMatchObject([{ type: 'channel.created', cursor: '2' }]))
    await feed.stop()
    expect(feed.states).toEqual(['live'])
  })

  it('goes again after a 429, as long as the board asked, where another 4xx would end it', async () => {
    const limited = () => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '1' } })
    const { fetch, waits } = remote([limited])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.states).toEqual(['retrying']))
    // Not the half-second backoff of an outage: the second it asked for.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(waits).toEqual(['0'])
    await vi.waitFor(() => expect(feed.states).toEqual(['retrying', 'live']), { timeout: 5000 })
    await feed.stop()
  }, 10_000)

  it('stops at once when aborted while waiting out a long Retry-After', async () => {
    const limited = () => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '3600' } })
    const { fetch } = remote([limited])
    const team = board({ backend: http(URL_, { fetch }) })
    const feed = follow((opts) => team.events({ all: true, after: '1' }, opts))
    await vi.waitFor(() => expect(feed.states).toEqual(['retrying']))
    const stopped = await Promise.race([feed.stop().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))])
    expect(stopped).toBe(true)
  })

  it('keeps a client on the stream going after a 429', async () => {
    const limited = () => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '1' } })
    const stream = () => new Response(`id: 2\nevent: board\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    const { fetch } = remote([limited, stream])
    const client = createBoardClient({ url: URL_, fetch })
    const feed = follow((opts) => client.events({ after: '1' }, opts))
    await vi.waitFor(() => expect(feed.seen).toMatchObject([{ type: 'channel.created' }]), { timeout: 5000 })
    await feed.stop()
    expect(feed.states).toEqual(['retrying', 'live'])
  }, 10_000)

  it('waits on through a 429 for the event that comes after it', async () => {
    const limited = () => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '1' } })
    const { fetch } = remote([limited, () => Response.json({ events: [event], cursor: '2' })])
    const client = createBoardClient({ url: URL_, fetch })
    await expect(client.wait({ after: '1' }, { timeout: '10s' })).resolves.toMatchObject({ type: 'channel.created' })
  }, 10_000)

  it('tells a client on the stream the same: retrying when it fails, live when the stream opens', async () => {
    const stream = () => new Response(`id: 2\nevent: board\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    const { fetch } = remote([down, stream])
    const client = createBoardClient({ url: URL_, fetch })
    const feed = follow((opts) => client.events({ after: '1' }, opts))
    await vi.waitFor(() => expect(feed.seen).toMatchObject([{ type: 'channel.created' }]), { timeout: 5000 })
    await feed.stop()
    expect(feed.states).toEqual(['retrying', 'live'])
  }, 10_000)
})

describe('what a grant form takes from the package', () => {
  it('lists the permission names, in the order the board shows them', () => {
    expect(PERMISSIONS).toEqual(['read', 'post', 'react', 'label', 'sync', 'manage'])
  })
})

// `ExplainPrincipal` is a type, so the type check is its test: without the export, this line fails `pnpm typecheck`.
const whom: ExplainPrincipal = { project: 'web', environment: 'preview' }
void whom
