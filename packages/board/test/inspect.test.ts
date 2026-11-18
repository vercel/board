import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBoardClient, type BoardClient } from '../src/client/client.ts'
import { startInspector, type Inspector } from '../src/inspect/server.ts'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'

let server: Awaited<ReturnType<typeof serve>>
let client: BoardClient
let inspector: Inspector
let token: string

beforeAll(async () => {
  server = await serve(testBoard({ url: undefined }).fetch)
  const url = `${server.origin}/api/board`
  client = createBoardClient({ url, token: await personToken('u_julian', url), profile: null })
  inspector = await startInspector({ client, port: 0 })
  const page = await (await fetch(`${inspector.url}/`)).text()
  token = /<meta name="inspect-token" content="([^"]+)">/.exec(page)![1]!
})
afterAll(async () => {
  await inspector.close()
  server.close()
})

/** The page's own client: the SDK, pointed at the inspector. */
const page = () => createBoardClient({ url: `${inspector.url}/board`, token: '', headers: { 'x-inspect-token': token, origin: inspector.url } })

const board = (path: string, init: RequestInit = {}) => fetch(`${inspector.url}/board${path}`, init)

/** A request exactly as written: fetch won't forge a Host header or keep `..` in a path. */
function exactly(path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const { hostname, port } = new URL(inspector.url)
    const req = request({ hostname, port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('inspect', () => {
  it('serves the page for every route, and its bundle', async () => {
    for (const path of ['/', '/c/errors-www', '/tasks', '/settings/schemas/test-run@1', '/inbox/slack']) {
      const response = await fetch(`${inspector.url}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(await response.text()).toContain('<div id="root"></div>')
    }
    const app = await fetch(`${inspector.url}/app.js`)
    expect(app.status).toBe(200)
    expect(app.headers.get('content-type')).toContain('javascript')
  })

  it('uploads attachments through the proxy, name and all, and serves them back', async () => {
    const ui = page()
    const file = await ui.upload({ data: new TextEncoder().encode('TypeError at login.tsx:42'), name: 'before fix.log', type: 'text/plain' })
    expect(file).toMatchObject({ name: 'before fix.log', type: 'text/plain' })
    const posted = await ui.post('ops', { text: '', attachments: [file] })
    expect(posted.attachments).toEqual([file])
    expect(await (await ui.download(file.id)).text()).toBe('TypeError at login.tsx:42')
    // Like every write, an upload needs the page's origin.
    const forged = await board('/attachments', { method: 'POST', headers: { 'x-inspect-token': token, 'content-type': 'text/plain' }, body: 'x' })
    expect(forged.status).toBe(403)
  })

  it('lets the page read and write the board as you', async () => {
    const ui = page()
    expect(await ui.me()).toMatchObject({ actor: 'vercel:user:u_julian', handle: 'u_julian' })
    const root = await ui.post('ops', 'standup in 5')
    const reply = await ui.reply(root.id, { text: 'on my way', noSync: true })
    await ui.react(root.id, 'eyes')
    await ui.label(root.id, { set: { status: 'open' } })
    await ui.edit(root.id, 'standup in 10')
    await ui.delete(reply.id)

    const thread = await client.thread(root.id)
    expect(thread.message).toMatchObject({
      text: 'standup in 10',
      labels: { status: 'open' },
      reactions: { eyes: ['vercel:user:u_julian'] },
      by: { actor: 'vercel:user:u_julian' },
    })
    expect(thread.replies[0]).toMatchObject({ deleted: true, noSync: true })
    expect((await ui.channel('ops').messages()).messages.map((m) => m.id)).toContain(root.id)
  })

  it('acts as the profile the page picks, with the avatar it gives it', async () => {
    // As a handle's `as(profile)` sends it: the board's own `x-board-profile`.
    const as = (profile: string, avatar?: string) =>
      createBoardClient({
        url: `${inspector.url}/board`,
        token: '',
        headers: { 'x-inspect-token': token, origin: inspector.url },
        profile: avatar ? { name: profile, avatar } : profile,
      })
    expect((await as('codex').me()).actor).toBe('vercel:user:u_julian+codex')
    expect((await page().me()).actor).toBe('vercel:user:u_julian') // yourself
    expect((await as('codex').post('ops', 'from codex')).by).toMatchObject({ actor: 'vercel:user:u_julian+codex', profile: 'codex' })
    const face = 'https://example.com/reviewer.png'
    expect(await as('reviewer', face).me()).toMatchObject({ actor: 'vercel:user:u_julian+reviewer', avatar: face })
    const posted = await as('reviewer', face).post('ops', 'from reviewer')
    expect((await page().thread(posted.id)).message.author).toMatchObject({ avatar: face })
  })

  it('starts the page as the profile inspect started as, and is yourself for a request that names none', async () => {
    const url = `${server.origin}/api/board`
    const face = 'https://example.com/claude.png?a=1&b="2"'
    const asClaude = createBoardClient({ url, token: await personToken('u_julian', url), profile: { name: 'claude', avatar: face } })
    const started = await startInspector({ client: asClaude, port: 0 })
    try {
      const html = await (await fetch(`${started.url}/`)).text()
      const content = /<meta name="inspect-profile" content="([^"]*)">/.exec(html)![1]!
      // What the page reads back from the attribute: the profile, avatar and all.
      const unescaped = content.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      expect(JSON.parse(unescaped)).toEqual({ name: 'claude', avatar: face })
      const key = /<meta name="inspect-token" content="([^"]+)">/.exec(html)![1]!
      // The page's handle says who each request is: with no profile, yourself, whatever inspect started as.
      const bare = createBoardClient({ url: `${started.url}/board`, token: '', headers: { 'x-inspect-token': key, origin: started.url } })
      expect((await bare.me()).actor).toBe('vercel:user:u_julian')
    } finally {
      await started.close()
    }
    const plain = await (await fetch(`${inspector.url}/`)).text()
    expect(plain).toContain('<meta name="inspect-profile" content="null">')
  })

  it('refuses a profile header that is not one, as the board would', async () => {
    const response = await board('/me', { headers: { 'x-inspect-token': token, 'x-board-profile': '"unclosed' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_profile' } })
  })

  it("passes the board's errors through", async () => {
    await expect(page().thread('9999')).rejects.toMatchObject({ status: 404 })
  })

  it('streams board events to the page', async () => {
    const controller = new AbortController()
    const events = page().events({ channel: 'live' }, { signal: controller.signal })
    const next = events.next()
    await new Promise((r) => setTimeout(r, 100))
    await client.post('live', 'hello')
    expect((await next).value).toMatchObject({ type: 'message.posted', message: { text: 'hello' } })
    controller.abort()
  })

  it('answers only its own page', async () => {
    expect((await board('/me')).status).toBe(403) // no token
    expect((await board('/me', { headers: { 'x-inspect-token': 'guess' } })).status).toBe(403)
    const write = (headers: Record<string, string>) =>
      board('/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ channel: 'ops', text: 'x' }) })
    expect((await write({ 'x-inspect-token': token })).status).toBe(403) // no origin
    expect((await write({ 'x-inspect-token': token, origin: 'https://evil.example' })).status).toBe(403)
    // URL parsing resolves `..` before routing, so this never reaches the proxy; an encoded slash would.
    expect(await exactly('/board/../me', { 'x-inspect-token': token })).toBe(200) // the page, not the board
    expect(await exactly('/board/%2F..%2Fsecret', { 'x-inspect-token': token })).toBe(400)
    expect(await exactly('/', { host: 'evil.example' })).toBe(421) // DNS rebinding
    // A caller behind a proxy can send the inspector's own name: what a proxy forwarded isn't this machine's.
    expect(await exactly('/', { 'x-forwarded-for': '203.0.113.7' })).toBe(421)
    // A request target that's no URL is refused, and the inspector goes on answering.
    expect(await exactly('//[')).toBe(400)
    expect(await exactly('/')).toBe(200)
    expect(await exactly('/')).toBe(200)
  })
})

describe('behind a proxy', () => {
  let proxied: Inspector
  beforeAll(async () => {
    proxied = await startInspector({ client, port: 0, hosts: ['box.tailnet.ts.net'] })
  })
  afterAll(() => proxied.close())

  /** A request to the inspector as a proxy in front forwards it: naming the host it serves on. */
  function via(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { hostname, port } = new URL(proxied.url)
      const req = request({ hostname, port, path, method: init.method ?? 'GET', headers: { host: 'box.tailnet.ts.net', ...init.headers } }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end(init.body)
    })
  }

  it('answers the host you allow, and writes from its origin', async () => {
    const page = await via('/')
    expect(page.status).toBe(200)
    const pageToken = /<meta name="inspect-token" content="([^"]+)">/.exec(page.body)![1]!
    expect((await via('/board/me', { headers: { 'x-inspect-token': pageToken } })).status).toBe(200)
    const write = (origin: string) =>
      via('/board/messages', {
        method: 'POST',
        headers: { 'x-inspect-token': pageToken, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'ops', text: 'from the tailnet' }),
      })
    expect((await write('https://box.tailnet.ts.net')).status).toBe(201)
    expect((await write('https://evil.example')).status).toBe(403)
  })

  it('still refuses every other host', async () => {
    expect((await via('/', { headers: { host: 'evil.example' } })).status).toBe(421)
  })

  it("never takes a forwarded request for its own name, even one you allowed", async () => {
    // A port that's free, to name before the inspector has it.
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo
        probe.close(() => resolve(port))
      })
    })
    const own = await startInspector({ client, port: free, hosts: [`127.0.0.1:${free}`] })
    const ask = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: free, path: '/', headers }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })
    try {
      expect(await ask({})).toBe(200)
      expect(await ask({ 'x-forwarded-host': `127.0.0.1:${free}` })).toBe(421)
    } finally {
      await own.close()
    }
  })
})
