import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, TEAM_ID, testBoard, workflowToken } from './harness.ts'

type Fetch = (request: Request) => Promise<Response>

// What a handle does on top of the protocol for grants: a private channel from createChannel and
// createGrant, and `can` and principals as people write them. Each handle here is a caller's, over
// HTTP, to a board in this process.

/** A handle on the board behind `fetch`, as whoever `token` names. */
const handleAs = (fetch: Fetch, token: () => Promise<string>) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

const ids = async (team: ReturnType<typeof testBoard>) => (await team.grants()).map((grant) => grant.id)

describe('a private channel, from the handle', () => {
  it("is a grant letting its creator in, then one closing it to everyone else, then the channel", async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    const made = await julian.createChannel('vault', { private: true })
    expect(made).toMatchObject({
      channel: { path: 'vault' },
      created: true,
      grants: [
        { principals: [{ kind: 'user', userId: 'u_julian' }], can: { 'vault/': 'all' } },
        { principals: [{ kind: 'everyone' }], can: { 'vault/': [] } },
      ],
    })
    expect((await julian.post('vault/keys', { text: 'rotated' })).channel).toBe('vault/keys')
    expect((await caller(team.fetch, await personToken('u_ada'))('POST', '/messages', { channel: 'vault', text: 'let me in' })).status).toBe(403)
    // A deployment lets in its own project, in the environment it runs in.
    await team.createGrant({ principals: [{ kind: 'project', project: 'prj_ops', environments: ['production'] }], can: { '*': 'all' } })
    const ops = handleAs(team.fetch, () => deploymentToken('ops', 'prj_ops', 'production'))
    expect((await ops.createChannel('ops/keys', { private: true })).grants?.[0]?.principals).toEqual([{ kind: 'project', projectId: 'prj_ops', name: null, environments: ['production'], teamId: TEAM_ID }])
  })

  it("refuses a path where it or a channel under it is there, and a caller no grant could name, before it writes anything", async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    await julian.post('dev', { text: 'already here' })
    await julian.post('security/incidents', { text: 'under it' })
    const before = await ids(team)
    await expect(julian.createChannel('dev', { private: true })).rejects.toMatchObject({ status: 409, code: 'channel_exists', origin: 'handle' })
    // Closing security/ would close security/incidents too.
    await expect(julian.createChannel('security', { private: true })).rejects.toMatchObject({ status: 409, code: 'channel_exists', message: expect.stringContaining('security/incidents') })
    // The board's own code, and a GitHub run, are no principal a grant could let in.
    await expect(team.createChannel('mine', { private: true })).rejects.toMatchObject({ status: 400, code: 'no_own_principal', origin: 'handle' })
    await team.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } })
    await expect(handleAs(team.fetch, () => workflowToken()).createChannel('ci-secrets', { private: true })).rejects.toMatchObject({ status: 400, code: 'no_own_principal' })
    expect((await team.channels()).map((channel) => channel.path)).toEqual(['dev', 'security/incidents'])
    expect((await ids(team)).length).toBe(before.length + 1)
  })

  it("refuses a path a grant reaches already, naming it, and a caller that can't list grants, before it writes anything", async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    // A grant on the channel itself would still let Ada in past the lock.
    const exact = (await team.createGrant({ principals: [{ kind: 'user', userId: 'u_ada' }], can: { vault: ['read'] } })).grant.id
    await expect(julian.createChannel('vault', { private: true })).rejects.toMatchObject({
      status: 409,
      code: 'channel_granted',
      origin: 'handle',
      message: `${exact} already grants in vault, so a private vault wouldn't be yours alone: nothing was made.`,
      hint: `Revoke it first: vb grants revoke ${exact}`,
    })
    // So would a principal's at <path>/, closer than everyone there, and one under it.
    const subtree = (await team.createGrant({ principals: [{ kind: 'project', project: 'prj_ops', environments: ['production'] }], can: { 'keys/': 'all' } })).grant.id
    await expect(julian.createChannel('keys', { private: true })).rejects.toMatchObject({ status: 409, code: 'channel_granted', message: expect.stringContaining(subtree) })
    const under = (await team.createGrant({ principals: [{ kind: 'user', userId: 'u_ada' }], can: { 'ops/deploys': ['read'] } })).grant.id
    await expect(julian.createChannel('ops', { private: true })).rejects.toMatchObject({ status: 409, code: 'channel_granted', message: expect.stringContaining(under) })
    const before = await ids(team)
    // A token that can't list grants can't tell, so it makes nothing.
    const minted = await caller(team.fetch, await personToken())('POST', '/tokens', { name: 'narrow', can: { '*': ['read', 'post'] } })
    await expect(handleAs(team.fetch, async () => minted.body.secret).createChannel('lockbox', { private: true })).rejects.toMatchObject({ status: 403 })
    expect(await ids(team)).toEqual(before)
    expect(await team.channels()).toEqual([])
  })

  it('leaves at most one way in when two make the same private channel at once', async () => {
    const team = testBoard()
    /** What opens once both racers have reached it. */
    const meeting = () => {
      let open!: () => void
      const opened = new Promise<void>((resolve) => (open = resolve))
      let arrived = 0
      return { opened, arrive: () => void (++arrived === 2 && open()) }
    }
    // Each one lists the grants again only once both own grants are made, and hears back only
    // once both have listed: each finds the other's.
    const owned = meeting()
    const listed = meeting()
    const racer = (token: () => Promise<string>) => {
      let mine = false
      return handleAs(async (request) => {
        const grants = new URL(request.url).pathname.endsWith('/grants')
        if (request.method === 'GET' && grants && mine) {
          await owned.opened
          const response = await team.fetch(request)
          listed.arrive()
          await listed.opened
          return response
        }
        const response = await team.fetch(request)
        if (request.method === 'POST' && grants && !mine) {
          mine = true
          owned.arrive()
        }
        return response
      }, token)
    }
    const [first, second] = await Promise.allSettled([racer(() => personToken()).createChannel('vault', { private: true }), racer(() => personToken('u_ada')).createChannel('vault', { private: true })])
    expect([first, second].map((settled) => (settled.status === 'rejected' ? (settled.reason as { code: string }).code : 'made'))).toEqual(['channel_granted', 'channel_granted'])
    // Each took its own back: no one has a way in, and nothing is closed or made.
    expect(await ids(team)).toEqual(['g1', 'g2', 'g3'])
    expect(await team.channels()).toEqual([])
  })

  it("takes its grants back, and makes nothing, when someone grants themselves in before its lock lands", async () => {
    const team = testBoard()
    let theirs: string | null = null
    // Just before the lock reaches the board, Ada, who manages the still-open path, grants herself in.
    const sneaking: Fetch = async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/grants') && theirs === null && (await request.clone().text()).includes('"everyone"'))
        theirs = (await caller(team.fetch, await personToken('u_ada'))('POST', '/grants', { principals: [{ kind: 'user', userId: 'u_ada' }], can: { 'vault/': 'all' } })).body.grant.id
      return team.fetch(request)
    }
    const refused = await handleAs(sneaking, () => personToken()).createChannel('vault', { private: true }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 409, code: 'channel_granted', message: `${theirs} already grants in vault, so a private vault wouldn't be yours alone: nothing was made.` })
    // Hers is the only one left: the lock and the creator's own are both gone, and no channel was made.
    expect(await ids(team)).toEqual(['g1', 'g2', 'g3', theirs])
    expect(await team.channels()).toEqual([])
  })

  it('takes its grants back, and makes nothing, when someone adds themselves to its own grant before its lock lands', async () => {
    const team = testBoard()
    // Ada manages the still-open path, so she can add herself to the creator's grant: once it's
    // made, before it's listed again, or just before the lock reaches the board.
    for (const [path, when] of [['vault', 'listing'], ['safe', 'lock']] as const) {
      let added: string | null = null
      const adding: Fetch = async (request) => {
        const onGrants = new URL(request.url).pathname.endsWith('/grants')
        const locking = request.method === 'POST' && onGrants && (await request.clone().text()).includes('"everyone"')
        const own = (await team.grants()).find((grant) => Object.hasOwn(grant.can, `${path}/`) && grant.principals.some((principal) => principal.kind === 'user'))
        if (!added && own && (when === 'lock' ? locking : request.method === 'GET' && onGrants)) {
          if ((await caller(team.fetch, await personToken('u_ada'))('PATCH', `/grants/${own.id}`, { add: [{ kind: 'user', userId: 'u_ada' }] })).status === 200) added = own.id
        }
        return team.fetch(request)
      }
      const refused = await handleAs(adding, () => personToken()).createChannel(path, { private: true }).catch((error: unknown) => error)
      // Its own grant is revoked by now, so it names no grant to revoke.
      expect(added).not.toBeNull()
      expect(refused).toMatchObject({ status: 409, code: 'channel_granted', message: `${added} changed while ${path} was being made, so a private ${path} wouldn't be yours alone: nothing was made.` })
      expect((refused as { hint?: string }).hint).toBeUndefined()
      // The grant she's on and the lock are both gone, and no channel was made.
      expect(await ids(team)).toEqual(['g1', 'g2', 'g3'])
      expect(await team.channels()).toEqual([])
    }
  })

  it('never shuts its creator out when a step fails part way', async () => {
    const team = testBoard()
    let grantsPosted = 0
    let channels = true
    // The second grant, the one that closes it, never reaches the board; then, the channel doesn't.
    const flaky: Fetch = async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'POST' && path.endsWith('/grants') && ++grantsPosted === 2) throw new TypeError('fetch failed')
      if (request.method === 'POST' && path.endsWith('/channels') && !channels) throw new TypeError('fetch failed')
      return team.fetch(request)
    }
    const julian = handleAs(flaky, () => personToken())
    const ada = caller(team.fetch, await personToken('u_ada'))
    await expect(julian.createChannel('vault', { private: true })).rejects.toThrow()
    // Open, with a grant too many.
    expect((await team.grants()).slice(3).map((grant) => [grant.principals, grant.can])).toEqual([[[{ kind: 'user', userId: 'u_julian', email: null }], { 'vault/': 'all' }]])
    expect((await team.channels()).map((channel) => channel.path)).toEqual([])
    expect((await ada('POST', '/messages', { channel: 'vault', text: 'still open' })).status).toBe(201)
    // Closed, and not made yet: its creator still gets in.
    channels = false
    await expect(julian.createChannel('lockbox', { private: true })).rejects.toThrow()
    expect((await team.channels()).map((channel) => channel.path)).toEqual(['vault'])
    expect((await ada('POST', '/messages', { channel: 'lockbox', text: 'let me in' })).status).toBe(403)
    expect((await caller(team.fetch, await personToken())('POST', '/messages', { channel: 'lockbox', text: 'mine' })).status).toBe(201)
  })
})

describe('grants, from the handle', () => {
  it("takes 'none' at a pattern and leaves out a project's environments, as people write them", async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    const { grant } = await julian.createGrant({
      principals: [{ kind: 'project', project: 'prj_web' }, { kind: 'all-projects' }],
      can: { '*': 'all', 'security/': 'none' },
    })
    expect(grant).toMatchObject({
      principals: [
        { kind: 'project', projectId: 'prj_web', environments: ['production'] },
        { kind: 'all-projects', environments: ['production'] },
      ],
      can: { '*': 'all', 'security/': [] },
    })
    const updated = await julian.updateGrant(grant.id, { add: [{ kind: 'project', project: 'prj_api' }], remove: [{ kind: 'all-projects' }], can: { 'ci/': 'none' } })
    expect(updated.grant).toMatchObject({ principals: [{ projectId: 'prj_web' }, { projectId: 'prj_api', environments: ['production'] }], can: { 'ci/': [] } })
    const { token } = await julian.createToken({ name: 'no-security', can: { '*': ['read'], 'security/': 'none' } })
    expect(token.can).toEqual({ '*': ['read'], 'security/': [] })
  })
})
