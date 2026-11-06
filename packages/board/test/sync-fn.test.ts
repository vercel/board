import { describe, expect, it, vi } from 'vitest'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'
import { slack, type SlackEvent } from '../src/sync/slack.ts'
import { github, repos } from '../src/sync/github.ts'
import { channels, into, mirror, render, type Sync, type SyncFn } from '../src/sync/fn.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

type Read = { id: number; text: string; re: number | null }

function webhookOf(board: ReturnType<typeof testBoard>) {
  return (key: string, body: unknown, headers: Record<string, string> = {}) =>
    board.fetch(new Request(`${BOARD_URL}/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
}

const read = async (call: ReturnType<typeof caller>, channel: string) => (await call('GET', `/messages?channel=${channel}`)).body.messages as Read[]

describe('sync functions', () => {
  it('does nothing, both ways, for a function that does nothing', async () => {
    const s = fakePlatform('slack')
    const seen: Sync<SlackEvent>['direction'][] = []
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, (sync) => void seen.push(sync.direction)) } })
    const julian = caller(board.fetch, await personToken())
    await webhookOf(board)('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U_ADA' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'a new root' })
    await vi.waitFor(() => expect(seen).toEqual(['in', 'out']))
    expect(await read(julian, 'firehose')).toHaveLength(1)
    expect(s.channelPosts).toEqual([])
    expect(s.posts).toEqual([])
  })

  it('renders each Slack channel its own way', async () => {
    const s = fakePlatform('slack')
    const loud = render(({ message }) => `LOUD ${message.text.toUpperCase()}`, mirror('dev'))
    const quiet = render(({ message }) => `(${message.text})`, mirror('ops'))
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: loud, C2: quiet, C3: 'random' })) } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'dev', text: 'deploy is out' })
    await julian('POST', '/messages', { channel: 'ops', text: 'disk at 90%' })
    await julian('POST', '/messages', { channel: 'random', text: 'lunch?' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(3))
    const sent = Object.fromEntries(s.channelPosts.map((post) => [post.channelId, JSON.parse(post.text).markdown]))
    expect(sent).toEqual({ 'slack:C1': 'LOUD DEPLOY IS OUT', 'slack:C2': '(disk at 90%)', 'slack:C3': '**julian**: lunch?' })

    // A reply renders the way its thread's channel does.
    const [root] = await read(julian, 'dev')
    await julian('POST', '/messages', { re: root!.id, text: 'rolling back' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(JSON.parse(s.posts[0]!.text).markdown).toBe('LOUD ROLLING BACK')
  })

  it('imports a repo `into` a channel and sends nothing back, unless a function delivers it', async () => {
    const g = fakePlatform('github')
    const sent = (sync: Sync) => sync.direction === 'out' && sync.message.text.startsWith('to github')
    const board = testBoard({
      sync: {
        github: github({ adapter: g.adapter }, async (sync) => {
          await repos({ 'acme/www': 'prs' })(sync)
          if (sync.direction === 'out' && sent(sync)) await sync.deliver()
        }),
      },
    })
    const julian = caller(board.fetch, await personToken())
    await webhookOf(board)('github', {
      action: 'opened', repository: { full_name: 'acme/www' }, sender: { id: 42, login: 'ada' },
      pull_request: { number: 7, title: 'Add sync', html_url: 'https://github.com/acme/www/pull/7', draft: false, merged: false },
    }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    await julian('POST', '/messages', { re: root!.id, text: 'stays on the board' })
    await julian('POST', '/messages', { re: root!.id, text: 'to github, please' })
    await vi.waitFor(() => expect(g.posts).toHaveLength(1))
    expect(JSON.parse(g.posts[0]!.text).markdown).toContain('to github, please')
    expect(g.posts.map((post) => post.text).join('\n')).not.toContain('stays on the board')
  })

  it("keeps only the channels a helper routes in the inbox, and threads the board syncs", async () => {
    const s = fakePlatform('slack')
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) } })
    const julian = caller(board.fetch, await personToken())
    const webhook = webhookOf(board)
    await webhook('slack', { type: 'message', threadId: 'slack:C9:900', id: '900', text: 'not ours', user: 'U_ADA' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'ours', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const inbox = async (channel: string) => (await julian('GET', `/inbox/slack?channel=${channel}`)).body.events as unknown[]
    expect(await inbox('C1')).toHaveLength(1)
    expect(await inbox('C9')).toEqual([])

    // A thread synced by hand outside its channels comes in, both ways.
    const [root] = await read(julian, 'firehose')
    await julian('POST', `/messages/${root!.id}/sync`, { target: 'slack:C9:900' })
    await webhook('slack', { type: 'message', threadId: 'slack:C9:900', id: '901', text: 'joined', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root!.id}`)).body.replies.map((reply: Read) => reply.text)).toEqual(['joined']))
    expect(await inbox('C9')).toHaveLength(1)
  })

  it('keeps every event in the inbox for a function of your own, even one that calls a helper', async () => {
    const s = fakePlatform('slack')
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, (sync) => channels({ C1: 'firehose' })(sync)) } })
    const julian = caller(board.fetch, await personToken())
    const webhook = webhookOf(board)
    await webhook('slack', { type: 'message', threadId: 'slack:C9:900', id: '900', text: 'not ours', user: 'U_ADA' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'ours', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['ours']))
    // The same board as with the helper outermost, but C9's event was stored.
    expect((await julian('GET', '/inbox/slack?channel=C9')).body.events).toHaveLength(1)
  })

  it('delivers once however many times a function asks, and never after it returns', async () => {
    const s = fakePlatform('slack')
    let late!: () => Promise<void>
    const twice: SyncFn<SlackEvent> = async (sync) => {
      if (sync.direction === 'in') return void (await sync.import('firehose'))
      if (sync.target === null) return sync.start('C1')
      late = () => sync.deliver()
      await Promise.all([sync.deliver(), sync.deliver()])
      await sync.deliver()
    }
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, twice) } })
    const julian = caller(board.fetch, await personToken())
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'one root' })).body.message
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    await julian('POST', '/messages', { re: root.id, text: 'one reply' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(() => late()).toThrow('sync function has finished')
  })

  it("holds what goes out to a channel it couldn't check, and asks again on each retry", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let listing = false
    const conversations = {
      // Slack's listing fails until it doesn't; #support is C9.
      list: vi.fn(async () => {
        if (!listing) throw Object.assign(new Error('An API error occurred: ratelimited'), { data: { error: 'ratelimited' } })
        return { channels: [{ id: 'C9', name: 'support', is_member: true }] }
      }),
      info: vi.fn(async () => ({ channel: { id: 'C9', is_member: true } })),
      join: vi.fn(async () => ({ ok: true })),
    }
    const s = fakePlatform('slack', withSlackClient({ conversations }, false))
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter, client: async () => ({ conversations }) as never }, channels({ '#support': into('support') })) } })
    const julian = caller(board.fetch, await personToken())
    const retry = async () => {
      await board.skipHold(board.servers[0]!, 'board')
      await board.servers[0]!.drain('board')
    }
    // A thread synced by hand to a Slack thread in #support, whose rule is to send nothing back.
    const root = (await julian('POST', '/messages', { channel: 'support', text: 'refund issued' })).body.message
    await julian('POST', `/messages/${root.id}/sync`, { target: 'slack:C9:900.1' })
    const reply = (await julian('POST', '/messages', { re: root.id, text: 'stays on the board' })).body.message
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't resolve #support")))
    const asked = conversations.list.mock.calls.length
    await retry()
    expect(conversations.list.mock.calls.length).toBeGreaterThan(asked)
    expect(s.posts).toEqual([])

    listing = true
    await vi.waitFor(async () => {
      await retry()
      const { body } = await julian('GET', `/messages/${root.id}`)
      expect(body.replies.find((m: { id: string }) => m.id === reply.id)).toMatchObject({ undelivered: {} })
      expect(conversations.list.mock.results.at(-1)?.type).toBe('return')
    })
    expect(s.posts).toEqual([])
    warn.mockRestore()
  })

  it("keeps what comes in from a channel it couldn't check, and imports it once the channel resolves", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let listing = false
    const conversations = {
      list: vi.fn(async () => {
        if (!listing) throw Object.assign(new Error('An API error occurred: ratelimited'), { data: { error: 'ratelimited' } })
        return { channels: [{ id: 'C9', name: 'support', is_member: true }] }
      }),
      info: vi.fn(async () => ({ channel: { id: 'C9', is_member: true } })),
      join: vi.fn(async () => ({ ok: true })),
    }
    const s = fakePlatform('slack', withSlackClient({ conversations }, false))
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter, client: async () => ({ conversations }) as never }, channels({ '#support': into('support') })) } })
    const julian = caller(board.fetch, await personToken())
    const event = { type: 'message', threadId: 'slack:C9:900', id: '900', text: 'my refund?', user: 'U_ADA' }
    expect((await webhookOf(board)('slack', event)).ok).toBe(true)
    expect((await julian('GET', '/inbox/slack?channel=C9')).body.events).toHaveLength(1)
    expect(await read(julian, 'support')).toEqual([])

    listing = true
    const inbox = board.servers.find((server) => server.contract.name === 'board-inbox')!
    await vi.waitFor(async () => {
      await board.skipHold(inbox, 'inbox:slack:C9')
      await inbox.drain('inbox:slack:C9')
      expect((await read(julian, 'support')).map((m) => m.text)).toEqual(['my refund?'])
    })
    warn.mockRestore()
  })

  const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), { data: { error: 'missing_scope' } })
  it.each([
    { why: "doesn't exist", list: async () => ({ channels: [] }) },
    // Without groups:read, Slack won't list private channels, so a private one's name never resolves.
    { why: "is private on an app without groups:read", list: async ({ types }: { types: string }) => {
      if (types.includes('private_channel')) throw missingScope
      return { channels: [] }
    } },
  ])("keeps a thread synced by hand going when a channel the map names $why", async ({ list }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = { list: vi.fn(list), info: vi.fn(async () => ({ channel: { id: 'C9', is_member: true } })), join: vi.fn() }
    const s = fakePlatform('slack', withSlackClient({ conversations }, false))
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter, client: async () => ({ conversations }) as never }, channels({ '#missing': into('support') })) } })
    const julian = caller(board.fetch, await personToken())
    const root = (await julian('POST', '/messages', { channel: 'random', text: 'deploy is out' })).body.message
    await julian('POST', `/messages/${root.id}/sync`, { target: 'slack:C9:900.1' })
    await julian('POST', '/messages', { re: root.id, text: 'rolling back' })
    await vi.waitFor(() => expect(s.posts.map((post) => post.threadId)).toEqual(['slack:C9:900.1']))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping #missing'))
    warn.mockRestore()
  })

  it("never starts a thread back in the channel a root came from", async () => {
    const s = fakePlatform('slack')
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose', C2: 'firehose' })) } })
    const julian = caller(board.fetch, await personToken())
    await webhookOf(board)('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'from C1', user: 'U_ADA' })
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.channelId)).toEqual(['slack:C2']))
    expect((await read(julian, 'firehose'))).toHaveLength(1)
  })
})
