import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import { compileAccess, FULL_ACCESS, parseScope, type Access, type Can } from './access.ts'
import { unauthorized, forbidden } from './errors.ts'

/** `external`: a platform user writing through sync (`slack:user:U0456`). A local board's people are `local:user:<name>`. */
export type PrincipalKind = 'person' | 'deployment' | 'workflow' | 'external'

export type Principal = {
  /** `vercel:user:<id>`, `vercel:project:<id>:<env>`, `github:repo:<id>`, `oidc:<issuer>:<sub>`. */
  id: string
  kind: PrincipalKind
  /** The default handle; a person's is replaced by the handle their CLI sends. */
  handle: string
  /** What it may do in each channel, narrowed by `x-board-scope` when a proxy sent one. */
  access: Access
  expiresAt: Date | null
  /** The verified token's claims, so its access can be worked out again later, as a schedule's sends do. Absent for people and the board's own code. */
  facts?: TokenFacts
  /** The `x-board-scope` it was narrowed by. */
  scope?: string
}

type Claims = JWTPayload & Record<string, unknown>

/** What a verified token said: its issuer and its claims, never the token itself. */
export type TokenFacts = {
  issuer: 'vercel' | 'github' | 'oidc'
  iss: string
  claims: Readonly<Record<string, string | number | boolean>>
}

const REGISTERED = new Set(['aud', 'exp', 'iat', 'nbf', 'jti'])

/** The claims rules can match on: plain values, bounded, as a schedule stores them. */
function factsOf(issuer: TokenFacts['issuer'], iss: string, claims: Claims): TokenFacts {
  const kept: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(claims)) {
    if (REGISTERED.has(name) || Object.keys(kept).length >= 64) continue
    if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 1000)) kept[name] = value
  }
  return { issuer, iss, claims: kept }
}

/** What a rule may compare claims to: the board's own Vercel team and project, when they're known. */
export type MatchContext = { teamId: string | null; projectId: string | null }

/** One entry in `board({ access })`: who it matches, and what they may do. The first entry that matches decides. */
export type AccessRule = {
  /** `vercel` and `github` are their platforms' issuers; `oidc` is the exact `url`. */
  issuer: 'vercel' | 'github' | 'oidc'
  /** For `oidc`: the issuer URL, pinned in code. */
  url?: string
  matches(claims: Claims, context: MatchContext): boolean
  access: Access
}

const oneOf = (value: unknown, allowed: string | readonly string[] | undefined) =>
  allowed === undefined ||
  (typeof value === 'string' && (typeof allowed === 'string' ? [allowed] : allowed).includes(value))

/**
 * A Vercel project's deployments, by name or ID. A name is only unique within
 * a team, so without `team` it means the board's own team, and matches nothing
 * when that isn't known. An ID is unique on Vercel, so it matches on any team.
 * `'self'` is the board's own project: its deployments in the environment the
 * board runs in have full access unless a rule says otherwise, and its other
 * environments have none unless one lists them. Its development tokens are
 * people, which no rule changes.
 */
export function vercelProject(options: {
  project: string
  team?: string
  environments?: readonly string[]
  can: Can
}): AccessRule {
  if (options.project === 'self' && options.team !== undefined)
    throw new Error("vercelProject({ project: 'self' }) is the board's own project: drop team")
  return {
    issuer: 'vercel',
    access: compileAccess(options.can),
    matches: (claims, { teamId, projectId }) =>
      (options.project === 'self'
        ? projectId !== null && claims.project_id === projectId
        : claims.project_id === options.project ||
          (claims.project === options.project &&
            (options.team === undefined
              ? teamId !== null && claims.owner_id === teamId
              : claims.owner === options.team || claims.owner_id === options.team))) &&
      oneOf(claims.environment, options.environments),
  }
}

/**
 * A GitHub Actions workflow. A `pull_request` run's token carries
 * `ref: refs/pull/<n>/merge`, so match those on `event` and `workflow`, not `ref`.
 */
export function githubActions(options: {
  repository: string
  event?: string | readonly string[]
  workflow?: string
  ref?: string
  can: Can
}): AccessRule {
  return {
    issuer: 'github',
    access: compileAccess(options.can),
    matches: (claims) =>
      claims.repository === options.repository &&
      oneOf(claims.event_name, options.event) &&
      (options.ref === undefined || claims.ref === options.ref) &&
      (options.workflow === undefined ||
        (typeof claims.workflow_ref === 'string' &&
          claims.workflow_ref.startsWith(`${options.repository}/${options.workflow}@`))),
  }
}

/**
 * Any OIDC issuer's tokens: GitLab, Buildkite, a cloud's workload identity.
 * The issuer is pinned here, and only issuers some rule names are trusted or
 * have their keys fetched. Every listed claim must match exactly (a list is
 * any of its values), and there must be at least one, since an issuer signs
 * tokens for everyone it serves. The principal is `oidc:<issuer host and path>:<sub>`.
 */
export function oidc(options: {
  issuer: string
  claims: Readonly<Record<string, string | readonly string[]>>
  can: Can
}): AccessRule {
  let url: URL
  try {
    url = new URL(options.issuer)
  } catch {
    throw new Error(`oidc: issuer must be a URL, got ${options.issuer}`)
  }
  if (url.protocol !== 'https:' || url.search || url.hash)
    throw new Error(`oidc: issuer must be an https URL with no query, got ${options.issuer}`)
  if (VERCEL_ISSUER.test(options.issuer)) throw new Error('oidc: use vercelProject() for Vercel tokens')
  if (options.issuer === GITHUB_ISSUER) throw new Error('oidc: use githubActions() for GitHub Actions tokens')
  const required = Object.entries(options.claims)
  if (required.length === 0) throw new Error(`oidc: name at least one claim to match for ${options.issuer}`)
  return {
    issuer: 'oidc',
    url: options.issuer,
    access: compileAccess(options.can),
    matches: (claims) => required.every(([name, allowed]) => oneOf(claims[name], allowed)),
  }
}

export type IssuerConfig = {
  /** Accepted `iss` values. */
  issuer: string | RegExp
  /** Key source; defaults to the issuer's published JWKS. */
  jwks?: JWTVerifyGetKey
}

/** Tests point these at a local issuer; production uses the defaults. */
export type AuthOptions = {
  vercel?: IssuerConfig
  github?: IssuerConfig
  /** Keys for `oidc()` issuers, by issuer URL, instead of their published JWKS. It trusts no issuer by itself. */
  oidc?: Readonly<Record<string, JWTVerifyGetKey>>
  /**
   * A local board's own issuer (`vb serve`): its tokens' `sub` is a person on
   * this machine, `local:user:<sub>`, with full access. Its keys are never
   * fetched, so `jwks` is required.
   */
  local?: { issuer: string; jwks: JWTVerifyGetKey }
}

const VERCEL_ISSUER = /^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9-]+)?$/
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

const issuerMatches = (iss: string, accepted: string | RegExp) =>
  typeof accepted === 'string' ? iss === accepted : accepted.test(iss)

const remoteKeys = new Map<string, JWTVerifyGetKey>()

async function keysFor(iss: string): Promise<JWTVerifyGetKey> {
  const cached = remoteKeys.get(iss)
  if (cached) return cached
  const response = await fetch(`${iss.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (!response.ok) throw unauthorized(`cannot load keys for issuer ${iss}`)
  const { jwks_uri } = (await response.json()) as { jwks_uri: string }
  const keys = createRemoteJWKSet(new URL(jwks_uri))
  remoteKeys.set(iss, keys)
  return keys
}

/** `gitlab.com`, `example.com/oidc`: an issuer as a principal names it. */
const issuerName = (iss: string) => {
  const url = new URL(iss)
  return `${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export function createVerifier(options: {
  projectId: () => Promise<string | null>
  /** The board's team from config or the environment; the platform's token is the fallback. */
  teamId: () => Promise<string | null>
  access: readonly AccessRule[]
  auth?: AuthOptions
}) {
  const vercelIssuer = options.auth?.vercel ?? { issuer: VERCEL_ISSUER }
  const githubIssuer = options.auth?.github ?? { issuer: GITHUB_ISSUER }
  // The only issuers past Vercel's and GitHub's whose tokens are verified, or whose keys are fetched.
  const oidcIssuers = new Set(options.access.flatMap((rule) => (rule.issuer === 'oidc' ? [rule.url!] : [])))

  const ruleFor = (issuer: AccessRule['issuer'], claims: Claims, context: MatchContext, url?: string): Access | null =>
    options.access.find(
      (rule) => rule.issuer === issuer && (url === undefined || rule.url === url) && rule.matches(claims, context),
    )?.access ?? null

  let platformTeam: string | null = null
  /**
   * The team on a Vercel-signed token for the board's own project. Project IDs
   * are unique, so its `owner_id` is the board's team, whoever sent the token.
   */
  async function teamFrom(platformToken: string | undefined, ownProject: string | null) {
    if (platformTeam !== null || !platformToken || ownProject === null) return platformTeam
    try {
      const iss = String(decodeJwt(platformToken).iss ?? '')
      if (!issuerMatches(iss, vercelIssuer.issuer)) return null
      const keys = vercelIssuer.jwks ?? (await keysFor(iss))
      const { payload } = await jwtVerify(platformToken, keys, { issuer: iss })
      if (payload.project_id === ownProject && typeof payload.owner_id === 'string') platformTeam = payload.owner_id
    } catch {}
    return platformTeam
  }

  /** `platformToken`: the board's own OIDC token, which Vercel sends with each request. */
  async function verify(token: string, audience: string, platformToken?: string): Promise<Principal> {
    let iss: string
    try {
      iss = String(decodeJwt(token).iss ?? '')
    } catch {
      throw unauthorized('malformed token')
    }

    const local = options.auth?.local
    if (local && iss === local.issuer) return localPerson(token, local, audience)

    const isVercel = issuerMatches(iss, vercelIssuer.issuer)
    const isGitHub = !isVercel && issuerMatches(iss, githubIssuer.issuer)
    const isOidc = !isVercel && !isGitHub && oidcIssuers.has(iss)
    if (!isVercel && !isGitHub && !isOidc) throw unauthorized(`untrusted issuer: ${iss || '(none)'}`)

    let claims: Claims
    try {
      const keys = isOidc
        ? (options.auth?.oidc?.[iss] ?? (await keysFor(iss)))
        : ((isVercel ? vercelIssuer : githubIssuer).jwks ?? (await keysFor(iss)))
      ;({ payload: claims } = (await jwtVerify(token, keys, { issuer: iss, audience })) as {
        payload: Claims
      })
    } catch (error) {
      if ((error as { status?: number }).status === 401) throw error
      throw unauthorized(`invalid token: ${(error as Error).message}`)
    }
    const facts = factsOf(isOidc ? 'oidc' : isGitHub ? 'github' : 'vercel', iss, claims)
    return principalOf(facts, claims.exp ? new Date(claims.exp * 1000) : null, platformToken)
  }

  /** Who verified claims are, and what the rules give them now: a 401 or 403 when they're not in access. */
  async function principalOf(facts: TokenFacts, expiresAt: Date | null, platformToken?: string): Promise<Principal> {
    const { issuer, iss } = facts
    const claims = facts.claims as Claims
    if (issuer === 'oidc') {
      if (!oidcIssuers.has(iss)) throw unauthorized(`untrusted issuer: ${iss}`)
      const access = ruleFor('oidc', claims, { teamId: null, projectId: null }, iss)
      if (!access) throw forbidden(`this token from ${iss} isn't in access`)
      if (typeof claims.sub !== 'string' || claims.sub === '') throw unauthorized(`token from ${iss} without sub`)
      return {
        id: `oidc:${issuerName(iss)}:${claims.sub}`,
        kind: 'workflow',
        handle: claims.sub.slice(0, 128),
        access,
        expiresAt,
        facts,
      }
    }

    if (issuer === 'github') {
      const access = ruleFor('github', claims, { teamId: null, projectId: null })
      if (!access) throw forbidden(`workflow isn't in access: ${String(claims.repository)}`)
      return {
        id: `github:repo:${String(claims.repository_id)}`,
        kind: 'workflow',
        handle: String(claims.repository),
        access,
        expiresAt,
        facts,
      }
    }

    const environment = String(claims.environment ?? '')
    const project = String(claims.project ?? '')
    const ownProject = (await options.projectId()) ?? null
    const own = ownProject !== null && claims.project_id === ownProject
    if (own && environment === 'development') {
      // A development token minted with someone's Vercel login carries their user ID.
      if (typeof claims.user_id !== 'string')
        throw unauthorized('development token without user_id')
      return {
        id: `vercel:user:${claims.user_id}`,
        kind: 'person',
        handle: `user-${claims.user_id.slice(0, 6).toLowerCase()}`,
        access: FULL_ACCESS,
        expiresAt,
      }
    }
    const teamId = options.access.some((rule) => rule.issuer === 'vercel')
      ? ((await options.teamId()) ?? (await teamFrom(platformToken ?? process.env.VERCEL_OIDC_TOKEN, ownProject)))
      : null
    const access = ruleFor('vercel', claims, { teamId, projectId: ownProject })
    if (access) return deployment(facts, project, environment, access, expiresAt)
    // A deployment in the board's own environment runs the board's code. A
    // preview runs any branch's, so a production board doesn't trust them.
    const here = boardEnvironment()
    if (own && here !== null && environment === here) return deployment(facts, project, environment, FULL_ACCESS, expiresAt)
    if (own)
      throw forbidden(
        `this board runs in ${here ?? 'no Vercel environment'}, so its project's ${environment || 'unnamed'} deployments need a rule: add vercelProject({ project: 'self', environments: ['${environment}'], can })`,
      )
    throw forbidden(`project isn't in access: ${project || String(claims.project_id)}`)
  }

  /**
   * What a principal may do under the rules as they are now, narrowed by its
   * scope: people, the board's own code, and the platform users sync writes as
   * everything, a token whatever the first rule matching its claims gives, and
   * null once none does.
   */
  async function accessNow(principal: Pick<Principal, 'id' | 'kind' | 'facts' | 'scope'>): Promise<Access | null> {
    let access: Access = FULL_ACCESS
    if (principal.kind !== 'person' && principal.kind !== 'external' && !principal.id.startsWith('vboard:')) {
      const facts = principal.facts ?? factsFromId(principal.id)
      if (!facts) return null
      try {
        access = (await principalOf(facts, null)).access
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status === 401 || status === 403) return null
        throw error
      }
    }
    return principal.scope === undefined ? access : access.narrow(parseScope(principal.scope))
  }

  return { verify, accessNow }
}

/**
 * The Vercel environment the board runs in: `production`, `preview`, or a
 * custom environment's name. `VERCEL_TARGET_ENV` names custom environments,
 * where `VERCEL_ENV` says `preview`. Null outside Vercel, where only people
 * get in without a rule.
 */
const boardEnvironment = (): string | null => process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV || null

/**
 * What a principal's ID still says, for one stored before the board kept
 * claims: a deployment's project ID and environment. A workflow's ID names
 * neither its repository nor its run, so it says nothing, and a rule that
 * needs more than the ID no longer matches.
 */
function factsFromId(id: string): TokenFacts | null {
  const deployment = id.match(/^vercel:project:([^:]+):([^:]+)$/)
  return deployment ? { issuer: 'vercel', iss: '', claims: { project_id: deployment[1]!, environment: deployment[2]! } } : null
}

const LOCAL_SUB = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

async function localPerson(token: string, local: NonNullable<AuthOptions['local']>, audience: string): Promise<Principal> {
  let claims: Claims
  try {
    ;({ payload: claims } = (await jwtVerify(token, local.jwks, { issuer: local.issuer, audience })) as { payload: Claims })
  } catch (error) {
    throw unauthorized(`invalid token: ${(error as Error).message}`)
  }
  const sub = String(claims.sub ?? '')
  if (!LOCAL_SUB.test(sub)) throw unauthorized('local token without a valid sub')
  return {
    id: `local:user:${sub}`,
    kind: 'person',
    handle: sub,
    access: FULL_ACCESS,
    expiresAt: claims.exp ? new Date(claims.exp * 1000) : null,
  }
}

const deployment = (
  facts: TokenFacts,
  project: string,
  environment: string,
  access: Access,
  expiresAt: Date | null,
): Principal => ({
  id: `vercel:project:${String(facts.claims.project_id)}:${environment}`,
  kind: 'deployment',
  handle: environment === 'production' ? project : `${project}@${environment}`,
  access,
  expiresAt,
  facts,
})
