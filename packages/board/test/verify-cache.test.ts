import { afterEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { mount } from './harness.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

// Every token a2() verifies, counted.
const verified = vi.hoisted(() => ({ count: 0 }))
vi.mock('jose', async (original) => {
  const jose = await original<typeof import('jose')>()
  return {
    ...jose,
    jwtVerify: ((...args: Parameters<typeof jose.jwtVerify>) => {
      verified.count++
      return jose.jwtVerify(...args)
    }) as typeof jose.jwtVerify,
  }
})

describe("a2()'s verified callers", () => {
  afterEach(() => {
    vi.useRealTimers()
    verified.count = 0
  })

  it('verifies a token once until it expires, then again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const board = testBoard()
    const julian = caller(board.fetch, await personToken())
    for (let i = 0; i < 3; i++) expect((await julian('GET', '/me')).status).toBe(200)
    expect(verified.count).toBe(1)
    // Someone else's is theirs to verify.
    expect((await caller(board.fetch, await personToken('u_ada'))('GET', '/me')).status).toBe(200)
    expect(verified.count).toBe(2)
    // Past its expiry, it's verified again, and refused.
    vi.setSystemTime(Date.now() + 2 * 3_600_000)
    expect(await julian('GET', '/me')).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
    expect(verified.count).toBe(3)
  })

  it("asks a host's verifier once for a stream, however many times it polls", async () => {
    let asked = 0
    const tenant = mount({
      store: memory(),
      url: BOARD_URL,
      authenticate: (request) => (asked++, request.headers.get('cookie') === 'session=ada' ? { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } : new Response(null, { status: 401 })),
    })
    const controller = new AbortController()
    const response = await tenant.fetch(new Request(`${BOARD_URL}/events?after=0`, { headers: { cookie: 'session=ada', accept: 'text/event-stream' }, signal: controller.signal }))
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    for (const text of ['one', 'two', 'three']) {
      await tenant.post('dev', text)
      while (!seen.includes(`"text":"${text}"`)) seen += decoder.decode((await reader.read()).value)
    }
    controller.abort()
    await reader.cancel().catch(() => {})
    expect(asked).toBe(1)
  })
})
