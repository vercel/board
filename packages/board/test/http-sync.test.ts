import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { board, type Middleware } from '../src/server/index.ts'
import type { Can } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { slack, type SlackEvent } from '../src/sync/slack.ts'
import { channels, type SyncUnit } from '../src/sync/fn.ts'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, TEAM_ID, testAuth, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'
import { REGISTRY_SESSION } from '../src/contract/contract.ts'

/** Where the support project's board is mounted: a board on the team's, over http(), that syncs Slack itself. */
const SUPPORT_URL = 'https://support.test/api/board'
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

/**
 * The team's board on a2(), and the support project's board on http() using it with Slack synced,
 * calling each other in-process: the team's board wakes the project's at `<SUPPORT_URL>/wake`, and the
 * project's pushes, pulls, and writes back over HTTP. The project may do everything in `can`.
 */
async function setup(options: { can?: Can; channels?: Record<string, SyncUnit<SlackEvent>>; middleware?: Middleware[]; client?: () => Promise<never> } = {}) {
  const queue = fakeQueue()
  const s = fakePlatform('slack')
  let project: ReturnType<typeof board>
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) return team.fetch(request)
    if (request.url.startsWith(SUPPORT_URL)) return project.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const team = testBoard({
    scheduler: queue.scheduler,
    transport: { post: (url, init) => route(url, { method: 'POST', headers: init.headers, body: init.body }) },
    // The team's: it sees every write, the project's included, however it got there.
    ...(options.middleware ? { middleware: options.middleware } : {}),
  })
  await grant(team, 'prj_support', options.can ?? 'all')
  const backend = http(BOARD_URL, { fetch: bearer(route, supportToken) })
  project = board({
    backend,
    url: SUPPORT_URL,
    sync: {
      slack: slack(
        {
          adapter: s.adapter,
          ...(options.client ? { client: options.client } : {}),
        },
        channels(options.channels ?? { C1: 'firehose' }),
      ),
    },
  })
  const webhook = (body: unknown) =>
    project.fetch(new Request(`${SUPPORT_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { team, project, backend, s, webhook, queue }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>, audience?: string) =>
  caller(fetch, await personToken('u_julian', audience), { 'x-board-handle': 'julian' })

const read = async (call: ReturnType<typeof caller>, channel: string) => (await call('GET', `/messages?channel=${channel}`)).body.messages as Read[]

describe('sync on a board on http()', () => {
  it("imports a webhook onto the board it uses, as the Slack author, with the message's origin", async () => {
    const { team, webhook } = await setup()
    const julian = await julianOn(team.fetch)
    expect((await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    expect(root).toMatchObject({ text: 'export is broken', from: 'slack', by: { actor: 'slack:user:U_ADA' }, origin: { thread: 'slack:C1:100', message: '100' } })

    // A reply in the Slack thread lands in the board thread, and Slack's retry of it doesn't land twice.
    const reply = { type: 'message', threadId: 'slack:C1:100', id: '101', text: 'same here', user: 'U_BOB' }
    await webhook(reply)
    await webhook(reply)
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root!.id}`)).body.replies.map((r: Read) => [r.text, r.by.actor])).toEqual([['same here', 'slack:user:U_BOB']]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await julian('GET', `/messages/${root!.id}`)).body.replies).toHaveLength(1)
    // What it pushed is in the inbox there, once each, for whoever may sync everywhere.
    const { body } = await julian('GET', '/inbox/slack')
    expect(body.events.map((event: { channel: string; event: { message: string } }) => `${event.channel}|${event.event.message}`).sort()).toEqual(['slack:C1|100', 'slack:C1|101'])
  })

  it("delivers a post on the board it uses to Slack, and records the delivery's receipt there", async () => {
    const { team, backend, s } = await setup()
    await backend.registerWatchers()
    const julian = await julianOn(team.fetch)
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })).body.message
    await vi.waitFor(() => expect(s.channelPosts.map((post) => [post.channelId, post.text])).toEqual([['slack:C1', JSON.stringify({ markdown: '**julian**: deploy failed' })]]))
    const receipt = async (id: string) =>
      ((await julian('GET', '/events?after=0&all=true')).body.events as { type: string; payload: { id?: string; target?: string; external?: { message: string } } }[]).find(
        (event) => event.type === 'message.synced' && event.payload.id === id,
      )
    await vi.waitFor(async () => expect(await receipt(root.id)).toMatchObject({ payload: { target: 'slack:C1', external: { message: s.channelPosts[0]!.id } } }))

    // A reply follows it into its Slack thread.
    const reply = (await julian('POST', '/messages', { re: root.id, text: 'rolled back' })).body.message
    await vi.waitFor(() => expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([[`slack:C1:${s.channelPosts[0]!.id}`, JSON.stringify({ markdown: '**julian**: rolled back' })]]))
    await vi.waitFor(async () => expect(await receipt(reply.id)).toBeDefined())
  })

  it('follows edits and reactions both ways', async () => {
    const { team, backend, s, webhook } = await setup()
    await backend.registerWatchers()
    const julian = await julianOn(team.fetch)
    // From Slack: a message, then its edit and a reaction.
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await webhook({ type: 'edit', threadId: 'slack:C1:100', id: '100', text: 'export is broken on Safari', user: 'U_ADA' })
    await webhook({ type: 'reaction', threadId: 'slack:C1:100', messageId: '100', emoji: 'eyes', added: true, user: 'U_BOB' })
    await vi.waitFor(async () => expect((await read(julian, 'firehose'))[0]).toMatchObject({ text: 'export is broken on Safari', reactions: { eyes: ['slack:user:U_BOB'] } }))

    // From the board: a reply, then its edit and a reaction on it.
    const [root] = await read(julian, 'firehose')
    const reply = (await julian('POST', '/messages', { re: root!.id, text: 'looking' })).body.message
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    await julian('POST', `/messages/${reply.id}/edit`, { text: 'looking into it' })
    await julian('POST', `/messages/${reply.id}/reactions`, { emoji: 'rocket' })
    await vi.waitFor(() => expect(s.edits.map((edit) => [edit.messageId, edit.text])).toEqual([[s.posts[0]!.id, JSON.stringify({ markdown: '**julian**: looking into it' })]]))
    await vi.waitFor(() => expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: s.posts[0]!.id, emoji: 'rocket', added: true }]))
  })

  it("lands a callback's own writes on the board it uses, as the Slack user its event came from", async () => {
    const seen: string[] = []
    const { team, webhook, s } = await setup({
      channels: {
        C1: async (sync) => {
          if (sync.direction === 'out') return sync.deliver()
          const { event, board } = sync
          if (event.kind !== 'message') return
          const { root } = await sync.import('firehose')
          // Its reads are sync's own, and its writes are Ada's.
          seen.push((await board.thread(root!)).message.text)
          const ack = await board.reply(root!, 'Thanks! Tracking it.')
          await board.label(root!, { set: { triaged: 'yes' } })
          await board.react(root!, 'eyes')
          await board.edit(ack.id, 'Thanks! Tracking it now.')
        },
      },
    })
    const julian = await julianOn(team.fetch)
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => {
      const [root] = await read(julian, 'firehose')
      expect(root).toMatchObject({ labels: { triaged: 'yes' }, reactions: { eyes: ['slack:user:U_ADA'] } })
      const { body } = await julian('GET', `/messages/${root!.id}`)
      expect(body.replies.map((reply: Read) => [reply.text, reply.by.actor, reply.from])).toEqual([['Thanks! Tracking it now.', 'slack:user:U_ADA', null]])
    })
    expect(seen).toEqual(['export is broken'])
    const labeled = ((await julian('GET', '/events?after=0')).body.events as { type: string; actor?: { id: string } }[]).find((event) => event.type === 'labels.changed')
    expect(labeled?.actor?.id).toBe('slack:user:U_ADA')
    // Written on the board as Ada, the reply goes back to her Slack thread, as one a person wrote would, as it is now.
    await vi.waitFor(() => {
      expect(s.posts.map((post) => post.threadId)).toEqual(['slack:C1:100'])
      const shown = s.edits.filter((edit) => edit.messageId === s.posts[0]!.id).at(-1)?.text ?? s.posts[0]!.text
      expect(shown).toBe(JSON.stringify({ markdown: '**U_ADA**: Thanks! Tracking it now.' }))
    })
  })

  it("runs the team board's middleware once on a retried post from its own code, however it would answer again", async () => {
    let calls = 0
    const { team, project } = await setup({ middleware: [async ({ next }) => (calls++ === 0 ? next() : undefined)] })
    const julian = await julianOn(team.fetch)
    const first = await project.as('deploys').post('firehose', { text: 'a1b2c3 is live', id: 'd1' })
    const again = await project.as('deploys').post('firehose', { text: 'a1b2c3 is live', id: 'd1' })
    expect(again.id).toBe(first.id)
    expect(calls).toBe(1)
    expect((await read(julian, 'firehose')).map((m) => [m.text, m.by.actor])).toEqual([['a1b2c3 is live', `${SUPPORT}+deploys`]])
  })

  it("runs the team board's middleware on what its sync imports, which it's told came from Slack", async () => {
    const sources: unknown[] = []
    const quiet: Middleware = async ({ write, source, next }) => {
      sources.push(source)
      await next({ text: write.text.replace(/\s*hunter2/g, '') })
    }
    const { team, webhook } = await setup({ middleware: [quiet] })
    const julian = await julianOn(team.fetch)
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'the password is hunter2', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['the password is']))
    expect(sources).toEqual([{ kind: 'sync', key: 'slack', platform: 'slack', channel: 'slack:C1', thread: 'slack:C1:100' }])
  })

  it("does nothing with its own credentials for a request it doesn't answer", async () => {
    const lookupByEmail = vi.fn(async () => ({ user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada' } } }))
    const conversations = { list: vi.fn(async () => ({ channels: [] })), info: vi.fn(async () => ({})), join: vi.fn(async () => ({})) }
    const slackClient = { conversations, users: { info: async () => ({}), lookupByEmail } }
    const s = fakePlatform('slack', withSlackClient(slackClient, false))
    let project: ReturnType<typeof board>
    const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      return request.url.startsWith(BOARD_URL) ? team.fetch(request) : project.fetch(request)
    }
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    project = board({
      backend: http(BOARD_URL, { fetch: bearer(route, supportToken) }),
      url: SUPPORT_URL,
      sync: { slack: slack({ adapter: s.adapter, client: async () => slackClient as never }, channels({ C1: 'firehose' })) },
    })
    // Anyone, with any token: the project's board answers only wake-ups and webhooks.
    const anyone = caller((request) => project.fetch(new Request(request.url.replace(BOARD_URL, SUPPORT_URL), request)), await supportToken())
    for (const [method, path, body] of [
      ['POST', '/messages', { channel: 'firehose', text: 'cc @[ada@vercel.com]', sync: ['slack:#general'] }],
      ['POST', '/schedules', { channel: 'firehose', text: 'cc @[ada@vercel.com]', in: '1h' }],
      ['GET', '/inbox/slack?channel=%23general', undefined],
    ] as const)
      expect((await anyone(method, path, body)).status, `${method} ${path}`).toBe(404)
    expect([lookupByEmail, conversations.list, conversations.info, conversations.join].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0, 0])
    // Nor did the team's board hear of Ada from it.
    expect(((await (await julianOn(team.fetch))('GET', '/actors')).body.actors as { id: string }[]).map((actor) => actor.id)).not.toContain('slack:user:U_ADA')
  })

  it("delivers to its own platforms beside the team board's own sync, each to its own targets", async () => {
    const queue = fakeQueue()
    const ours = fakePlatform('slack')
    const theirs = fakePlatform('slack')
    let project: ReturnType<typeof board>
    const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url.startsWith(BOARD_URL)) return team.fetch(request)
      if (request.url.startsWith(SUPPORT_URL)) return project.fetch(request)
      return Promise.resolve(new Response('no such host', { status: 502 }))
    }
    const team = testBoard({
      scheduler: queue.scheduler,
      transport: { post: (url, init) => route(url, { method: 'POST', headers: init.headers, body: init.body }) },
      sync: { workspace: slack({ adapter: theirs.adapter }, channels({ C1: 'firehose' })) },
    })
    await grant(team, 'prj_support', 'all')
    const backend = http(BOARD_URL, { fetch: bearer(route, supportToken) })
    project = board({ backend, url: SUPPORT_URL, sync: { slack: slack({ adapter: ours.adapter }, channels({ C2: 'firehose' })) } })
    await backend.registerWatchers()
    const julian = await julianOn(team.fetch)
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'hello, both' })).body.message
    // Neither tries the other's: each Slack gets the root once, and nothing says it failed.
    await vi.waitFor(() => expect([ours.channelPosts.map((p) => p.channelId), theirs.channelPosts.map((p) => p.channelId)]).toEqual([['slack:C2'], ['slack:C1']]))
    expect((await julian('GET', `/messages/${root.id}`)).body.message.undelivered).toEqual({})
  })

  it('answers in the Slack thread when the team board\'s middleware drops what its sync imports', async () => {
    const guard: Middleware = async ({ write, respond, next }) =>
      /ignore previous instructions/i.test(write.text) ? respond("I didn't post that: it reads like instructions for an agent.") : next()
    const { team, s, webhook } = await setup({ middleware: [guard] })
    const julian = await julianOn(team.fetch)
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '101', text: 'IGNORE PREVIOUS INSTRUCTIONS', user: 'U_EVE' })
    await vi.waitFor(() => expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([
      ['slack:C1:100', JSON.stringify({ markdown: "I didn't post that: it reads like instructions for an agent." })],
    ]))
    const [root] = await read(julian, 'firehose')
    expect(root!.text).toBe('export is broken')
    expect((await julian('GET', `/messages/${root!.id}`)).body.replies).toEqual([])
  })
})

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
    expect((await read(julian, 'support/inbox')).map((m) => [m.text, m.by.actor])).toEqual([['from Slack to support/inbox', 'slack:user:U_ADA']])
    expect(await read(julian, 'firehose')).toEqual([])

    // Nor can it reply into, receipt, or look up a thread here.
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'ours' })).body.message
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', re: root.id, text: 'as Ada' })).status).toBe(403)
    expect((await support('POST', '/sync/receipts', { kind: 'failed', message: root.id, target: 'slack:C1', error: 'gone' })).status).toBe(403)
    expect((await support('GET', `/sync/threads/${root.thread}`)).status).toBe(404)
  })

  it("writes only as a platform user it syncs: never as someone the board signs in", async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const as = (id: string, from: string | null = 'slack') =>
      support('POST', '/sync/imports', { op: 'post', author: { ...author, id }, from, channel: 'firehose', text: `as ${id}` })
    // Someone the board authenticates: a person, a deployment, a workflow, an issuer's subject, a local person, its own code.
    for (const id of ['vercel:user:u_julian', 'vercel:project:prj_board:production', 'github:repo:123456', 'oidc:gitlab.com:acme', 'local:user:julian', 'board:client:deploys']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
      // A callback's own writes too.
      expect((await as(id, null)).status, id).toBe(403)
    }
    // A user of another platform than the entry's, or of one it doesn't sync at all.
    expect((await as('github:user:42')).body.error.message).toBe("github:user:42 isn't a user of slack")
    expect((await as('github:user:42', null)).status).toBe(403)
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'github', channel: 'firehose', text: 'as Ada' })).body.error.message).toBe(
      "this token doesn't sync github here: its board registers its sync entries",
    )
    expect(await read(julian, 'firehose')).toEqual([])
    expect((await as('slack:user:U_ADA')).status).toBe(200)
    expect((await read(julian, 'firehose')).map((m) => m.by.actor)).toEqual(['slack:user:U_ADA'])
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
    expect((await read(julian, 'firehose')).map((m) => [m.text, m.by.actor])).toEqual([['from Slack', 'slack:user:U_ADA']])
  })

  it("delivers what a sync elsewhere imports to this board's own platforms, under a key this board doesn't have", async () => {
    const s = fakePlatform('slack')
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    const imported = await support('POST', '/sync/imports', { op: 'post', author, from: 'helpdesk', channel: 'firehose', text: 'export is broken' })
    expect(imported.status).toBe(200)
    // The team's Slack gets it, named for the platform it came from.
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([JSON.stringify({ markdown: '**Ada (slack)**: export is broken' })]))
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
    const refused = await reader('POST', '/watchers', { url: 'https://reader.test/api/board', watch: {}, sync })
    expect([refused.status, refused.body.error.message]).toEqual([403, "this token can't register a sync: it needs sync somewhere"])
    expect((await reader('POST', '/watchers', { url: 'https://reader.test/api/board', watch: {} })).status).toBe(200)
    expect(await listed()).toEqual([])
    expect((await otherOne('POST', '/watchers', { url: 'https://other.test/api/board', watch: {}, sync })).status).toBe(200)
    expect(await listed()).toEqual(sync)
    // One that may no longer sync isn't listed.
    await team.revokeGrant(others.grant.id)
    expect(await listed()).toEqual([])
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

  it('refuses a caller narrowed with x-board-scope what its sync records', async () => {
    const team = testBoard()
    await grant(team, 'prj_support', 'all')
    const support = caller(team.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: {}, sync: [entry] })).status).toBe(200)
    const own = (await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'from Slack' })).body.message as string
    // A sandbox with the project's token, narrowed to support/: what it claimed there, its project's sync would fill from anywhere.
    const narrowed = caller(team.fetch, await supportToken(), { 'x-board-scope': 'support/=all' })
    const pushed = { id: 'e1', event: { kind: 'deleted', channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1' }, raw: null }
    for (const [method, path, body] of [
      ['POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'claimed', origin: inC('C7', '1', '1') }],
      ['POST', '/sync/receipts', { kind: 'failed', message: own, target: 'slack:C9', error: 'gone' }],
      ['POST', '/inbox/slack', { events: [pushed] }],
      ['GET', '/inbox/slack/next', undefined],
      ['POST', '/inbox/slack/e1/ack', { lease: 'l1' }],
    ] as const) {
      const refused = await narrowed(method, path, body)
      expect([refused.status, refused.body.error?.message], path).toEqual([403, expect.stringContaining('narrowed with x-board-scope')])
    }
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'support/inbox', text: 'claimed', origin: inC('C7', '1', '1') })).status).toBe(200)
  })
})

describe("platform users' records", () => {
  it('change only with a sync that may sync in every channel: any other carries its author and leaves them be', async () => {
    const team = testBoard()
    await grant(team, 'prj_support', { 'support/': 'all' })
    await grant(team, 'prj_all', 'all')
    const support = caller(team.fetch, await supportToken())
    const everywhere = caller(team.fetch, await deploymentToken('all', 'prj_all', 'production'))
    const julian = await julianOn(team.fetch)
    for (const as of [support, everywhere]) expect((await as('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const eve = { id: 'slack:user:U_EVE', handle: 'eve', name: 'Eve', avatar: 'https://avatars.test/eve.png', isBot: false }
    const imported = (as: typeof support, author: object, channel: string) => as('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel, text: 'hi' })
    const record = async (id: string) =>
      ((await julian('GET', '/actors')).body.actors as { id: string; name: string; avatar: string | null }[]).find((actor) => actor.id === id)
    expect((await imported(everywhere, eve, 'firehose')).status).toBe(200)
    expect(await record(eve.id)).toMatchObject({ name: 'Eve', avatar: 'https://avatars.test/eve.png' })

    // Sync in support/ writes as Eve there, but who Eve is, every channel shows: it can't rename her or swap her avatar.
    const renamed = { ...eve, handle: 'ceo', name: 'The CEO', avatar: 'https://tracker.test/pixel.png' }
    const message = async (id: string) => (await julian('GET', `/messages/${id}`)).body.message
    expect(await message((await imported(support, renamed, 'support/inbox')).body.message)).toMatchObject({ by: { actor: eve.id }, author: { name: 'Eve' } })
    expect((await support('POST', '/sync/imports', { op: 'seen', author: renamed })).status).toBe(200)
    expect(await record(eve.id)).toMatchObject({ handle: 'eve', name: 'Eve', avatar: 'https://avatars.test/eve.png' })
    // Nor make up someone the board hasn't seen: the message names its author, and the board knows nothing of them.
    const stranger = { id: 'slack:user:U_NEW', handle: 'julian', name: 'Julian', avatar: null, isBot: false }
    expect(await message((await imported(support, stranger, 'support/inbox')).body.message)).toMatchObject({ by: { actor: 'slack:user:U_NEW' }, author: null })
    expect(await record(stranger.id)).toBeUndefined()

    // An avatar that isn't https never shows: it's dropped, and the one the board knows stays.
    for (const avatar of ['http://avatars.test/eve.png', 'javascript:alert(1)', 'not a url'])
      expect((await imported(everywhere, { ...eve, avatar }, 'firehose')).status, avatar).toBe(200)
    expect(await record(eve.id)).toMatchObject({ avatar: 'https://avatars.test/eve.png' })
    expect((await imported(everywhere, { ...stranger, id: 'slack:user:U_BOB', handle: 'bob', avatar: 'http://avatars.test/bob.png' }, 'firehose')).status).toBe(200)
    expect(await record('slack:user:U_BOB')).toMatchObject({ avatar: null })
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
  it("finds what its own sync synced from a platform link, and links where it's synced, on the board it uses", async () => {
    const permalink = 'https://acme.slack.com/archives/C1/p1727000000123456'
    // Slack, as the app sees it: in C1 already, and with the message's permalink.
    const client = async () => ({ conversations: { info: async () => ({ channel: { id: 'C1', is_member: true } }) }, chat: { getPermalink: async () => ({ permalink }) } }) as never
    const { team, project, webhook } = await setup({ client })
    const julian = await julianOn(team.fetch)
    await webhook({ type: 'message', threadId: 'slack:C1:1727000000.123456', id: '1727000000.123456', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    // The team's board keeps the records; the project's own Slack sync reads the link and makes it.
    expect((await project.linked(permalink)).message.id).toBe(root!.id)
    expect((await project.sync(root!.id)).targets).toEqual([
      { target: 'slack:C1:1727000000.123456', key: 'slack', thread: 'slack:C1:1727000000.123456', message: '1727000000.123456', url: permalink, undelivered: null },
    ])
    await expect(project.linked('https://acme.slack.com/archives/C1/p1727000009000000')).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
  })
})
