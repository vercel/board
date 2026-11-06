import { request } from 'node:http'
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
  client = createBoardClient({ url, token: await personToken('u_julian', url), handle: 'julian', profile: null })
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
    for (const path of ['/', '/c/errors-www', '/inbox/slack']) {
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
    expect(await ui.me()).toMatchObject({ actor: 'vercel:user:u_julian', handle: 'julian' })
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
    expect((await ui.messages({ channel: 'ops' })).messages.map((m) => m.id)).toContain(root.id)
  })

  it('acts as the profile the page picks, with the avatar it gives it', async () => {
    const as = (profile: string, avatar?: string) =>
      createBoardClient({
        url: `${inspector.url}/board`,
        token: '',
        headers: { 'x-inspect-token': token, origin: inspector.url, 'x-inspect-profile': profile, ...(avatar ? { 'x-inspect-avatar': avatar } : {}) },
      })
    expect((await as('codex').me()).actor).toBe('vercel:user:u_julian+codex')
    expect((await as('').me()).actor).toBe('vercel:user:u_julian') // yourself
    expect((await as('codex').post('ops', 'from codex')).by).toMatchObject({ actor: 'vercel:user:u_julian+codex', profile: 'codex' })
    const face = 'https://example.com/reviewer.png'
    expect(await as('reviewer', face).me()).toMatchObject({ actor: 'vercel:user:u_julian+reviewer', avatar: face })
    const posted = await as('reviewer', face).post('ops', 'from reviewer')
    expect((await page().thread(posted.id)).message.author).toMatchObject({ avatar: face })
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
    expect(await exactly('/')).toBe(200)
  })
})
