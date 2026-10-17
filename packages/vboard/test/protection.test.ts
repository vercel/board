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

const { createClient } = await import('../src/client/node.ts')
const { BOARD_URL, personToken, testBoard } = await import('./harness.ts')

const HOST = new URL(BOARD_URL).host
const SECRET = 'automation-bypass-secret'

/**
 * A board behind Vercel Authentication (a 302 to vercel.com/sso-api without the
 * secret), and the slice of the Vercel API `vercel curl` uses to get through:
 * the host is a deployment in one of your teams, not your own scope.
 */
function protectedBoard(
  options: { bypass?: Record<string, { scope: string }>; canCreate?: boolean; canRead?: boolean; page?: boolean } = {},
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
        const sso = options.page ? null : { deploymentType: 'all_except_custom_domains' }
        return Response.json({ id: 'prj_board', name: 'board', protectionBypass: bypass, ssoProtection: sso, passwordProtection: null })
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
    config = await mkdtemp(join(tmpdir(), 'vboard-protection-'))
    vi.stubEnv('XDG_CONFIG_HOME', config)
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VBOARD_TOKEN', '')
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
    const client = createClient({ url: BOARD_URL, token, fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    await client.post('dev', 'native trust')
    expect(sent[1]!.get('authorization')).toBe(`Bearer ${token}`)
    expect(runtimeToken).not.toHaveBeenCalled()
  })

  it.each(['option', 'callback', 'environment'] as const)('uses the explicit %s token for hosted discovery even when runtime OIDC fails', async (source) => {
    vi.stubEnv('VERCEL', '1')
    runtimeToken.mockRejectedValue(new Error('runtime OIDC is unavailable'))
    const token = await personToken()
    if (source === 'environment') vi.stubEnv('VBOARD_TOKEN', token)
    else vi.stubEnv('VBOARD_TOKEN', 'lower-precedence-token')
    const board = testBoard()
    const sent: Headers[] = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      sent.push(request.headers)
      expect(request.headers.get('x-vercel-trusted-oidc-idp-token')).toBe(token)
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const supplied = source === 'option' ? token : source === 'callback' ? async () => token : undefined
    const client = createClient({ url: BOARD_URL, token: supplied, fetch })
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
    expect((await createClient({ url: BOARD_URL, fetch }).discovery()).url).toBe(BOARD_URL)
    expect(runtimeToken).toHaveBeenCalledWith({ audience: BOARD_URL })
  })

  it('explains how to configure hosted OIDC when minting fails without leaking the error', async () => {
    vi.stubEnv('VERCEL', '1')
    runtimeToken.mockRejectedValue(new Error('private runtime details'))
    const fetch = vi.fn()
    await expect(createClient({ url: BOARD_URL, fetch }).discovery()).rejects.toMatchObject({
      code: 'no_token',
      message: expect.stringContaining('enable OIDC'),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails hosted trust with setup guidance instead of reading or creating a bypass', async () => {
    vi.stubEnv('VERCEL', '1')
    const { fetch, api } = protectedBoard()
    await expect(createClient({ url: BOARD_URL, token: await personToken(), fetch }).discovery())
      .rejects.toMatchObject({ code: 'protected', message: expect.stringContaining('Trusted Sources') })
    expect(api).toEqual([])
  })

  it('still sends VERCEL_AUTOMATION_BYPASS_SECRET when hosted callers set it', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', SECRET)
    runtimeToken.mockRejectedValue(new Error('runtime OIDC is unavailable'))
    const { fetch, api, sent } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    await client.post('dev', 'hosted with a bypass')
    expect(sent.every((header) => header === SECRET)).toBe(true)
    expect(api).toEqual([])
    expect(runtimeToken).not.toHaveBeenCalled()
  })

  it('keeps local person credentials out of the Trusted Sources header', async () => {
    const token = await personToken()
    const board = testBoard()
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.headers.has('x-vercel-trusted-oidc-idp-token')).toBe(false)
      return board.fetch(request)
    }) as typeof globalThis.fetch
    const client = createClient({ url: BOARD_URL, token, fetch })
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
    await createClient({ url: BOARD_URL, token: 'runtime-token', fetch }).me()
    expect(calls).toBe(2)
  })

  it("gets through with the project's automation bypass, read with your Vercel login, and caches it", async () => {
    const { fetch, api, sent } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
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
    const again = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await again.discovery()).url).toBe(BOARD_URL)
    expect(api).toEqual([])
    expect(sent).toEqual([SECRET])
  })

  it('creates the automation bypass when the project has none, and says so', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('PATCH /v1/projects/prj_board/protection-bypass?teamId=team_board')
    expect(stderr).toHaveBeenCalledWith('created a Protection Bypass for Automation on the Vercel project board\n')
  })

  it('looks the secret up again when the cached one is stale', async () => {
    const { fetch } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    await createClient({ url: BOARD_URL, token: await personToken(), fetch }).discovery()
    const [file] = await readdir(join(config, 'vboard', 'bypass'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(config, 'vboard', 'bypass', file!), JSON.stringify({ host: HOST, secret: 'revoked' }))
    const { fetch: again, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    expect((await createClient({ url: BOARD_URL, token: await personToken(), fetch: again }).discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('GET /v9/projects/prj_board?teamId=team_board')
  })

  it("says so when your Vercel login can't see the project", async () => {
    login.token = 'someone-else'
    vi.stubEnv('PATH', '')
    const { fetch } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: `${BOARD_URL} is behind Vercel Deployment Protection, and your Vercel login can't see its project: run \`vercel login\` or ask for access, or set VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment Protection → Protection Bypass for Automation)`,
    })
  })

  it("says so when your Vercel login can't create the bypass", async () => {
    const { fetch } = protectedBoard({ canCreate: false })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining("can't read or create its project's automation bypass"),
    })
  })

  it("doesn't create a bypass on an unprotected project that answers with a web page", async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api } = protectedBoard({ page: true })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'no_board',
      message: `no board at ${BOARD_URL}: it answered with a web page, and its Vercel project isn't protected`,
    })
    expect(api.some((call) => call.startsWith('PATCH'))).toBe(false)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("doesn't create a second bypass when it can't read the project's settings", async () => {
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } }, canRead: false })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining("can't read its project's settings"),
    })
    expect(api.some((call) => call.startsWith('PATCH'))).toBe(false)
  })

  it('uses VERCEL_AUTOMATION_BYPASS_SECRET when set, without asking Vercel', async () => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'wrong')
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining('rejected VERCEL_AUTOMATION_BYPASS_SECRET'),
    })
    expect(api).toEqual([])
  })
})
