// Your team's board in Vercel's API, internal: board()'s default backend, and the CLI's. In Node, it finds credentials the way
// the Vercel CLI and a deployment do: `VERCEL_TOKEN`, the deployment's OIDC token, or `vercel login`,
// after `BOARD_TOKEN`, a board token you set, as `vb` sends one to any board.
import { readFile } from 'node:fs/promises'
import { getVercelOidcToken, getVercelToken } from '@vercel/oidc'
import { decodeJwt } from 'jose'
import { asYou, environmentProfile, loginHanded, vercelLogin, vercelProjectFile } from '../client/node.ts'
import { createVercel, type VercelBackend, type VercelEnvironment, type VercelOptions } from '../server/backend-vercel.ts'
import { HttpError } from '../server/errors.ts'

/** On Vercel, or with its OIDC token pulled (`vercel env pull`): a deployment acts as its project. */
const deployed = () => process.env.VERCEL === '1' || !!process.env.VERCEL_OIDC_TOKEN

/**
 * A token you set for the board: it goes as `Authorization: Bearer <token>`, as it is, whatever its
 * format (that's Vercel's API's), ahead of every other, as it does to a board at a URL.
 */
const boardToken = () => process.env.BOARD_TOKEN || null

/**
 * A token Vercel's API takes: `BOARD_TOKEN`, `VERCEL_TOKEN`, this deployment's OIDC token, or your
 * Vercel login, the one the CLI that runs board's hands it (`vercel board`'s) or your `vercel login`.
 */
async function token(): Promise<string> {
  const given = boardToken()
  if (given) return given
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN
  if (deployed()) return getVercelOidcToken()
  // With no login to send, that's what it says, as `http()`'s does, not that the API didn't answer.
  return vercelLogin().catch(() => {
    throw new HttpError(401, 'not_logged_in', "You're not logged in to Vercel.", { hint: 'Run vercel login.', origin: 'handle' })
  })
}

/** Where `token` comes from, in words: what `vb whoami` says. */
export function credentialSource(): string {
  if (boardToken()) return 'BOARD_TOKEN'
  if (process.env.VERCEL_TOKEN) return 'VERCEL_TOKEN'
  if (deployed()) return 'Vercel OIDC'
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
  if (!process.env.VERCEL_TOKEN && deployed()) {
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
    // credentials. A token you set goes as it is.
    if (!boardToken() && !process.env.VERCEL_TOKEN && !deployed())
      return asYou(input, init, credential)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${credential}`)
    return globalThis.fetch(input, { ...init, headers })
  },
  team,
  profile: environmentProfile,
}

/**
 * Your team's board, in Vercel's API: this board keeps nothing, and reads and writes that one as
 * this deployment's project, or as you. Without `board`, the team's board; without `fetch`, it
 * sends the credentials the Vercel CLI or the deployment has.
 */
export function vercel(options: VercelOptions = {}): VercelBackend {
  return createVercel(options, environment)
}

export type { VercelBackend, VercelOptions }
