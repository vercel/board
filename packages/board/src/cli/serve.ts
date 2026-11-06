import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { BoardError } from '../client/client.ts'
import { localTokenFile } from '../client/node.ts'
import { local } from '../server/local.ts'
import { oidcTokens } from '../server/tokens.ts'
import { board } from '../server/index.ts'

export const DEFAULT_SERVE_PORT = 4100
const ISSUER = 'board:local'
const BODY_MAX = 8 * 1024 * 1024

export type LocalBoard = {
  /** The board's URL, `http://127.0.0.1:<port>/api/board`. */
  url: string
  /** Who you are on it: `local:user:<name>`. */
  principal: string
  handle: string
  /** Your token for it, also in `localTokenFile(url)`. */
  token: string
  /** Where its log and attachments live. */
  dir: string
  close(): Promise<void>
}

/** Your OS username as a handle: lowercase letters, digits, `.`, `_`, `-`. */
export function localHandle(name = safeUsername()): string {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/, '')
  return handle || 'me'
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || 'me'
  }
}

/** What an earlier `vb serve` left under `dir` (`board.db`, `attachments/`), moved to where `local()` keeps the board. */
async function carryOver(dir: string) {
  const there = (path: string) => stat(join(dir, path)).then(() => true, () => false)
  if (!(await there('board.db')) || (await there('local.db'))) return
  for (const suffix of ['', '-wal', '-shm']) if (await there(`board.db${suffix}`)) await rename(join(dir, `board.db${suffix}`), join(dir, `local.db${suffix}`))
  if ((await there('attachments')) && !(await there('local'))) await rename(join(dir, 'attachments'), join(dir, 'local'))
}

/**
 * A board on this machine, for agents and people sharing one computer: `local()` under `dir`, its
 * log in SQLite, attachments next to it, a scheduler in this process, no sync, on 127.0.0.1 only.
 * Its keys live in memory for this run; it signs one token, for you, into a file only you can read
 * (`localTokenFile`), which `vb` on this machine picks up.
 */
export async function serveLocal(options: { dir: string; port?: number; handle?: string }): Promise<LocalBoard> {
  const dir = resolve(options.dir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  quietSqliteWarning()
  await carryOver(dir)
  const backend = local({ dir })

  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'local', alg: 'ES256' }] })

  // The URL is the token's audience, so it's fixed once the port is known.
  let handler: ((request: Request) => Promise<Response>) | null = null
  const server = createServer((request, response) => {
    if (!handler) return void response.writeHead(503).end()
    void forward(handler, request, response)
  })
  let port: number
  try {
    port = await listen(server, options.port ?? DEFAULT_SERVE_PORT)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new BoardError('port_taken', `Port ${options.port ?? DEFAULT_SERVE_PORT} is taken. Is a board already running there?`, 0)
    throw error
  }
  const url = `http://127.0.0.1:${port}/api/board`
  const mounted = board({
    // Its timers live in this process, which runs as long as the board does.
    backend,
    authenticate: oidcTokens({ local: { issuer: ISSUER, jwks } }),
    url,
    basePath: '/api/board',
  })
  try {
    // Opened now, so a directory it can't write says so before it serves.
    await mounted.channels()
  } catch (error) {
    server.close()
    throw error
  }
  handler = mounted.fetch

  const handle = options.handle ?? localHandle()
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'local' })
    .setIssuer(ISSUER)
    .setAudience(url)
    .setSubject(handle)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(privateKey)
  const file = localTokenFile(url)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify({ url, token, handle }), { mode: 0o600 })

  return {
    url,
    principal: `local:user:${handle}`,
    handle,
    token,
    dir,
    async close() {
      await rm(file, { force: true })
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await backend.close()
    },
  }
}

/** Node flags `node:sqlite` as experimental on stderr, which would be the CLI's only stderr line. */
function quietSqliteWarning() {
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (/SQLite is an experimental feature/.test(text)) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail)
      done((server.address() as AddressInfo).port)
    })
  })
}

async function forward(handler: (request: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  try {
    let body: Uint8Array<ArrayBuffer> | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > BODY_MAX) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'too_large', message: 'request too large' } }))
          return
        }
        chunks.push(chunk as Buffer)
      }
      body = new Uint8Array(Buffer.concat(chunks))
    }
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    const response = await handler(
      new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        ...(body && body.length > 0 ? { body } : {}),
        signal: controller.signal,
      }),
    )
    const out: Record<string, string | string[]> = {}
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') return
      out[key] = value
    })
    res.writeHead(response.status, out)
    if (response.body)
      try {
        for await (const chunk of response.body) res.write(chunk)
      } catch {}
    res.end()
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'internal', message: (error as Error).message } }))
  }
}
