import { describe, expect, it, vi } from 'vitest'
import type { Adapter } from 'chat'
import { fakePlatform, withSlackClient, type WebhookPayload } from './sync-fixtures.ts'
import { slack } from '../src/sync/slack.ts'
import { ChatSyncProvider } from '../src/sync/chat-provider.ts'
import type { SyncContext, EventMapping } from '../src/sync/provider.ts'
import { envelope, eventSchema } from '../src/sync/events.ts'
import { z } from 'zod'
import { createServer } from 'experimental-a2/server'
import { memory } from 'experimental-a2/store-memory'
import { boardContract } from '../src/contract/contract.ts'
import { github } from '../src/sync/github.ts'
import type { BoardOptions } from '../src/server/index.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'
import { VERCEL_BUILDING } from './vercel-fixtures.ts'

type SlackChannels = Parameters<typeof slack>[0]['channels']

function setup(
  options: {
    alerts?: SlackChannels[string]
    channels?: SlackChannels
    slackClient?: unknown
    slackRender?: import('../src/sync/provider.ts').ProviderOptions['render']
    asyncToken?: boolean
    githubClient?: unknown
    repos?: Parameters<typeof github>[0]['repos']
    watch?: BoardOptions['watch']
    basePath?: string
  } = {},
) {
  const s = fakePlatform('slack', options.slackClient ? withSlackClient(options.slackClient, !!options.asyncToken) : undefined)
  const g = fakePlatform('github', options.githubClient ? (adapter) => Object.assign(adapter, { octokit: options.githubClient }) : undefined)
  const board = testBoard({
    sync: {
      slack: slack({
        adapter: s.adapter,
        render: options.slackRender,
        ...(options.slackClient ? { client: async () => options.slackClient as import('../src/sync/slack.ts').SlackClient } : {}),
        channels: { C1: 'firehose', C2: 'prs', ...(options.alerts ? { C3: options.alerts } : {}), ...options.channels },
      }),
      github: github({ adapter: g.adapter, repos: options.repos ?? { 'basehub-ai/vboard': 'prs' } }),
    },
    ...(options.watch ? { watch: options.watch } : {}),
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
  })
  const webhook = (key: string, body: unknown, headers: Record<string, string> = {}) =>
    board.fetch(
      new Request(`${BOARD_URL}/webhooks/${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
  return { board, s, g, webhook }
}

const read = async (call: ReturnType<typeof caller>, channel: string) =>
  (await call('GET', `/messages?channel=${channel}`)).body.messages as {
    id: number
    text: string
    re: number | null
    from: string | null
    labels: Record<string, string>
    reactions: Record<string, string[]>
    by: { actor: string }
  }[]

describe('sync', () => {
  it('keeps the mentions it can resolve in platform text, and leaves the rest as text', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'hi' })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:500', id: '500', text: '@julian and @nobody, look', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    const messages = (await julian('GET', '/messages?channel=firehose&from=slack')).body.messages as { mentions: string[] }[]
    expect(messages[0]!.mentions).toEqual(['vercel:user:u_julian'])
  })

  it("runs watchers on Slack's messages, and syncs their replies back to Slack", async () => {
    const seen: string[] = []
    const { board, s, webhook } = setup({
      watch: {
        triage: {
          tail: 'firehose --from slack',
          run: async ({ event, board }) => {
            if (event.type === 'message.posted' && event.message!.re === null)
              await board.reply(event.message!.id, 'Thanks! Tracking it.')
          },
        },
        seen: { tail: 'firehose', run: ({ event }) => void seen.push(event.type) },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.threadId)).toEqual(['slack:C1:100']))
    expect(s.posts[0]!.text).toContain('Thanks! Tracking it.')

    // The delivery receipt is bookkeeping: only `--all` shows it, and no watcher runs on it.
    const types = async (query: string) =>
      ((await julian('GET', `/events?channel=firehose&after=0${query}`)).body.events as { type: string }[]).map((e) => e.type)
    await vi.waitFor(async () => expect(await types('&all=true')).toContain('message.synced'))
    expect(await types('')).toEqual(['message.posted', 'message.posted'])
    await vi.waitFor(() => expect(seen).toEqual(['message.posted', 'message.posted']))
  })

  it('runs `--all` watchers on receipts too, like `vb tail --all`: where a message landed', async () => {
    const landed: unknown[] = []
    const { board, s } = setup({
      watch: {
        landed: {
          tail: 'prs --label pr --all',
          run: ({ event }) => {
            if (event.type === 'message.synced') landed.push({ id: event.payload.id, external: event.payload.external, pr: event.message?.labels.pr })
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'prs', text: 'no PR here' })
    const pr = (await julian('POST', '/messages', { channel: 'prs', text: 'PR #12', labels: { pr: 'acme/www#12' } })).body.message
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(2))
    await vi.waitFor(() => expect(landed).toHaveLength(1))
    expect(landed[0]).toEqual({ id: pr.id, external: { thread: `slack:C2:${s.channelPosts[1]!.id}`, message: s.channelPosts[1]!.id }, pr: 'acme/www#12' })
  })

  it('mirrors a Slack thread into the board, and board replies back into Slack', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    expect((await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    expect(root).toMatchObject({ text: 'export is broken', from: 'slack', by: { actor: 'slack:user:U_ADA' } })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: 'same here', user: 'U_BOB' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))

    await julian('POST', '/messages', { re: root!.id, text: 'looking into it' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]).toMatchObject({ threadId: 'slack:C1:100' })
    expect(s.posts[0]!.text).toContain('looking into it')
    expect(s.channelPosts).toHaveLength(0) // a thread that came from Slack is never re-posted to its channel
  })

  it('posts a reply to Slack as written, with no quote of the message it answers', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: 'same here', user: 'U_BOB' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    const [, bob] = await read(julian, 'firehose')

    await julian('POST', '/messages', { re: bob!.id, text: 'which browser?' })
    await julian('POST', '/messages', { re: bob!.id, text: 'and which version?' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(2))
    // Bob's message is no longer the one right above, and still nothing quotes it.
    expect(s.posts[1]!.text).toContain('and which version?')
    expect(s.posts[1]!.text).not.toContain('↪')
    expect(s.posts[1]!.text).not.toContain('same here')
    const [, , , second] = await read(julian, 'firehose')
    expect(second).toMatchObject({ replyTo: bob!.id })
  })

  it('uploads attachments to Slack after the text, and notes them on GitHub, which takes no uploads', async () => {
    const files = { delete: vi.fn(async () => ({ ok: true })) }
    const { board, s, g, webhook } = setup({ slackClient: { conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) }, files } })
    const token = await personToken()
    const julian = caller(board.fetch, token)
    const upload = async (name: string) => {
      const response = await board.fetch(
        new Request(`${BOARD_URL}/attachments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-board-filename': name },
          body: new Uint8Array([1, 2, 3]),
        }),
      )
      return ((await response.json()) as { attachment: { id: string } }).attachment.id
    }

    // A Slack thread: the reply's text goes first, then its file, into the same thread.
    await webhook('slack', { type: 'message', threadId: 'slack:C1:1727.1', id: '1727.1', text: 'login is broken', user: 'U1' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    const reply = (await julian('POST', '/messages', { re: root!.id, text: 'fixed, see after', attachments: [await upload('after.png')] })).body.message
    await vi.waitFor(() => expect(s.posts).toHaveLength(2))
    expect(s.posts.map((p) => p.threadId)).toEqual(['slack:C1:1727.1', 'slack:C1:1727.1'])
    expect(JSON.parse(s.posts[0]!.text)).toEqual({ markdown: expect.stringContaining('fixed, see after') })
    expect(s.posts[0]!.text).not.toContain('📎')
    expect(JSON.parse(s.posts[1]!.text)).toMatchObject({ markdown: '', files: [{ filename: 'after.png', mimeType: 'image/png' }] })

    // Deleting it on the board deletes the text and the files Slack made a message of.
    await julian('POST', `/messages/${reply.id}/delete`, {})
    await vi.waitFor(() => expect(files.delete).toHaveBeenCalledWith({ file: 'F_after.png' }))
    expect(s.deletes).toEqual([{ threadId: 'slack:C1:1727.1', messageId: s.posts[0]!.id }])

    // A PR thread: GitHub gets a note instead.
    await webhook(
      'github',
      {
        action: 'opened',
        repository: { full_name: 'basehub-ai/vboard' },
        sender: { login: 'julianbenegas', id: 42 },
        pull_request: { number: 7, title: 'Fix login', html_url: 'https://github.com/basehub-ai/vboard/pull/7', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'att1' },
    )
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [pr] = await read(julian, 'prs')
    const proof = (await julian('POST', '/messages', { re: pr!.id, text: '', attachments: [await upload('proof.png')] })).body.message
    await vi.waitFor(() => expect(g.posts).toHaveLength(1))
    expect(g.posts[0]!.text).toContain(`📎 proof.png (3 B, on the board: #${proof.id})`)
    expect(g.posts[0]!.text).not.toContain('"files"')

    // A handle no one on the board has stays plain text, and GitHub can't make it ping its login.
    await julian('POST', '/messages', { re: pr!.id, text: 'cc @TK, not `@tk`' })
    await vi.waitFor(() => expect(g.posts).toHaveLength(2))
    expect(g.posts[1]!.text).toContain('cc @\u2060TK, not `@tk`')
  })

  it('brings files posted in Slack onto the board, fetched through the adapter', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    s.served.set('https://files.slack.test/shot.png', png)

    // A root with only a file: no "(no text)" filler.
    await webhook('slack', {
      type: 'message', threadId: 'slack:C1:500.1', id: '500.1', text: '', user: 'U1',
      files: [{ name: 'shot.png', mimeType: 'image/png', url: 'https://files.slack.test/shot.png', size: png.byteLength }],
    })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = (await read(julian, 'firehose')) as unknown as { id: number; text: string; attachments: { id: string; name: string; type: string; size: number }[] }[]
    expect(root!.text).toBe('')
    expect(root!.attachments).toEqual([{ id: expect.any(String), name: 'shot.png', type: 'image/png', size: png.byteLength }])
    const file = await board.fetch(new Request(`${BOARD_URL}/attachments/${root!.attachments[0]!.id}`, { headers: { authorization: `Bearer ${await personToken()}` } }))
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png)

    // A reply in the thread, with text, and a file too big to bring over: it keeps its text and gets a line instead.
    await webhook('slack', {
      type: 'message', threadId: 'slack:C1:500.1', id: '500.2', text: 'and the recording', user: 'U1',
      files: [{ name: 'run.mov', mimeType: 'video/quicktime', url: 'https://files.slack.test/run.mov', size: 50 * 1024 * 1024 }],
    })
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root!.id}`)
      expect(body.replies).toHaveLength(1)
      expect(body.replies[0]).toMatchObject({ text: "and the recording\n\n📎 run.mov (50.0 MB) didn't come over: over 4 MB", attachments: [] })
    })
    expect(s.fetches).toEqual(['https://files.slack.test/shot.png']) // the big one was never downloaded

    // Slack edits know only the text they show: the file-only root stays empty, and the reply keeps its note.
    await webhook('slack', { type: 'edit', threadId: 'slack:C1:500.1', id: '500.1', text: '', user: 'U1' })
    await webhook('slack', { type: 'edit', threadId: 'slack:C1:500.1', id: '500.2', text: 'and the recording, again', user: 'U1' })
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root!.id}`)
      expect(body.replies[0]).toMatchObject({ text: "and the recording, again\n\n📎 run.mov (50.0 MB) didn't come over: over 4 MB" })
    })
    const { body: after } = await julian('GET', `/messages/${root!.id}`)
    expect(after.message).toMatchObject({ text: '', editedAt: null, attachments: [{ name: 'shot.png' }] })
    expect(s.posts).toHaveLength(0) // nothing echoes back to Slack
  })

  it('retries a file Slack fails to hand over, then notes it if it keeps failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const log = new TextEncoder().encode('stack trace')
    let flaky = 1
    s.served.set('https://files.slack.test/flaky.log', new Error('ECONNRESET'))
    s.served.set('https://files.slack.test/gone.log', new Error('403 Forbidden'))
    const inbox = board.servers[1]!

    await webhook('slack', {
      type: 'message', threadId: 'slack:C1:600.1', id: '600.1', text: 'logs', user: 'U1',
      files: [{ name: 'flaky.log', mimeType: 'text/plain', url: 'https://files.slack.test/flaky.log' }],
    })
    // The first attempt fails; then Slack answers.
    await vi.waitFor(() => expect(s.fetches).toHaveLength(flaky))
    s.served.set('https://files.slack.test/flaky.log', log)
    await vi.waitFor(async () => {
      await inbox.drain('inbox:slack:C1')
      expect(await read(julian, 'firehose')).toHaveLength(1)
    })
    const [root] = (await read(julian, 'firehose')) as unknown as { id: number; text: string; attachments: { name: string }[] }[]
    expect(root).toMatchObject({ text: 'logs', attachments: [{ name: 'flaky.log' }] })
    flaky = s.fetches.length

    await webhook('slack', {
      type: 'message', threadId: 'slack:C1:600.1', id: '600.2', text: 'older one', user: 'U1',
      files: [{ name: 'gone.log', mimeType: 'text/plain', url: 'https://files.slack.test/gone.log', size: 11 }],
    })
    await vi.waitFor(async () => {
      await inbox.drain('inbox:slack:C1')
      const { body } = await julian('GET', `/messages/${root!.id}`)
      expect(body.replies[0]).toMatchObject({ text: "older one\n\n📎 gone.log (11 B) didn't come over: slack wouldn't hand it over", attachments: [] })
    })
    expect(s.fetches.length - flaky).toBe(3) // FILE_ATTEMPTS, then a note: the thread's lane moves on
    warn.mockRestore()
    error.mockRestore()
  })

  it('notes the files in the text when Slack refuses them, and retries any other failure without posting the text twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { board, s, webhook } = setup()
    const post = s.adapter.postMessage.bind(s.adapter)
    let answer: string | null = 'ratelimited'
    s.adapter.postMessage = async (threadId, message) => {
      if (typeof message === 'object' && 'files' in message && message.files?.length && answer) {
        const code = answer
        if (code === 'ratelimited') answer = 'missing_scope'
        throw Object.assign(new Error(code), { data: { error: code } })
      }
      return post(threadId, message)
    }
    const token = await personToken()
    const julian = caller(board.fetch, token)
    await webhook('slack', { type: 'message', threadId: 'slack:C1:1727.2', id: '1727.2', text: 'broken', user: 'U1' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    const uploaded = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-board-filename': 'repro.log' },
        body: 'stack trace',
      }),
    )
    const { attachment } = (await uploaded.json()) as { attachment: { id: string } }
    const { body } = await julian('POST', '/messages', { re: root!.id, text: 'logs', attachments: [attachment.id] })

    // A rate limit retries the upload alone (each drain is the next attempt); the refusal that follows notes the file in the text.
    await vi.waitFor(async () => {
      await board.servers[0]!.drain('board')
      expect(s.edits).toHaveLength(1)
    })
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0]!.text).not.toContain('📎')
    expect(s.edits[0]).toMatchObject({ messageId: s.posts[0]!.id, text: expect.stringContaining('📎 repro.log') })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("won't take"))

    // An edit keeps the notes, since the files never went.
    await julian('POST', `/messages/${body.message.id}/edit`, { text: 'logs, again' })
    await vi.waitFor(() => expect(s.edits).toHaveLength(2))
    expect(s.edits[1]!.text).toContain('📎 repro.log')
    warn.mockRestore()
    error.mockRestore()
  })

  it('uploads a text file Slack would call binary under a name it previews, and keeps its own name on the board', async () => {
    const { board, s, webhook } = setup()
    const token = await personToken()
    const julian = caller(board.fetch, token)
    const upload = async (name: string, type: string) => {
      const response = await board.fetch(
        new Request(`${BOARD_URL}/attachments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-board-filename': name },
          body: 'exit 0',
        }),
      )
      return ((await response.json()) as { attachment: { id: string } }).attachment.id
    }
    await webhook('slack', { type: 'message', threadId: 'slack:C1:1727.3', id: '1727.3', text: 'run deepsec', user: 'U1' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    const files = [await upload('deepsec.log', 'text/plain'), await upload('notes.md', 'text/markdown'), await upload('proof.png', 'image/png')]
    const { body } = await julian('POST', '/messages', { re: root!.id, text: 'nothing found', attachments: files })
    await vi.waitFor(() => expect(s.posts).toHaveLength(2))
    expect(JSON.parse(s.posts[1]!.text).files.map((f: { filename: string }) => f.filename)).toEqual(['deepsec.log.txt', 'notes.md', 'proof.png'])
    expect(body.message.attachments.map((a: { name: string }) => a.name)).toEqual(['deepsec.log', 'notes.md', 'proof.png'])
  })

  it('starts a Slack thread for a board root in a mirrored channel, then follows it', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    const { body } = await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    const started = s.channelPosts[0]!
    expect(started.channelId).toBe('slack:C1')
    expect(started.text).toContain('deploy failed')

    await julian('POST', '/messages', { re: body.message.id, text: 'rolled back' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]!.threadId).toBe(`slack:C1:${started.id}`)

    // A Slack reply in that thread comes back to the board thread.
    await webhook('slack', { type: 'message', threadId: `slack:C1:${started.id}`, id: 'r1', text: 'thanks', user: 'U_ADA' })
    await vi.waitFor(async () =>
      expect((await julian('GET', `/messages/${body.message.id}`)).body.replies.map((m: { text: string }) => m.text)).toEqual([
        'rolled back',
        'thanks',
      ]),
    )
    expect(s.posts).toHaveLength(1) // and isn't echoed back
  })

  it('keeps `noSync` roots on the board', async () => {
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken())
    await julian('POST', '/messages', { channel: 'firehose', text: 'scratch', noSync: true })
    await julian('POST', '/messages', { channel: 'firehose', text: 'shared' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.text).toContain('shared') // only the synced root reaches Slack
    expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['scratch', 'shared'])
  })

  it('syncs reactions both ways', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:200', id: '200', text: 'bug', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [message] = await read(julian, 'firehose')

    await julian('POST', `/messages/${message!.id}/reactions`, { emoji: 'eyes' })
    await vi.waitFor(() => expect(s.reactions).toEqual([{ threadId: 'slack:C1:200', messageId: '200', emoji: 'eyes', added: true }]))

    await webhook('slack', { type: 'reaction', threadId: 'slack:C1:200', messageId: '200', emoji: 'white_check_mark', added: true, user: 'U_ADA' })
    await vi.waitFor(async () => {
      const [after] = await read(julian, 'firehose')
      expect(after!.reactions).toMatchObject({ eyes: ['vercel:user:u_julian'], check: ['slack:user:U_ADA'] })
    })
    expect(s.reactions).toHaveLength(1) // the Slack reaction isn't echoed back
  })

  it('shows typing in every platform thread a board thread is synced to, skipping one that fails', async () => {
    const { board, s, g, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:200', id: '200', text: 'bug', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    await julian('POST', `/messages/${root!.id}/sync`, { target: 'github:basehub-ai/vboard:12' })

    const typed = await julian('POST', `/messages/${root!.id}/typing`, {})
    expect(typed).toMatchObject({ status: 200, body: { targets: ['slack:C1:200', 'github:basehub-ai/vboard:12'] } })
    expect(s.typing).toEqual(['slack:C1:200'])
    expect(g.typing).toEqual(['github:basehub-ai/vboard:12'])

    s.adapter.startTyping = async () => {
      throw new Error('missing_scope')
    }
    const partial = await julian('POST', `/messages/${root!.id}/typing`, {})
    expect(partial).toMatchObject({ status: 200, body: { targets: ['github:basehub-ai/vboard:12'] } })
  })

  it('passes a typing status through to Slack, which shows it instead of "Typing…"', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:200', id: '200', text: 'bug', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')

    await julian('POST', `/messages/${root!.id}/typing`, { status: '  running tests…  ' })
    await julian('POST', `/messages/${root!.id}/typing`, {})
    expect(s.typing).toEqual(['slack:C1:200', 'slack:C1:200'])
    expect(s.statuses).toEqual(['running tests…', undefined])

    expect((await julian('POST', `/messages/${root!.id}/typing`, { status: 'x'.repeat(101) })).status).toBe(400)
  })

  it('runs function mappings for connected conversations and delegates normal imports', async () => {
    const seen: string[] = []
    const { board, s, webhook } = setup({
      alerts: async ({ event, board }) => {
        if (event.kind !== 'message') return
        seen.push(event.text)
        const project = event.text.match(/project: (\S+)/)?.[1] ?? 'unknown'
        await board.sync(`alerts/${project}`, event)
      },
    })
    const julian = caller(board.fetch, await personToken())
    const payload = { type: 'message', threadId: 'slack:C3:300', id: '300', text: 'TypeError in checkout, project: www', user: 'B_SENTRY' }
    await webhook('slack', payload)
    await webhook('slack', payload) // a platform retry
    await vi.waitFor(async () => expect(await read(julian, 'alerts/www')).toHaveLength(1))
    expect(seen).toHaveLength(1)
    const [root] = await read(julian, 'alerts/www')
    expect(root!.by.actor).toBe('slack:user:B_SENTRY')
    expect(s.channelPosts).toHaveLength(0) // joining a thread doesn't re-post the root

    await julian('POST', '/messages', { re: root!.id, text: 'on it' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.threadId)).toEqual(['slack:C3:300']))
    await webhook('slack', { type: 'message', threadId: 'slack:C3:300', id: '301', text: 'thanks', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'alerts/www')).toHaveLength(3))
    expect(seen).toEqual(['TypeError in checkout, project: www', 'thanks'])
  })

  it.each(['/api/board', '/api/board/'])('hands threads to the function on a board mounted at basePath %s', async (basePath) => {
    const errors: string[] = []
    const { board, webhook } = setup({
      basePath,
      alerts: async ({ event, board }) => {
        if (event.kind !== 'message') return
        try {
          await board.sync('alerts/www', event)
        } catch (error) {
          errors.push((error as Error).message)
        }
      },
    })
    const julian = caller(board.fetch, await personToken())
    const payload = { type: 'message', threadId: 'slack:C3:310', id: '310', text: 'TypeError', user: 'B_SENTRY' }
    await webhook('slack', payload)
    await webhook('slack', payload) // a platform retry stays idempotent
    await vi.waitFor(async () => expect(await read(julian, 'alerts/www')).toHaveLength(1))
    expect(errors).toEqual([])
    expect((await read(julian, 'alerts/www'))[0]!.by.actor).toBe('slack:user:B_SENTRY')
  })

  it('turns a PR into a thread with state labels, and starts a Slack thread for it', async () => {
    const { board, s, g, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const pr = (action: string, extra: Record<string, unknown> = {}) => ({
      action,
      repository: { full_name: 'basehub-ai/vboard' },
      sender: { login: 'julianbenegas', id: 42 },
      pull_request: { number: 7, title: 'Add sync', html_url: 'https://github.com/basehub-ai/vboard/pull/7', draft: false, merged: false, ...extra },
    })
    const event = (body: unknown, delivery: string) =>
      webhook('github', body, { 'x-github-event': 'pull_request', 'x-github-delivery': delivery })

    await event(pr('opened'), 'd1')
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    expect(root).toMatchObject({ from: 'github', labels: { pr: 'basehub-ai/vboard#7', state: 'open' } })
    expect(root!.text).toContain('PR #7: Add sync')
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId)).toEqual(['slack:C2']))

    await event(pr('closed', { merged: true }), 'd2')
    await event(pr('closed', { merged: true }), 'd2') // redelivered
    await vi.waitFor(async () => {
      const thread = (await julian('GET', `/messages/${root!.id}`)).body
      expect(thread.message.labels.state).toBe('merged')
      expect(thread.replies.map((m: { text: string }) => m.text)).toEqual(['merged by julianbenegas'])
    })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toEqual([expect.stringContaining('merged by julianbenegas')]))
    expect(g.posts).toHaveLength(0) // GitHub's own reply never goes back to GitHub
  })

  it("keeps a GitHub author's avatar when a comment arrives without one", async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const avatar = 'https://avatars.githubusercontent.com/u/42?v=4'
    await webhook(
      'github',
      {
        action: 'opened',
        repository: { full_name: 'basehub-ai/vboard' },
        sender: { login: 'julianbenegas', id: 42, avatar_url: avatar },
        pull_request: { number: 8, title: 'Avatars', html_url: 'https://github.com/basehub-ai/vboard/pull/8', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'a1' },
    )
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    // Chat SDK's GitHub messages carry no avatar.
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:8', id: 'c1', text: 'nice', user: '42', name: 'julianbenegas' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))

    const { body } = await julian('GET', '/actors')
    expect(body.actors.find((a: { id: string }) => a.id === 'github:user:42')).toMatchObject({ avatar })
    const events = (await julian('GET', '/events?after=0&all=true')).body.events as { type: string }[]
    expect(events.filter((e) => e.type === 'actor.seen')).toHaveLength(1) // the comment didn't rewrite the author
  })

  it('mirrors a draft PR before its deployment comments and keeps the root when it becomes ready', async () => {
    const get = vi.fn()
    const { board, s, g, webhook } = setup({ githubClient: { rest: { pulls: { get } } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const sender = { id: 42, login: 'julianbenegas' }
    const pr = { number: 38, title: 'Fix imports', html_url: 'https://github.com/basehub-ai/vboard/pull/38' }
    await webhook('github', { action: 'opened', repository, sender, pull_request: { ...pr, draft: true } }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'draft-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    expect(root).toMatchObject({ text: `PR #38: Fix imports\n${pr.html_url}`, labels: { pr: 'basehub-ai/vboard#38', state: 'draft' } })

    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:38', id: 'deploy', text: 'Building', user: '35613825', name: 'vercel[bot]' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))
    await webhook('github', { action: 'ready_for_review', repository, sender, pull_request: { ...pr, draft: false } }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'draft-ready' })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]).toMatchObject({ id: root!.id, labels: { state: 'open' } }))
    expect((await read(julian, 'prs'))[1]).toMatchObject({ text: 'Building', re: root!.id })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.channelPosts).toHaveLength(1)
    expect(s.channelPosts[0]!.text).toContain('PR #38: Fix imports')
    expect(s.posts[0]!.threadId).toBe(`slack:C2:${s.channelPosts[0]!.id}`)
    expect(get).not.toHaveBeenCalled()
    expect(g.posts).toHaveLength(0)
  })

  it('keeps a draft PR a draft when it is closed and reopened', async () => {
    const { board, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() } } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const sender = { id: 42, login: 'julianbenegas' }
    const pr = { number: 39, title: 'Spike', html_url: 'https://github.com/basehub-ai/vboard/pull/39', draft: true }
    const send = (action: string, extra = {}) =>
      webhook('github', { action, repository, sender, pull_request: { ...pr, ...extra } }, { 'x-github-event': 'pull_request', 'x-github-delivery': `draft-${action}` })
    await send('opened')
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]?.labels.state).toBe('draft'))
    await send('closed', { merged: false })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]?.labels.state).toBe('closed'))
    await send('reopened')
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]?.labels.state).toBe('draft'))
  })

  it.each([
    { name: 'PR', key: 'pull_request', event: 'pull_request' },
    { name: 'issue', key: 'issue', event: 'issues' },
  ])('puts a reaction on a $name root on the $name itself, not on a comment', async ({ key, event }) => {
    const reactions = {
      createForIssue: vi.fn(async () => ({})),
      listForIssue: vi.fn(async () => ({ data: [{ id: 9, content: 'rocket', user: { id: 42 } }, { id: 10, content: 'rocket', user: { id: 1 } }] })),
      deleteForIssue: vi.fn(async () => ({})),
    }
    const { board, g, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() }, issues: { get: vi.fn() }, reactions } } })
    Object.assign(g.adapter, { botUserId: '1', emojiToGitHubReaction: (emoji: string) => ({ rocket: 'rocket', eyes: 'eyes' })[emoji] ?? '+1' })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const item = { number: 41, title: 'Ship it', html_url: 'https://github.com/basehub-ai/vboard/pull/41' }
    await webhook('github', { action: 'opened', repository: { full_name: 'basehub-ai/vboard' }, sender: { id: 42, login: 'julianbenegas' }, [key]: item },
      { 'x-github-event': event, 'x-github-delivery': `react-${key}` })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')

    await julian('POST', `/messages/${root!.id}/reactions`, { emoji: 'rocket' })
    const where = { owner: 'basehub-ai', repo: 'vboard', issue_number: 41 }
    await vi.waitFor(() => expect(reactions.createForIssue).toHaveBeenCalledExactlyOnceWith({ ...where, content: 'rocket' }))
    expect(g.reactions).toEqual([]) // no comment reaction on comment NaN

    // Emoji GitHub doesn't have stay off the PR, rather than turning into the bot's 👍.
    await julian('POST', `/messages/${root!.id}/reactions`, { emoji: 'looking-bunny' })
    await julian('POST', `/messages/${root!.id}/reactions`, { emoji: 'thumbs_up' })
    await vi.waitFor(() => expect(reactions.createForIssue).toHaveBeenLastCalledWith({ ...where, content: '+1' }))
    expect(reactions.createForIssue).toHaveBeenCalledTimes(2)
    expect((await read(julian, 'prs'))[0]!.reactions).toHaveProperty('looking-bunny')

    await julian('POST', `/messages/${root!.id}/reactions`, { emoji: 'rocket', remove: true })
    await vi.waitFor(() => expect(reactions.deleteForIssue).toHaveBeenCalledExactlyOnceWith({ ...where, reaction_id: 10 }))
  })

  it("mirrors Vercel's deployment comment to Slack as a line per deployment, keeping the original on the board", async () => {
    const { board, s, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() } } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const pr = { number: 39, title: 'Deploy me', html_url: 'https://github.com/basehub-ai/vboard/pull/39' }
    await webhook('github', { action: 'opened', repository, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'vc-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:39', id: 'vc', text: VERCEL_BUILDING, user: '35613825', name: 'vercel[bot]' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect((await read(julian, 'prs'))[1]!.text).toMatch(/^\[vc\]: #/) // the board keeps what Vercel wrote
    const posted = JSON.parse(s.posts[0]!.text).markdown as string
    expect(posted).toContain('**▲ Vercel**\n- ⏳ **[vboard-factory](https://vercel.com/vercel-internal-playground/vboard-factory)** · [Building]')
    expect(posted).not.toContain('[vc]:')
    expect(posted).not.toContain('| Project |')
  })

  it('keeps a reply imported with `noSync` on the board, and still delivers the rest of its thread', async () => {
    const { board, s, webhook } = setup({
      githubClient: { rest: { pulls: { get: vi.fn() } } },
      repos: {
        // Inline review threads stay on GitHub and the board.
        'basehub-ai/vboard': { channel: 'prs', run: async ({ event, board }) => void (await board.sync('prs', event, { noSync: event.subthread !== null })) },
      },
    })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const pr = { number: 40, title: 'Review me', html_url: 'https://github.com/basehub-ai/vboard/pull/40' }
    await webhook('github', { action: 'opened', repository, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'rv-opened' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:40:rc:9', id: 'rc1', text: 'Fixed in abc123', user: '43', raw: { path: 'src/a.ts', line: 3 } })
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:40', id: 'c1', text: 'Ready for another look', user: '43' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(3))
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    const [, inline, top] = await read(julian, 'prs')
    expect(inline).toMatchObject({ text: 'Fixed in abc123', noSync: true })
    expect(top).toMatchObject({ text: 'Ready for another look', noSync: false })
    expect(JSON.parse(s.posts[0]!.text).markdown).toContain('Ready for another look')

    // A backfill leaves it out too.
    await julian('POST', `/messages/${(await read(julian, 'prs'))[0]!.id}/sync`, { target: 'slack:C1' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(2))
    await vi.waitFor(() => expect(s.posts).toHaveLength(2))
    expect(s.posts.map((p) => p.text).join('\n')).not.toContain('Fixed in abc123')
  })

  it("keeps a PR's `noSync` lifecycle reply on the board, and still re-renders its root in Slack", async () => {
    const { board, s, webhook } = setup({
      githubClient: { rest: { pulls: { get: vi.fn() } } },
      slackRender: ({ message }) => `[${message.labels.state ?? '-'}] ${message.text}`,
      repos: {
        'basehub-ai/vboard': {
          channel: 'prs',
          run: async ({ event, board }) =>
            void (await board.sync('prs', event, { noSync: event.type === 'pr.closed' && event.labels?.state === 'closed' })),
        },
      },
    })
    const julian = caller(board.fetch, await personToken())
    const pr = (action: string, merged = false) => ({
      action, repository: { full_name: 'basehub-ai/vboard' }, sender: { id: 42, login: 'julianbenegas' },
      pull_request: { number: 44, title: 'Stale', html_url: 'https://github.com/basehub-ai/vboard/pull/44', draft: false, merged },
    })
    const send = (action: string, delivery: string, merged = false) =>
      webhook('github', pr(action, merged), { 'x-github-event': 'pull_request', 'x-github-delivery': delivery })
    await send('opened', 'q-opened')
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))

    await send('closed', 'q-closed')
    await vi.waitFor(() => expect(s.edits.map((e) => e.text)).toEqual([expect.stringContaining('[closed] PR #44')]))
    const [, closed] = await read(julian, 'prs')
    expect(closed).toMatchObject({ text: 'closed by julianbenegas', noSync: true })

    await send('reopened', 'q-reopened')
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toEqual([expect.stringContaining('reopened by julianbenegas')]))
    expect(s.posts.map((p) => p.text).join('\n')).not.toContain('closed by')
  })

  it.each([
    { thread: 'basehub-ai/vboard:50', issue: false, draft: false, merged: false, state: 'open', expectedState: 'open' },
    { thread: 'basehub-ai/vboard:50:rc:123', issue: false, draft: true, merged: false, state: 'open', expectedState: 'draft' },
    { thread: 'basehub-ai/vboard:50', issue: false, draft: false, merged: true, state: 'closed', expectedState: 'merged' },
    { thread: 'basehub-ai/vboard:issue:50', issue: true, draft: false, merged: false, state: 'closed', expectedState: 'closed' },
  ])('fetches a titled root for an unseen $expectedState thread ($thread)', async ({ thread, issue, draft, merged, state, expectedState }) => {
    const url = `https://github.com/basehub-ai/vboard/${issue ? 'issues' : 'pull'}/50`
    const avatar = 'https://avatars.githubusercontent.com/u/42?v=4'
    const get = vi.fn(async () => ({ data: {
      number: 50, title: 'Root first', html_url: url, state, draft, merged,
      user: { id: 42, login: 'julianbenegas', avatar_url: avatar },
      labels: [{ name: 'bug' }], assignees: [{ login: 'ada' }],
    } }))
    const { board, s, g, webhook } = setup({ githubClient: { rest: { pulls: { get }, issues: { get } } } })
    const julian = caller(board.fetch, await personToken())
    const payload = { type: 'message', threadId: `github:${thread}`, id: 'c1', text: 'Building', user: '35613825', name: 'vercel[bot]', raw: { path: 'src/index.ts', line: 12 } }
    await webhook('github', payload)
    await webhook('github', payload)
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))
    const [root, comment] = await read(julian, 'prs')
    expect(root).toMatchObject({
      text: `${issue ? 'Issue' : 'PR'} #50: Root first\n${url}`, re: null, by: { actor: 'github:user:42' },
      labels: { [issue ? 'issue' : 'pr']: 'basehub-ai/vboard#50', state: expectedState, 'tag.bug': 'bug', 'assignee.ada': 'ada' },
    })
    expect(comment).toMatchObject({ text: 'Building', re: root!.id, by: { actor: 'github:user:35613825' } })
    const { body } = await julian('GET', `/messages/${root!.id}`)
    expect(body.message.author.avatar).toBe(avatar)
    expect(body.message.origin).toMatchObject({ thread: `github:basehub-ai/vboard:${issue ? 'issue:' : ''}50`, subthread: null, context: null })
    expect(body.replies[0].origin).toMatchObject({ subthread: thread.endsWith(':rc:123') ? `github:${thread}` : null, context: 'src/index.ts:12' })
    expect(get).toHaveBeenCalledExactlyOnceWith({ owner: 'basehub-ai', repo: 'vboard', [issue ? 'issue_number' : 'pull_number']: 50 })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.channelPosts).toHaveLength(1)
    expect(s.channelPosts[0]!.text).toContain('Root first')
    expect(s.posts[0]!.threadId).toBe(`slack:C2:${s.channelPosts[0]!.id}`)
    expect(g.posts).toHaveLength(0)

    await webhook('github', { action: 'opened', repository: { full_name: 'basehub-ai/vboard' }, sender: { id: 42, login: 'julianbenegas' },
      [issue ? 'issue' : 'pull_request']: { number: 50, title: 'Root first', html_url: url, draft, labels: [{ name: 'bug' }], assignees: [{ login: 'ada' }] },
    }, { 'x-github-event': issue ? 'issues' : 'pull_request', 'x-github-delivery': 'late-opened' })
    await webhook('github', { ...payload, id: 'c2', text: 'Ready' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(3))
    expect((await read(julian, 'prs')).filter((m) => m.re === null).map((m) => m.id)).toEqual([root!.id])
    expect(get).toHaveBeenCalledTimes(1)
    expect(s.channelPosts).toHaveLength(1)
  })

  it('retries a failed GitHub root lookup without posting the comment as a root', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('GitHub unavailable')).mockResolvedValue({ data: {
      number: 51, title: 'Try again', html_url: 'https://github.com/basehub-ai/vboard/pull/51', state: 'open', user: { id: 42, login: 'julianbenegas' },
    } })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { board, s, webhook } = setup({ githubClient: { rest: { pulls: { get } } } })
      const julian = caller(board.fetch, await personToken())
      await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:51', id: 'c1', text: 'Building', user: '35613825', name: 'vercel[bot]' })
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      expect(await read(julian, 'prs')).toHaveLength(0)
      expect(s.channelPosts).toHaveLength(0)
      await vi.waitFor(async () => {
        await board.servers[1]!.drain('inbox:github:basehub-ai/vboard:pulls')
        expect(await read(julian, 'prs')).toHaveLength(2)
      })
      const [root, comment] = await read(julian, 'prs')
      expect(root!.text).toContain('PR #51: Try again')
      expect(comment).toMatchObject({ text: 'Building', re: root!.id })
      expect(get).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  it('leaves unseen comments to repo functions without fetching a root', async () => {
    const seen = vi.fn()
    const get = vi.fn()
    const { board, webhook } = setup({ repos: { 'basehub-ai/vboard': seen }, githubClient: { rest: { pulls: { get } } } })
    const julian = caller(board.fetch, await personToken())
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:52', id: 'c1', text: 'Building', user: '35613825' })
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    expect(seen.mock.calls[0]![0].event).toMatchObject({ type: 'comment', text: 'Building' })
    expect(await read(julian, 'prs')).toHaveLength(0)
    expect(get).not.toHaveBeenCalled()
  })

  it("sends a repo's PRs and issues to different channels", async () => {
    const { board, webhook } = setup({ repos: { 'basehub-ai/vboard': { pulls: 'prs', issues: 'issues' } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const sender = { login: 'julianbenegas', id: 42 }
    await webhook(
      'github',
      { action: 'opened', repository, sender, pull_request: { number: 9, title: 'A PR', html_url: 'https://github.com/x/pull/9', draft: false, merged: false } },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 's1' },
    )
    await webhook(
      'github',
      { action: 'opened', repository, sender, issue: { number: 10, title: 'An issue', html_url: 'https://github.com/x/issues/10' } },
      { 'x-github-event': 'issues', 'x-github-delivery': 's2' },
    )
    await vi.waitFor(async () => expect((await read(julian, 'issues')).map((m) => m.text)).toEqual([expect.stringContaining('Issue #10')]))
    expect((await read(julian, 'prs')).map((m) => m.text)).toEqual([expect.stringContaining('PR #9')])

    // A comment on the issue follows it there.
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:issue:10', id: 'c2', text: 'on it', user: '42' })
    await vi.waitFor(async () => expect(await read(julian, 'issues')).toHaveLength(2))
    expect(await read(julian, 'prs')).toHaveLength(1)
  })

  it("mirrors GitHub's labels and assignees as `tag.*` and `assignee.*` labels", async () => {
    const { board, webhook } = setup({ repos: { 'basehub-ai/vboard': { pulls: 'prs', issues: 'issues' } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const sender = { login: 'julianbenegas', id: 42 }
    let delivery = 0
    const send = (name: string, body: Record<string, unknown>) =>
      webhook('github', { repository, sender, ...body }, { 'x-github-event': name, 'x-github-delivery': `t${++delivery}` })
    const labelEvents = async () =>
      ((await julian('GET', '/events?after=0&all=true')).body.events as { type: string }[]).filter((e) => e.type === 'labels.changed')

    // Like GitHub's, every payload carries the issue's labels and assignees after the action.
    const issue = (labels: string[], assignees: string[] = []) => ({
      number: 10,
      title: 'Label sync',
      html_url: 'https://github.com/x/issues/10',
      labels: labels.map((name) => ({ name })),
      assignees: assignees.map((login) => ({ login })),
    })
    await send('issues', { action: 'opened', issue: issue(['bug', 'Good First Issue', '🐛'], ['julianbenegas']) })
    await vi.waitFor(async () => expect(await read(julian, 'issues')).toHaveLength(1))
    const labelsOf = async () => (await read(julian, 'issues'))[0]!.labels
    expect(await labelsOf()).toEqual({
      issue: 'basehub-ai/vboard#10',
      state: 'open',
      'tag.bug': 'bug',
      'tag.good-first-issue': 'Good First Issue',
      'assignee.julianbenegas': 'julianbenegas',
    })

    // GitHub follows an issue opened with labels by a `labeled` for each: nothing changes, so nothing's written.
    const all = ['bug', 'Good First Issue', '🐛']
    await send('issues', { action: 'labeled', issue: issue(all, ['julianbenegas']), label: { name: 'bug' } })
    await send('issues', { action: 'labeled', issue: issue([...all, 'priority: high'], ['julianbenegas']), label: { name: 'priority: high' } })
    await vi.waitFor(async () => expect((await labelsOf())['tag.priority-high']).toBe('priority: high'))
    expect(await labelEvents()).toHaveLength(1)

    await send('issues', { action: 'unlabeled', issue: issue(['Good First Issue', 'priority: high'], ['julianbenegas']), label: { name: 'bug' } })
    await send('issues', { action: 'unassigned', issue: issue(['Good First Issue', 'priority: high']), assignee: { login: 'julianbenegas' } })
    await vi.waitFor(async () => {
      const labels = await labelsOf()
      expect(labels).not.toHaveProperty('tag.bug')
      expect(labels).not.toHaveProperty('assignee.julianbenegas')
    })
    expect((await read(julian, 'issues')).filter((m) => m.re !== null)).toHaveLength(0) // label changes post no replies

    // The mirror owns `tag.*` and `assignee.*`: any event puts them back to what GitHub has, even after a missed
    // `unlabeled` or a board edit. Two names that share a key keep it until both are gone.
    await julian('POST', `/messages/${(await read(julian, 'issues'))[0]!.id}/labels`, { set: { 'tag.stale': 'stale', status: 'triaged' } })
    await send('issues', { action: 'labeled', issue: issue(['Good First Issue', 'good-first-issue', 'priority: high']), label: { name: 'good-first-issue' } })
    await send('issues', { action: 'unlabeled', issue: issue(['good-first-issue', 'priority: high']), label: { name: 'Good First Issue' } })
    await vi.waitFor(async () => expect(await labelsOf()).not.toHaveProperty('tag.stale'))
    expect(await labelsOf()).toEqual({
      issue: 'basehub-ai/vboard#10',
      state: 'open',
      status: 'triaged', // not the mirror's
      'tag.good-first-issue': 'good-first-issue',
      'tag.priority-high': 'priority: high',
    })

    const pr = { number: 11, title: 'Draft', html_url: 'https://github.com/x/pull/11', merged: false }
    await send('pull_request', { action: 'opened', pull_request: { ...pr, draft: true } })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [draft] = await read(julian, 'prs')
    expect(draft).toMatchObject({ text: 'PR #11: Draft\nhttps://github.com/x/pull/11', labels: { pr: 'basehub-ai/vboard#11', state: 'draft' } })
    await send('pull_request', { action: 'labeled', pull_request: { ...pr, draft: true, labels: [{ name: 'wip' }] }, label: { name: 'wip' } })
    await send('pull_request', { action: 'ready_for_review', pull_request: { ...pr, draft: false, labels: [{ name: 'wip' }] } })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]).toMatchObject({ id: draft!.id, labels: { state: 'open', 'tag.wip': 'wip' } }))
    const assigned = { ...pr, labels: [{ name: 'wip' }], assignees: [{ login: 'pi-bot[bot]' }] }
    await send('pull_request', { action: 'assigned', pull_request: assigned, assignee: { login: 'pi-bot[bot]' } })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]!.labels['assignee.pi-bot-bot']).toBe('pi-bot[bot]'))
    expect((await julian('GET', '/messages?label=tag.wip')).body.messages).toHaveLength(1)
  })

  it('leaves `tag.*` or `assignee.*` alone when a payload leaves out `labels` or `assignees`', async () => {
    const { board, webhook } = setup({ repos: { 'basehub-ai/vboard': { pulls: 'prs', issues: 'issues' } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const sender = { login: 'julianbenegas', id: 42 }
    let delivery = 0
    const send = (body: Record<string, unknown>) =>
      webhook('github', { repository, sender, ...body }, { 'x-github-event': 'issues', 'x-github-delivery': `m${++delivery}` })
    const base = { number: 12, title: 'Trimmed', html_url: 'https://github.com/x/issues/12' }
    const labelsOf = async () => (await read(julian, 'issues'))[0]!.labels

    await send({ action: 'opened', issue: { ...base, labels: [{ name: 'bug' }], assignees: [{ login: 'julianbenegas' }] } })
    await vi.waitFor(async () => expect((await labelsOf())['assignee.julianbenegas']).toBe('julianbenegas'))

    // No `assignees`: the labels reconcile, the assignees stay.
    await send({ action: 'labeled', issue: { ...base, labels: [{ name: 'bug' }, { name: 'p1' }] }, label: { name: 'p1' } })
    await vi.waitFor(async () => expect((await labelsOf())['tag.p1']).toBe('p1'))
    expect(await labelsOf()).toMatchObject({ 'tag.bug': 'bug', 'assignee.julianbenegas': 'julianbenegas' })

    // No `labels`: the assignees reconcile, the labels stay.
    await send({ action: 'unassigned', issue: { ...base, assignees: [] }, assignee: { login: 'julianbenegas' } })
    await vi.waitFor(async () => expect(await labelsOf()).not.toHaveProperty('assignee.julianbenegas'))
    expect(await labelsOf()).toMatchObject({ 'tag.bug': 'bug', 'tag.p1': 'p1' })
  })

  it("keeps GitHub's markdown and avatars, and posts markdown to platforms", async () => {
    const get = vi.fn(async () => ({ data: { number: 3, title: 'Deploy previews', html_url: 'https://github.com/basehub-ai/vboard/pull/3', state: 'open', user: { id: 42, login: 'julianbenegas' } } }))
    const { board, s, webhook } = setup({ githubClient: { rest: { pulls: { get } } } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const table = '| Project | Status |\n| --- | --- |\n| www | Ready |'
    await webhook('github', {
      type: 'message',
      threadId: 'github:basehub-ai/vboard:3',
      id: 'c9',
      text: 'Project Status www Ready', // Chat SDK's flattened text
      user: '35613825',
      name: 'vercel[bot]',
      raw: { comment: { body: table, user: { avatar_url: 'https://avatars.githubusercontent.com/in/8329?v=4' } } },
    })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))
    const [root, comment] = await read(julian, 'prs')
    expect(root!.text).toBe('PR #3: Deploy previews\nhttps://github.com/basehub-ai/vboard/pull/3')
    expect(comment).toMatchObject({ text: table, re: root!.id })
    expect(get).toHaveBeenCalledExactlyOnceWith({ owner: 'basehub-ai', repo: 'vboard', pull_number: 3 })
    const { body } = await julian('GET', '/actors')
    expect(body.actors.find((a: { id: string }) => a.id === 'github:user:35613825')).toMatchObject({
      avatar: 'https://avatars.githubusercontent.com/in/8329?v=4',
    })

    await julian('POST', '/messages', { channel: 'firehose', text: '**ship it**' })
    // The GitHub thread mirrored to Slack too: each starts a thread in its channel.
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId).sort()).toEqual(['slack:C1', 'slack:C2']))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(JSON.stringify({ markdown: '**julian**: **ship it**' }))
  })

  it('re-renders a copy when a label change changes its rendering, and only then', async () => {
    const { board, s } = setup({ slackRender: ({ message }) => `[${message.labels.state ?? '-'}] ${message.text}` })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const { body } = await julian('POST', '/messages', { channel: 'prs', text: 'PR #1', labels: { state: 'draft' } })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.text).toBe(JSON.stringify({ markdown: '[draft] PR #1' }))

    await julian('POST', `/messages/${body.message.id}/labels`, { set: { review: 'approved' } })
    await julian('POST', `/messages/${body.message.id}/labels`, { set: { state: 'merged' } })
    await vi.waitFor(() => expect(s.edits).toHaveLength(1))
    expect(s.edits[0]).toMatchObject({ messageId: s.channelPosts[0]!.id, text: JSON.stringify({ markdown: '[merged] PR #1' }) })
  })

  it.each([false, true])('posts mentions natively without changing code (custom renderer: %s)', async (customRender) => {
    const { board, s, webhook } = setup({ slackRender: customRender ? ({ message }) => message.text : undefined })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'prs', text: 'hi' })
    await webhook('slack', { type: 'message', threadId: 'slack:C2:500', id: '500', text: 'hello', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))

    await julian('POST', '/messages', { channel: 'firehose', text: '@[slack:user:U_ADA] and @julian, see \`@julian\`' })
    await vi.waitFor(() => expect(s.channelPosts.some((p) => p.channelId === 'slack:C1')).toBe(true))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(
      JSON.stringify({ markdown: `${customRender ? '' : '**julian**: '}<@U_ADA> and julian, see \`@julian\`` }),
    )
  })

  it('turns @[email] into the Slack user with that email, and leaves an unknown one as text', async () => {
    const lookupByEmail = vi.fn(async ({ email }: { email: string }) => {
      if (email === 'missing-id@vercel.com') return { user: { name: 'missing-id' } }
      if (email !== 'ada@vercel.com') throw new Error('users_not_found')
      return { user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada Lovelace' } } }
    })
    const conversations = { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) }
    const { board, s } = setup({ slackClient: { conversations, users: { info: async () => ({}), lookupByEmail } } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    const { body } = await julian('POST', '/messages', {
      channel: 'firehose',
      text: 'owner: @[ada@vercel.com], cc @[nobody@vercel.com], missing: @[missing-id@vercel.com]',
    })

    expect(body.message).toMatchObject({
      text: 'owner: @[slack:user:U_ADA], cc nobody@vercel.com, missing: missing-id@vercel.com',
      mentions: ['slack:user:U_ADA'],
    })
    const actors = (await julian('GET', '/actors')).body.actors as { id: string; name: string }[]
    expect(actors.find((actor) => actor.id === 'slack:user:U_ADA')).toMatchObject({ name: 'Ada Lovelace' })
    await vi.waitFor(() => expect(s.channelPosts.some((p) => p.channelId === 'slack:C1')).toBe(true))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(
      JSON.stringify({ markdown: '**julian**: owner: <@U_ADA>, cc nobody@vercel.com, missing: missing-id@vercel.com' }),
    )
  })

  it('attaches an existing thread to a new target and backfills it', async () => {
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'deploys', text: 'rollback in progress' })
    await julian('POST', '/messages', { re: body.message.id, text: 'db restored' })
    const attached = await julian('POST', `/messages/${body.message.id}/sync`, { target: 'slack:C9' })
    expect(attached.body).toEqual({ target: 'slack:C9', attached: true })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.channelPosts.map((p) => p.channelId)).toEqual(['slack:C9'])
    expect(s.posts[0]!.text).toContain('db restored')
    const again = await julian('POST', `/messages/${body.message.id}/sync`, { target: 'slack:C9' })
    expect(again.body.attached).toBe(false)
  })

  it('skips a Slack channel name that does not resolve, and syncs the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = { list: vi.fn(async () => ({ channels: [] })), info: vi.fn(async () => ({})), join: vi.fn() }
    const { board, s, webhook } = setup({ channels: { '#missing': 'alerts' }, slackClient: { conversations } })
    const julian = caller(board.fetch, await personToken())

    await webhook('slack', { type: 'message', threadId: 'slack:C1:500', id: '500', text: 'still syncing', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await julian('POST', '/messages', { channel: 'prs', text: 'and outbound too' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping #missing: no Slack channel named #missing'))
    warn.mockRestore()
  })

  it('joins mapped Slack channels by name, and says which private ones need an invite', async () => {
    // The Vercel Connect shape: the bot token resolves asynchronously.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = {
      list: vi.fn(async () => ({
        channels: [
          { id: 'C9', name: 'sf-prs', is_member: false, is_private: false },
          { id: 'C8', name: 'sf-secret', is_member: false, is_private: true },
        ],
      })),
      info: vi.fn(async ({ channel }: { channel: string }) => ({ channel: { id: channel, is_member: true } })),
      join: vi.fn(async () => ({ ok: true })),
    }
    const { board, s } = setup({
      channels: { '#sf-prs': 'deploys', '#sf-secret': 'secret' },
      slackClient: { conversations },
      asyncToken: true,
    })
    const julian = caller(board.fetch, await personToken())

    await julian('POST', '/messages', { channel: 'deploys', text: 'shipped' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.channelId).toBe('slack:C9')
    expect(conversations.join).toHaveBeenCalledTimes(1)
    expect(conversations.join).toHaveBeenCalledWith({ channel: 'C9' })
    expect(conversations.list).toHaveBeenCalledTimes(1) // one listing resolves every name
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invite the app to #sf-secret'))
    warn.mockRestore()
  })

  it('finds public channels by name when the app may not list private ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'groups:read' },
    })
    const conversations = {
      list: vi.fn(async ({ types }: { types: string }) => {
        if (types.includes('private_channel')) throw missingScope
        return { channels: [{ id: 'C9', name: 'sf-prs', is_member: true }] }
      }),
      info: vi.fn(async () => {
        throw missingScope
      }),
      join: vi.fn(),
    }
    const { board, s } = setup({
      channels: { '#sf-prs': 'deploys', '#sf-secret': 'secret' },
      slackClient: { conversations },
      asyncToken: true,
    })
    const julian = caller(board.fetch, await personToken())

    await julian('POST', '/messages', { channel: 'deploys', text: 'shipped' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.channelId).toBe('slack:C9')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no public Slack channel named #sf-secret'))
    const inbox = await julian('GET', `/inbox/slack?channel=${encodeURIComponent('#sf-secret')}`)
    expect(inbox.status).toBe(400)
    expect(inbox.body.error.message).toContain('groups:read')
    warn.mockRestore()
  })

  it('records a delivery it gives up on, and keeps syncing the thread', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))

    const post = s.adapter.postMessage
    let attempts = 0
    s.adapter.postMessage = async () => {
      attempts++
      throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } })
    }
    const { body: failed } = await julian('POST', '/messages', { re: body.message.id, text: 'rolled back' })
    // Without a scheduler nothing retries on its own; each drain is the next attempt.
    await vi.waitFor(async () => {
      await board.servers[0]!.drain('board')
      const { body: thread } = await julian('GET', `/messages/${body.message.id}`)
      expect(thread.replies[0].undelivered).toEqual({ 'slack:C1': 'not_in_channel' })
    })
    expect(attempts).toBe(5)

    s.adapter.postMessage = post
    await julian('POST', '/messages', { re: body.message.id, text: 'fixed forward' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toEqual([expect.stringContaining('fixed forward')]))
    const events = (await julian('GET', '/events?after=0')).body.events as { type: string; payload: { id?: number } }[]
    expect(events.find((e) => e.type === 'message.sync_failed')?.payload.id).toBe(failed.message.id)
    error.mockRestore()
  })

  it('shows raw platform events in the inbox', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    await webhook('slack', { type: 'message', threadId: 'slack:C1:400', id: '400', text: 'hello', user: 'U_ADA' })
    await webhook('slack', { type: 'message', threadId: 'slack:C7:1', id: '1', text: 'unmapped', user: 'U_ADA' })
    const { body } = await julian('GET', '/inbox/slack')
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ channel: 'slack:C1', sync: 'slack', event: { kind: 'message', text: 'hello' } })
  })
})

describe('provider callbacks', () => {

  it.each([
    { action: 'opened', existing: false, issue: false },
    { action: 'reopened', existing: false, issue: false },
    { action: 'reopened', existing: true, issue: false },
    { action: 'opened', existing: false, issue: true },
    { action: 'reopened', existing: false, issue: true },
    { action: 'reopened', existing: true, issue: true },
  ])('returns stable lifecycle results across retry ($action, existing: $existing, issue: $issue)', async ({ action, existing, issue }) => {
    const g = fakePlatform('github')
    const results: import('../src/sync/events.ts').SyncResult[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const board = testBoard({ sync: { github: github({
        adapter: g.adapter,
        repos: { 'basehub-ai/vboard': async ({ event, board }) => {
          const selected = event.kind === 'lifecycle' && event.raw.action === action
          const imported = await board.sync('prs', event, { root: () => ({ labels: { 'tag.custom': 'custom' } }) })
          if (selected) {
            results.push(imported)
            await board.reply(imported.root!, 'ack')
            if (results.length === 1) throw new Error('interrupted after lifecycle import')
          }
        } },
      }) } })
      const call = caller(board.fetch, await personToken())
      const send = (action: string, delivery: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
        method: 'POST', headers: { 'x-github-event': issue ? 'issues' : 'pull_request', 'x-github-delivery': delivery },
        body: JSON.stringify({
          action, repository: { full_name: 'basehub-ai/vboard' }, sender: { id: 42, login: 'ada' },
          [issue ? 'issue' : 'pull_request']: { number: 81, title: 'Lifecycle result', html_url: 'https://github.com/basehub-ai/vboard/pull/81', labels: [] },
        }),
      }))
      if (existing) {
        await send('opened', 'initial')
        await vi.waitFor(async () => expect(await read(call, 'prs')).toHaveLength(1))
      }
      await send(action, 'selected')
      await vi.waitFor(() => expect(error).toHaveBeenCalled())
      await vi.waitFor(async () => {
        await board.servers[1]!.drain(`inbox:github:basehub-ai/vboard:${issue ? 'issues' : 'pulls'}`)
        expect(results).toHaveLength(2)
      })
      expect(results[1]).toEqual(results[0])
      const messages = await read(call, 'prs')
      expect(messages).toHaveLength(action === 'opened' ? 2 : 3)
      expect(results[0]).toEqual({ root: messages[0]!.id, message: messages[action === 'opened' ? 0 : 1]!.id })
      expect(messages[0]?.labels['tag.custom']).toBe(existing ? undefined : 'custom')
      expect(messages.filter((message) => message.text === 'ack')).toHaveLength(1)
    } finally { error.mockRestore() }
  })

  it('preserves A2 receipt identities from the pre-refactor handler step', async () => {
    const { board, s, webhook } = setup()
    const call = caller(board.fetch, await personToken())
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'root', user: 'U1' })
    await vi.waitFor(async () => expect(await read(call, 'firehose')).toHaveLength(1))
    const [root] = await read(call, 'firehose')
    const posted = await call('POST', '/messages', { re: root!.id, text: 'reply' })
    const session = board.servers[0]!.session('board')
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    const history = await session.history()
    const trigger = history.find((event) => event.type === 'message.posted' && event.index === posted.body.message.id)
    const receipt = history.find((event) => event.type === 'message.synced' && event.payload.id === posted.body.message.id)
    if (!trigger || trigger.type !== 'message.posted' || !receipt || receipt.type !== 'message.synced') throw new Error('missing delivery history')
    const reference = createServer({
      contract: boardContract, store: memory(),
      handlers: {
        'message.posted': { handler: async (ctx) => {
          await ctx.session.append(`receipt:${posted.body.message.id}:${receipt.payload.target}`, { type: 'message.synced', payload: receipt.payload })
        } },
      },
    })
    const old = reference.session('board')
    await old.append({ id: trigger.id, type: 'message.posted', payload: trigger.payload })
    await vi.waitFor(async () => {
      const expected = (await old.history()).find((event) => event.type === 'message.synced')
      expect(expected?.id).toBe(receipt.id)
    })
  })

  it('keeps callback payload requirements out of a default GitHub mirror', async () => {
    const g = fakePlatform('github')
    const provider = github({ adapter: g.adapter, repos: { 'basehub-ai/vboard': 'prs' } })
    const project = vi.spyOn(provider, 'event')
    const board = testBoard({ sync: { github: provider } })
    const call = caller(board.fetch, await personToken())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
        method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'trimmed-pr' },
        body: JSON.stringify({
          action: 'opened', repository: { full_name: 'basehub-ai/vboard' }, sender: { id: 42, login: 'ada' },
          pull_request: { number: 72, title: 'Trimmed metadata', html_url: 'https://github.com/basehub-ai/vboard/pull/72', base: {} },
        }),
      }))
      await vi.waitFor(async () => expect((await read(call, 'prs'))[0]?.text).toBe('PR #72: Trimmed metadata\nhttps://github.com/basehub-ai/vboard/pull/72'))
      expect(project).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it.each([
    { action: 'opened', existing: false, rootText: 'event text' },
    { action: 'reopened', existing: false, rootText: 'root draft' },
    { action: 'reopened', existing: true, rootText: 'PR #73: Original\nhttps://github.com/basehub-ai/vboard/pull/73' },
  ])('defines text/root precedence for $action (existing: $existing)', async ({ action, existing, rootText }) => {
    const g = fakePlatform('github')
    const board = testBoard({ sync: { github: github({
      adapter: g.adapter,
      repos: { 'basehub-ai/vboard': async ({ event, board }) => {
        const selected = event.kind === 'lifecycle' && event.raw.action === action
        await board.sync('prs', event, selected ? {
          text: 'event text',
          root: () => ({ text: 'root draft', labels: { temporary: 'yes' } }),
          unset: ['temporary', 'tag.bug'],
        } : undefined)
      } },
    }) } })
    const call = caller(board.fetch, await personToken())
    const send = (action: string, delivery: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
      method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': delivery },
      body: JSON.stringify({
        action, repository: { full_name: 'basehub-ai/vboard' }, sender: { id: 42, login: 'ada' },
        pull_request: { number: 73, title: 'Original', html_url: 'https://github.com/basehub-ai/vboard/pull/73', labels: [{ name: 'bug' }] },
      }),
    }))
    if (existing) {
      await send('opened', 'initial')
      await vi.waitFor(async () => expect(await read(call, 'prs')).toHaveLength(1))
    }
    await send(action, 'selected')
    await vi.waitFor(async () => {
      const messages = await read(call, 'prs')
      expect(messages).toHaveLength(action === 'reopened' ? 2 : 1)
      expect(messages[0]?.text).toBe(rootText)
      expect(messages[0]?.labels).not.toHaveProperty('temporary')
      expect(messages[0]?.labels).not.toHaveProperty('tag.bug')
      if (action === 'reopened') expect(messages[1]?.text).toBe('event text')
    })
  })
  it('requires a public client resolver for async-token Slack adapters at setup', () => {
    const adapter = fakePlatform('slack', withSlackClient({}, true)).adapter
    expect(() => slack({ adapter, channels: { C1: 'support' } })).toThrow('public client resolver')
  })


  it('resumes a failed callback after import without treating the retry as an echo', async () => {
    const s = fakePlatform('slack')
    let attempts = 0
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const board = testBoard({ sync: { slack: slack({
        adapter: s.adapter,
        channels: { C1: async ({ event, board }) => {
          const imported = await board.sync('support', event)
          await board.reply(imported.root!, 'ack')
          if (++attempts === 1) throw new Error('interrupted after import')
        } },
      }) } })
      const call = caller(board.fetch, await personToken())
      await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U1' }) }))
      await vi.waitFor(() => expect(attempts).toBe(1))
      await vi.waitFor(async () => {
        await board.servers[1]!.drain('inbox:slack:C1')
        expect(attempts).toBe(2)
      })
      expect((await read(call, 'support')).map((m) => m.text)).toEqual(['hello', 'ack'])
      await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    } finally {
      error.mockRestore()
    }
  })
  it('imports every Slack event through the verified sync client, retaining files and authorship', async () => {
    const s = fakePlatform('slack')
    const seen: string[] = []
    const board = testBoard({ sync: { work: slack({
      adapter: s.adapter,
      channels: { C1: async ({ event, board }) => {
        seen.push(event.type)
        expect(event.platform).toBe('slack')
        expect(event.key).toBe('work')
        expect(Object.isFrozen(event)).toBe(true)
        if (event.kind === 'message') expect(event.files?.[0]?.name).toBe('proof.png')
        await board.sync('support', event, { labels: { area: 'support' }, text: 'text' in event ? `custom: ${event.text}` : undefined })
      } },
    }) } })
    const call = caller(board.fetch, await personToken())
    const receive = (payload: WebhookPayload) => board.fetch(new Request(`${BOARD_URL}/webhooks/work`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }))
    s.served.set('https://files.test/proof', new Uint8Array([1, 2, 3]))
    const root = { type: 'message' as const, threadId: 'slack:C1:100', id: '100', user: 'U1', text: 'hello', files: [{ name: 'proof.png', mimeType: 'image/png', url: 'https://files.test/proof', size: 3 }] }
    await receive(root)
    await receive(root)
    await vi.waitFor(async () => expect(await read(call, 'support')).toHaveLength(1))
    const [imported] = await read(call, 'support')
    expect(imported).toMatchObject({ text: 'custom: hello', labels: { area: 'support' }, by: { actor: 'slack:user:U1' } })
    const view = await call('GET', `/messages/${imported!.id}`)
    expect(view.body.message.attachments).toHaveLength(1)
    await receive({ ...root, id: '101', files: root.files, text: 'reply' })
    await vi.waitFor(async () => expect(await read(call, 'support')).toHaveLength(2))
    await receive({ type: 'edit', threadId: root.threadId, id: '101', text: 'edited', user: 'U1' })
    await vi.waitFor(async () => expect((await read(call, 'support'))[1]?.text).toBe('custom: edited'))
    await receive({ type: 'reaction', threadId: root.threadId, messageId: '100', emoji: 'eyes', added: true, user: 'U2' })
    await vi.waitFor(async () => expect((await read(call, 'support'))[0]?.reactions).toEqual({ eyes: ['slack:user:U2'] }))
    await receive({ type: 'delete', threadId: root.threadId, id: '101' })
    await vi.waitFor(() => expect(seen).toEqual(['message', 'message', 'message.edited', 'reaction.added', 'message.deleted']))
    const reply = (await read(call, 'support'))[1]!
    await vi.waitFor(async () => expect((await call('GET', `/messages/${reply.id}`)).body.replies.find((message: { id: number }) => message.id === reply.id).deleted).toBe(true))
  })

  it('gives a Slack callback the message permalink lazily, without importing the thread', async () => {
    const getPermalink = vi.fn(async ({ channel, message_ts }: { channel: string; message_ts: string }) =>
      ({ permalink: `https://acme.enterprise.slack.com/archives/${channel}/p${message_ts.replace('.', '')}?thread_ts=100.000000` }))
    const client = { conversations: { list: async () => ({}), info: async () => ({}), join: async () => ({}) }, chat: { postMessage: async () => ({}), getPermalink } }
    const s = fakePlatform('slack', withSlackClient(client, false))
    const links: (string | null)[] = []
    let skipped = 0
    const board = testBoard({ sync: { slack: slack({
      adapter: s.adapter,
      channels: { C1: async ({ event, permalink }) => {
        if (event.kind === 'deleted') return void links.push(await permalink())
        if (event.kind !== 'message') return
        if (event.text === 'skip') return void skipped++
        links.push(await permalink(), await permalink())
      } },
    }) } })
    const call = caller(board.fetch, await personToken())
    const send = (id: string, text: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100.000000', id, text, user: 'U1' }) }))
    await send('100.000200', 'skip')
    await send('100.000300', 'copy me')
    await vi.waitFor(() => expect(links).toHaveLength(2))
    expect(skipped).toBe(1)
    expect(links).toEqual(Array(2).fill('https://acme.enterprise.slack.com/archives/C1/p100000300?thread_ts=100.000000'))
    expect(getPermalink).toHaveBeenCalledExactlyOnceWith({ channel: 'C1', message_ts: '100.000300' })
    expect(await read(call, 'firehose')).toEqual([])
    await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'delete', threadId: 'slack:C1:100.000000', id: '100.000300' }) }))
    await vi.waitFor(() => expect(links).toHaveLength(3))
    expect(links[2]).toBeNull()
    expect(getPermalink).toHaveBeenCalledOnce()
  })

  it('rejects forged envelopes and calls after the callback, and skips an event without disconnecting', async () => {
    const s = fakePlatform('slack')
    let saved!: () => Promise<unknown>
    const board = testBoard({ sync: { slack: slack({
      adapter: s.adapter,
      channels: { C1: async ({ event, board }) => {
        await expect(board.sync('support', { ...event })).rejects.toThrow('current verified event')
        saved = () => board.sync('support', event)
        if (event.kind === 'message' && event.text === 'skip') return
        await board.sync('support', event)
        await expect(board.sync('support', event)).rejects.toThrow('only be imported once')
      } },
    }) } })
    const call = caller(board.fetch, await personToken())
    const send = (id: string, text: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id, text, user: 'U1' }) }))
    await send('100', 'first')
    await vi.waitFor(async () => expect(await read(call, 'support')).toHaveLength(1))
    await expect(saved()).rejects.toThrow('callback has finished')
    await send('101', 'skip')
    await send('102', 'last')
    await vi.waitFor(async () => expect((await read(call, 'support')).map((m) => m.text)).toEqual(['first', 'last']))
    await call('POST', '/messages', { re: (await read(call, 'support'))[0]!.id, text: 'outgoing' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]!.threadId).toBe('slack:C1:100')
  })

  it('keeps automatic reverse routing with a static channel and an all-event callback', async () => {
    const s = fakePlatform('slack')
    const run = vi.fn(async ({ event, board }: Parameters<import('../src/sync/provider.ts').SyncHandler<import('../src/sync/slack.ts').SlackEvent>>[0]) => {
      await board.sync('support', event)
    })
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter, channels: { C1: { channel: 'support', run } } }) } })
    const call = caller(board.fetch, await personToken())
    const posted = await call('POST', '/messages', { channel: 'support', text: 'new board thread' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    const id = s.channelPosts[0]!.id
    await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: `slack:C1:${id}`, id, text: 'new board thread', user: 'B_BOARD' }) }))
    expect(run).not.toHaveBeenCalled()
    await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: `slack:C1:${id}`, id: 'response', text: 'hello', user: 'U1' }) }))
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await vi.waitFor(async () => expect((await read(call, 'support'))[1]?.re).toBe(posted.body.message.id))
  })

  it.each([true, false])('customizes a GitHub root consistently (opening first: %s) and identifies comment subjects', async (openingFirst) => {
    const g = fakePlatform('github')
    const item = { number: 70, title: 'Title', html_url: 'https://github.com/basehub-ai/vboard/pull/70', body: 'Description', draft: true, state: 'open', user: { id: 42, login: 'ada' } }
    const get = vi.fn(async () => ({ data: item }))
    Object.assign(g.adapter, { octokit: { rest: { pulls: { get } } } })
    const seen: { type: string; subject: string }[] = []
    const board = testBoard({ sync: { git: github({
      adapter: g.adapter,
      repos: { 'basehub-ai/vboard': async ({ event, board }) => {
        seen.push({ type: event.type, subject: event.subject.type })
        await board.sync(event.subject.type === 'pull_request' ? 'prs' : 'issues', event, {
          labels: { area: 'vboard' },
          root: ({ raw }) => {
            const pr = (raw as { pull_request: typeof item }).pull_request
            return { text: `${pr.title}\n\n${pr.body}`, labels: { kind: 'code' } }
          },
        })
      } },
    }) } })
    const call = caller(board.fetch, await personToken())
    const opened = () => board.fetch(new Request(`${BOARD_URL}/webhooks/git`, {
      method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'opened-70' },
      body: JSON.stringify({ action: 'opened', repository: { full_name: 'basehub-ai/vboard' }, sender: item.user, pull_request: item }),
    }))
    const comment = () => board.fetch(new Request(`${BOARD_URL}/webhooks/git`, {
      method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'github:basehub-ai/vboard:70:rc:12', id: 'c1', text: 'comment', user: '43', raw: { path: 'src/main.ts', line: 4 } }),
    }))
    if (openingFirst) { await opened(); await comment() } else { await comment(); await opened() }
    await vi.waitFor(async () => expect(await read(call, 'prs')).toHaveLength(2))
    const [root, reply] = await read(call, 'prs')
    expect(root).toMatchObject({ text: 'Title\n\nDescription', labels: { state: 'draft', area: 'vboard', kind: 'code' } })
    expect(reply?.re).toBe(root!.id)
    expect(get).toHaveBeenCalledTimes(openingFirst ? 0 : 1)
    expect(seen).toEqual(openingFirst ? [{ type: 'pr.opened', subject: 'pull_request' }, { type: 'comment', subject: 'pull_request' }] : [{ type: 'comment', subject: 'pull_request' }, { type: 'pr.opened', subject: 'pull_request' }])
  })

  it('does not fetch or import a skipped unknown GitHub conversation', async () => {
    const g = fakePlatform('github')
    const get = vi.fn()
    Object.assign(g.adapter, { octokit: { rest: { pulls: { get } } } })
    const seen = vi.fn()
    const board = testBoard({ sync: { github: github({ adapter: g.adapter, repos: { 'basehub-ai/vboard': seen } }) } })
    await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'github:basehub-ai/vboard:99', id: 'c1', text: 'skip', user: '1' }) }))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce())
    expect(seen.mock.calls[0]![0].event).toMatchObject({ type: 'comment', text: 'skip' })
    expect(get).not.toHaveBeenCalled()
  })

  it('lets a fourth provider resolve opaque IDs without changing the core, preserving media fallback', async () => {
    const nativeChannel = 'https://provider.test/team:inbox'
    const Schema = eventSchema('opaque', 'message')
    type OpaqueEvent = z.infer<typeof Schema>
    class OpaqueProvider extends ChatSyncProvider<OpaqueEvent> {
      constructor(adapter: Adapter, mapping: EventMapping<OpaqueEvent>) {
        super({
          platform: 'opaque', adapter, canStartThreads: true,
          author: (author) => ({ id: `opaque:tenant:sample:user:${author.userId}`, handle: author.userId, name: author.fullName || author.userId, avatar: null, isBot: author.isBot === true }),
          resolveChannel: async () => nativeChannel,
          resolveTarget: async (target) => ({ target: target === 'inbox' ? nativeChannel : target, channel: nativeChannel, kind: target === 'inbox' || target === nativeChannel ? 'channel' : 'thread' }),
          channelOf: () => nativeChannel,
        })
        this.map('inbox', mapping)
      }
      override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>): OpaqueEvent {
        return Schema.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
      }
    }
    const p = fakePlatform('opaque')
    const receive = p.adapter.handleWebhook.bind(p.adapter)
    p.adapter.handleWebhook = (request, options) => request.headers.get('x-native-signature') === 'valid' ? receive(request, options) : Promise.resolve(new Response('invalid signature', { status: 401 }))
    const provider = new OpaqueProvider(p.adapter, { channel: 'tickets', run: async ({ event, board }) => {
      await board.sync('tickets', event)
    } })
    const board = testBoard({ sync: { tickets: provider } })
    const call = caller(board.fetch, await personToken())
    const posted = await call('POST', '/messages', { channel: 'tickets', text: 'opaque root' })
    await vi.waitFor(() => expect(p.channelPosts).toHaveLength(1))
    const thread = `opaque:${nativeChannel}:${p.channelPosts[0]!.id}`
    await board.fetch(new Request(`${BOARD_URL}/webhooks/tickets`, { method: 'POST', headers: { 'x-native-signature': 'valid' }, body: JSON.stringify({ type: 'message', threadId: thread, id: 'response', text: 'native reply', user: '42' }) }))
    await vi.waitFor(async () => expect((await read(call, 'tickets'))[1]?.re).toBe(posted.body.message.id))
    expect((await read(call, 'tickets'))[1]?.by.actor).toBe('opaque:tenant:sample:user:42')
    expect((await board.fetch(new Request(`${BOARD_URL}/webhooks/tickets`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: thread, id: 'forged', text: 'forged', user: '42' }) }))).status).toBe(401)
    const uploaded = await board.fetch(new Request(`${BOARD_URL}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${await personToken()}`, 'content-type': 'image/png', 'x-board-filename': 'proof.png' }, body: new Uint8Array([1, 2, 3]) }))
    const attachment = (await uploaded.json()).attachment
    await call('POST', '/messages', { re: posted.body.message.id, text: 'reply', attachments: [attachment.id] })
    await vi.waitFor(() => expect(p.posts).toHaveLength(1))
    expect(p.posts[0]!.threadId).toBe(thread)
    expect(p.posts[0]!.text).toContain('proof.png')
    const other = await call('POST', '/messages', { channel: 'other', text: 'attach by alias' })
    expect((await call('POST', `/messages/${other.body.message.id}/sync`, { target: 'tickets:inbox' })).body.attached).toBe(true)
    await vi.waitFor(() => expect(p.channelPosts).toHaveLength(2))
    expect(provider.platform).toBe('opaque')
  })
})
