import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Can } from '../src/access/index.ts'
import { slack, SlackProvider } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { VERCEL_BUILDING } from './vercel-fixtures.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { REGISTRY_SESSION } from '../src/contract/contract.ts'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vb } from '../src/cli/embedded.ts'
import { continues, sourcePlatform } from '../src/inspect/app/store.ts'
import type { MessageView } from '../src/api/routes.ts'

/** The support project, a sync elsewhere: it registers its sync entries on the team's board, and imports and records through its sync routes. */
const SUPPORT = 'vercel:project:prj_support:production'
const supportToken = () => deploymentToken('support', 'prj_support', 'production')

/** Lets a project's production deployments do what `can` says on the team's board. */
const grant = async (team: ReturnType<typeof testBoard>, projectId: string, can: Can) => {
  const written = (typeof can === 'object' && !Array.isArray(can) ? can : { '*': can }) as never
  const grants = await team.grants()
  const named = grants.find((one) => one.principals.length === 1 && one.principals[0]!.kind === 'project' && one.principals[0]!.projectId === projectId)
  if (named) return team.updateGrant(named.id, { can: written })
  // Without g2's every project on the team, it may do only what its grant says.
  if (grants.some((one) => one.id === 'g2')) await team.revokeGrant('g2')
  return team.createGrant({ principals: [{ kind: 'project', project: projectId, environments: ['production'] }], can: written })
}

type Read = { id: string; text: string; from: string | null; by: { actor: string }; origin: { thread: string; message: string } | null; reactions: Record<string, string[]> }

/** Julian, by a Vercel login whose user ID, his handle, is `julian`. */
const julianOn = async (fetch: (request: Request) => Promise<Response>, audience?: string) =>
  caller(fetch, await personToken('julian', audience), {})

const read = async (call: ReturnType<typeof caller>, channel: string) => (await call('GET', `/messages?channel=${channel}`)).body.messages as Read[]

describe('the sync permission', () => {
  const author = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }

  it("gates every sync route: a caller without it can't speak for platform users", async () => {
    const team = testBoard()
    await grant(team, 'prj_support', { firehose: ['read', 'post'] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'hello' })).body.message
    // It's let in: it reads firehose, so each refusal below is for the sync it lacks.
    expect((await support('GET', '/messages?channel=firehose')).status).toBe(200)
    const event = { kind: 'message', channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1', isRoot: true, text: 'hi', context: null, author }
    for (const [method, path, body] of [
      ['POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'firehose', text: 'as Ada' }],
      ['POST', '/sync/receipts', { kind: 'message', message: root.id, target: 'slack:C1', external: { thread: 'slack:C1:1', message: '1' } }],
      ['GET', `/sync/threads/${root.thread}`],
      ['GET', '/sync/find?thread=slack:C1:1'],
      ['GET', `/sync/copies?message=${root.id}`],
      ['POST', '/inbox/slack', { events: [{ id: '1', event, raw: {} }] }],
      ['GET', '/inbox/slack/next'],
      ['POST', '/inbox/slack/1/ack', { lease: 'l1' }],
      ['GET', '/inbox/slack'],
    ] as const) {
      const denied = await support(method, path, body)
      expect(denied.status, `${method} ${path}`).toBe(403)
    }
    expect(await read(julian, 'firehose')).toHaveLength(1)
  })

  it("lets a caller with it in another subtree import there, and not here", async () => {
    const team = testBoard()
    await grant(team, 'prj_support', { 'support/': 'all', firehose: ['read'] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const post = (channel: string) => support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel, text: `from Slack to ${channel}` })
    const denied = await post('firehose')
    expect([denied.status, denied.body.error.message]).toEqual([403, "this token can't sync in firehose, so it can't import there"])
    expect((await post('support/inbox')).status).toBe(200)
    expect((await read(julian, 'support/inbox')).map((m) => [m.text, m.by.actor])).toEqual([['from Slack to support/inbox', `${SUPPORT}+slack:user:U_ADA`]])
    expect(await read(julian, 'firehose')).toEqual([])

    // Nor can it reply into, receipt, or look up a thread here.
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'ours' })).body.message
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', re: root.id, text: 'as Ada' })).status).toBe(403)
    expect((await support('POST', '/sync/receipts', { kind: 'failed', message: root.id, target: 'slack:C1', error: 'gone' })).status).toBe(403)
    expect((await support('GET', `/sync/threads/${root.thread}`)).status).toBe(404)
  })

  it("writes only as a user of a sync key it has, named under that key: never as someone the board signs in", async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }, { key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    const as = (id: string, from: string | null = 'slack') =>
      support('POST', '/sync/imports', { op: 'post', author: { ...author, id }, from, channel: 'firehose', text: `as ${id}` })
    // Someone the board authenticates: a person, a deployment, a workflow, an issuer's subject, a local person, its own code.
    for (const id of ['vercel:user:u_julian', 'vercel:project:prj_board:production', 'github:repo:123456', 'oidc:gitlab.com:acme', 'local:user:julian', 'board:client:deploys']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
      // A callback's own writes too.
      expect((await as(id, null)).status, id).toBe(403)
    }
    // A user of another platform, or of its other key: a user is named by the key it came through.
    expect((await as('github:user:42')).body.error.message).toBe("github:user:42 isn't a user of slack: their ID starts with its key")
    expect((await as('slack-eu:user:U_ADA')).body.error.message).toBe("slack-eu:user:U_ADA isn't a user of slack: their ID starts with its key")
    expect((await as('slack:user:U_ADA', 'slack-eu')).body.error.message).toBe("slack:user:U_ADA isn't a user of slack-eu: their ID starts with its key")
    expect((await as('github:user:42', null)).body.error.message).toBe("github:user:42 isn't a user of slack or slack-eu: their ID starts with its key")
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'github', channel: 'firehose', text: 'as Ada' })).body.error.message).toBe(
      "this token doesn't sync github here: its board registers its sync entries",
    )
    expect(await read(julian, 'firehose')).toEqual([])
    expect((await as('slack:user:U_ADA')).status).toBe(200)
    expect((await as('slack-eu:user:U_ADA', 'slack-eu')).status).toBe(200)
    // A callback's own write, through no key, is a user of any key it has.
    expect((await as('slack-eu:user:U_BOB', null)).status).toBe(200)
    expect((await read(julian, 'firehose')).map((m) => m.by.actor)).toEqual([`${SUPPORT}+slack:user:U_ADA`, `${SUPPORT}+slack-eu:user:U_ADA`, `${SUPPORT}+slack-eu:user:U_BOB`])
  })

  it("keeps the IDs imports land with from anyone who posts, so no one can take one first", async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    // An import's ID is its sync's, under its principal: anyone can work it out.
    const id = `sync:${SUPPORT}:${createHash('sha256').update('board-sync\u001fslack-100').digest('hex').slice(0, 32)}`
    const taken = await julian('POST', '/messages', { channel: 'firehose', text: 'first', id })
    expect([taken.status, taken.body.error?.message]).toEqual([400, "id: sync:… IDs are what sync imports, under the principal that imports them"])
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'firehose', text: 'from Slack', id: 'slack-100' })).status).toBe(200)
    expect((await read(julian, 'firehose')).map((m) => [m.text, m.by.actor])).toEqual([['from Slack', `${SUPPORT}+slack:user:U_ADA`]])
  })

  it("delivers what a sync elsewhere imports to this board's own platforms, under a key this board doesn't have", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    const imported = await support('POST', '/sync/imports', { op: 'post', author: { ...author, id: 'helpdesk:user:U_ADA' }, from: 'helpdesk', channel: 'firehose', text: 'export is broken' })
    expect(imported.status).toBe(200)
    // The team's Slack gets it, named through the project whose word it is, and for the platform it came from.
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '**Ada via support (slack)**: export is broken' })]))
  })

  it('registers sync entries only for a token that may sync, and lists those of the ones that still may', async () => {
    // A project that may only read, and one whose sync the team can take away.
    const team = testBoard()
    await grant(team, 'prj_reader', { '*': ['read'] })
    const others = await grant(team, 'prj_other', 'all')
    const reader = caller(team.fetch, await deploymentToken('reader', 'prj_reader', 'production'))
    const otherOne = caller(team.fetch, await deploymentToken('other', 'prj_other', 'production'))
    const listed = async () => (await team.fetch(new Request(BOARD_URL)).then((r) => r.json())).sync
    const sync = [{ key: 'slack', platform: 'slack' }]
    // Reading is enough to register watchers, not a sync.
    const refused = await reader('POST', '/watchers', { watch: {}, sync })
    expect([refused.status, refused.body.error.message]).toEqual([403, "this token can't register a sync: it needs sync somewhere"])
    expect((await reader('POST', '/watchers', { watch: {} })).status).toBe(200)
    expect(await listed()).toEqual([])
    expect((await otherOne('POST', '/watchers', { watch: {}, sync })).status).toBe(200)
    expect(await listed()).toEqual(sync)
    // One that may no longer sync isn't listed.
    await team.revokeGrant(others.grant.id)
    expect(await listed()).toEqual([])
  })

  it('lets every project on the team sync on a new board, through g2', async () => {
    const team = testBoard()
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    expect((await support('POST', '/sync/imports', { op: 'post', author: { ...author, id: 'helpdesk:user:U_ADA' }, from: 'helpdesk', channel: 'firehose', text: 'export is broken' })).status).toBe(200)
    expect((await read(julian, 'firehose')).map((m) => [m.text, m.by.actor])).toEqual([['export is broken', `${SUPPORT}+helpdesk:user:U_ADA`]])
  })

  it('keeps sync from a project a closer grant names without it, and from every project once g2 drops it', async () => {
    const team = testBoard()
    const web = caller(team.fetch, await deploymentToken('web', 'prj_web', 'preview'))
    const support = caller(team.fetch, await supportToken())
    const sync = [{ key: 'helpdesk', platform: 'slack' }]
    await team.createGrant({ principals: [{ kind: 'project', project: 'prj_web', environments: ['preview'] }], can: { '*': ['read', 'post', 'react', 'label'] } })
    const refused = await web('POST', '/watchers', { watch: {}, sync })
    expect([refused.status, refused.body.error.message]).toEqual([403, "this token can't register a sync: it needs sync somewhere"])
    expect((await support('POST', '/watchers', { watch: {}, sync })).status).toBe(200)
    await team.updateGrant('g2', { can: { '*': ['read', 'post', 'react', 'label'] } })
    const dropped = await support('POST', '/sync/imports', { op: 'post', author, from: 'helpdesk', channel: 'firehose', text: 'as Ada' })
    expect([dropped.status, dropped.body.error.message]).toEqual([403, "this token can't import: it needs sync"])
  })

  it('takes provenance only on the sync routes: a post never says who it is by', async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    const posted = (await support('POST', '/messages', { channel: 'firehose', text: 'hi', author, origin: { thread: 'slack:C1:1', message: '1' }, from: 'slack' })).body.message
    expect(posted).toMatchObject({ by: { actor: SUPPORT }, from: null, origin: null })
    expect((await read(julian, 'firehose'))[0]).toMatchObject({ by: { actor: SUPPORT }, from: null })
  })
})

describe("sync's records", () => {
  const author = { id: 'slack:user:U_EVE', handle: 'eve', name: 'Eve', avatar: null, isBot: false }

  /**
   * The ops project syncs Slack's C1 with firehose, and the support project may sync only in
   * support/, under the same key: a Slack thread ops syncs is its, not support's.
   */
  async function synced() {
    const team = testBoard()
    await grant(team, 'prj_support', { 'support/': 'all' })
    await grant(team, 'prj_ops', 'all')
    const support = caller(team.fetch, await supportToken())
    const ops = caller(team.fetch, await deploymentToken('ops', 'prj_ops', 'production'))
    const julian = await julianOn(team.fetch)
    for (const as of [support, ops]) expect((await as('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const inC1 = (message: string) => ({ channel: 'slack:C1', thread: 'slack:C1:100', subthread: null, message, context: null })
    const ada = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    const incident = (await ops('POST', '/sync/imports', { op: 'post', author: ada, from: 'slack', channel: 'firehose', text: 'the incident', origin: inC1('100') })).body.message as string
    /** A Slack reply in ops's thread lands in its board thread, wherever else it could have gone. */
    const replied = async () => {
      const bob = { ...ada, id: 'slack:user:U_BOB', handle: 'bob', name: 'Bob' }
      expect((await ops('POST', '/sync/imports', { op: 'post', author: bob, from: 'slack', re: incident, text: 'the fix is in the runbook', origin: inC1('101') })).status).toBe(200)
      expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['the incident', 'the fix is in the runbook'])
    }
    return { team, support, ops, julian, incident: { id: incident }, replied }
  }

  it("tells two platform messages apart when their thread and message read the same joined by a bar", async () => {
    const { support, julian } = await synced()
    const origin = (thread: string, message: string) => ({ channel: 'slack:C1', thread, subthread: null, message, context: null })
    const root = (text: string, at: ReturnType<typeof origin>) => support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text, origin: at })
    expect((await root('first', origin('slack:C1:700', 'b|c'))).status).toBe(200)
    expect((await root('second', origin('slack:C1:700|b', 'c'))).status).toBe(200)
    // An edit by its platform message changes that one, not the other.
    expect((await support('POST', '/sync/imports', { op: 'edit', author, from: 'slack', origin: { thread: 'slack:C1:700|b', message: 'c' }, text: 'second, edited' })).status).toBe(200)
    expect((await read(julian, 'support/inbox')).map((m) => m.text)).toEqual(['first', 'second, edited'])
  })

  it("won't let an import's origin take a platform thread or message another board thread syncs with", async () => {
    const { support, julian, replied } = await synced()
    const origin = (thread: string, message: string, subthread: string | null = null) => ({ channel: 'slack:C1', thread, subthread, message, context: null })
    const root = (body: object) => support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'mine now', ...body })
    // A new root from ops's Slack thread.
    const taken = await root({ origin: origin('slack:C1:100', '999') })
    expect([taken.status, taken.body.error?.code]).toEqual([409, 'already_synced'])
    // Or one whose exact platform thread is in another thread, claiming a message there the board
    // doesn't have yet: its edits, and its replies' text, would land in this one.
    const across = await root({ origin: origin('slack:C1:555', '999', 'slack:C1:100') })
    expect([across.status, across.body.error?.message]).toEqual([400, "an import's subthread is in its thread: slack:C1:100 isn't in slack:C1:555"])
    // A reply in its own thread, from a platform thread that isn't that thread's.
    const own = (await root({ text: 'a thread of its own' })).body.message as string
    const reply = await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', re: own, text: 'mine too', origin: origin('slack:C1:100', '998') })
    expect([reply.status, reply.body.error?.code]).toEqual([409, 'already_synced'])
    // Nor from a platform it doesn't sync under that key, or with no key at all.
    const elsewhere = await root({ origin: { thread: 'github:acme/www:12', subthread: null, message: '1', context: null } })
    expect([elsewhere.status, elsewhere.body.error?.code]).toEqual([400, 'invalid_request'])
    const keyless = await root({ from: null, origin: origin('slack:C1:556', '1') })
    expect([keyless.status, keyless.body.error?.code]).toEqual([400, 'invalid_request'])
    expect((await read(julian, 'support/inbox')).map((m) => m.text)).toEqual(['a thread of its own'])
    // From a Slack thread of its own, a reply from one of that thread's own threads lands.
    const mine = (await root({ text: 'from C5', origin: origin('slack:C5:1', '1') })).body.message as string
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', re: mine, text: 'in review', origin: origin('slack:C5:1', '2', 'slack:C5:1:rc:9') })).status).toBe(200)
    await replied()
  })

  it("won't let a receipt take a platform thread or message another board thread syncs with, or name a target its thread lacks", async () => {
    const { support, julian, replied, incident } = await synced()
    const own = (await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'a thread of its own' })).body.message as string
    expect((await support('POST', '/sync/receipts', { kind: 'thread', message: own, target: 'slack:C9', targetKind: 'channel', cause: 'request' })).status).toBe(200)
    const receipt = (target: string, external: { thread: string; message: string }) => support('POST', '/sync/receipts', { kind: 'message', message: own, target, external })
    // Its root landed in the team's Slack thread, or as the team's root there.
    for (const external of [{ thread: 'slack:C1:100', message: '777' }, { thread: 'slack:C1:100', message: '100' }]) {
      const taken = await receipt('slack:C9', external)
      expect([taken.status, taken.body.error?.code], JSON.stringify(external)).toEqual([409, 'already_synced'])
    }
    // A target its thread doesn't sync with, or one under a key it doesn't sync.
    const unsynced = await receipt('slack:C7', { thread: 'slack:C7:300', message: '300' })
    expect([unsynced.status, unsynced.body.error?.code]).toEqual([400, 'not_a_target'])
    expect((await support('POST', '/sync/receipts', { kind: 'thread', message: own, target: 'github:acme/www:12', targetKind: 'thread', cause: 'request' })).status).toBe(200)
    expect((await receipt('github:acme/www:12', { thread: 'github:acme/www:12', message: '1' })).status).toBe(403)
    expect((await support('POST', '/sync/receipts', { kind: 'failed', message: own, target: 'slack:C7', error: 'gone' })).body.error?.code).toBe('not_a_target')
    // Its own delivery lands, and a copy is one board message's.
    expect((await receipt('slack:C9', { thread: 'slack:C9:200', message: '200' })).status).toBe(200)
    const reply = (await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', re: own, text: 'and a reply' })).body.message as string
    const twice = await support('POST', '/sync/receipts', { kind: 'message', message: reply, target: 'slack:C9', external: { thread: 'slack:C9:200', message: '200' } })
    expect([twice.status, twice.body.error?.code]).toEqual([409, 'already_synced'])
    expect((await julian('GET', `/messages/${incident.id}`)).body.message.undelivered).toEqual({})
    await replied()
  })
})

describe('whose records are whose', () => {
  const author = { id: 'slack:user:U_EVE', handle: 'eve', name: 'Eve', avatar: null, isBot: false }
  const entry = { key: 'slack', platform: 'slack' }
  const inC = (channel: string, thread: string, message: string) => ({ channel: `slack:${channel}`, thread: `slack:${channel}:${thread}`, subthread: null, message, context: null })

  it("keeps this board's own sync's keys its own: a sync elsewhere can't register one, or record under one it registered before", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect(await support('POST', '/watchers', { watch: {}, sync: [entry] })).toEqual({
      status: 409,
      body: { error: { code: 'sync_key_taken', message: "this board's own sync has sync entry slack: give yours another key" } },
    })
    // One it registered before the board's own sync had the key.
    const registry = team.servers[3]!.session(REGISTRY_SESSION) as unknown as { append(event: { type: string; payload: unknown }): Promise<unknown> }
    await registry.append({
      type: 'watchers.registered',
      payload: { owner: SUPPORT, principal: { id: SUPPORT, kind: 'deployment', handle: 'support' }, url: null, watch: {}, sync: [entry], hash: 'before' },
    })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })).body.message
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.message.undelivered).toEqual({}))
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    // A receipt saying the post is another Slack message the app posted, which an edit of it would then change, and an import claiming one.
    const forged = await support('POST', '/sync/receipts', { kind: 'message', message: root.id, target: 'slack:C1', external: { thread: 'slack:C1:555', message: '555' } })
    expect([forged.status, forged.body.error?.message]).toEqual([403, "this token doesn't sync slack here: its board registers its sync entries"])
    const claimed = await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'firehose', text: 'mine', origin: inC('C1', '777', '777') })
    expect(claimed.status).toBe(403)
    // So an edit changes only the copy its own sync made.
    await julian('POST', `/messages/${root.id}/edit`, { text: 'deploy fixed' })
    await vi.waitFor(() => expect(s.edits.map((edit) => edit.messageId)).toEqual([s.channelPosts[0]!.id]))
  })

  it('shows a sync elsewhere only the copies it made, and lets only it say what their files are', async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    await grant(team, 'prj_ops', 'all')
    const support = caller(team.fetch, await supportToken())
    const ops = caller(team.fetch, await deploymentToken('ops', 'prj_ops', 'production'))
    // Two syncs under one key, each with its own Slack app.
    for (const as of [support, ops]) expect((await as('POST', '/watchers', { watch: {}, sync: [entry] })).status).toBe(200)
    const root = (await ops('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'firehose', text: 'deploy failed', origin: inC('C1', '100', '100') })).body.message as string
    expect((await ops('POST', '/sync/receipts', { kind: 'thread', message: root, target: 'slack:C9', targetKind: 'channel', cause: 'request' })).status).toBe(200)
    expect((await ops('POST', '/sync/receipts', { kind: 'message', message: root, target: 'slack:C9', external: { thread: 'slack:C9:200', message: '200' } })).status).toBe(200)
    // Support says ops's copy carried files its own app has, which deleting the post would delete with ops's.
    expect((await support('POST', '/sync/receipts', { kind: 'files', message: root, target: 'slack:C9', files: ['F_SUPPORTS'] })).status).toBe(200)
    const copies = async (as: typeof ops) => (await as('GET', `/sync/copies?message=${root}`)).body.copies[root]
    expect(await copies(ops)).toEqual({ 'slack:C1:100': { thread: 'slack:C1:100', message: '100' }, 'slack:C9': { thread: 'slack:C9:200', message: '200' } })
    expect(await copies(support)).toEqual({})
  })

  it('refuses a caller narrowed with x-board-can what its sync records', async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: {}, sync: [entry] })).status).toBe(200)
    const own = (await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'from Slack' })).body.message as string
    // A sandbox with the project's token, narrowed to support/: what it claimed there, its project's sync would fill from anywhere.
    const narrowed = caller(team.fetch, await supportToken(), { 'x-board-can': 'support/=all' })
    const pushed = { id: 'e1', event: { kind: 'deleted', channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1' }, raw: null }
    for (const [method, path, body] of [
      ['POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'claimed', origin: inC('C7', '1', '1') }],
      ['POST', '/sync/receipts', { kind: 'failed', message: own, target: 'slack:C9', error: 'gone' }],
      ['POST', '/inbox/slack', { events: [pushed] }],
      ['GET', '/inbox/slack/next', undefined],
      ['POST', '/inbox/slack/e1/ack', { lease: 'l1' }],
    ] as const) {
      const refused = await narrowed(method, path, body)
      expect([refused.status, refused.body.error?.message], path).toEqual([403, expect.stringContaining('narrowed with x-board-can')])
    }
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'claimed', origin: inC('C7', '1', '1') })).status).toBe(200)
  })
})

/** `vb` as Julian, in process, on the board `team` serves. */
const vbOn = async (team: ReturnType<typeof testBoard>) => {
  const token = await personToken('julian', BOARD_URL)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    request.headers.set('authorization', `Bearer ${token}`)
    return team.fetch(request)
  }) as typeof globalThis.fetch
  const handle = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
  return (args: string[]) => vb(handle, args)
}

describe('who an import is by', () => {
  const malte = { id: 'slack-eu:user:U_MALTE', handle: 'malte', name: 'Malte', avatar: null, isBot: false }

  it("is a sync elsewhere's platform user as a profile of its principal, shown through its project, and the board's own sync's as the platform user", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    // g2 lets every project on the team sync, its previews included.
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'preview'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    expect((await support('POST', '/sync/imports', { op: 'post', author: malte, from: 'slack-eu', channel: 'firehose', text: 'ship it, I checked' })).status).toBe(200)
    await team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'the export page is blank', user: 'U_ADA', name: 'Ada' }) }))
    const julian = await julianOn(team.fetch)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    const messages = (await julian('GET', '/messages?channel=firehose')).body.messages as MessageView[]
    expect(messages.map((m) => [m.text, m.by.actor, m.by.principal, m.by.profile, m.author?.via])).toEqual([
      ['ship it, I checked', 'vercel:project:prj_support:preview+slack-eu:user:U_MALTE', 'vercel:project:prj_support:preview', 'slack-eu:user:U_MALTE', { name: 'support', environment: 'preview' }],
      ['the export page is blank', 'slack:user:U_ADA', 'slack:user:U_ADA', null, undefined],
    ])
    const read_ = await (await vbOn(team))(['read', 'firehose'])
    expect(read_.stdout).toMatch(/^firehose · 2 threads · cursor \d+\n\n#\d+  Malte via support \(preview\) · \d+s\n {6}ship it, I checked\n {6}no replies\n\n#\d+  Ada · \d+s\n {6}the export page is blank\n {6}no replies\n\nnew since then: vb read firehose --after \d+\n$/)
  })

  it("keeps two syncs' imports of one platform user apart: two actors, which the inspector never groups", async () => {
    const team = testBoard()
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'preview'))
    const web = caller(team.fetch, await deploymentToken('web', 'prj_web', 'production'))
    for (const as of [support, web]) expect((await as('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    const post = (as: typeof support, text: string, re?: string) =>
      as('POST', '/sync/imports', { op: 'post', author: malte, from: 'slack-eu', ...(re === undefined ? { channel: 'firehose' } : { re }), text })
    // The inspector groups a thread's replies, never its roots: so a thread, and three replies in it.
    const root = (await post(support, 'zero')).body.message as string
    for (const [as, text] of [[support, 'one'], [support, 'two'], [web, 'three']] as const) expect((await post(as, text, root)).status).toBe(200)
    const julian = await julianOn(team.fetch)
    const [, one, two, three] = (await julian('GET', '/messages?channel=firehose')).body.messages as MessageView[]
    expect([one!.by.actor, three!.by.actor]).toEqual(['vercel:project:prj_support:preview+slack-eu:user:U_MALTE', 'vercel:project:prj_web:production+slack-eu:user:U_MALTE'])
    // One sync's Malte twice runs on as one; the other's Malte, right after, starts anew.
    expect([continues(one, two!), continues(two, three!)]).toEqual([true, false])
    const actors = (await (await vbOn(team))(['actors'])).stdout.split('\n').filter((line) => line.includes('U_MALTE'))
    expect(actors.sort()).toEqual([
      '@support/malte  Malte via support (preview)  vercel:project:prj_support:preview+slack-eu:user:U_MALTE',
      '@web/malte  Malte via web  vercel:project:prj_web:production+slack-eu:user:U_MALTE',
    ])
  })

  it("is mentioned natively on Slack only by the sync that speaks for them: the board's own names a sync elsewhere's by name", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'preview'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    expect((await support('POST', '/sync/imports', { op: 'post', author: malte, from: 'slack-eu', channel: 'support', text: 'hi' })).status).toBe(200)
    await team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U_ADA', name: 'Ada' }) }))
    const julian = await julianOn(team.fetch)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await julian('POST', '/messages', { channel: 'firehose', text: '@[slack:user:U_ADA] and @[vercel:project:prj_support:preview+slack-eu:user:U_MALTE], have a look' })
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '**julian**: <@U_ADA> and Malte, have a look' })]))
  })

  it("tells the middleware who an import lands as: a sync elsewhere's profile of its user, or the board's own sync's user", async () => {
    const s = fakePlatform('slack')
    const authors: string[] = []
    const team = testBoard({
      sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) },
      middleware: [
        async ({ write, author, next }) => {
          if (write.kind === 'post') authors.push(author.id)
          await next()
        },
      ],
    })
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'preview'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    expect((await support('POST', '/sync/imports', { op: 'post', author: malte, from: 'slack-eu', channel: 'firehose', text: 'ship it' })).status).toBe(200)
    await team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U_ADA', name: 'Ada' }) }))
    await vi.waitFor(() => expect(authors).toEqual(['vercel:project:prj_support:preview+slack-eu:user:U_MALTE', 'slack:user:U_ADA']))
    const messages = (await (await julianOn(team.fetch))('GET', '/messages?channel=firehose')).body.messages as MessageView[]
    expect(messages.map((m) => m.by.actor)).toEqual(authors)
  })

  it("lets a sync change by board ID only what its own platform user wrote, not another of its users'", async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    const ada = { id: 'slack-eu:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    const id = (await support('POST', '/sync/imports', { op: 'post', author: malte, from: 'slack-eu', channel: 'firehose', text: 'mine' })).body.message
    const edit = (author: typeof malte) => support('POST', '/sync/imports', { op: 'edit', author, from: null, message: id, text: 'changed' })
    const refused = await edit(ada)
    expect([refused.status, refused.body.error.message]).toEqual([403, 'only the author can edit a message'])
    expect((await edit(malte)).status).toBe(200)
    expect((await read(await julianOn(team.fetch), 'firehose')).map((m) => m.text)).toEqual(['changed'])
  })

  it("shows Vercel's deployment comment a sync elsewhere imported from GitHub as its deployments, and a look-alike under another GitHub user as written", async () => {
    const asked = vi.spyOn(SlackProvider.prototype, 'post')
    try {
      const s = fakePlatform('slack')
      const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
      await grant(team, 'prj_support', 'all')
      const support = caller(team.fetch, await supportToken())
      expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'github', platform: 'github' }] })).status).toBe(200)
      const bot = { id: 'github:user:35613825', handle: 'vercel[bot]', name: 'vercel[bot]', avatar: null, isBot: true }
      const lookAlike = { ...bot, id: 'github:user:999' }
      const ids: string[] = []
      for (const author of [bot, lookAlike]) {
        const imported = await support('POST', '/sync/imports', { op: 'post', author, from: 'github', channel: 'firehose', text: VERCEL_BUILDING })
        expect(imported.status).toBe(200)
        ids.push(imported.body.message)
      }
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2))
      const [vercel, other] = asked.mock.calls.map(([, , body]) => body)
      expect(vercel!.markdown).toContain('**▲ Vercel**\n- ⏳ **[acme-agents](https://vercel.com/acme/acme-agents)** · [Building]')
      expect(vercel!.deployments).toMatchObject([{ project: 'acme-agents', status: 'Building' }])
      expect(other!.markdown).toContain('| Project |')
      expect(other).not.toHaveProperty('deployments')
      const vbRead = await vbOn(team)
      const [botsRead, othersRead] = [(await vbRead(['read', ids[0]!])).stdout, (await vbRead(['read', ids[1]!])).stdout]
      expect(botsRead).toContain('▲ Vercel')
      expect(botsRead).not.toContain('| Project |')
      expect(othersRead).toContain('| Project |')
      expect(othersRead).not.toContain('▲ Vercel')
    } finally {
      asked.mockRestore()
    }
  })
})

describe('platform users, named by sync key', () => {
  const webhook = (team: ReturnType<typeof testBoard>, key: string, body: object) =>
    team.fetch(new Request(`${BOARD_URL}/webhooks/${key}`, { method: 'POST', body: JSON.stringify({ type: 'message', ...body }) }))

  it("are named for the key they came through, with that key's platform to show them by", async () => {
    const eu = fakePlatform('slack')
    const team = testBoard({ sync: { 'slack-eu': slack({ adapter: eu.adapter }, channels({ C9: 'firehose' })) } })
    await webhook(team, 'slack-eu', { threadId: 'slack:C9:100', id: '100', text: 'the export page is blank', user: 'U_ADA', name: 'Ada' })
    const julian = await julianOn(team.fetch)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [message] = (await julian('GET', '/messages?channel=firehose')).body.messages as MessageView[]
    expect([message!.by.actor, message!.from, message!.author]).toEqual(['slack-eu:user:U_ADA', 'slack-eu', { kind: 'external', handle: 'Ada', name: 'Ada', avatar: null, platform: 'slack' }])
    // The inspector shows its key's platform's logo, even where the board's sync entries don't list the key, as on Vercel's board.
    expect([sourcePlatform(message!), sourcePlatform({ ...message!, author: null })]).toEqual(['slack', 'slack-eu'])
  })

  it('are mentioned natively only by the sync of their own key, and by name through any other', async () => {
    const us = fakePlatform('slack')
    const eu = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: us.adapter }, channels({ C1: 'firehose' })), 'slack-eu': slack({ adapter: eu.adapter }, channels({ C9: 'firehose' })) } })
    await webhook(team, 'slack', { threadId: 'slack:C1:100', id: '100', text: 'hi', user: 'U_ADA', name: 'Ada' })
    await webhook(team, 'slack-eu', { threadId: 'slack:C9:200', id: '200', text: 'hej', user: 'U_BOB', name: 'Bob' })
    const julian = await julianOn(team.fetch)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    await julian('POST', '/messages', { channel: 'firehose', text: '@[slack:user:U_ADA] and @[slack-eu:user:U_BOB], have a look' })
    await vi.waitFor(() => expect([...us.channelPosts, ...eu.channelPosts].filter((post) => post.text.includes('have a look'))).toHaveLength(2))
    const posted = (platform: typeof us) => platform.channelPosts.find((post) => post.text.includes('have a look'))!.text
    expect([posted(us), posted(eu)]).toEqual([
      JSON.stringify({ markdown: '**julian**: <@U_ADA> and Bob, have a look' }),
      JSON.stringify({ markdown: '**julian**: Ada and <@U_BOB>, have a look' }),
    ])
  })

  it("maps an import's mention of one of its key's users to its own profile of them", async () => {
    const team = testBoard()
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'preview'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    const ada = { id: 'slack-eu:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    expect((await support('POST', '/sync/imports', { op: 'post', author: ada, from: 'slack-eu', channel: 'support', text: 'hi' })).status).toBe(200)
    const bob = { ...ada, id: 'slack-eu:user:U_BOB', handle: 'bob', name: 'Bob' }
    const id = (await support('POST', '/sync/imports', { op: 'post', author: bob, from: 'slack-eu', channel: 'firehose', text: 'cc @[slack-eu:user:U_ADA]' })).body.message
    const { message } = (await (await julianOn(team.fetch))('GET', `/messages/${id}`)).body as { message: MessageView }
    expect(message.text).toBe('cc @[vercel:project:prj_support:preview+slack-eu:user:U_ADA]')
  })
})

describe("an imported platform user's handle", () => {
  it("is under its importer's project name, in every environment, and typable: two projects' Maltes are support/malte and www/malte", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'preview'))
    const www = caller(team.fetch, await deploymentToken('www', 'prj_www', 'production'))
    const imported = async (as: typeof support, author: object, text: string) => {
      expect((await as('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
      expect((await as('POST', '/sync/imports', { op: 'post', author, from: 'slack-eu', channel: 'support', text })).status).toBe(200)
    }
    const malte = { id: 'slack-eu:user:U_MALTE', handle: 'Malte Ubl', name: 'Malte Ubl', avatar: null, isBot: false }
    await imported(support, malte, 'one')
    await imported(www, malte, 'two')
    await imported(www, { ...malte, id: 'slack-eu:user:U_SHRUG', handle: '¯\\_(ツ)_/¯', name: 'Shrug' }, 'three')
    await imported(support, { ...malte, id: 'slack-eu:T_EU:U0JURGEN', handle: 'Jürgen', name: 'Jürgen' }, 'four')
    await imported(support, { ...malte, id: 'slack-eu:T_EU:U0STAR', handle: '***', name: 'Star' }, 'five')
    // The board's own sync's user is themselves, as Slack names them.
    await team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hi', user: 'U_ADA', name: 'Ada' }) }))
    const julian = await julianOn(team.fetch)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const actors = (await (await vbOn(team))(['actors'])).stdout.split('\n').filter((line) => line.includes('slack'))
    expect(actors.sort()).toEqual([
      '@Ada  Ada  slack:user:U_ADA',
      '@support/jurgen  Jürgen via support (preview)  vercel:project:prj_support:preview+slack-eu:T_EU:U0JURGEN',
      '@support/malte-ubl  Malte Ubl via support (preview)  vercel:project:prj_support:preview+slack-eu:user:U_MALTE',
      '@support/t_eu-u0star  Star via support (preview)  vercel:project:prj_support:preview+slack-eu:T_EU:U0STAR',
      '@www/malte-ubl  Malte Ubl via www  vercel:project:prj_www:production+slack-eu:user:U_MALTE',
      '@www/user-u_shrug  Shrug via www  vercel:project:prj_www:production+slack-eu:user:U_SHRUG',
    ])
  })

  it('fits a long one under its project, so the import lands', async () => {
    const team = testBoard()
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'production'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    const author = { id: 'slack-eu:user:U_LONG', handle: 'a'.repeat(125), name: 'Long', avatar: null, isBot: false }
    const imported = await support('POST', '/sync/imports', { op: 'post', author, from: 'slack-eu', channel: 'support', text: 'hi' })
    expect(imported.status).toBe(200)
    const { message } = (await (await julianOn(team.fetch))('GET', `/messages/${imported.body.message}`)).body as { message: MessageView }
    expect(message.author?.handle).toBe(`support/${'a'.repeat(120)}`)
  })

  it("is what mention filters find, and a project's name covers everyone it imported", async () => {
    const team = testBoard()
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'production'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack-eu', platform: 'slack' }] })).status).toBe(200)
    const malte = { id: 'slack-eu:user:U_MALTE', handle: 'malte', name: 'Malte', avatar: null, isBot: false }
    expect((await support('POST', '/sync/imports', { op: 'post', author: malte, from: 'slack-eu', channel: 'support', text: 'hi' })).status).toBe(200)
    expect((await support('POST', '/messages', { channel: 'support', text: 'deployed' })).status).toBe(201)
    const julian = await julianOn(team.fetch)
    for (const text of ['@support/malte can you look?', 'cc @[vercel:project:prj_support:production+slack-eu:user:U_MALTE]', 'thanks @support', '@malte alone', '@supported'])
      await julian('POST', '/messages', { channel: 'dev', text })
    const texts = async (mentions: string) => ((await julian('GET', `/messages?channel=dev&mentions=${encodeURIComponent(mentions)}`)).body.messages as Read[]).map((m) => m.text)
    // A handle one actor has in full was stored as a mention of them: support's Malte, and support itself. `@malte` alone is no one's.
    const mentioned = '@[vercel:project:prj_support:production+slack-eu:user:U_MALTE]'
    expect(await texts('support/malte')).toEqual([`${mentioned} can you look?`, `cc ${mentioned}`])
    expect(await texts('support')).toEqual([`${mentioned} can you look?`, `cc ${mentioned}`, 'thanks @[vercel:project:prj_support:production]'])
  })
})

describe('mentions, as sync posts them', () => {
  const webhook = (team: ReturnType<typeof testBoard>, body: object) =>
    team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', ...body }) }))
  const texts = async (as: ReturnType<typeof caller>, query: string) => ((await as('GET', `/messages?${query}`)).body.messages as Read[]).map((m) => m.text)

  it("are no one a sync granted one channel imported, for a handle they only have under its name", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    await grant(team, 'prj_support', { 'support/': 'all' })
    const support = caller(team.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    // Support may sync only support/, and imports a user who goes by julian.
    const squatter = { id: 'helpdesk:user:U_X', handle: 'julian', name: 'Not Julian', avatar: null, isBot: false }
    expect((await support('POST', '/sync/imports', { op: 'post', author: squatter, from: 'helpdesk', channel: 'support/x', text: 'hi' })).status).toBe(200)
    const julian = await julianOn(team.fetch)
    const posted = await julian('POST', '/messages', { channel: 'firehose', text: '@julian look' })
    // No one has written as julian yet, and what support imported goes by support/julian: it's a candidate, never the one named.
    expect([posted.status, posted.body.message?.text]).toEqual([201, '@julian look'])
    expect(posted.body.mentions).toEqual([{ written: '@julian', actor: null, candidates: [{ id: 'vercel:project:prj_support:production+helpdesk:user:U_X', handle: 'support/julian', name: 'Not Julian' }] }])
    expect(await texts(julian, 'mentions=me')).toEqual(['@julian look'])
    // So the board's own Slack is sent the handle as written.
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '**julian**: @julian look' })]))
  })

  it("are text two syncs' imports of one person don't make ambiguous", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    const support = caller(team.fetch, await deploymentToken('support', 'prj_support', 'production'))
    const web = caller(team.fetch, await deploymentToken('web', 'prj_web', 'production'))
    for (const [as, key, user] of [[support, 'helpdesk', 'U_M1'], [web, 'webchat', 'U_M2']] as const) {
      expect((await as('POST', '/watchers', { watch: {}, sync: [{ key, platform: 'slack' }] })).status).toBe(200)
      const malte = { id: `${key}:user:${user}`, handle: 'malte', name: 'Malte', avatar: null, isBot: false }
      expect((await as('POST', '/sync/imports', { op: 'post', author: malte, from: key, channel: 'support', text: 'hi' })).status).toBe(200)
    }
    const julian = await julianOn(team.fetch)
    const posted = await julian('POST', '/messages', { channel: 'firehose', text: '@malte have a look' })
    expect([posted.status, posted.body.message?.text]).toEqual([201, '@malte have a look'])
    expect(await texts(julian, 'mentions=malte')).toEqual(['@malte have a look'])
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '**julian**: @malte have a look' })]))
  })

  it("go out natively for the one of a sync's users with the handle, or of several, the one who wrote in the thread", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    const julian = await julianOn(team.fetch)
    await webhook(team, { threadId: 'slack:C1:100', id: '100', text: 'deploys are slow', user: 'U_ADA', name: 'Ada' })
    await webhook(team, { threadId: 'slack:C1:200', id: '200', text: 'checkout is down', user: 'U_M1', name: 'Malte' })
    await webhook(team, { threadId: 'slack:C1:300', id: '300', text: 'search is down', user: 'U_M2', name: 'Malte' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(3))
    const [, checkout, search] = await read(julian, 'firehose')
    await julian('POST', '/messages', { re: checkout!.id, text: '@ada and @malte, have a look' })
    await julian('POST', '/messages', { re: search!.id, text: '@malte too' })
    await julian('POST', '/messages', { channel: 'firehose', text: '@malte, both of you' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(2))
    expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([
      ['slack:C1:200', JSON.stringify({ markdown: '**julian**: <@U_ADA> and <@U_M1>, have a look' })],
      ['slack:C1:300', JSON.stringify({ markdown: '**julian**: <@U_M2> too' })],
    ])
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '**julian**: @malte, both of you' })]))
  })
})

describe("platform users' records", () => {
  it("are each principal's own: a sync names its own profiles of platform users, never another's or the board's own sync's", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    await grant(team, 'prj_support', { 'support/': 'all' })
    await grant(team, 'prj_all', 'all')
    const support = caller(team.fetch, await supportToken())
    const everywhere = caller(team.fetch, await deploymentToken('all', 'prj_all', 'production'))
    const julian = await julianOn(team.fetch)
    for (const as of [support, everywhere]) expect((await as('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    const eve = { id: 'helpdesk:user:U_EVE', handle: 'eve', name: 'Eve', avatar: 'https://avatars.test/eve.png', isBot: false }
    const imported = (as: typeof support, author: object, channel: string) => as('POST', '/sync/imports', { op: 'post', author, from: 'helpdesk', channel, text: 'hi' })
    const record = async (id: string) =>
      ((await julian('GET', '/actors')).body.actors as { id: string; handle: string; name: string; avatar: string | null }[]).find((actor) => actor.id === id)
    // The board's own sync's Eve, whom it checked with Slack, and the one a project that syncs everywhere speaks for.
    await team.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U_EVE', name: 'Eve' }) }))
    await vi.waitFor(async () => expect(await record('slack:user:U_EVE')).toMatchObject({ name: 'Eve' }))
    expect((await imported(everywhere, eve, 'firehose')).status).toBe(200)
    expect(await record(`vercel:project:prj_all:production+${eve.id}`)).toMatchObject({ name: 'Eve', avatar: 'https://avatars.test/eve.png', via: { name: 'all', environment: 'production' } })

    // Support's Eve is its own: it names her what it likes, through itself, and no one else's changes.
    const renamed = { ...eve, handle: 'ceo', name: 'The CEO', avatar: 'https://tracker.test/pixel.png' }
    const message = async (id: string) => (await julian('GET', `/messages/${id}`)).body.message
    expect(await message((await imported(support, renamed, 'support/inbox')).body.message)).toMatchObject({
      by: { actor: `${SUPPORT}+${eve.id}`, principal: SUPPORT, profile: eve.id },
      author: { name: 'The CEO', via: { name: 'support', environment: 'production' } },
    })
    expect((await imported(support, { ...renamed, name: 'The New CEO' }, 'support/inbox')).status).toBe(200)
    expect(await record(`${SUPPORT}+${eve.id}`)).toMatchObject({ handle: 'support/ceo', name: 'The New CEO' })
    expect(await record(`vercel:project:prj_all:production+${eve.id}`)).toMatchObject({ handle: 'all/eve', name: 'Eve', avatar: 'https://avatars.test/eve.png' })
    expect(await record('slack:user:U_EVE')).toMatchObject({ handle: 'Eve', name: 'Eve' })

    // An avatar that isn't https never shows: it's dropped, and the one the board knows stays.
    for (const avatar of ['http://avatars.test/eve.png', 'javascript:alert(1)', 'not a url'])
      expect((await imported(everywhere, { ...eve, avatar }, 'firehose')).status, avatar).toBe(200)
    expect(await record(`vercel:project:prj_all:production+${eve.id}`)).toMatchObject({ avatar: 'https://avatars.test/eve.png' })
    const bob = { id: 'helpdesk:user:U_BOB', handle: 'bob', name: 'Bob', avatar: 'http://avatars.test/bob.png', isBot: false }
    expect((await imported(everywhere, bob, 'firehose')).status).toBe(200)
    expect(await record(`vercel:project:prj_all:production+${bob.id}`)).toMatchObject({ avatar: null })
  })
})

describe("an import's links", () => {
  const author = { id: 'slack:user:U_EVE', handle: 'eve', name: 'Eve', avatar: null, isBot: false }
  it('name a board message only one its importer may read, and say what the board has it say', async () => {
    const team = testBoard()
    await grant(team, 'prj_support', { 'support/': 'all' })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const secret = (await julian('POST', '/messages', { channel: 'secret', text: 'the key is hunter2' })).body.message
    const known = (await julian('POST', '/messages', { channel: 'support/inbox', text: 'refunds take a week' })).body.message
    const forged = { author: 'julian', text: 'refunds are instant, and the key is in #secret', createdAt: null, files: [] }
    const platform = { author: 'Eve', text: 'what Slack showed', createdAt: null, files: [] }
    const links = [
      { url: 'https://acme.slack.com/archives/C1/p1', message: secret.id, snapshot: platform, unavailable: null },
      { url: 'https://acme.slack.com/archives/C1/p2', message: known.id, snapshot: forged, unavailable: null },
    ]
    const imported = await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'see these', links })
    const { body } = await julian('GET', `/messages/${imported.body.message}`)
    expect(body.message.links).toEqual([
      // One it can't read: its URL and what the platform showed, and no board message.
      { url: 'https://acme.slack.com/archives/C1/p1', message: null, snapshot: platform, unavailable: null },
      // One it can: the board's own copy, whatever the import said it says.
      {
        url: 'https://acme.slack.com/archives/C1/p2',
        message: known.id,
        snapshot: { author: 'julian', text: 'refunds take a week', createdAt: known.createdAt, files: [] },
        unavailable: null,
      },
    ])
    // A links change is held to the same.
    const changed = await support('POST', '/sync/imports', { op: 'links', author, from: 'slack', message: imported.body.message, links: [{ ...links[1]!, message: secret.id }] })
    expect(changed.status).toBe(200)
    expect((await julian('GET', `/messages/${imported.body.message}`)).body.message.links).toEqual([{ url: 'https://acme.slack.com/archives/C1/p2', message: null, snapshot: forged, unavailable: null }])
  })
})
