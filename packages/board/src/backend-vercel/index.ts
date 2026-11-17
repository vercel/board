// Your team's board in Vercel's API, internal: board()'s default backend, and the CLI's. In Node, it finds credentials the way
// a deployment and the Vercel CLI do: the deployment's OIDC token, or else `BOARD_TOKEN` or your login. Never
// `VERCEL_TOKEN`, a name people set for other reasons, and nothing in the environment replaces a deployment's
// own token: only a token someone passed the CLI for this run goes ahead of it.
import { readFile } from 'node:fs/promises'
import { getVercelOidcToken, getVercelToken } from '@vercel/oidc'
import { decodeJwt } from 'jose'
import { asYou, environmentProfile, loginHanded, PASSED, passedToken, sandboxHeaders, vercelLogin, vercelProjectFile } from '../client/node.ts'
import { createVercel, type VercelBackend, type VercelEnvironment, type VercelOptions } from '../server/backend-vercel.ts'
import { HttpError } from '../server/errors.ts'

/** On Vercel, or with its OIDC token pulled (`vercel env pull`): a deployment acts as its project. */
const deployed = () => process.env.VERCEL === '1' || !!process.env.VERCEL_OIDC_TOKEN

/** Off a deployment, a credential Vercel's API takes, set for board: what a sandbox or CI passes. */
const boardToken = () => (deployed() ? null : process.env.BOARD_TOKEN || null)

/** Whether what goes is a Vercel login: a token passed for this run, or with no deployment's token and no `BOARD_TOKEN`, yours. */
const asLogin = () => passedToken() !== null || (!deployed() && !boardToken())

/**
 * A token Vercel's API takes: the one this run was passed (`vercel board --token`), or else this
 * deployment's OIDC token, or else `BOARD_TOKEN`, or your Vercel login, the one the CLI that runs
 * board's hands it (`vercel board`'s, or `VERCEL_AUTH_TOKEN`) or your `vercel login`.
 */
async function token(): Promise<string> {
  const passed = passedToken()
  if (passed !== null) return passed
  if (deployed()) return getVercelOidcToken()
  const set = boardToken()
  if (set) return set
  // With no login to send, that's what it says, as `http()`'s does, not that the API didn't answer.
  return vercelLogin().catch(() => {
    throw new HttpError(401, 'not_logged_in', "You're not logged in to Vercel.", { hint: 'Run vercel login.', origin: 'handle' })
  })
}

/** Where `token` comes from, in words: what `vb whoami` says. */
export function credentialSource(): string {
  if (passedToken() !== null) return PASSED
  if (deployed()) return 'Vercel OIDC'
  if (boardToken()) return 'BOARD_TOKEN'
  return loginHanded() ? 'the Vercel CLI' : 'vercel login'
}

/** The team a CLI that runs board's resolves itself (`vercel board`'s), while one does. */
let handed: (() => Promise<string | null>) | null = null

/**
 * Hands board the team to use when nothing names one (`--scope` still wins), resolved as the app
 * resolves its own and asked for only when a request needs it. Null takes it back.
 */
export function handTeam(resolve: (() => Promise<string | null>) | null) {
  handed = resolve
}

/**
 * The team: the one a CLI that runs board's hands it, `VERCEL_ORG_ID`, the one the deployment's OIDC
 * token names, or the linked project's (the nearest `.vercel/project.json`). A handed one that
 * throws fails the request with what it threw: the app's own words, not an internal error.
 */
async function team(): Promise<string | null> {
  if (handed) {
    try {
      return await handed()
    } catch (error) {
      throw new HttpError(502, 'no_team', error instanceof Error ? error.message : String(error), { origin: 'handle' })
    }
  }
  if (process.env.VERCEL_ORG_ID) return process.env.VERCEL_ORG_ID
  if (deployed()) {
    try {
      const owner = decodeJwt(await getVercelOidcToken()).owner_id
      if (typeof owner === 'string') return owner
    } catch {}
  }
  const file = vercelProjectFile()
  if (!file) return null
  try {
    const linked = JSON.parse(await readFile(file, 'utf8')) as { orgId?: unknown }
    if (typeof linked.orgId === 'string') return linked.orgId
  } catch {}
  return null
}

const environment: VercelEnvironment = {
  fetch: () => async (input, init = {}) => {
    const credential = await token()
    // Your login goes through the fetch the CLI that runs board's hands it, which adds its own
    // credentials. A deployment's token, or BOARD_TOKEN, goes as it is.
    if (asLogin()) return asYou(input, init, credential)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${credential}`)
    return globalThis.fetch(input, { ...init, headers })
  },
  team,
  profile: environmentProfile,
  sandbox: (url, token) => sandboxHeaders(url, null, token),
}

/** The fetch `vercel()` sends by default, with the credentials it finds: for the CLI to add a header of its own to. */
export const credentialed = (): typeof fetch => environment.fetch()

/**
 * Your team's board, in Vercel's API: this board keeps nothing, and reads and writes that one as
 * this deployment's project, or as you. Without `board`, the team's board; without `fetch`, it
 * sends the credentials the Vercel CLI or the deployment has.
 */
export function vercel(options: VercelOptions = {}): VercelBackend {
  return createVercel(options, environment)
}

export type { VercelBackend, VercelOptions }
