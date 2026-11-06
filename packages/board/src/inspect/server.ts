import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Me } from '../api/routes.ts'
import type { BoardClient } from '../client/client.ts'
import { ATTACHMENT_BYTES_MAX } from '../contract/schemas.ts'
import { CSS } from './style.ts'

/** A browser UI for one board, on this machine, reading and writing as the client's identity. */
export type Inspector = {
  url: string
  board: string
  me: Me
  close(): Promise<void>
}

export const DEFAULT_PORT = 4747

/** The prebuilt UI: next to the CLI in `dist`, or in `dist` when running from source. */
const BUNDLES = [new URL('./inspect/app.js', import.meta.url), new URL('../../dist/inspect/app.js', import.meta.url)]

async function bundle(): Promise<string | null> {
  for (const candidate of BUNDLES)
    try {
      return await readFile(candidate, 'utf8')
    } catch {}
  return null
}

const shell = (token: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="inspect-token" content="${token}">
<title>board</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`

const CSP = [
  "default-src 'none'",
  // Attachments arrive as `blob:` URLs: the page fetches them through the proxy, with its token.
  'img-src https: http://localhost:* http://127.0.0.1:* data: blob:',
  'media-src blob:',
  "style-src 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Serves the UI, and a proxy for the board's API that adds your credentials, on
 * 127.0.0.1. Because the proxy acts as you, it answers only its own page: every
 * request must name this server's host (no DNS rebinding) and carry the per-run
 * token that only the page has, and writes must also come from its origin. Your
 * board token never leaves this process.
 */
export async function startInspector(options: { client: BoardClient; port?: number }): Promise<Inspector> {
  const { client } = options
  const me = await client.me()
  // The board it acts on, as that board names itself: a handle on one elsewhere has no URL of its own.
  const board = (await client.discovery().catch(() => null))?.url ?? client.url
  const app = await bundle()
  const token = randomBytes(24).toString('base64url')
  let origins = new Set<string>()
  const streams = new Set<AbortController>()

  async function proxy(request: IncomingMessage, response: ServerResponse, url: URL) {
    const reading = request.method === 'GET' || request.method === 'HEAD'
    if (!sameSecret(String(request.headers['x-inspect-token'] ?? ''), token) || (!reading && !origins.has(String(request.headers.origin))))
      return json(response, 403, { error: { code: 'forbidden', message: "the board is reachable only from the inspector's own page" } })
    const path = url.pathname.slice('/board'.length) || '/'
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      decoded = '..'
    }
    if (/(^|\/)\.\.?(\/|$)|\\/.test(decoded)) return json(response, 400, { error: { code: 'bad_path', message: 'no relative paths' } })
    const controller = new AbortController()
    streams.add(controller)
    response.on('close', () => controller.abort())
    try {
      // An upload is a whole file; everything else is a little JSON.
      const body = reading ? undefined : await read(request, path === '/attachments' ? ATTACHMENT_BYTES_MAX : undefined)
      // The page may pick who you act as: one of your profiles, with its avatar, or yourself (an empty name).
      const chosen = request.headers['x-inspect-profile']
      const avatar = request.headers['x-inspect-avatar']
      const as = typeof chosen === 'string' ? (chosen === '' ? null : typeof avatar === 'string' && avatar ? { name: chosen, avatar } : chosen) : undefined
      const upstream = await client.request(`${path}${url.search}`, {
        ...(as !== undefined ? { as } : {}),
        method: request.method ?? 'GET',
        headers: {
          ...(request.headers['content-type'] ? { 'content-type': String(request.headers['content-type']) } : {}),
          ...(request.headers.accept ? { accept: String(request.headers.accept) } : {}),
          ...(request.headers['x-board-filename'] ? { 'x-board-filename': String(request.headers['x-board-filename']) } : {}),
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
      })
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
      response.end()
    } catch (error) {
      if (controller.signal.aborted || response.headersSent) return void response.end()
      json(response, 502, { error: { code: 'unreachable', message: `the board didn't answer: ${(error as Error).message}` } })
    } finally {
      streams.delete(controller)
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://inspector')
    if (!origins.has(`http://${request.headers.host}`)) return send(response, 421, 'text/plain; charset=utf-8', 'wrong host')
    if (url.pathname === '/board' || url.pathname.startsWith('/board/'))
      return void proxy(request, response, url).catch(() =>
        response.headersSent ? response.end() : send(response, 500, 'text/plain; charset=utf-8', 'error'),
      )
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
    if (url.pathname === '/app.js')
      return app
        ? send(response, 200, 'text/javascript; charset=utf-8', app)
        : send(response, 503, 'text/plain; charset=utf-8', "the inspector's UI isn't built: run `pnpm --filter @vercel/board build`")
    // Every other path is a route inside the page.
    send(response, 200, 'text/html; charset=utf-8', shell(token), { 'content-security-policy': CSP })
  })

  const port = await listen(server, options.port ?? DEFAULT_PORT, options.port === undefined)
  origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  return {
    url: `http://127.0.0.1:${port}`,
    board,
    me,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.abort()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function read(request: IncomingMessage, limit = 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  response.end(body)
}

const json = (response: ServerResponse, status: number, body: unknown) =>
  send(response, status, 'application/json', JSON.stringify(body))

/** Listens on the port, or any free one when the default port is taken. */
async function listen(server: Server, port: number, fallback: boolean): Promise<number> {
  try {
    return await listenOn(server, port)
  } catch (error) {
    if (fallback && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') return listenOn(server, 0)
    throw error
  }
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}
