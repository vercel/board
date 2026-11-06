import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { BOARD_URL, caller, TEAM_ID, testBoard } from './harness.ts'

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
/** The board's own team's project, once it's moved to another team: the same ID, another owner. */
const moved = () => deployment('elsewhere', 'team_elsewhere', 'marketing', 'prj_marketing')

describe("a project grant, across teams' issuers", () => {
  it("lets in its project on the board's team only: not another team's, by its ID or its name", async () => {
    const board = testBoard({ auth })
    // Without g2, which lets in every project on the board's team.
    await board.revokeGrant('g2')
    const call = async (token: string) => caller(board.fetch, token)('GET', '/me')
    expect((await call(await theirs())).body.error).toEqual({
      code: 'forbidden',
      message: "this token can't use this board: no grant lets in project prj_attacker in production",
      hint: 'Grant it: vb grants create --project prj_attacker --environment production',
    })
    const { grant } = await board.createGrant({ principals: [{ kind: 'project', project: 'prj_attacker', environments: ['production'] }, { kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { '*': 'all' } })
    // It keeps each project on the board's own team.
    expect(grant.principals.map((principal) => (principal.kind === 'project' ? principal.teamId : null))).toEqual([TEAM_ID, TEAM_ID])
    expect((await call(await theirs())).status).toBe(403)
    expect((await caller(board.fetch, await ours())('POST', '/messages', { channel: 'general', text: 'deploy approved' })).status).toBe(201)
  })

  it("keeps no grant for a project moved to another team, whose tokens name that team", async () => {
    const board = testBoard({ auth })
    await board.revokeGrant('g2')
    await board.createGrant({ principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { '*': 'all' } })
    expect((await caller(board.fetch, await ours())('GET', '/me')).status).toBe(200)
    expect((await caller(board.fetch, await moved())('GET', '/me')).status).toBe(403)
  })
})
