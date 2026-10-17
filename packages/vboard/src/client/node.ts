import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decodeJwt } from 'jose'
import { exchangeVercelOidcToken, getVercelOidcToken, getVercelToken } from '@vercel/oidc'
import type { Discovery } from '../api/routes.ts'
import {
  BoardError,
  createBoardClient,
  type BoardClient,
  type ClientOptions,
  type ProfileOption,
} from './client.ts'

export const configDir = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'vboard')

/** The board saved by `vboard use <url>`. */
export function savedUrl(): string | undefined {
  try {
    const { url } = JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) as {
      url?: string
    }
    return url
  } catch {
    return undefined
  }
}

/**
 * A Git checkout's root: `.git` is a directory with a `HEAD`, or a worktree's
 * `gitdir:` file. A stray empty `.git` (say, in `~` or `/tmp`) isn't one.
 */
function isCheckout(directory: string): boolean {
  const git = join(directory, '.git')
  try {
    if (statSync(git).isDirectory()) return existsSync(join(git, 'HEAD'))
    return readFileSync(git, 'utf8').startsWith('gitdir:')
  } catch {
    return false
  }
}

export function projectDir(cwd = process.cwd()): string {
  let directory = resolve(cwd)
  while (true) {
    if (existsSync(join(directory, '.vboard', 'config.json')) || isCheckout(directory))
      return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(cwd)
    directory = parent
  }
}

export function projectUrl(): string | undefined {
  const path = join(projectDir(), '.vboard', 'config.json')
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const { url } = JSON.parse(contents)
    if (typeof url === 'string' && ['http:', 'https:'].includes(new URL(url).protocol)) return url
  } catch {}
  throw new BoardError('invalid_config', `invalid board link at ${path}: expected an http(s) url`, 0)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Where `vb serve` leaves the token for the board it runs at `url`: only this user can read it. */
export function localTokenFile(url: string): string {
  const normalized = url.replace(/\/+$/, '')
  return join(configDir(), 'local', `${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}.json`)
}

/** The token a local board on this machine left for you, if `url` is one. */
function localToken(url: string): { token: string; handle: string | null } | null {
  try {
    if (!LOOPBACK.has(new URL(url).hostname)) return null
    const saved = JSON.parse(readFileSync(localTokenFile(url), 'utf8')) as { url?: string; token?: string; handle?: string }
    if (saved.url !== url.replace(/\/+$/, '') || typeof saved.token !== 'string') return null
    return { token: saved.token, handle: saved.handle ?? null }
  } catch {
    return null
  }
}

export type DetectedAgent = { profile: string; session: string | null }

/** Claude Code, Codex, and Grok sessions select their own profile, like Just Chat's CLI. */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): DetectedAgent | null {
  const found: DetectedAgent[] = []
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_SESSION_ID)
    found.push({ profile: 'claude', session: env.CLAUDE_CODE_SESSION_ID || null })
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID)
    found.push({ profile: 'codex', session: env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null })
  if (env.GROK_SESSION_ID) found.push({ profile: 'grok', session: env.GROK_SESSION_ID })
  if (env.CURSOR_AGENT === '1') found.push({ profile: 'cursor', session: null })
  if (env.PI_CODING_AGENT === 'true' || env.AI_AGENT === 'pi') found.push({ profile: 'pi', session: env.PI_SESSION_ID || null })
  // AI_AGENT is a generic marker: any agent that sets it gets its own profile.
  const named = env.AI_AGENT?.trim().toLowerCase()
  if (named && /^[a-z][a-z0-9-]{0,31}$/.test(named) && !found.some((agent) => agent.profile === named))
    found.push({ profile: named, session: null })
  if (found.length > 1)
    throw new BoardError(
      'ambiguous_agent',
      `several agent environments detected (${found.map((a) => a.profile).join(', ')}): choose one with a profile, or none`,
      0,
    )
  return found[0] ?? null
}

const expiry = (token: string): number => {
  try {
    const { exp } = decodeJwt(token)
    return exp ? exp * 1000 : Date.now() + 5 * 60_000
  } catch {
    return Date.now() + 5 * 60_000
  }
}

type Cached = { token: string; expiresAt: number; handle?: string | null; name?: string | null; avatar?: string | null }

const cacheFile = (audience: string) =>
  join(configDir(), 'tokens', `${createHash('sha256').update(audience).digest('hex').slice(0, 32)}.json`)

async function readCache(audience: string): Promise<Cached | null> {
  try {
    const cached = JSON.parse(await readFile(cacheFile(audience), 'utf8')) as Cached
    return cached.expiresAt - 5 * 60_000 > Date.now() ? cached : null
  } catch {
    return null
  }
}

async function writeCache(audience: string, cached: Cached) {
  await mkdir(join(configDir(), 'tokens'), { recursive: true, mode: 0o700 })
  await writeFile(cacheFile(audience), JSON.stringify(cached), { mode: 0o600 })
}

/**
 * A person's token: their Vercel CLI login mints a development token for the
 * board's project, exchanged so its audience is the board's URL. Cached on
 * disk for its 12-hour life.
 */
async function personToken(audience: string, discovery: Discovery): Promise<Cached> {
  const cached = await readCache(audience)
  // Tokens cached before names and avatars were kept get them once.
  if (cached && cached.name === undefined) {
    const user = await getVercelToken()
      .then(vercelUser)
      .catch(() => null)
    const filled = { ...cached, name: user?.name ?? null, avatar: user?.avatar ?? null }
    await writeCache(audience, filled).catch(() => {})
    return filled
  }
  if (cached) return cached
  if (!discovery.project_id)
    throw new BoardError('no_project', `the board at ${discovery.url} doesn't know its Vercel project`, 0)

  let development: string
  let authToken: string | null = null
  try {
    authToken = await getVercelToken()
    const response = await fetch(
      `https://api.vercel.com/v1/projects/${discovery.project_id}/token?source=vboard${
        discovery.team_id ? `&teamId=${discovery.team_id}` : ''
      }`,
      { method: 'POST', headers: { authorization: `Bearer ${authToken}` } },
    )
    if (response.status === 403 || response.status === 404)
      throw new BoardError(
        'no_access',
        "your Vercel account can't access this board's project: ask for access to it",
        response.status,
      )
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    development = ((await response.json()) as { token: string }).token
  } catch (error) {
    if (error instanceof BoardError) throw error
    development = await tokenFromVercelCli(discovery)
  }

  const token = await exchangeVercelOidcToken({ token: development, audience })
  const user = authToken ? await vercelUser(authToken) : null
  const fresh: Cached = { token, expiresAt: expiry(token), handle: user?.handle ?? null, name: user?.name ?? null, avatar: user?.avatar ?? null }
  await writeCache(audience, fresh).catch(() => {})
  return fresh
}

/** When credentials live in the keychain, the Vercel CLI mints the token itself. */
async function tokenFromVercelCli(discovery: Discovery): Promise<string> {
  const args = ['project', 'token', discovery.project_id!, '--format=json']
  if (discovery.team_id) args.push('--scope', discovery.team_id)
  try {
    const { stdout } = await promisify(execFile)('vercel', args, { timeout: 30_000 })
    return (JSON.parse(stdout) as { token: string }).token
  } catch {
    throw new BoardError('not_logged_in', 'not signed in to Vercel: run `vercel login`', 0)
  }
}

/** Your Vercel username, display name, and avatar (Vercel serves avatars publicly). */
async function vercelUser(authToken: string): Promise<{ handle: string | null; name: string | null; avatar: string | null } | null> {
  try {
    const response = await fetch('https://api.vercel.com/v2/user', {
      headers: { authorization: `Bearer ${authToken}` },
    })
    if (!response.ok) return null
    const { user } = (await response.json()) as { user?: { username?: string; name?: string | null; avatar?: string | null } }
    return {
      handle: user?.username?.toLowerCase() ?? null,
      name: user?.name?.trim() || null,
      avatar: user?.avatar && /^[0-9a-f]+$/i.test(user.avatar) ? `https://vercel.com/api/www/avatar/${user.avatar}?s=128` : null,
    }
  } catch {
    return null
  }
}

async function githubActionsToken(audience: string): Promise<string> {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!)
  url.searchParams.set('audience', audience)
  const response = await fetch(url, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  })
  if (!response.ok)
    throw new BoardError(
      'no_token',
      `GitHub Actions refused an OIDC token (${response.status}): does the job have \`permissions: id-token: write\`?`,
      0,
    )
  return ((await response.json()) as { value: string }).value
}

export type NodeClientOptions = Partial<ClientOptions>

/**
 * A client with Node defaults: the URL from `VBOARD_URL`, the project link,
 * or the saved board, and a token from `VBOARD_TOKEN`, a local board's token file
 * (`vb serve`), GitHub Actions, the Vercel runtime, or your Vercel CLI login, in that order.
 */
export function createClient(options: NodeClientOptions = {}): BoardClient {
  const url = (options.url ?? process.env.VBOARD_URL ?? projectUrl() ?? savedUrl())?.replace(/\/+$/, '')
  if (!url)
    throw new BoardError('no_board', 'no board URL: run `vboard link <url>`, set VBOARD_URL, run `vboard use <url>`, or `vboard serve` for a local one', 0)
  const doFetch = guarded(url, options.fetch ?? globalThis.fetch, options.token)

  // Every token is for `url`, the board it's sent to. A board whose discovery claims
  // another audience gets none, so its answer can't get us to mint one it could replay.
  let discovery: Promise<Discovery> | undefined
  const discover = () =>
    (discovery ??= doFetch(url).then(async (response) => {
      if (!response.ok) throw new BoardError('no_board', `no board at ${url} (${response.status})`, response.status)
      const found = (await response.json()) as Discovery
      if (found.audience !== url)
        throw new BoardError('wrong_audience', `the board at ${url} says its URL is ${found.audience}: use that URL`, 0)
      return found
    }))

  let cached: Cached | null = null
  let source: string | null = null
  let person: Promise<Cached> | null = null
  // `source` says which of these it picked, for `vb whoami`.
  const mint = async (): Promise<Cached> => {
    if (process.env.VBOARD_TOKEN) {
      const token = process.env.VBOARD_TOKEN
      source = 'VBOARD_TOKEN'
      return { token, expiresAt: expiry(token) }
    }
    const local = localToken(url)
    if (local) {
      source = 'vb serve'
      return { token: local.token, expiresAt: expiry(local.token), handle: local.handle, name: null, avatar: null }
    }
    const discovered = await discover()
    const audience = url
    if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
      const token = await githubActionsToken(audience)
      source = 'GitHub Actions OIDC'
      return { token, expiresAt: expiry(token) }
    }
    if (process.env.VERCEL === '1') {
      const token = await hostedToken(audience)
      source = 'Vercel OIDC'
      return { token, expiresAt: expiry(token) }
    }
    person ??= personToken(audience, discovered).finally(() => {
      person = null
    })
    const minted = await person
    source = 'vercel login'
    return minted
  }
  const token = async () => {
    if (!cached || cached.expiresAt - 60_000 < Date.now()) cached = await mint()
    return cached.token
  }

  let agent: DetectedAgent | null | undefined
  const detected = () => (agent === undefined ? (agent = detectAgent()) : agent)

  const profile =
    options.profile !== undefined
      ? options.profile
      : (): ProfileOption => {
          const name = process.env.VBOARD_AS || detected()?.profile
          if (!name) return null
          const avatar = process.env.VBOARD_AVATAR
          return avatar ? { name, avatar } : name
        }

  return createBoardClient({
    url,
    token: options.token ?? token,
    profile,
    session: options.session !== undefined ? options.session : () => detected()?.session ?? null,
    handle:
      options.handle !== undefined
        ? options.handle
        : async () => {
            if (process.env.VBOARD_HANDLE) return process.env.VBOARD_HANDLE
            if (options.token !== undefined) return null
            await token()
            return cached?.handle ?? null
          },
    person:
      options.person !== undefined
        ? options.person
        : async () => {
            if (options.token !== undefined) return null
            await token()
            return cached ? { name: cached.name ?? null, avatar: cached.avatar ?? null } : null
          },
    source:
      options.source !== undefined
        ? options.source
        : async () => {
            if (options.token !== undefined) return null
            await token()
            return source
          },
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    fetch: doFetch,
  })
}

export { BoardError, type BoardClient, type ClientOptions, type ProfileOption } from './client.ts'

const WHERE = 'Project → Settings → Deployment Protection → Protection Bypass for Automation'

class Wall extends Error {
  readonly status: number
  constructor(status: number) {
    super('protected')
    this.status = status
  }
}

async function hostedToken(url: string): Promise<string> {
  try {
    return await getVercelOidcToken({ audience: url })
  } catch {
    throw new BoardError('no_token', `cannot obtain Vercel OIDC credentials for ${url}: enable OIDC on the calling project or supply token / VBOARD_TOKEN; configure Deployment Protection Trusted Sources for its project and environment`, 0)
  }
}

/** Explicit bypass wins; otherwise hosted calls use OIDC and local people use their saved bypass. */
function guarded(url: string, doFetch: typeof fetch, suppliedToken?: ClientOptions['token']): typeof fetch {
  const host = new URL(url).host
  let secret: Promise<string | null> | undefined
  let looked: Promise<{ secret: string; created: boolean }> | undefined
  return async (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    init = { ...init, headers }
    // An explicit bypass secret still wins, hosted or not: it's what hosted callers
    // and `vercel env pull` setups used before Trusted Sources.
    const fromEnv = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    if (fromEnv)
      return through(doFetch, input, init, fromEnv).catch((error) => {
        throw error instanceof Wall
          ? new BoardError('protected', `${url} is behind Vercel Deployment Protection and rejected VERCEL_AUTOMATION_BYPASS_SECRET; check it against ${WHERE}`, error.status)
          : error
      })
    // Without one, hosted workloads use project trust, never a person's saved bypass credentials.
    if (process.env.VERCEL === '1') {
      if (!headers.has('x-vercel-trusted-oidc-idp-token')) {
        const bearer = headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
        const token = bearer ?? (typeof suppliedToken === 'function' ? await suppliedToken() : suppliedToken)
          ?? (process.env.VBOARD_TOKEN || await hostedToken(url))
        headers.set('x-vercel-trusted-oidc-idp-token', token)
      }
      return through(doFetch, input, init, null).catch((error) => {
        throw error instanceof Wall
          ? new BoardError('protected', `${url} rejected Vercel OIDC access: configure Deployment Protection Trusted Sources for the calling project and environment`, error.status)
          : error
      })
    }
    const used = await (secret ??= readBypass(host))
    try {
      return await through(doFetch, input, init, used)
    } catch (error) {
      if (!(error instanceof Wall)) throw error
    }
    // The cached secret (or none) didn't get through: ask Vercel, once per client.
    looked ??= projectBypass(url, host, doFetch).then(async (found) => {
      await writeBypass(host, found.secret).catch(() => {})
      return found
    })
    const { secret: found, created } = await looked
    secret = Promise.resolve(found)
    try {
      return await through(doFetch, input, init, found).catch(async (error) => {
        if (!(error instanceof Wall) || !created) throw error
        // Like `vercel curl`: a new secret takes a moment to reach the edge.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return through(doFetch, input, init, found)
      })
    } catch (error) {
      throw error instanceof Wall
        ? new BoardError('protected', `${url} is behind Vercel Deployment Protection and its project's automation bypass didn't get through; set VERCEL_AUTOMATION_BYPASS_SECRET (${WHERE})`, error.status)
        : error
    }
  }
}

/**
 * One request that recognizes the wall: a redirect to `/sso-api`, or an HTML
 * page where the board answers JSON (on SAML teams, the redirects end at the
 * IdP's login page with a 200). Only a 2xx, 401, or 403 HTML page counts, so a
 * 404 page keeps its own error; attachments, which may be HTML, come with a
 * `content-disposition`. Other redirects of a GET or HEAD are followed as fetch
 * would, dropping the token and bypass secret on the way to another origin; a
 * redirected POST comes back as its 3xx.
 */
async function through(doFetch: typeof fetch, input: RequestInfo | URL, init: RequestInit, bypass: string | null): Promise<Response> {
  let target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  let headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  if (bypass) headers.set('x-vercel-protection-bypass', bypass)
  for (let hops = 0; ; hops++) {
    const response = await doFetch(hops === 0 ? input : target, { ...init, headers, redirect: 'manual' })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location) {
      const next = new URL(location, target)
      if (next.pathname.startsWith('/sso-api')) throw new Wall(response.status)
      if (method === 'GET' || method === 'HEAD') {
        if (hops >= 20) throw new BoardError('too_many_redirects', `too many redirects from ${target}`, response.status)
        if (next.origin !== new URL(target).origin) {
          headers = new Headers(headers)
          headers.delete('authorization')
          headers.delete('x-vercel-trusted-oidc-idp-token')
          headers.delete('x-vercel-protection-bypass')
        }
        target = next.href
        continue
      }
    }
    const { status } = response
    const page = /^text\/html\b/i.test(response.headers.get('content-type') ?? '') && !response.headers.has('content-disposition')
    if (page && ((status >= 200 && status < 300) || status === 401 || status === 403)) throw new Wall(status)
    return response
  }
}

const bypassFile = (host: string) =>
  join(configDir(), 'bypass', `${createHash('sha256').update(host).digest('hex').slice(0, 32)}.json`)

async function readBypass(host: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(bypassFile(host), 'utf8')) as { secret?: string }).secret || null
  } catch {
    return null
  }
}

async function writeBypass(host: string, secret: string) {
  await mkdir(join(configDir(), 'bypass'), { recursive: true, mode: 0o700 })
  await writeFile(bypassFile(host), JSON.stringify({ host, secret }), { mode: 0o600 })
}

type Bypasses = Record<string, { scope?: string }> | undefined
const automationBypass = (bypasses: Bypasses) =>
  Object.entries(bypasses ?? {}).find(([, value]) => value.scope === 'automation-bypass')?.[0] ?? null

type VercelApi = (method: 'GET' | 'PATCH', path: string) => Promise<unknown>

/**
 * The board's project's automation bypass secret, as `vercel curl` finds it:
 * the deployment (or alias) behind the host gives the project, whose
 * `protectionBypass` has it. When there's none, it's created.
 */
async function projectBypass(url: string, host: string, doFetch: typeof fetch): Promise<{ secret: string; created: boolean }> {
  const blocked = (why: string) =>
    new BoardError('protected', `${url} is behind Vercel Deployment Protection, and your Vercel login ${why}, or set VERCEL_AUTOMATION_BYPASS_SECRET (${WHERE})`, 0)
  let api: VercelApi
  try {
    const token = await getVercelToken()
    api = async (method, path) => {
      const response = await doFetch(`https://api.vercel.com${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(method === 'PATCH' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'PATCH' ? { body: '{}' } : {}),
      })
      return response.ok ? await response.json() : null
    }
  } catch {
    api = vercelCliApi
  }

  const project = await findProject(api, host)
  if (!project) throw blocked("can't see its project: run `vercel login` or ask for access")
  const scope = project.ownerId.startsWith('team_') ? `?teamId=${project.ownerId}` : ''
  const details = (await api('GET', `/v9/projects/${project.projectId}${scope}`)) as {
    name?: string
    protectionBypass?: Bypasses
    ssoProtection?: unknown
    passwordProtection?: unknown
  } | null
  // Without the project's settings, creating could add a second bypass.
  if (!details) throw blocked("can't read its project's settings: ask for access")
  const existing = automationBypass(details.protectionBypass)
  if (existing) return { secret: existing, created: false }
  // An HTML page from an unprotected project isn't a wall: it isn't a board, so nothing gets created.
  if (!details.ssoProtection && !details.passwordProtection)
    throw new BoardError('no_board', `no board at ${url}: it answered with a web page, and its Vercel project isn't protected`, 0)
  const created = (await api('PATCH', `/v1/projects/${project.projectId}/protection-bypass${scope}`)) as { protectionBypass?: Bypasses } | null
  const secret = automationBypass(created?.protectionBypass)
  if (!secret) throw blocked("can't read or create its project's automation bypass: ask a project admin")
  process.stderr.write(`created a Protection Bypass for Automation on the Vercel project ${details?.name ?? project.projectId}\n`)
  return { secret, created: true }
}

/** The project behind a host, as `vercel curl` finds it: the deployment, then the alias, in your own scope and then each of your teams. */
async function findProject(api: VercelApi, host: string): Promise<{ projectId: string; ownerId: string } | null> {
  type Found = { projectId?: string; ownerId?: string; team?: { id?: string } } | null
  const lookup = async (kind: 'deployment' | 'alias', team: string | null) => {
    const path = kind === 'deployment' ? `/v13/deployments/${encodeURIComponent(host)}` : `/now/aliases/${encodeURIComponent(host)}`
    const found = (await api('GET', `${path}${team ? `?teamId=${team}` : ''}`).catch(() => null)) as Found
    const owner = found?.ownerId ?? found?.team?.id ?? team
    return found?.projectId && owner ? { projectId: found.projectId, ownerId: owner } : null
  }
  const own = (await lookup('deployment', null)) ?? (await lookup('alias', null))
  if (own) return own
  const { teams } = ((await api('GET', '/v2/teams?limit=100').catch(() => null)) ?? {}) as { teams?: { id: string; limited?: boolean }[] }
  const ids = (teams ?? []).filter((team) => !team.limited).map((team) => team.id)
  for (const kind of ['deployment', 'alias'] as const) {
    // A few at a time: with keychain credentials each lookup is a `vercel` process.
    for (let i = 0; i < ids.length; i += 8) {
      const found = (await Promise.all(ids.slice(i, i + 8).map((id) => lookup(kind, id)))).find(Boolean)
      if (found) return found
    }
  }
  return null
}

/** When credentials live in the keychain, the Vercel CLI makes the API call itself. */
let vercelCli: Promise<boolean> | undefined
const vercelCliApi: VercelApi = async (method, path) => {
  // Signed out, `vercel` starts a login flow and waits: check once, quickly, before any call.
  vercelCli ??= promisify(execFile)('vercel', ['whoami', '--non-interactive'], { timeout: 10_000 }).then(
    () => true,
    () => false,
  )
  if (!(await vercelCli)) throw new BoardError('not_logged_in', 'not signed in to Vercel: run `vercel login`', 0)
  const args = ['api', path, '-X', method, '--raw', '--non-interactive']
  if (method === 'PATCH') args.push('--input', '-')
  try {
    const run = promisify(execFile)('vercel', args, { timeout: 30_000 })
    run.child.stdin?.end(method === 'PATCH' ? '{}' : '')
    return JSON.parse((await run).stdout)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new BoardError('not_logged_in', 'not signed in to Vercel: run `vercel login`', 0)
    return null
  }
}
