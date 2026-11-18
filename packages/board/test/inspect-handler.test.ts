import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createBoardClient, type BoardClient } from '../src/client/client.ts'
import { inspector, type InspectorHandler } from '../src/inspect/handler.ts'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'

// The inspector as an app serves it from a route handler: requests in, responses out, as a
// framework hands them over. The board behind it is a real one over HTTP.

const ORIGIN = 'https://factory.example.com'

let server: Awaited<ReturnType<typeof serve>>
let client: BoardClient
let handle: InspectorHandler

beforeAll(async () => {
  server = await serve(testBoard({ url: undefined }).fetch)
  const url = `${server.origin}/api/board`
  client = createBoardClient({ url, token: await personToken('u_julian', url), profile: null })
  handle = inspector({ board: client, basePath: '/board/' })
})
afterAll(() => server.close())

/** What a browser on the page sends: its token, and that it's this origin's own page. */
const PAGE = { 'x-inspect-token': 'page', 'sec-fetch-site': 'same-origin', origin: ORIGIN }

/** The page's own client, as the page makes it: the SDK, its fetch going to the route handler. */
const page = (profile: string | null = null) =>
  createBoardClient({
    url: `${ORIGIN}/board/board`,
    token: '',
    headers: PAGE,
    profile,
    fetch: (input, init) => handle(new Request(input, init)),
  })

const ask = (path: string, init: RequestInit = {}) => handle(new Request(`${ORIGIN}${path}`, init))

describe('the inspector in a route handler', () => {
  it('serves the page under its base path for every route, its bundle there too', async () => {
    for (const path of ['/board', '/board/', '/board/c/ops', '/board/tasks', '/board/settings/access']) {
      const response = await ask(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
      const html = await response.text()
      expect(html).toContain('<meta name="inspect-base" content="/board">')
      expect(html).toMatch(/<script type="module" src="\/board\/app\.js\?v=[^"]+"><\/script>/)
    }
    const app = await ask('/board/app.js?v=1')
    expect(app.status).toBe(200)
    expect(app.headers.get('content-type')).toContain('javascript')
    expect((await ask('/elsewhere')).status).toBe(404)
    expect((await ask('/boardroom')).status).toBe(404)
  })

  it('reads and writes the board as its handle, under the profile the page names', async () => {
    expect(await page().me()).toMatchObject({ actor: 'vercel:user:u_julian' })
    const root = await page('ada').post('ops', 'standup in 5')
    expect(root.by).toMatchObject({ actor: 'vercel:user:u_julian+ada', profile: 'ada' })
    await page('ada').react(root.id, 'eyes')
    const reply = await page('ada').reply(root.id, 'on my way')
    await page('ada').edit(reply.id, 'on my way, 2 min')
    const file = await page('ada').upload({ data: new TextEncoder().encode('trace'), name: 'trace.log', type: 'text/plain' })
    expect(await (await page().download(file.id)).text()).toBe('trace')
    const thread = await client.thread(root.id)
    expect(thread.message.reactions).toEqual({ eyes: ['vercel:user:u_julian+ada'] })
    expect(thread.replies[0]).toMatchObject({ text: 'on my way, 2 min', by: { actor: 'vercel:user:u_julian+ada' } })
    await expect(page().thread('9999')).rejects.toMatchObject({ status: 404 })
  })

  it('never writes as its handle itself, which is the app and not whoever is visiting, so the page asks who first', async () => {
    expect(await (await ask('/board')).text()).toContain('<meta name="inspect-named" content="1">')
    await expect(page().post('ops', 'as the app')).rejects.toMatchObject({ status: 401, code: 'profile_required' })
    await expect(page().react('1', 'eyes')).rejects.toMatchObject({ status: 401, code: 'profile_required' })
    expect((await client.channel('ops').messages()).messages.map((message) => message.text)).not.toContain('as the app')
  })

  it("won't write under its handle's own profile, the app's name, either", async () => {
    const url = `${server.origin}/api/board`
    const asFactory = inspector({ board: createBoardClient({ url, token: await personToken('u_julian', url), profile: 'factory' }), basePath: '/board' })
    const write = (profile: string | null) =>
      asFactory(
        new Request(`${ORIGIN}/board/board/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...PAGE, ...(profile ? { 'x-board-profile': profile } : {}) },
          body: JSON.stringify({ channel: 'ops', text: `as ${profile}` }),
        }),
      )
    for (const profile of [null, 'factory', 'Factory', 'FACTORY', 'factory;avatar="https://example.com/a.png"']) {
      const refused = await write(profile)
      expect(refused.status).toBe(401)
      expect(await refused.json()).toMatchObject({ error: { code: 'profile_required' } })
    }
    expect((await write('ada')).status).toBe(201)
  })

  it('streams board events to the page', async () => {
    const controller = new AbortController()
    const events = page().events({ channel: 'live-handler' }, { signal: controller.signal })
    const next = events.next()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await client.post('live-handler', 'hello')
    expect((await next).value).toMatchObject({ type: 'message.posted', message: { text: 'hello' } })
    controller.abort()
  })

  it('answers only its own page', async () => {
    const write = (headers: Record<string, string>) =>
      ask('/board/board/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ channel: 'ops', text: 'x' }) })
    expect((await ask('/board/board/me')).status).toBe(403) // no token
    expect((await ask('/board/board/me', { headers: { 'x-inspect-token': 'guess' } })).status).toBe(403)
    // Another site's page, which a browser says it is.
    expect((await ask('/board/board/me', { headers: { ...PAGE, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await write({ 'x-inspect-token': 'page' })).status).toBe(403) // no origin
    expect((await write({ ...PAGE, origin: 'https://evil.example' })).status).toBe(403)
    expect((await write({ ...PAGE, 'x-board-profile': 'ada' })).status).toBe(201)
    expect((await ask('/board/board/%2E%2E%2Fsecret', { headers: PAGE })).status).toBe(400)
    const bad = await ask('/board/board/me', { headers: { ...PAGE, 'x-board-profile': '"unclosed' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_profile' } })
    expect((await ask('/board/c/ops', { method: 'POST', headers: PAGE })).status).toBe(405)
  })

  it('starts the page as the profile its handle has', async () => {
    const url = `${server.origin}/api/board`
    const asClaude = createBoardClient({ url, token: await personToken('u_julian', url), profile: 'claude' })
    const html = await (await inspector({ board: asClaude, basePath: '/' })(new Request(`${ORIGIN}/`))).text()
    expect(html).toContain('<meta name="inspect-profile" content="&#34;claude&#34;">')
    expect(html).toContain('<meta name="inspect-base" content="">')
    expect(html).toContain('src="/app.js?v=')
  })
})

describe('the inspector in a route handler, on a board that refuses its handle', () => {
  it('still serves the page, which says why when it asks', async () => {
    const refused = createBoardClient({ url: `${server.origin}/api/board`, token: 'not-a-token', profile: null })
    const response = await inspector({ board: refused, basePath: '/board' })(new Request(`${ORIGIN}/board`))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<meta name="inspect-profile" content="null">')
  })
})

describe('the inspector in a route handler, given too much', () => {
  it('refuses a body over its cap, without reading the rest of it', async () => {
    const handler = inspector({ board: client, basePath: '/board' })
    const headers = { ...PAGE, 'x-board-profile': 'ada', 'content-type': 'application/json' }
    // Said up front: refused before a byte is read.
    const declared = await handler(new Request(`${ORIGIN}/board/board/messages`, { method: 'POST', headers: { ...headers, 'content-length': String(2 * 1024 * 1024) }, body: 'x' }))
    expect(declared.status).toBe(413)
    // Streamed with no length: read until it passes the cap, then canceled.
    let pulled = 0
    let canceled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel() {
        canceled = true
      },
    })
    const streamed = await handler(new Request(`${ORIGIN}/board/board/messages`, { method: 'POST', headers, body: endless, duplex: 'half' } as RequestInit))
    expect(streamed.status).toBe(413)
    expect(canceled).toBe(true)
    expect(pulled).toBeLessThan(40)
  })
})
