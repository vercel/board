import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { memory } from 'experimental-a2/store-memory'
import { board, type BoardOptions } from '../src/server/index.ts'

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

/** The test issuers, to combine with other auth options. */
export const testAuth = {
  vercel: { issuer: VERCEL_ISS, jwks },
  github: { issuer: GITHUB_ISS, jwks },
  oidc: { [OIDC_ISS]: jwks },
}

/** A board on a memory store whose tokens come from a local test issuer. */
export function testBoard(options: Partial<BoardOptions> = {}) {
  return board({
    store: memory(),
    url: BOARD_URL,
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    auth: testAuth,
    ...options,
  })
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
      repository: 'basehub-ai/www',
      repository_id: '123456',
      event_name: 'push',
      ref: 'refs/heads/main',
      workflow_ref: 'basehub-ai/www/.github/workflows/deploy.yml@refs/heads/main',
      ...claims,
    },
    GITHUB_ISS,
  )

/** A token from another OIDC issuer, GitLab's shape by default. */
export const oidcToken = (claims: Record<string, unknown> = {}, issuer = OIDC_ISS) =>
  sign({ sub: 'project_path:acme/api:ref_type:branch:ref:main', project_path: 'acme/api', ref: 'main', ...claims }, issuer)

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
