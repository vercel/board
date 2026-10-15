import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { memory } from 'experimental-a2/store-memory'
import { describe, expect, it } from 'vitest'
import { board, vercelProject } from '../src/server/index.ts'
import { BOARD_URL, caller, PROJECT_ID, TEAM_ID, testBoard } from './harness.ts'

// Vercel signs every team's tokens, each under its own issuer
// (`https://oidc.vercel.com/<team>`), and production accepts any of them.
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'vercel', alg: 'RS256' }] })
const auth = { vercel: { issuer: /^https:\/\/oidc\.vercel\.com\/[a-z0-9-]+$/, jwks } }

/** A production deployment of `project` on some team. */
const deployment = (team: string, teamId: string, project: string, projectId: string, audience = BOARD_URL) =>
  new SignJWT({
    sub: `owner:${team}:project:${project}:environment:production`,
    owner: team,
    owner_id: teamId,
    project,
    project_id: projectId,
    environment: 'production',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'vercel' })
    .setIssuer(`https://oidc.vercel.com/${team}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

const ours = () => deployment('test', TEAM_ID, 'marketing', 'prj_marketing')
const theirs = () => deployment('attacker', 'team_attacker', 'marketing', 'prj_attacker')
const access = [vercelProject({ project: 'marketing', environments: ['production'], can: 'all' })]

describe('a trusted Vercel project named without its team', () => {
  const configured = () => testBoard({ auth, access })

  it("trusts the board's own team's project of that name", async () => {
    const me = await caller(configured().fetch, await ours())('GET', '/me')
    expect({ status: me.status, actor: me.body?.actor }).toEqual({
      status: 200,
      actor: 'vercel:project:prj_marketing:production',
    })
  })

  it("doesn't trust another team's project that took the same name", async () => {
    const call = caller(configured().fetch, await theirs())
    expect((await call('GET', '/me')).status).toBe(403)
    expect((await call('POST', '/messages', { channel: 'general', text: 'deploy approved' })).status).toBe(403)
  })

  it('trusts a project named by ID on any team, since IDs are unique', async () => {
    const { fetch } = testBoard({ auth, access: [vercelProject({ project: 'prj_attacker', can: 'all' })] })
    expect((await caller(fetch, await theirs())('GET', '/me')).status).toBe(200)
  })

  it('learns its team from the platform token for its own project', async () => {
    const { fetch } = board({ store: memory(), url: BOARD_URL, project: { id: PROJECT_ID }, auth, access })
    const call = async (token: string, platform?: string) =>
      (await caller(fetch, token, platform ? { 'x-vercel-oidc-token': platform } : {})('GET', '/me')).status
    // With no team to scope it to, a name matches nothing.
    expect(await call(await ours())).toBe(403)
    // A token for some other project says nothing about the board's team.
    expect(await call(await theirs(), await deployment('attacker', 'team_attacker', 'x', 'prj_x', 'https://vercel.com/attacker'))).toBe(403)
    const platform = await deployment('test', TEAM_ID, 'board', PROJECT_ID, 'https://vercel.com/test')
    expect(await call(await ours(), platform)).toBe(200)
    expect(await call(await theirs(), platform)).toBe(403)
  })
})
