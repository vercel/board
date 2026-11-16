import { describe, expect, it } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { inspector } from '../src/inspect/fetch.ts'
import { testBoard } from './harness.ts'

// `@vercel/board/inspect`: the inspector as a route of a deployment, acting on its board as the
// deployment. What a browser at the page sees, and what the board keeps of what it writes.

const ORIGIN = 'https://factory.example.com'
const PAGE = { 'x-inspect-token': 'page', origin: ORIGIN }

function mounted(options: { can?: Parameters<typeof inspector>[0]['can'] } = {}) {
  const team = testBoard()
  const handle = inspector({ board: team, basePath: '/inspect', page: 'console.log("app")', ...options })
  const at = (path: string, init: RequestInit = {}) => handle(new Request(`${ORIGIN}/inspect${path}`, init))
  /** The page's own handle, as `profile`: the SDK pointed at the proxy, with what the page sends. */
  const page = (profile: string | null) =>
    createBoardClient({ url: `${ORIGIN}/inspect/board`, token: '', profile, headers: PAGE, fetch: ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch })
  return { team, handle, at, page }
}

describe('the inspector on a deployment', () => {
  it('serves the page under its mount, told where it is and that it acts only as a named profile', async () => {
    const { at, handle } = mounted()
    for (const path of ['', '/', '/c/dev', '/settings/access']) {
      const response = await at(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
      const html = await response.text()
      expect(html).toContain('<script type="module" src="/inspect/app.js"></script>')
      expect(html).toContain('<meta name="inspect-base" content="/inspect">')
      expect(html).toContain('<meta name="inspect-named" content="1">')
      expect(html).toContain('<meta name="inspect-profile" content="null">')
    }
    const app = await at('/app.js')
    expect(app.headers.get('content-type')).toContain('javascript')
    expect(await app.text()).toBe('console.log("app")')
    expect((await handle(new Request(`${ORIGIN}/elsewhere`))).status).toBe(404)
  })

  it('writes as the profile the visitor names, never as the deployment itself', async () => {
    const { team, page } = mounted()
    const ada = page('ada')
    // A board in this process names a profile of its own code `board:client:<profile>`; Vercel's, `<deployment>+<profile>`.
    expect(await ada.me()).toMatchObject({ actor: 'board:client:ada', handle: 'ada' })
    const posted = await ada.post('dev', 'hello from my phone')
    expect(posted.by.actor).toBe('board:client:ada')

    const bare = page(null)
    await expect(bare.post('dev', 'as the agent')).rejects.toMatchObject({ status: 401, code: 'profile_required' })
    expect((await team.messages({ channel: 'dev' })).messages.map((message) => message.text)).toEqual(['hello from my phone'])
  })

  it("answers only the page's own requests: its header, from its own site, and writes from its origin", async () => {
    const { at } = mounted()
    const ada = { 'x-board-profile': 'ada' }
    expect((await at('/board/me', { headers: ada })).status).toBe(403)
    expect((await at('/board/me', { headers: { ...ada, ...PAGE, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await at('/board/me', { headers: { ...ada, ...PAGE, 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
    const write = (origin: string) =>
      at('/board/messages', { method: 'POST', headers: { ...ada, ...PAGE, origin, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'dev', text: 'hi' }) })
    expect((await write('https://evil.example.com')).status).toBe(403)
    expect((await write(ORIGIN)).status).toBe(201)
    expect((await at('/board/..%2Fsecrets', { headers: { ...ada, ...PAGE } })).status).toBe(400)
  })

  it('holds visitors to what `can` allows', async () => {
    const { page } = mounted({ can: ['read'] })
    const ada = page('ada')
    expect((await ada.me()).actor).toBe('board:client:ada')
    await expect(ada.post('dev', 'hi')).rejects.toMatchObject({ status: 403 })
  })
})
