// `@vercel/board/inspect`: the inspector as one fetch handler, for a route of your app, so people
// open your board from your deployment (a phone included) instead of running `vb inspect`.
import type { ProfileOption } from '../client/client.ts'
import { InvalidProfileHeader, parseProfileHeader } from '../contract/profile-header.ts'
import { ATTACHMENT_BYTES_MAX } from '../contract/schemas.ts'
import type { AsOptions, Board } from '../server/board.ts'
import { CSP, shell } from './shell.ts'

export type InspectorOptions = {
  /** The board the page reads and writes, as this deployment: `board()`'s handle. */
  board: Pick<Board, 'as'>
  /** Where the handler is mounted, like `/inspect`: the page at it, its script at `<basePath>/app.js`, and its proxy at `<basePath>/board`. */
  basePath: string
  /** What a visitor may do at most, as `board.as(profile, { can })` narrows it. Without one, this deployment's own. */
  can?: AsOptions['can']
  /** The page's script: by default, the one board is installed with, read from its `dist` on the first request. */
  page?: string
}

/**
 * The header the page sends on every request to the proxy. It's no secret: a header of its own makes
 * a browser ask before sending one cross-origin, and this handler answers no such question, so only
 * the page's own origin gets a request through.
 */
const PAGE_HEADER = 'x-inspect-token'
const PAGE_TOKEN = 'page'

/**
 * The inspector, as `(request) => response`: its page, its script, and a proxy that acts on `board`
 * as this deployment. It doesn't know who's visiting, so it never writes as the deployment itself:
 * every write names a profile (`ada`, shown as `ada via <deployment>`), and one that names none is
 * refused. Writes must come from the page's own origin too.
 *
 * Whoever reaches it acts as this deployment under the profile they type, so serve it only where
 * strangers can't: behind Vercel Authentication, say. It doesn't check that itself.
 */
export function inspector(options: InspectorOptions): (request: Request) => Promise<Response> {
  const base = options.basePath.replace(/\/+$/, '')
  let app: Promise<string | null> | null = options.page === undefined ? null : Promise.resolve(options.page)
  const script = () => (app ??= import('./page.ts').then((module) => module.page()))

  async function proxy(request: Request, path: string, url: URL): Promise<Response> {
    const reading = request.method === 'GET' || request.method === 'HEAD'
    const site = request.headers.get('sec-fetch-site')
    if (request.headers.get(PAGE_HEADER) !== PAGE_TOKEN || (site !== null && site !== 'same-origin') || (!reading && request.headers.get('origin') !== url.origin))
      return json(403, { code: 'forbidden', message: "the board is reachable only from the inspector's own page" })
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      decoded = '..'
    }
    if (/(^|\/)\.\.?(\/|$)|\\/.test(decoded)) return json(400, { code: 'bad_path', message: 'no relative paths' })
    // Reads are the same whoever's asking, and the page's handle reads some (`/`, `/me`) as itself.
    // A write is someone's, so it names whose.
    const named = request.headers.get('x-board-profile')?.trim()
    if (!named && !reading)
      return json(401, { code: 'profile_required', message: "name a profile to write as: this page doesn't know who you are, and writes as no one without one" })
    let as: ProfileOption = null
    if (named)
      try {
        const { name, avatar } = parseProfileHeader(named)
        as = avatar === null ? name : { name, avatar }
      } catch (error) {
        if (!(error instanceof InvalidProfileHeader)) throw error
        return json(400, { code: 'invalid_profile', message: error.message })
      }
    let body: Uint8Array<ArrayBuffer> | undefined
    if (!reading) {
      const limit = path === '/attachments' ? ATTACHMENT_BYTES_MAX : 1024 * 1024
      if (Number(request.headers.get('content-length') ?? 0) > limit) return json(413, { code: 'too_large', message: 'request too large' })
      body = new Uint8Array(await request.arrayBuffer())
      if (body.byteLength > limit) return json(413, { code: 'too_large', message: 'request too large' })
    }
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'accept', 'x-board-filename']) {
      const value = request.headers.get(name)
      if (value !== null) headers[name] = value
    }
    const acting = options.can === undefined ? options.board.as(as) : options.board.as(as, { can: options.can })
    let upstream: Response
    try {
      upstream = await acting.request(`${path}${url.search}`, { as, method: request.method, headers, ...(body ? { body } : {}), signal: request.signal })
    } catch (error) {
      return json(502, { code: 'unreachable', message: `the board didn't answer: ${(error as Error).message}` })
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return text(404, 'not found')
    const path = url.pathname.slice(base.length) || '/'
    if (path === '/board' || path.startsWith('/board/')) return proxy(request, path.slice('/board'.length) || '/', url)
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed')
    if (path === '/app.js') {
      const found = await script()
      if (found === null) return text(503, "the inspector's UI isn't built: run `pnpm --filter @vercel/board build`")
      return new Response(found, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
    // Every other path is a route inside the page.
    return new Response(shell({ token: PAGE_TOKEN, profile: null, base, named: true }), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': CSP,
      },
    })
  }
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

const json = (status: number, error: { code: string; message: string }) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
