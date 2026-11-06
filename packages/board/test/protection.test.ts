import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A person's Vercel CLI login, as @vercel/oidc reads it.
const login = vi.hoisted(() => ({ token: 'vercel-cli-token' as string | null }))
const runtimeToken = vi.hoisted(() => vi.fn(async (_options: { audience: string }) => 'runtime-token'))
vi.mock('@vercel/oidc', async (original) => ({
  ...(await original<typeof import('@vercel/oidc')>()),
  getVercelOidcToken: runtimeToken,
  getVercelToken: vi.fn(async () => {
    if (!login.token) throw new Error('not logged in')
    return login.token
  }),
}))

const { board } = await import('../src/server/index.ts')
const { http } = await import('../src/backend-http/index.ts')
const { connect, handFetch, handLogin } = await import('../src/client/node.ts')
/** A handle on the board at `url`, over http(), reaching it the way `vb` does, over the network `fetch` is. */
const handle = ({ url, ...options }: { url: string } & NonNullable<Parameters<typeof connect>[1]>) =>
  board({ backend: http(url, { fetch: connect(url, options).fetch }) })
const { BOARD_URL, caller, personToken, testBoard } = await import('./harness.ts')

const HOST = new URL(BOARD_URL).host
const SECRET = 'automation-bypass-secret'
// The hosts Vercel says a deployment answers on.
const OWN_HOSTS = ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const

/**
 * A board behind Vercel Authentication (a 302 to vercel.com/sso-api without the
 * secret), or Vercel Connect passport (a fetch gets Vercel's own 401), and the
 * slice of the Vercel API `vercel curl` uses to get through: the host is a
 * deployment in one of your teams, not your own scope.
 */
function protectedBoard(
  options: { bypass?: Record<string, { scope: string }>; canCreate?: boolean; canRead?: boolean; page?: boolean; passport?: boolean } = {},
) {
  const board = testBoard()
  let bypass = options.bypass ?? {}
  const api: string[] = []
  const sent: (string | null)[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.host === 'api.vercel.com') {
      api.push(`${request.method} ${url.pathname}${url.search}`)
      if (request.headers.get('authorization') !== 'Bearer vercel-cli-token')
        return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
      const team = url.searchParams.get('teamId')
      if (url.pathname === '/v2/teams') return Response.json({ teams: [{ id: 'team_other' }, { id: 'team_board' }] })
      if (url.pathname === `/v13/deployments/${HOST}` && team === 'team_board')
        return Response.json({ projectId: 'prj_board', ownerId: 'team_board' })
      if (url.pathname === '/v9/projects/prj_board' && team === 'team_board') {
        if (options.canRead === false) return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        const sso = options.page || options.passport ? null : { deploymentType: 'all_except_custom_domains' }
        const passport = options.passport ? { connectorId: 'scl_board', deploymentType: 'all' } : null
        return Response.json({ id: 'prj_board', name: 'board', protectionBypass: bypass, ssoProtection: sso, passwordProtection: null, passport })
      }
      if (url.pathname === '/v1/projects/prj_board/protection-bypass' && request.method === 'PATCH' && team === 'team_board') {
        if (options.canCreate === false) return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        bypass = { ...bypass, [SECRET]: { scope: 'automation-bypass' } }
        return Response.json({ protectionBypass: bypass })
      }
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    }
    sent.push(request.headers.get('x-vercel-protection-bypass'))
    // A plain website, not a board: an HTML page whatever you send.
    if (options.page) return new Response('<!DOCTYPE html><h1>Welcome</h1>', { headers: { 'content-type': 'text/html' } })
    // Passport redirects only a page load (`sec-fetch-mode: navigate`); Node's fetch says `cors`.
    if (options.passport && request.headers.get('x-vercel-protection-bypass') !== SECRET)
      return new Response('You must sign in\n\nUNAUTHORIZED\n', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-vercel-error': 'UNAUTHORIZED' },
      })
    if (request.headers.get('x-vercel-protection-bypass') !== SECRET)
      return new Response('Protected by Vercel Authentication', {
        status: 302,
        headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(request.url)}`, 'content-type': 'text/plain' },
      })
    return board.fetch(request)
  }) as typeof globalThis.fetch
  return { fetch, api, sent }
}

describe('a board behind Vercel Deployment Protection, without VERCEL_AUTOMATION_BYPASS_SECRET', () => {
  let config: string
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), 'board-protection-'))
    vi.stubEnv('XDG_CONFIG_HOME', config)
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
    vi.stubEnv('VERCEL', '')
    for (const own of OWN_HOSTS) vi.stubEnv(own, '')
    vi.stubEnv('BOARD_TOKEN', '')
    runtimeToken.mockReset().mockResolvedValue('runtime-token')
    login.token = 'vercel-cli-token'
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(config, { recursive: true, force: true })
  })

  it('uses Trusted Sources for hosted discovery and authenticated calls without bypass credentials', async () => {
    vi.stubEnv('VERCEL', '1')
    const token = await personToken()
    const board = testBoard()
    const sent: Headers[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(new URL(request.url).host).toBe(HOST)
      sent.push(request.headers)
      expect(request.headers.get('x-vercel-trusted-oidc-idp-token')).toBe(token)
      expect(request.headers.has('x-vercel-protection-bypass')).toBe(false)
      // Vercel's edge consumes the native header; app auth still needs Authorization.
      request.headers.delete('x-vercel-trusted-oidc-idp-token')
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const client = handle({ url: BOARD_URL, token, fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    await client.post('dev', 'native trust')
    expect(sent[1]!.get('authorization')).toBe(`Bearer ${token}`)
    expect(runtimeToken).not.toHaveBeenCalled()
  })

  it.each(['option', 'callback', 'environment'] as const)('uses the explicit %s token for hosted discovery even when runtime OIDC fails', async (source) => {
    vi.stubEnv('VERCEL', '1')
    runtimeToken.mockRejectedValue(new Error('runtime OIDC is unavailable'))
    const token = await personToken()
    if (source === 'environment') vi.stubEnv('BOARD_TOKEN', token)
    else vi.stubEnv('BOARD_TOKEN', 'lower-precedence-token')
    const board = testBoard()
    const sent: Headers[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push(request.headers)
      expect(request.headers.get('x-vercel-trusted-oidc-idp-token')).toBe(token)
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const supplied = source === 'option' ? token : source === 'callback' ? async () => token : undefined
    const client = handle({ url: BOARD_URL, token: supplied, fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    await client.post('dev', 'explicit credentials')
    expect(sent[1]!.get('authorization')).toBe(`Bearer ${token}`)
    expect(runtimeToken).not.toHaveBeenCalled()
  })

  it('mints an audience-bound edge token for hosted discovery when no token was supplied', async () => {
    vi.stubEnv('VERCEL', '1')
    const board = testBoard()
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.headers.get('x-vercel-trusted-oidc-idp-token')).toBe('runtime-token')
      return board.fetch(request)
    }) as typeof globalThis.fetch
    expect((await handle({ url: BOARD_URL, fetch }).discovery()).url).toBe(BOARD_URL)
    expect(runtimeToken).toHaveBeenCalledWith({ audience: BOARD_URL })
  })

  it('explains how to configure hosted OIDC when minting fails without leaking the error', async () => {
    vi.stubEnv('VERCEL', '1')
    runtimeToken.mockRejectedValue(new Error('private runtime details'))
    const fetch = vi.fn()
    await expect(handle({ url: BOARD_URL, fetch }).discovery()).rejects.toMatchObject({
      code: 'no_token',
      message: expect.not.stringContaining('private runtime details'),
      hint: expect.stringContaining('Enable OIDC'),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends a board token to the board, and this deployment's OIDC token to the edge", async () => {
    vi.stubEnv('VERCEL', '1')
    const board = testBoard()
    const { secret } = (await caller(board.fetch, await personToken())('POST', '/tokens', { name: 'agent', can: { 'dev/': ['read', 'post'] } })).body
    const sent: Headers[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push(new Headers(request.headers))
      // Vercel's edge consumes the native header.
      request.headers.delete('x-vercel-trusted-oidc-idp-token')
      return board.fetch(request)
    }) as typeof globalThis.fetch
    await handle({ url: BOARD_URL, token: secret, fetch }).post('dev', 'from the agent')
    expect(sent.at(-1)!.get('authorization')).toBe(`Bearer ${secret}`)
    expect(sent.at(-1)!.get('x-vercel-trusted-oidc-idp-token')).toBe('runtime-token')
  })

  it('sends a board token without an edge token where this deployment has no OIDC, and says so when the edge wants one', async () => {
    vi.stubEnv('VERCEL', '1')
    runtimeToken.mockRejectedValue(new Error('OIDC is off'))
    const board = testBoard()
    const { secret } = (await caller(board.fetch, await personToken())('POST', '/tokens', { name: 'agent', can: { 'dev/': ['read', 'post'] } })).body
    const sent: Headers[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push(new Headers(request.headers))
      return board.fetch(request)
    }) as typeof globalThis.fetch
    await handle({ url: BOARD_URL, token: secret, fetch }).post('dev', 'no protection here')
    expect(sent.some((headers) => headers.has('x-vercel-trusted-oidc-idp-token'))).toBe(false)
    const { fetch: guarded } = protectedBoard()
    await expect(handle({ url: BOARD_URL, token: secret, fetch: guarded }).discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining('has no Vercel OIDC token'),
      hint: expect.stringContaining('Enable OIDC'),
    })
  })

  it('fails hosted trust with setup guidance instead of reading or creating a bypass', async () => {
    vi.stubEnv('VERCEL', '1')
    const { fetch, api } = protectedBoard()
    await expect(handle({ url: BOARD_URL, token: await personToken(), fetch }).discovery())
      .rejects.toMatchObject({ code: 'protected', hint: expect.stringContaining('Trusted Sources') })
    expect(api).toEqual([])
  })

  it.each(OWN_HOSTS)('still sends hosted VERCEL_AUTOMATION_BYPASS_SECRET to its own host, from %s', async (own) => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', SECRET)
    // Hosts compare without case.
    vi.stubEnv(own, HOST.toUpperCase())
    runtimeToken.mockRejectedValue(new Error('runtime OIDC is unavailable'))
    const { fetch, api, sent } = protectedBoard()
    const client = handle({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    await client.post('dev', 'hosted with a bypass')
    expect(sent.every((header) => header === SECRET)).toBe(true)
    expect(api).toEqual([])
    expect(runtimeToken).not.toHaveBeenCalled()
  })

  it('never sends hosted VERCEL_AUTOMATION_BYPASS_SECRET to a host that is not its own', async () => {
    // Vercel sets it to the deployment's own project's secret: another project's board would
    // get a key to this one's protection, and it wouldn't open the board's anyway.
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'the-callers-own-secret')
    vi.stubEnv('VERCEL_URL', 'caller-abc123.vercel.app')
    vi.stubEnv('VERCEL_BRANCH_URL', 'caller-git-main.vercel.app')
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'caller.example')
    const token = await personToken()
    const board = testBoard()
    const sent: Headers[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push(new Headers(request.headers))
      if (!request.headers.has('x-vercel-trusted-oidc-idp-token'))
        return new Response('Protected by Vercel Authentication', {
          status: 302,
          headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(request.url)}` },
        })
      request.headers.delete('x-vercel-trusted-oidc-idp-token')
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const client = handle({ url: BOARD_URL, token, handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    const root = await client.post('dev', 'from another project')
    await client.thread(root.id)
    expect(sent.map((headers) => headers.get('x-vercel-protection-bypass'))).toEqual([null, null, null])
    expect(sent.map((headers) => headers.get('x-vercel-trusted-oidc-idp-token'))).toEqual([token, token, token])
  })

  it('falls back to OIDC when its own host rejects hosted VERCEL_AUTOMATION_BYPASS_SECRET', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'a-stale-secret')
    vi.stubEnv('VERCEL_URL', HOST)
    const board = testBoard()
    const tried: string[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const trusted = request.headers.get('x-vercel-trusted-oidc-idp-token')
      tried.push(request.headers.has('x-vercel-protection-bypass') ? 'bypass' : trusted ? 'oidc' : 'none')
      if (!trusted)
        return new Response('Protected by Vercel Authentication', {
          status: 302,
          headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(request.url)}` },
        })
      request.headers.delete('x-vercel-trusted-oidc-idp-token')
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const client = handle({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    await client.post('dev', 'past a stale secret')
    // Once rejected, the secret isn't sent again.
    expect(tried).toEqual(['bypass', 'oidc', 'oidc'])
  })

  it('keeps local person credentials out of the Trusted Sources header', async () => {
    const token = await personToken()
    const board = testBoard()
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.headers.has('x-vercel-trusted-oidc-idp-token')).toBe(false)
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const client = handle({ url: BOARD_URL, token, fetch })
    await client.discovery()
    await client.post('dev', 'local person')
    expect(runtimeToken).not.toHaveBeenCalled()
  })

  it('strips both OIDC headers on cross-origin redirects', async () => {
    vi.stubEnv('VERCEL', '1')
    let calls = 0
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (calls++ === 0) {
        expect(request.headers.get('authorization')).toBe('Bearer runtime-token')
        expect(request.headers.get('x-vercel-trusted-oidc-idp-token')).toBe('runtime-token')
        return new Response(null, { status: 302, headers: { location: 'https://other.test/board' } })
      }
      expect(request.headers.has('authorization')).toBe(false)
      expect(request.headers.has('x-vercel-trusted-oidc-idp-token')).toBe(false)
      expect(request.headers.has('x-vercel-protection-bypass')).toBe(false)
      return Response.json({ url: BOARD_URL })
    }) as typeof globalThis.fetch
    await handle({ url: BOARD_URL, token: 'runtime-token', fetch }).me()
    expect(calls).toBe(2)
  })

  it("gets through with the project's automation bypass, read with your Vercel login, and caches it", async () => {
    const { fetch, api, sent } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = handle({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    const root = await client.post('dev', 'through the wall')
    expect((await client.thread(root.id)).message.text).toBe('through the wall')
    expect(api).toEqual([
      `GET /v13/deployments/${HOST}`,
      `GET /now/aliases/${HOST}`,
      'GET /v2/teams?limit=100',
      `GET /v13/deployments/${HOST}?teamId=team_other`,
      `GET /v13/deployments/${HOST}?teamId=team_board`,
      'GET /v9/projects/prj_board?teamId=team_board',
    ])
    expect(sent.slice(1).every((header) => header === SECRET)).toBe(true)

    // A new process sends the cached secret from the start, without asking Vercel.
    api.length = 0
    sent.length = 0
    login.token = null
    const again = handle({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await again.discovery()).url).toBe(BOARD_URL)
    expect(api).toEqual([])
    expect(sent).toEqual([SECRET])
  })

  it("reads the bypass through the app's fetch with a handed login, which adds the login's credentials, never its own", async () => {
    const { fetch, api, sent } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    // A login no request takes as a Bearer token, as a DPoP one: only the app can sign with it.
    handLogin(async () => 'key-bound-token')
    const signed: string[] = []
    const unsigned = vi.fn()
    handFetch(async (input, init) => {
      const request = new Request(input, init)
      if (request.headers.has('authorization')) unsigned(request.url)
      signed.push(`${request.method} ${new URL(request.url).pathname}`)
      request.headers.set('authorization', 'Bearer vercel-cli-token')
      return fetch(request)
    })
    try {
      const client = handle({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
      expect((await client.discovery()).url).toBe(BOARD_URL)
      expect(signed).toContain('GET /v9/projects/prj_board')
      expect(api).toContain('GET /v9/projects/prj_board?teamId=team_board')
      expect(unsigned).not.toHaveBeenCalled()
      expect(sent.slice(1).every((header) => header === SECRET)).toBe(true)
    } finally {
      handLogin(null)
      handFetch(null)
    }
  })

  it('creates the automation bypass when the project has none, and says so', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api } = protectedBoard()
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('PATCH /v1/projects/prj_board/protection-bypass?teamId=team_board')
    expect(stderr).toHaveBeenCalledWith('created a Protection Bypass for Automation on the Vercel project board\n')
  })

  it("gets through Vercel Connect passport's 401 with the project's bypass, creating it when there's none", async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api, sent } = protectedBoard({ passport: true })
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('PATCH /v1/projects/prj_board/protection-bypass?teamId=team_board')
    expect(sent).toEqual([null, SECRET])
    expect(stderr).toHaveBeenCalledWith('created a Protection Bypass for Automation on the Vercel project board\n')
  })

  it('looks the secret up again when the cached one is stale', async () => {
    const { fetch } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    await handle({ url: BOARD_URL, token: await personToken(), fetch }).discovery()
    const [file] = await readdir(join(config, 'board', 'bypass'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(config, 'board', 'bypass', file!), JSON.stringify({ host: HOST, secret: 'revoked' }))
    const { fetch: again, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    expect((await handle({ url: BOARD_URL, token: await personToken(), fetch: again }).discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('GET /v9/projects/prj_board?teamId=team_board')
  })

  it("says so when your Vercel login can't see the project", async () => {
    login.token = 'someone-else'
    vi.stubEnv('PATH', '')
    const { fetch } = protectedBoard()
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: `${BOARD_URL} is behind Vercel Deployment Protection, and your Vercel login can't see its project.`,
      hint: expect.stringContaining('VERCEL_AUTOMATION_BYPASS_SECRET'),
    })
  })

  it('asks Vercel for the bypass again after a lookup failed', async () => {
    login.token = 'someone-else'
    vi.stubEnv('PATH', '')
    const { fetch } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({ code: 'protected' })
    login.token = 'vercel-cli-token'
    expect((await client.discovery()).url).toBe(BOARD_URL)
  })

  it("says so when your Vercel login can't create the bypass", async () => {
    const { fetch } = protectedBoard({ canCreate: false })
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining("can't read or create its project's automation bypass"),
    })
  })

  it("doesn't create a bypass on an unprotected project that answers with a web page", async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api } = protectedBoard({ page: true })
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'no_board',
      message: `There's no board at ${BOARD_URL}: it answered with a web page, and its Vercel project isn't protected.`,
    })
    expect(api.some((call) => call.startsWith('PATCH'))).toBe(false)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("doesn't create a second bypass when it can't read the project's settings", async () => {
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } }, canRead: false })
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining("can't read its project's settings"),
    })
    expect(api.some((call) => call.startsWith('PATCH'))).toBe(false)
  })

  it('uses VERCEL_AUTOMATION_BYPASS_SECRET when set, without asking Vercel', async () => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'wrong')
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = handle({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining('rejected VERCEL_AUTOMATION_BYPASS_SECRET'),
    })
    expect(api).toEqual([])
  })
})
