import { describe, expect, it, vi } from 'vitest'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { formatSourceRead } from '../src/cli/format.ts'
import { BOARD_URL, caller, personToken, testBoard, workflowToken } from './harness.ts'

const ROOT = '1791389583.493629'
const REPLY = '1791393976.415219'
const AGENT = '1791393999.000001'
const PERMALINK = `https://acme.slack.com/archives/CKIT/p${REPLY.replace('.', '')}?thread_ts=${ROOT}&cid=CKIT`

type Channel = { id: string; name: string; is_member: boolean; is_private?: boolean; is_ext_shared?: boolean }
const CHANNELS: Record<string, Channel> = {
  CKIT: { id: 'CKIT', name: 'project-vercel-kit', is_member: true },
  CPRIV: { id: 'CPRIV', name: 'secret', is_member: true, is_private: true },
  COUT: { id: 'COUT', name: 'elsewhere', is_member: false },
  CEXT: { id: 'CEXT', name: 'shared-with-acme', is_member: true, is_ext_shared: true },
}

async function setup(options: { join: boolean } = { join: false }) {
  const member = new Set(Object.values(CHANNELS).filter((c) => c.is_member).map((c) => c.id))
  const history = vi.fn(async ({ limit }: { channel: string; limit: number }) => ({
    messages: [
      { ts: '1791399999.000002', user: 'U_JB', text: 'latest' },
      { ts: ROOT, user: 'U_ADA', text: 'kit maps slack users to vercel ids', reply_count: 2, thread_ts: ROOT, files: [{ name: 'map.png', permalink: 'https://acme.slack.com/files/map' }] },
    ].slice(0, limit),
    has_more: limit < 2,
  }))
  // Like Slack: a reply's ts reads only that reply; the root's reads the thread.
  const replies = vi.fn(async ({ ts }: { channel: string; ts: string; limit: number }) => ts === REPLY
    ? { messages: [{ ts: REPLY, bot_profile: { name: 'pi' }, text: 'nice', thread_ts: ROOT }], has_more: false }
    : {
        messages: [
          { ts: ROOT, user: 'U_ADA', text: 'kit maps slack users to vercel ids', reply_count: 2, thread_ts: ROOT },
          { ts: REPLY, bot_profile: { name: 'pi' }, text: 'nice', thread_ts: ROOT },
          { ts: AGENT, bot_profile: { name: 'board' }, username: 'clever-lemur via acme-agents', text: 'on it', thread_ts: ROOT },
        ],
        has_more: false,
      })
  const join = vi.fn(async ({ channel }: { channel: string }) => {
    member.add(channel)
    return {}
  })
  const web = {
    conversations: {
      list: async () => ({ channels: Object.values(CHANNELS) }),
      info: async ({ channel }: { channel: string }) => {
        if (channel === 'CBUSY') throw Object.assign(new Error('An API error occurred: ratelimited'), { data: { error: 'ratelimited' } })
        return { channel: CHANNELS[channel] && { ...CHANNELS[channel], is_member: member.has(channel) } }
      },
      join, history, replies,
    },
    users: { info: async ({ user }: { user: string }) => ({ user: { id: user, real_name: user === 'U_ADA' ? 'Ada Lovelace' : 'Julian' } }) },
  }
  const s = fakePlatform('slack', withSlackClient(web, false))
  const board = testBoard({
    sync: { slack: slack({ adapter: s.adapter, client: async () => web as unknown as SlackClient, join: options.join }, channels({ C1: 'firehose' })) },
  })
  // The deploy workflow may post everywhere, and manage nowhere.
  await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web', workflow: 'deploy.yml', branch: 'main' }], can: { '*': ['post'] } })
  const webhook = (body: unknown) =>
    board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { board, history, replies, join, webhook }
}

const joinChannel = (call: ReturnType<typeof caller>, target: string) => call('POST', '/sources/slack/join', { target })

const read = (call: ReturnType<typeof caller>, target: string, limit?: number) =>
  call('GET', `/sources/slack/read?target=${encodeURIComponent(target)}${limit ? `&limit=${limit}` : ''}`)

describe('reading a platform on demand (vb sources <key> read)', () => {
  it('reads a public channel the app is in, oldest first, by name or ID', async () => {
    const { board, history, join } = await setup()
    const julian = caller(board.fetch, await personToken())
    const { status, body } = await read(julian, '#project-vercel-kit')
    expect(status).toBe(200)
    expect(body).toEqual({
      channel: 'CKIT', name: 'project-vercel-kit', thread: null,
      messages: [
        { id: ROOT, thread: `CKIT:${ROOT}`, author: 'Ada Lovelace', text: 'kit maps slack users to vercel ids', createdAt: new Date(Number(ROOT) * 1000).toISOString(), replies: 2, files: [{ name: 'map.png', url: 'https://acme.slack.com/files/map' }] },
        { id: '1791399999.000002', thread: 'CKIT:1791399999.000002', author: 'Julian', text: 'latest', createdAt: new Date(1791399999.000002 * 1000).toISOString(), replies: 0, files: [] },
      ],
      more: false,
    })
    const newest = (await read(julian, 'CKIT', 1)).body
    expect(newest.messages.map((m: { id: string }) => m.id)).toEqual(['1791399999.000002'])
    expect(newest.more).toBe(true)
    expect(history).toHaveBeenLastCalledWith({ channel: 'CKIT', limit: 1 })
    expect(join).not.toHaveBeenCalled()
  })

  it('reads the thread a permalink points into, or a channel:ts thread', async () => {
    const { board, replies } = await setup()
    const julian = caller(board.fetch, await personToken())
    const { body } = await read(julian, PERMALINK)
    expect(replies).toHaveBeenCalledWith({ channel: 'CKIT', ts: ROOT, limit: 50 })
    expect(body.thread).toBe(ROOT)
    expect(body.messages.map((m: { author: string; text: string }) => `${m.author}: ${m.text}`)).toEqual(['Ada Lovelace: kit maps slack users to vercel ids', 'pi: nice', 'clever-lemur via acme-agents: on it'])
    expect((await read(julian, `CKIT:${ROOT}`)).body.thread).toBe(ROOT)
  })

  it("reads the whole thread from a reply's ts, or a reply permalink without thread_ts", async () => {
    const { board, replies } = await setup()
    const julian = caller(board.fetch, await personToken())
    for (const target of [`CKIT:${REPLY}`, `https://acme.slack.com/archives/CKIT/p${REPLY.replace('.', '')}`]) {
      const { body } = await read(julian, target)
      expect(body.thread).toBe(ROOT)
      expect(body.messages.map((m: { id: string }) => m.id)).toEqual([ROOT, REPLY, AGENT])
    }
    expect(replies).toHaveBeenLastCalledWith({ channel: 'CKIT', ts: ROOT, limit: 50 })
  })

  it("answers what it can't read with a status that says why", async () => {
    const { board } = await setup()
    const julian = caller(board.fetch, await personToken())
    const unknownName = await read(julian, '#nope')
    expect(unknownName.status).toBe(404)
    expect(unknownName.body.error.code).toBe('channel_not_found')
    const unknownId = await read(julian, 'CNOPE')
    expect(unknownId.status).toBe(404)
    expect(unknownId.body.error.code).toBe('channel_not_found')
    const busy = await read(julian, 'CBUSY')
    expect(busy.status).toBe(429)
    expect(busy.body.error.code).toBe('ratelimited')
    const shared = await read(julian, '#shared-with-acme')
    expect(shared.status).toBe(403)
    expect(shared.body.error.code).toBe('shared_channel')
  })

  it("won't read private channels or channels the app isn't in, and never joins", async () => {
    const { board, history, join } = await setup()
    const julian = caller(board.fetch, await personToken())
    const secret = await read(julian, 'CPRIV')
    expect(secret.status).toBe(403)
    expect(secret.body.error).toMatchObject({ code: 'private_channel' })
    const outside = await read(julian, '#elsewhere')
    expect(outside.status).toBe(403)
    expect(outside.body.error.code).toBe('not_in_channel')
    expect(outside.body.error.message).toContain("won't join on its own")
    expect(history).not.toHaveBeenCalled()
    expect(join).not.toHaveBeenCalled()
    const nonsense = await read(julian, 'not a channel')
    expect(nonsense.status).toBe(400)
    expect(nonsense.body.error.code).toBe('invalid_target')
  })

  it('stores nothing, and the board still only listens to configured channels', async () => {
    const { board, webhook } = await setup()
    const julian = caller(board.fetch, await personToken())
    await read(julian, '#project-vercel-kit')
    await webhook({ type: 'message', threadId: `slack:CKIT:${ROOT}`, id: ROOT, text: 'should not sync', user: 'U_ADA' })
    await webhook({ type: 'message', threadId: `slack:C1:${REPLY}`, id: REPLY, text: 'syncs', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', '/messages')).body.messages.map((m: { text: string }) => m.text)).toEqual(['syncs']))
    expect((await julian('GET', '/inbox/slack?channel=CKIT')).body.events ?? []).toEqual([])
  })

  it('needs manage, since the app reads more than the caller may', async () => {
    const { board } = await setup()
    const workflow = caller(board.fetch, await workflowToken())
    const denied = await read(workflow, '#project-vercel-kit')
    expect(denied.status).toBe(403)
    expect(denied.body.error.message).toContain('it needs manage in every channel')
  })

  it('prints a channel with how to open each thread', () => {
    const now = Number(ROOT) * 1000 + 3_600_000
    const channel = formatSourceRead('slack', {
      channel: 'CKIT', name: 'project-vercel-kit', thread: null,
      messages: [{ id: ROOT, thread: `CKIT:${ROOT}`, author: 'Ada', text: 'kit maps users\nto vercel ids', createdAt: new Date(Number(ROOT) * 1000).toISOString(), replies: 2, files: [{ name: 'map.png', url: null }] }],
      more: true,
    }, now)
    expect(channel.split('\n')).toEqual([
      'slack:CKIT (#project-vercel-kit)',
      `${ROOT}  Ada · 1h  (2 replies: vb sources slack read CKIT:${ROOT})`,
      '      kit maps users',
      '      to vercel ids',
      '      file map.png',
      '(older messages not shown: raise --limit, up to 200)',
    ])
    const thread = formatSourceRead('slack', {
      channel: 'CKIT', name: null, thread: ROOT,
      messages: [
        { id: ROOT, thread: `CKIT:${ROOT}`, author: 'Ada', text: 'root', createdAt: null, replies: 1, files: [] },
        { id: REPLY, thread: `CKIT:${ROOT}`, author: 'pi', text: 'nice', createdAt: null, replies: 0, files: [] },
      ],
      more: false,
    })
    expect(thread.split('\n')).toEqual([`slack:CKIT, thread ${ROOT}`, `${ROOT}  Ada`, '      root', `  ↳ ${REPLY}  pi`, '    nice'])
  })
})

describe('joining a channel to read it (vb sources <key> join)', () => {
  it("won't join unless the board opted in", async () => {
    const { board, join } = await setup()
    const julian = caller(board.fetch, await personToken())
    const refused = await joinChannel(julian, '#elsewhere')
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('join_disabled')
    expect(join).not.toHaveBeenCalled()
  })

  it('joins a public channel the app is not in, then reads it', async () => {
    const { board, join, history } = await setup({ join: true })
    const julian = caller(board.fetch, await personToken())
    const before = await read(julian, '#elsewhere')
    expect(before.body.error.code).toBe('not_in_channel')
    expect(before.body.error.message).toContain('join it first')
    const joined = await joinChannel(julian, '#elsewhere')
    expect(joined.status).toBe(200)
    expect(joined.body).toEqual({ channel: 'COUT', name: 'elsewhere', joined: true })
    expect(join).toHaveBeenCalledWith({ channel: 'COUT' })
    expect((await read(julian, 'COUT')).status).toBe(200)
    expect(history).toHaveBeenLastCalledWith({ channel: 'COUT', limit: 50 })
    expect((await joinChannel(julian, `https://acme.slack.com/archives/COUT/p${ROOT.replace('.', '')}`)).body).toEqual({ channel: 'COUT', name: 'elsewhere', joined: false })
    expect(join).toHaveBeenCalledTimes(1)
  })

  it("won't join private or Slack Connect channels, and needs manage", async () => {
    const { board, join } = await setup({ join: true })
    const julian = caller(board.fetch, await personToken())
    expect((await joinChannel(julian, 'CPRIV')).body.error.code).toBe('private_channel')
    expect((await joinChannel(julian, 'CEXT')).body.error.code).toBe('shared_channel')
    const workflow = caller(board.fetch, await workflowToken())
    const denied = await joinChannel(workflow, 'COUT')
    expect(denied.status).toBe(403)
    expect(denied.body.error.message).toContain('it needs manage in every channel')
    expect(join).not.toHaveBeenCalled()
  })
})
