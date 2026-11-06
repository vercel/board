// What every test of a board needs whatever its version: the test project, the test issuers'
// keys, tokens they sign, and a caller. It imports nothing of board's, so a test of another
// release (the factory's pinned one) uses it too.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'

export const BOARD_URL = 'http://board.test/api/board'
export const PROJECT_ID = 'prj_board'
export const TEAM_ID = 'team_test'
export const VERCEL_ISS = 'https://oidc.vercel.com/test'
export const GITHUB_ISS = 'https://token.actions.githubusercontent.com'
/** Some other OIDC issuer, for `oidc()`. */
export const OIDC_ISS = 'https://gitlab.test'

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }
const jwks = createLocalJWKSet({ keys: [jwk] })
/** The test issuers' public keys, as an issuer's `jwks_uri` serves them. */
export const testKeys = { keys: [jwk] }

/** The test issuers, to combine with other auth options. */
export const testAuth = {
  vercel: { issuer: VERCEL_ISS, jwks },
  github: { issuer: GITHUB_ISS, jwks },
  oidc: { [OIDC_ISS]: jwks },
}

async function sign(claims: Record<string, unknown>, issuer: string, audience = BOARD_URL) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

/** A local board's own issuer, as `vb serve` keeps one: the tokens it signs are its local user's. */
export const LOCAL_ISS = 'http://local.board.test'
export const testLocal = { issuer: LOCAL_ISS, jwks }

/** The board's local user, its owner, as `vb serve` mints a token for it. */
export const localUserToken = (handle = 'julian', audience?: string) => sign({ sub: handle }, LOCAL_ISS, audience)

/** A person: a development token for the board's own project. */
export const personToken = (userId = 'u_julian', audience?: string) =>
  sign(
    {
      sub: `owner:test:project:board:environment:development`,
      owner: 'test',
      owner_id: TEAM_ID,
      project: 'board',
      project_id: PROJECT_ID,
      environment: 'development',
      user_id: userId,
    },
    VERCEL_ISS,
    audience,
  )

/** A deployment of some Vercel project. */
export const deploymentToken = (
  project = 'marketing',
  projectId = 'prj_marketing',
  environment = 'production',
  options: { teamId?: string; audience?: string } = {},
) =>
  sign(
    {
      sub: `owner:test:project:${project}:environment:${environment}`,
      owner: 'test',
      owner_id: options.teamId ?? TEAM_ID,
      project,
      project_id: projectId,
      environment,
    },
    VERCEL_ISS,
    options.audience,
  )

/** A GitHub Actions run. */
export const workflowToken = (claims: Record<string, unknown> = {}) =>
  sign(
    {
      repository: 'acme/web',
      repository_id: '123456',
      event_name: 'push',
      ref: 'refs/heads/main',
      workflow_ref: 'acme/web/.github/workflows/deploy.yml@refs/heads/main',
      ...claims,
    },
    GITHUB_ISS,
  )

/** A token from another OIDC issuer, GitLab's shape by default. */
export const oidcToken = (claims: Record<string, unknown> = {}, issuer = OIDC_ISS) =>
  sign({ sub: 'project_path:acme/api:ref_type:branch:ref:main', project_path: 'acme/api', ref: 'main', ...claims }, issuer)

/**
 * A config home where Julian is signed in to each board in `audiences`, as `vercel login` leaves
 * it: a token cached for each, so the Node client mints none. Pass it as `XDG_CONFIG_HOME`.
 */
export async function signedInHome(audiences: string[], userId = 'u_julian') {
  const home = await mkdtemp(join(tmpdir(), 'board-tokens-'))
  await mkdir(join(home, 'board', 'tokens'), { recursive: true })
  for (const audience of audiences) {
    const token = await personToken(userId, audience)
    const file = join(home, 'board', 'tokens', `${createHash('sha256').update(audience).digest('hex').slice(0, 32)}.json`)
    await writeFile(file, JSON.stringify({ token, expiresAt: Date.now() + 3_600_000, handle: 'julian', name: 'Julian', avatar: null }))
  }
  return home
}

/** Calls the board in-process, like a client would over HTTP. */
export function caller(handler: (request: Request) => Promise<Response>, token: string, headers: Record<string, string> = {}) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await handler(
      new Request(`${BOARD_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
}

/**
 * A deployment's own fetch, as `http(url, { fetch })` takes it: `fetch`, with a bearer token on
 * each request that brings none.
 */
export function bearer(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  token: string | (() => string | Promise<string>),
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${typeof token === 'function' ? await token() : token}`)
    return fetch(input, { ...init, headers })
  }) as typeof globalThis.fetch
}
