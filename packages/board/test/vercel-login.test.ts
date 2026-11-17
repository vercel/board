import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A person's Vercel CLI login, as @vercel/oidc reads it, and the exchange that binds a development token to a URL.
const login = vi.hoisted(() => ({ token: 'vercel-cli-token' as string | null }))
const exchange = vi.hoisted(() => vi.fn(async (_options: { token: string; audience: string }) => ''))
vi.mock('@vercel/oidc', async (original) => ({
  ...(await original<typeof import('@vercel/oidc')>()),
  getVercelToken: vi.fn(async () => {
    if (!login.token) throw new Error('not logged in')
    return login.token
  }),
  exchangeVercelOidcToken: exchange,
}))

const { board } = await import('../src/server/index.ts')
const { http } = await import('../src/backend-http/index.ts')
const { BOARD_URL, personToken, testBoard } = await import('./harness.ts')
const { handFetch, handLogin } = await import('../src/client/node.ts')
const { createApp } = await import('../src/cli/embedded.ts')

const EVIL = 'https://evil.example/api/board'
const LOCAL = 'http://localhost:3000/api/board'

/**
 * The Vercel API as your login sees it: the hosts it resolves to a project (with or
 * without a `teamId`, which must be the owner's), and a development token for any
 * project you can access, here `prj_board` and `prj_victim`. Every call is recorded.
 */
function vercel(hosts: Record<string, { projectId: string; ownerId: string }>) {
  const calls: string[] = []
  const handle = (request: Request) => {
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}${url.search}`)
    if (request.headers.get('authorization') !== 'Bearer vercel-cli-token')
      return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
    const team = url.searchParams.get('teamId')
    const host = url.pathname.match(/^\/v13\/deployments\/([^/]+)$/)?.[1]
    const found = host ? hosts[decodeURIComponent(host)] : undefined
    if (found && (!team || team === found.ownerId)) return Response.json({ ...found, url: 'board-abc123.vercel.app' })
    if (url.pathname === '/v2/teams') return Response.json({ teams: [{ id: 'team_test' }, { id: 'team_victim' }] })
    const minted = url.pathname.match(/^\/v1\/projects\/(prj_board|prj_victim)\/token$/)?.[1]
    if (minted && request.method === 'POST') return Response.json({ token: `development-token-for-${minted}` })
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  }
  return { handle, calls }
}

/** A board at EVIL whose discovery says it's `prj_victim`, a project you can access. */
function evilBoard(teamId: string | null) {
  return (request: Request) =>
    request.method === 'GET' && request.url === EVIL
      ? Response.json({ version: '0', url: EVIL, audience: EVIL, team_id: teamId, project_id: 'prj_victim', sync: [] })
      : Response.json({ channels: [] })
}

describe("a person's token from `vercel login`", () => {
  let config: string
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), 'board-login-'))
    for (const key of Object.keys(process.env))
      if (/^(BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)) vi.stubEnv(key, '')
    vi.stubEnv('XDG_CONFIG_HOME', config)
    login.token = 'vercel-cli-token'
    exchange.mockReset().mockImplementation(async ({ audience }) => personToken('u_julian', audience))
  })
  afterEach(async () => {
    handLogin(null)
    handFetch(null)
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(config, { recursive: true, force: true })
  })

  // Requests to api.vercel.com reach `api`; everything else reaches the board, which records each bearer it's sent.
  function network(api: ReturnType<typeof vercel>, board: (request: Request) => Response | Promise<Response>) {
    const bearers: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).host === 'api.vercel.com') return api.handle(request)
      const bearer = request.headers.get('authorization')
      if (bearer) bearers.push(bearer)
      return board(request)
    })
    return bearers
  }
  /** A handle on the board at `url`, reaching it the way `vb` does. */
  const client = (url: string) => board({ backend: http(url) })

  /** A signed-in `vercel` on PATH that answers anything and logs each call to the file it returns. */
  async function vercelOnPath() {
    const bin = await mkdtemp(join(tmpdir(), 'board-bin-'))
    const log = join(bin, 'calls')
    await writeFile(join(bin, 'vercel'), `#!/bin/sh\necho "$*" >> ${log}\necho '{"token":"development-token","projectId":"prj_board","ownerId":"team_test"}'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', bin)
    return { log, done: () => rm(bin, { recursive: true, force: true }) }
  }

  it("is minted for the project Vercel says the board's host is a deployment of", async () => {
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const board = testBoard()
    const bearers = network(api, (request) => board.fetch(request))
    expect(await client(BOARD_URL).channels()).toEqual([])
    expect(api.calls).toEqual([
      'GET /v13/deployments/board.test',
      'POST /v1/projects/prj_board/token?source=board&teamId=team_test'
    ])
    expect(exchange).toHaveBeenCalledWith({ token: 'development-token-for-prj_board', audience: BOARD_URL })
    expect(bearers).toEqual([`Bearer ${await exchange.mock.results[0]!.value}`])
  })

  it("isn't minted for a board whose discovery names a project its host isn't a deployment of", async () => {
    // evil.example is the attacker's own Vercel project, and its discovery claims yours.
    const api = vercel({ 'evil.example': { projectId: 'prj_evil', ownerId: 'team_evil' } })
    const bearers = network(api, evilBoard(null))
    await expect(client(EVIL).channels()).rejects.toMatchObject({
      code: 'wrong_project',
      message: `The board at ${EVIL} says its project is prj_victim, but it's a deployment of prj_evil, so no token is minted for it.`,
    })
    expect(api.calls).toEqual(['GET /v13/deployments/evil.example'])
    expect(exchange).not.toHaveBeenCalled()
    expect(bearers).toEqual([])
  })

  it("isn't minted for a host Vercel won't resolve for you, whatever team its discovery names", async () => {
    const api = vercel({})
    const bearers = network(api, evilBoard('team_victim'))
    await expect(client(EVIL).channels()).rejects.toMatchObject({
      code: 'no_access',
      message: "Your Vercel login can't see the project evil.example belongs to.",
      hint: expect.stringContaining('vercel login'),
    })
    expect(api.calls.length).toBeGreaterThan(0)
    expect(api.calls.filter((call) => !call.startsWith('GET '))).toEqual([])
    expect(exchange).not.toHaveBeenCalled()
    expect(bearers).toEqual([])
  })

  it("is minted for a loopback board's own project, which Vercel has no host for", async () => {
    const api = vercel({})
    const board = testBoard({ url: LOCAL })
    const bearers = network(api, (request) => board.fetch(request))
    expect(await client(LOCAL).channels()).toEqual([])
    expect(api.calls).toEqual(['POST /v1/projects/prj_board/token?source=board&teamId=team_test'])
    expect(exchange).toHaveBeenCalledWith({ token: 'development-token-for-prj_board', audience: LOCAL })
    expect(bearers).toHaveLength(1)
  })

  /**
   * What a command prints from an app passed `token`, or none. Its `fetch` adds the app's own login's
   * credentials to whatever it sends, as `vercel board`'s does: a login Vercel's API turns away here.
   */
  async function app(args: string[], token?: string) {
    let stdout = ''
    let stderr = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true))
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true))
    const appFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', 'Bearer the-apps-own-login')
      return globalThis.fetch(input, { ...init, headers })
    }
    try {
      const code = await createApp({ appName: 'vercel board', fetch: appFetch, ...(token ? { token } : {}) }).run(args)
      return { code, stdout, stderr }
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  }

  it('is minted with the token an app was passed, ahead of BOARD_TOKEN, and that token never reaches the board', async () => {
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const board = testBoard()
    const bearers = network(api, (request) => board.fetch(request))
    // `vercel login`'s is an account Vercel's API turns away here, and BOARD_TOKEN is someone else on this board.
    login.token = 'another-login'
    vi.stubEnv('BOARD_URL', BOARD_URL)
    vi.stubEnv('BOARD_TOKEN', await personToken('u_bo', BOARD_URL))
    const whoami = async (token?: string) => JSON.parse((await app(['whoami', '--json'], token)).stdout) as { principal: string; source: string }
    expect(await whoami('vercel-cli-token')).toMatchObject({ principal: 'vercel:user:u_julian', source: 'the token you passed' })
    expect(bearers).not.toContain('Bearer vercel-cli-token')
    expect(exchange).toHaveBeenCalledWith({ token: 'development-token-for-prj_board', audience: BOARD_URL })
    // Passed none, the same app sends BOARD_TOKEN, as vb does.
    expect(await whoami()).toMatchObject({ principal: 'vercel:user:u_bo', source: 'BOARD_TOKEN' })
  })

  it("says to pass another token when a board refuses the one minted with it, whatever BOARD_TOKEN holds", async () => {
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const board = testBoard()
    // A board that answers its discovery and takes no one's token.
    network(api, (request) => (request.method === 'GET' && request.url === BOARD_URL ? board.fetch(request) : Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 })))
    vi.stubEnv('BOARD_URL', BOARD_URL)
    vi.stubEnv('BOARD_TOKEN', await personToken('u_bo', BOARD_URL))
    const refused = await app(['read', 'general'], 'vercel-cli-token')
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('Pass a token it accepts') })
    expect(refused.stderr).not.toMatch(/BOARD_TOKEN|vercel login/)
    // Passed none, BOARD_TOKEN is what went, and what to replace.
    expect((await app(['read', 'general'])).stderr).toContain('BOARD_TOKEN')
  })

  it("fails when a login a CLI hands it fails, never acting as `vercel login`'s account", async () => {
    handLogin(async () => {
      throw new Error('refresh failed')
    })
    // `vercel login`'s token for this board, fresh, and its `vercel` on PATH.
    const tokens = join(config, 'board', 'tokens')
    await mkdir(tokens, { recursive: true })
    await writeFile(
      join(tokens, `${createHash('sha256').update(BOARD_URL).digest('hex').slice(0, 32)}.json`),
      JSON.stringify({ token: 'someone-elses', expiresAt: Date.now() + 12 * 3600_000, handle: 'ada', name: 'Ada', avatar: null }),
    )
    const cli = await vercelOnPath()
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const board = testBoard()
    try {
      const bearers = network(api, (request) => board.fetch(request))
      await expect(client(BOARD_URL).channels()).rejects.toMatchObject({ code: 'not_logged_in', hint: 'Run vercel login.' })
      expect([bearers, api.calls, exchange.mock.calls]).toEqual([[], [], []])
      await expect(readFile(cli.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cli.done()
    }
  })

  it("mints with a handed login only, not the `vercel` on PATH when Vercel won't mint", async () => {
    handLogin(async () => 'vercel-cli-token')
    const cli = await vercelOnPath()
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const down = { calls: api.calls, handle: (request: Request) => (request.method === 'POST' ? new Response('', { status: 502 }) : api.handle(request)) }
    const board = testBoard()
    try {
      const bearers = network(down, (request) => board.fetch(request))
      await expect(client(BOARD_URL).channels()).rejects.toThrow('502')
      expect([bearers, exchange.mock.calls]).toEqual([[], []])
      await expect(readFile(cli.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cli.done()
    }
  })

  it("mints with a handed login through the app's fetch, which adds the login's credentials, never its own", async () => {
    handLogin(async () => 'vercel-cli-token')
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    // The app's fetch, as `vercel board` signs a DPoP login's request, for this method and URL.
    const unsigned = vi.fn()
    handFetch(async (input, init = {}) => {
      const request = new Request(input, init)
      if (request.headers.has('authorization')) unsigned(request.url)
      request.headers.set('authorization', 'Bearer vercel-cli-token')
      return api.handle(request)
    })
    const board = testBoard()
    const bearers = network({ calls: [], handle: () => Response.json({ error: { code: 'unsigned' } }, { status: 401 }) }, (request) => board.fetch(request))
    expect(await client(BOARD_URL).channels()).toEqual([])
    expect(api.calls).toEqual([
      'GET /v13/deployments/board.test',
      'POST /v1/projects/prj_board/token?source=board&teamId=team_test'
    ])
    expect(unsigned).not.toHaveBeenCalled()
    expect(bearers).toEqual([`Bearer ${await exchange.mock.results[0]!.value}`])
  })

  it('drops cached tokens a day old when it caches one, as a rotating login leaves one per access token', async () => {
    const tokens = join(config, 'board', 'tokens')
    await mkdir(tokens, { recursive: true })
    for (const name of ['dead.json', 'alive.json']) await writeFile(join(tokens, name), '{}')
    const twoDays = new Date(Date.now() - 48 * 3600_000)
    await utimes(join(tokens, 'dead.json'), twoDays, twoDays)
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const board = testBoard()
    network(api, (request) => board.fetch(request))
    expect(await client(BOARD_URL).channels()).toEqual([])
    const left = await readdir(tokens)
    expect([left.includes('dead.json'), left.includes('alive.json'), left.length]).toEqual([false, true, 2])
  })

  it('looks the host up with the Vercel CLI when the login is in the keychain, before it mints', async () => {
    login.token = null
    // A signed-in `vercel` that logs each call: the API through `vercel api`, and `vercel project token`.
    const bin = await mkdtemp(join(tmpdir(), 'board-bin-'))
    const log = join(bin, 'calls')
    await writeFile(
      join(bin, 'vercel'),
      [
        '#!/bin/sh',
        `echo "$*" >> ${log}`,
        'case "$1 $2" in',
        '  "whoami "*) echo julian ;;',
        `  "api /v13/deployments/board.test") echo '{"projectId":"prj_board","ownerId":"team_test"}' ;;`,
        `  "api /v13/deployments/evil.example") echo '{"projectId":"prj_evil","ownerId":"team_evil"}' ;;`,
        `  "project token") echo '{"token":"development-token"}' ;;`,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', bin)
    const api = vercel({})
    try {
      const evil = network(api, evilBoard(null))
      await expect(client(EVIL).channels()).rejects.toMatchObject({ code: 'wrong_project' })
      expect(evil).toEqual([])
      const board = testBoard()
      network(api, (request) => board.fetch(request))
      expect(await client(BOARD_URL).channels()).toEqual([])
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
        'whoami --non-interactive',
        'api /v13/deployments/evil.example -X GET --raw --non-interactive',
        'api /v13/deployments/board.test -X GET --raw --non-interactive',
        'project token prj_board --format=json --scope team_test',
      ])
      expect(api.calls).toEqual([])
      expect(exchange.mock.calls).toEqual([[{ token: 'development-token', audience: BOARD_URL }]])
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
})
