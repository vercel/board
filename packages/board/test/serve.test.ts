import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { localHandle } from '../src/cli/serve.ts'
import { localTokenFile } from '../src/client/node.ts'
import { BOARD_URL, caller, personToken, testAuth, testBoard } from './harness.ts'
import { CLI, tmp } from './cli-harness.ts'

async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' }] })
  const sign = (sub: string, audience = BOARD_URL, iss = 'board:local') =>
    new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer(iss).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey)
  return { jwks, sign }
}

describe('local auth', () => {
  it("makes a local issuer's subject a person with full access", async () => {
    const { jwks, sign } = await issuer()
    const board = testBoard({ auth: { ...testAuth, local: { issuer: 'board:local', jwks } } })
    const me = await caller(board.fetch, await sign('julian'))('GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ actor: 'local:user:julian', principal: 'local:user:julian', kind: 'person', handle: 'julian' })
    const posted = await caller(board.fetch, await sign('julian'), { 'x-board-profile': 'claude' })('POST', '/messages', { channel: 'local', text: 'hi' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by).toMatchObject({ actor: 'local:user:julian+claude', principal: 'local:user:julian' })
  })

  it("refuses another key, another board's audience, a bad sub, and boards without the issuer", async () => {
    const { jwks, sign } = await issuer()
    const other = await issuer()
    const board = testBoard({ auth: { ...testAuth, local: { issuer: 'board:local', jwks } } })
    for (const token of [await other.sign('julian'), await sign('julian', 'http://elsewhere/api/board'), await sign('../root')])
      expect((await caller(board.fetch, token)('GET', '/me')).status).toBe(401)
    expect((await caller(testBoard().fetch, await sign('julian'))('GET', '/me')).status).toBe(401)
    // The board's own Vercel people still get in alongside.
    expect((await caller(board.fetch, await personToken())('GET', '/me')).status).toBe(200)
  })

  it('turns OS usernames into handles', () => {
    expect(localHandle('Julian Benegas')).toBe('julian-benegas')
    expect(localHandle('DOMAIN\\jb')).toBe('domain-jb')
    expect(localHandle('_')).toBe('me')
  })
})

const running: ChildProcess[] = []
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL')
})

async function setup() {
  const project = await tmp('serve-project-')
  await mkdir(join(project, '.git'))
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|CURSOR_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)),
  )
  const env = { ...clean, HOME: await tmp('serve-home-'), XDG_CONFIG_HOME: await tmp('serve-config-') }
  return { project, env }
}

/** `vb serve` on a free port, resolved once it says where it's serving. */
function serveIn(cwd: string, env: NodeJS.ProcessEnv, flags = ['--no-inspect']) {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...flags], { cwd, env })
  running.push(child)
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  const url = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      stdout += d
      const found = /serving a local board at (\S+)/.exec(stdout)
      if (found && stdout.includes('\n', found.index)) resolve(found[1]!)
    })
    void exited.then((code) => reject(new Error(`vb serve exited ${code}: ${stderr}`)))
  })
  return { child, url, exited, output: () => stdout }
}

function withConfig<T>(dir: string, run: () => T): T {
  const saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
  }
}

function vb(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}

/** A request as a proxy in front of `vb serve` forwards it, with the headers it sends: fetch won't forge a `Host`. A `body` is posted as JSON. */
function forwarded(to: string, path: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { hostname, port, pathname } = new URL(to)
    const sent = body === undefined ? headers : { 'content-type': 'application/json', ...headers }
    const req = request({ hostname, port, path: `${pathname === '/' ? '' : pathname}${path}` || '/', method: body === undefined ? 'GET' : 'POST', headers: sent }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

const proxies: Server[] = []
afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close()
})

/**
 * Stands in for `tailscale serve`, which no test runs: it forwards to `target()`, keeps the `Host`
 * it was asked for, drops any `Tailscale-*` header its caller sent, and names `login` as who's
 * calling, or no one, as Tailscale does for a tagged device.
 */
async function tailscaleProxy(target: () => string, login: string | null) {
  const proxy = createServer((req, res) => {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    for (const name of Object.keys(headers)) if (name.startsWith('tailscale-')) delete headers[name]
    if (login !== null) headers['tailscale-user-login'] = login
    const { hostname, port } = new URL(target())
    const up = request({ hostname, port, path: req.url, method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  proxies.push(proxy)
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return `127.0.0.1:${(proxy.address() as AddressInfo).port}`
}

describe('vb serve', () => {
  /** Who you are on a local board: this machine's user, as its local token names you. */
  const me = localHandle()

  it('runs a board here, says how to reach it, and keeps its log across runs', async () => {
    const { project, env } = await setup()
    const first = serveIn(project, env)
    const url = await first.url
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/board$/)
    // It links nothing: other commands reach it by its URL, and its log stays out of Git.
    await expect.poll(first.output).toContain(`reach it with --url ${url}, or BOARD_URL=${url}`)
    expect(existsSync(join(project, '.board', 'config.json'))).toBe(false)
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe('.board/\n')
    const at = { ...env, BOARD_URL: url }

    const whoami = await vb(project, at, ['whoami', '--json'])
    expect(whoami.stderr).toBe('')
    expect(JSON.parse(whoami.stdout)).toMatchObject({ actor: `local:user:${me}`, handle: me, board: url })

    // An agent in the same checkout that says who it is is "claude via <you>".
    const posted = await vb(project, at, ['post', 'local', 'from claude', '--as', 'claude', '--json'])
    expect(posted.code).toBe(0)
    expect(JSON.parse(posted.stdout).message.by).toMatchObject({ actor: `local:user:${me}+claude` })
    const reply = await vb(join(project), at, ['reply', String(JSON.parse(posted.stdout).message.id), 'from julian'])
    expect(reply.code).toBe(0)

    const tokenFile = withConfig(env.XDG_CONFIG_HOME, () => localTokenFile(url))
    expect(existsSync(tokenFile)).toBe(true)
    first.child.kill('SIGINT')
    expect(await first.exited).toBe(0)
    expect(existsSync(tokenFile)).toBe(false)
    expect(existsSync(join(project, '.board', 'local.db'))).toBe(true)

    // A new run, on another port, still has the thread.
    const second = serveIn(project, env)
    const again = await second.url
    const read = await vb(project, { ...env, BOARD_URL: again }, ['read', 'local', '--json'])
    expect(read.stderr).toBe('')
    expect(read.stdout).toContain('from claude')
    expect(read.stdout).toContain('from julian')
    second.child.kill('SIGINT')
    expect(await second.exited).toBe(0)
  })

  it('carries over the log and files an earlier vb serve kept in .board/board.db', async () => {
    const { project, env } = await setup()
    await writeFile(join(project, 'shot.txt'), 'pixels')
    const first = serveIn(project, env)
    const at = { ...env, BOARD_URL: await first.url }
    const posted = await vb(project, at, ['post', 'local', 'before the upgrade', '--attach', 'shot.txt', '--json'])
    const [file] = JSON.parse(posted.stdout).message.attachments
    first.child.kill('SIGINT')
    expect(await first.exited).toBe(0)
    // As an earlier vb serve left it: the log in board.db, the files in attachments/.
    const board = join(project, '.board')
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(board, `local.db${suffix}`))) await rename(join(board, `local.db${suffix}`), join(board, `board.db${suffix}`))
    await rename(join(board, 'local'), join(board, 'attachments'))

    const second = serveIn(project, env)
    const again = { ...env, BOARD_URL: await second.url }
    expect((await vb(project, again, ['read', 'local'])).stdout).toContain('before the upgrade')
    expect(await vb(project, again, ['download', file.id, '-'])).toMatchObject({ code: 0, stdout: 'pixels' })
    expect(existsSync(join(board, 'board.db'))).toBe(false)
    second.child.kill('SIGINT')
    expect(await second.exited).toBe(0)
  })

  it("serves the inspector beside the board, on its port, and the board alone with --no-inspect", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open'])
    const url = await serving.url
    const origin = new URL(url).origin
    await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
    // Every path outside the board's is the page's, as on the inspector's own server.
    for (const path of ['/', '/c/local', '/settings/access']) {
      const page = await fetch(`${origin}${path}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<div id="root"></div>')
    }
    expect((await fetch(`${origin}/app.js`)).headers.get('content-type')).toContain('text/javascript')
    // And the board is where it was.
    expect(await (await fetch(url)).json()).toMatchObject({ url, audience: url })
    expect((await vb(project, { ...env, BOARD_URL: url }, ['post', 'local', 'beside the page'])).code).toBe(0)
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)

    const alone = serveIn(project, env, ['--no-inspect'])
    const bare = await alone.url
    expect((await fetch(`${new URL(bare).origin}/`)).status).toBe(404)
    expect(alone.output()).not.toContain('inspector at')
    expect((await vb(project, { ...env, BOARD_URL: bare }, ['read', 'local'])).stdout).toContain('beside the page')
    alone.child.kill('SIGINT')
    expect(await alone.exited).toBe(0)
  })

  it('keeps serving after a path the page can\'t parse', async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open'])
    const url = await serving.url
    const origin = new URL(url).origin
    await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
    // A request target HTTP allows and a URL doesn't: it's refused, and nothing stops.
    expect((await forwarded(origin, '//[', {})).status).toBe(400)
    expect((await fetch(`${origin}/`)).status).toBe(200)
    expect((await fetch(url)).status).toBe(200)
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it("gives a request a proxy forwarded the page only at a host you allowed, whatever Host it carries", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open', '--allow-host', 'box.tailnet.ts.net'])
    const url = await serving.url
    const origin = new URL(url).origin
    await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
    const own = new URL(url).host
    // On this machine, by the server's own name: yours.
    expect((await forwarded(origin, '/', { host: own })).status).toBe(200)
    // Through a proxy, a caller can send that name too: it isn't on this machine, so it's no one's page.
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip'])
      expect((await forwarded(origin, '/', { host: own, [header]: 'anything' })).status, header).toBe(421)
    expect((await forwarded(origin, '/board/me', { host: `localhost:${new URL(url).port}`, 'x-forwarded-host': 'box.tailnet.ts.net' })).status).toBe(421)
    // At the host you allowed, it's the page, as before.
    expect((await forwarded(origin, '/', { host: 'box.tailnet.ts.net', 'x-forwarded-host': 'box.tailnet.ts.net', 'x-forwarded-for': '100.64.0.1' })).status).toBe(200)
    // The board takes tokens wherever it's reached, so it still answers: at its own URL, for a name you didn't allow.
    expect(JSON.parse((await forwarded(url, '', { host: own, 'x-forwarded-for': '100.64.0.1' })).body)).toMatchObject({ url, audience: url })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it("opens the inspector as you on this board, whatever BOARD_TOKEN holds", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, { ...env, BOARD_TOKEN: 'not-a-token-for-this-board' }, ['--no-open'])
    await serving.url
    await expect.poll(serving.output, { timeout: 10_000 }).toMatch(/inspector at http:\/\/127\.0\.0\.1:\d+\n/)
    const inspector = /inspector at (\S+)/.exec(serving.output())![1]!
    const page = await (await fetch(`${inspector}/`)).text()
    const token = /<meta name="inspect-token" content="([^"]+)">/.exec(page)![1]!
    const me = await (await fetch(`${inspector}/board/me`, { headers: { 'x-inspect-token': token } })).json()
    expect(me).toMatchObject({ actor: `local:user:${localHandle()}` })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it('is the board at a host you allow, and at its own address for any other', async () => {
    const { project, env } = await setup()
    // As in production, where a board that checks no Host itself takes none from a request.
    const serving = serveIn(project, { ...env, NODE_ENV: 'production' }, ['--no-inspect', '--allow-host', 'box.tailnet.ts.net'])
    const url = await serving.url
    const discovered = async (headers: Record<string, string>) => JSON.parse((await forwarded(url, '', headers)).body)
    // A proxy that keeps the Host it was asked for, and says the request came over TLS.
    const there = 'https://box.tailnet.ts.net/api/board'
    expect(await discovered({ host: 'box.tailnet.ts.net', 'x-forwarded-proto': 'https' })).toMatchObject({ url: there, audience: there })
    expect(await discovered({ host: 'BOX.tailnet.ts.net' })).toMatchObject({ audience: 'http://box.tailnet.ts.net/api/board' })
    // A sender chooses its Host: one you didn't allow doesn't get to name the board.
    expect(await discovered({ host: 'evil.example', 'x-forwarded-proto': 'https' })).toMatchObject({ url, audience: url })

    // Your token is for the board's own URL: it's you there, and no one at the host you allowed.
    const { token } = JSON.parse(await readFile(withConfig(env.XDG_CONFIG_HOME, () => localTokenFile(url)), 'utf8'))
    const me = (headers: Record<string, string>) => forwarded(url, '/me', { authorization: `Bearer ${token}`, ...headers })
    expect((await me({})).status).toBe(200)
    expect((await me({ host: 'evil.example' })).status).toBe(200)
    expect((await me({ host: 'box.tailnet.ts.net', 'x-forwarded-proto': 'https' })).status).toBe(401)
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it('opens the inspector to a host you allow, beside the board there', async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open', '--allow-host', 'box.tailnet.ts.net'])
    const url = await serving.url
    await expect.poll(serving.output, { timeout: 10_000 }).toMatch(/inspector at http:\/\/127\.0\.0\.1:\d+\n/)
    const inspector = /inspector at (\S+)/.exec(serving.output())![1]!
    const page = await forwarded(inspector, '/', { host: 'box.tailnet.ts.net' })
    expect(page.status).toBe(200)
    // The page there acts as you, as on this machine.
    const token = /<meta name="inspect-token" content="([^"]+)">/.exec(page.body)![1]!
    const me = await forwarded(inspector, '/board/me', { host: 'box.tailnet.ts.net', 'x-inspect-token': token })
    expect(JSON.parse(me.body)).toMatchObject({ actor: `local:user:${localHandle()}` })
    expect((await forwarded(inspector, '/', { host: 'evil.example' })).status).toBe(421)
    // One name reaches both: the board is under it too.
    expect(JSON.parse((await forwarded(url, '', { host: 'box.tailnet.ts.net' })).body)).toMatchObject({ url: 'http://box.tailnet.ts.net/api/board' })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  describe('--tailscale', () => {
    const at = { host: 'box.tailnet.ts.net', 'x-forwarded-proto': 'https' }
    const ada = { ...at, 'tailscale-user-login': 'Ada@Example.com' }

    it('names whoever Tailscale says is calling, only at the host it serves the board on', async () => {
      const { project, env } = await setup()
      const serving = serveIn(project, env, ['--no-inspect', '--tailscale', 'box.tailnet.ts.net'])
      const url = await serving.url
      // It says what to hand the people on the tailnet, and what puts Tailscale in front of this port.
      await expect.poll(serving.output).toContain(`on your tailnet, behind tailscale serve --bg ${new URL(url).port}: BOARD_URL=https://box.tailnet.ts.net/api/board\n`)
      const me = async (headers: Record<string, string>) => {
        const answer = await forwarded(url, '/me', headers)
        return { status: answer.status, ...(answer.status === 200 ? { actor: JSON.parse(answer.body).actor as string } : {}) }
      }
      // No token: the person is the login Tailscale's proxy sets, and the board is that host's.
      const found = await forwarded(url, '/me', ada)
      expect(JSON.parse(found.body)).toMatchObject({ actor: 'tailscale:user:ada@example.com', kind: 'person', handle: 'ada', can: { '*': expect.arrayContaining(['read', 'post', 'manage']) } })
      // Their agents write as profiles of theirs, as anyone's do.
      const posted = await forwarded(url, '/messages', { ...ada, 'x-board-profile': 'claude' }, { channel: 'local', text: 'from the tailnet' })
      expect(posted.status).toBe(201)
      expect(JSON.parse(posted.body).message.by).toMatchObject({ actor: 'tailscale:user:ada@example.com+claude', principal: 'tailscale:user:ada@example.com' })

      // The header is Tailscale's word only at the host Tailscale serves: anywhere else a sender writes its own.
      expect(await me({ 'tailscale-user-login': 'ada@example.com' })).toEqual({ status: 401 })
      expect(await me({ host: 'other.example', 'tailscale-user-login': 'ada@example.com' })).toEqual({ status: 401 })
      // And through Tailscale, a caller who sends the board's own name as its Host is still not you.
      expect(await me({ host: new URL(url).host, 'x-forwarded-host': new URL(url).host, 'tailscale-user-login': 'ada@example.com' })).toEqual({ status: 401 })
      // No one named, as for a tagged device, or a login an ID can't hold: a token, or nothing.
      expect(await me(at)).toEqual({ status: 401 })
      expect(await me({ ...at, 'tailscale-user-login': 'ada+work@example.com' })).toEqual({ status: 401 })
      // A browser carries its user's place on the tailnet for any site's page: only the board's own acts as them.
      expect(await me({ ...ada, origin: 'https://evil.example' })).toEqual({ status: 403 })
      expect(await me({ ...ada, 'sec-fetch-site': 'cross-site' })).toEqual({ status: 403 })
      expect(await me({ ...ada, origin: 'https://box.tailnet.ts.net', 'sec-fetch-site': 'same-origin' })).toEqual({ status: 200, actor: 'tailscale:user:ada@example.com' })

      // You're still you, with your token, at the board's own address.
      const { token } = JSON.parse(await readFile(withConfig(env.XDG_CONFIG_HOME, () => localTokenFile(url)), 'utf8'))
      expect(await me({ authorization: `Bearer ${token}` })).toEqual({ status: 200, actor: `local:user:${localHandle()}` })
      serving.child.kill('SIGINT')
      expect(await serving.exited).toBe(0)
    })

    it('lets a grant name a person by their login, which no other local board can look up', async () => {
      const { project, env } = await setup()
      const serving = serveIn(project, env, ['--no-inspect', '--tailscale', 'box.tailnet.ts.net'])
      const url = await serving.url
      const owner = { ...env, BOARD_URL: url }
      const post = (channel: string) => forwarded(url, '/messages', ada, { channel, text: 'hi' })
      // Every person may do everything until a grant says less of one.
      expect((await post('ops/deploys')).status).toBe(201)
      const granted = await vb(project, owner, ['grants', 'create', '--user', 'Ada@Example.com', '--can', 'ops/=read', '--json'])
      expect(granted.stderr).toBe('')
      expect(JSON.parse(granted.stdout).grant.principals).toEqual([{ kind: 'user', userId: 'ada@example.com', email: null }])
      expect((await post('ops/deploys')).status).toBe(403)
      expect((await post('dev')).status).toBe(201)
      const explained = await vb(project, owner, ['grants', 'explain', 'ops/deploys', '--user', 'ada@example.com', '--json'])
      expect(JSON.parse(explained.stdout)).toMatchObject({ explanation: { pattern: 'ops/', level: 'principal', can: ['read'] } })
      serving.child.kill('SIGINT')
      expect(await serving.exited).toBe(0)

      // Without Tailscale, a local board's people are OS users: it has nothing to look an email up with.
      const plain = serveIn(project, env)
      const refused = await vb(project, { ...env, BOARD_URL: await plain.url }, ['grants', 'create', '--user', 'bob@example.com', '--can', 'ops/=read'])
      expect(refused.code).toBe(2)
      expect(refused.stderr).toContain("can't look up bob@example.com")
      plain.child.kill('SIGINT')
      expect(await plain.exited).toBe(0)
    })

    it('makes the page act as its visitor there, and as you on this machine', async () => {
      const { project, env } = await setup()
      const serving = serveIn(project, env, ['--no-open', '--tailscale', 'box.tailnet.ts.net'])
      const url = await serving.url
      const origin = new URL(url).origin
      await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
      const page = await forwarded(origin, '/', ada)
      expect(page.status).toBe(200)
      const token = /<meta name="inspect-token" content="([^"]+)">/.exec(page.body)![1]!
      const through = { 'x-inspect-token': token }
      // The page's proxy acts as whoever Tailscale named, never as you.
      expect(JSON.parse((await forwarded(origin, '/board/me', { ...ada, ...through })).body)).toMatchObject({ actor: 'tailscale:user:ada@example.com' })
      const written = await forwarded(origin, '/board/messages', { ...ada, ...through, origin: 'https://box.tailnet.ts.net' }, { channel: 'local', text: 'from the page' })
      expect(written.status).toBe(201)
      expect(JSON.parse(written.body).message.by).toMatchObject({ actor: 'tailscale:user:ada@example.com' })
      // With no one named, the page there is no one's: it doesn't fall back to you.
      expect((await forwarded(origin, '/board/me', { ...at, ...through })).status).toBe(401)
      // Nor for a caller who sends the board's own name through Tailscale, which forwards whatever Host it's sent.
      const spoofed = { host: new URL(url).host, 'x-forwarded-host': new URL(url).host, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'ada@example.com' }
      expect((await forwarded(origin, '/', spoofed)).status).toBe(421)
      expect((await forwarded(origin, '/board/me', { ...spoofed, ...through })).status).toBe(421)
      // At the board's own address the page is yours, as it was.
      expect(await (await fetch(`${origin}/board/me`, { headers: through })).json()).toMatchObject({ actor: `local:user:${localHandle()}` })
      serving.child.kill('SIGINT')
      expect(await serving.exited).toBe(0)
    })

    it("is no one's but its visitor's when the host is written with its scheme's port", async () => {
      const { project, env } = await setup()
      const serving = serveIn(project, env, ['--no-open', '--tailscale', 'box.tailnet.ts.net:443'])
      const url = await serving.url
      const origin = new URL(url).origin
      await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
      const token = /<meta name="inspect-token" content="([^"]+)">/.exec(await (await fetch(`${origin}/`)).text())![1]!
      const through = { 'x-inspect-token': token, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'box.tailnet.ts.net' }
      // A caller writes its Host with the port or without: either way it's the host you named, and never you.
      for (const host of ['box.tailnet.ts.net:443', 'box.tailnet.ts.net']) {
        const named = { ...through, host, 'tailscale-user-login': 'ada@example.com' }
        expect(JSON.parse((await forwarded(origin, '/board/me', named)).body), host).toMatchObject({ actor: 'tailscale:user:ada@example.com' })
        expect(JSON.parse((await forwarded(url, '/me', named)).body), host).toMatchObject({ actor: 'tailscale:user:ada@example.com' })
        expect((await forwarded(origin, '/board/me', { ...through, host })).status, host).toBe(401)
      }
      serving.child.kill('SIGINT')
      expect(await serving.exited).toBe(0)
    })

    it('lets vb in from another machine with no token, and says so when no one is named', async () => {
      const { project, env } = await setup()
      // The proxy is up first, so the board can be told the name it serves it on.
      let board = ''
      const named = await tailscaleProxy(() => board, 'ada@example.com')
      const unnamed = await tailscaleProxy(() => board, null)
      const serving = serveIn(project, env, ['--no-inspect', '--tailscale', named, '--tailscale', unnamed])
      board = await serving.url
      // Another machine: no token file of this board's, and no BOARD_TOKEN.
      const elsewhere = { ...env, XDG_CONFIG_HOME: await tmp('serve-elsewhere-') }
      const whoami = await vb(project, { ...elsewhere, BOARD_URL: `http://${named}/api/board` }, ['whoami', '--json'])
      expect(whoami.stderr).toBe('')
      expect(JSON.parse(whoami.stdout)).toMatchObject({ actor: 'tailscale:user:ada@example.com', handle: 'ada', board: `http://${named}/api/board`, source: null })
      const posted = await vb(project, { ...elsewhere, BOARD_URL: `http://${named}/api/board` }, ['post', 'local', 'from another machine', '--as', 'claude', '--json'])
      expect(JSON.parse(posted.stdout).message.by).toMatchObject({ actor: 'tailscale:user:ada@example.com+claude' })

      const noOne = await vb(project, { ...elsewhere, BOARD_URL: `http://${unnamed}/api/board` }, ['whoami'])
      expect(noOne.code).toBe(1)
      expect(noOne.stderr).toContain("doesn't know who you are without one")
      expect(noOne.stderr).toContain('BOARD_TOKEN')
      serving.child.kill('SIGINT')
      expect(await serving.exited).toBe(0)
    })
  })

  it("refuses --tailscale beside --allow-host: another proxy could forge Tailscale's word", async () => {
    const { project, env } = await setup()
    const refused = await vb(project, env, ['serve', '--port', '0', '--no-inspect', '--tailscale', 'box.tailnet.ts.net', '--allow-host', 'box.example.com'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("doesn't go with --allow-host")
  })

  it('takes only a host for --allow-host', async () => {
    const { project, env } = await setup()
    const refused = await vb(project, env, ['serve', '--port', '0', '--no-inspect', '--allow-host', 'https://box.tailnet.ts.net/'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('--allow-host takes a host')
  })

  it('says so when the port is taken', async () => {
    const { project, env } = await setup()
    const first = serveIn(project, env)
    const port = new URL(await first.url).port
    const second = await vb(project, env, ['serve', '--port', port, '--no-inspect'])
    expect(second.code).toBe(1)
    expect(second.stderr).toBe(`error: Port ${port} is taken. Is a board already running there?\n\n  Pick another port:\n    vb serve --port <PORT>\n`)
  })
})
