import { describe, expect, it, vi } from 'vitest'
import type { Adapter } from 'chat'
import { fakePlatform, withSlackClient, type WebhookPayload } from './sync-fixtures.ts'
import { slack, SlackProvider, type SlackEvent } from '../src/sync/slack.ts'
import { ChatSyncProvider } from '../src/sync/chat-provider.ts'
import type { Renderer, SyncContext } from '../src/sync/provider.ts'
import { channels, mirror, render, type Sync, type SyncFn, type SyncUnit } from '../src/sync/fn.ts'
import { envelope, eventSchema } from '../src/sync/events.ts'
import { z } from 'zod'
import { consumer, createServer } from 'experimental-a2/server'
import { memory } from 'experimental-a2/store-memory'
import { boardContract } from '../src/contract/contract.ts'
import { github, repos, type GitHubEvent } from '../src/sync/github.ts'
import type { MountOptions } from './harness.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { memory as boardMemory } from '../src/store/memory.ts'
import type { MessageTables } from '../src/store/types.ts'
import { VERCEL_BUILDING } from './vercel-fixtures.ts'
import { fakeQueue } from './queue.ts'
import { HttpError } from '../src/server/errors.ts'

type SlackChannels = Record<string, SyncUnit<SlackEvent>>

function setup(
  options: {
    alerts?: SlackChannels[string]
    channels?: SlackChannels
    slackClient?: unknown
    slackRender?: Renderer
    asyncToken?: boolean
    githubClient?: unknown
    github?: SyncFn<GitHubEvent>
    watch?: MountOptions['watch']
    basePath?: string
    store?: MountOptions['store']
  } = {},
) {
  const s = fakePlatform('slack', options.slackClient ? withSlackClient(options.slackClient, !!options.asyncToken) : undefined)
  const g = fakePlatform('github', options.githubClient ? (adapter) => Object.assign(adapter, { octokit: options.githubClient }) : undefined)
  const board = testBoard({
    sync: {
      slack: slack(
        {
          adapter: s.adapter,
          ...(options.slackClient ? { client: async () => options.slackClient as import('../src/sync/slack.ts').SlackClient } : {}),
        },
        rendered(options.slackRender, channels({ C1: 'firehose', C2: 'prs', ...(options.alerts ? { C3: options.alerts } : {}), ...options.channels })),
      ),
      github: github({ adapter: g.adapter }, options.github ?? repos({ 'vercel-labs/board': mirror('prs') })),
    },
    ...(options.watch ? { watch: options.watch } : {}),
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    ...(options.store ? { store: options.store } : {}),
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

const rendered = <E extends import('../src/sync/events.ts').ProviderEvent>(renderer: Renderer | undefined, fn: SyncFn<E>) => (renderer ? render(renderer, fn) : fn)

/** A unit that delivers what the board says, and hands what comes in to `inbound`. */
const delivering = <E extends import('../src/sync/events.ts').ProviderEvent>(inbound: (sync: Extract<Sync<E>, { direction: 'in' }>) => unknown): SyncFn<E> =>
  async (sync) => (sync.direction === 'in' ? inbound(sync) : sync.deliver())

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
  it("keeps a platform's mentions as its text says them, which mention filters find", async () => {
    const { board, webhook } = setup()
    // A Vercel login's handle is its user ID: Julian's is `julian`.
    const julian = caller(board.fetch, await personToken('julian'), {})
    await julian('POST', '/messages', { channel: 'firehose', text: 'hi' })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:500', id: '500', text: '@julian and @nobody, look', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    const texts = async (query: string) => ((await julian('GET', `/messages?channel=firehose&${query}`)).body.messages as { text: string }[]).map((m) => m.text)
    expect(await texts('from=slack')).toEqual(['@julian and @nobody, look'])
    expect(await texts('mentions=me')).toEqual(['@julian and @nobody, look'])
    expect(await texts('mentions=nobody')).toEqual(['@julian and @nobody, look'])
  })

  it("runs watchers on Slack's messages, and syncs their replies back to Slack", async () => {
    const seen: string[] = []
    const { board, s, webhook } = setup({
      watch: {
        triage: {
          tail: 'firehose --source slack',
          run: async ({ event, board }) => {
            if (event.type === 'message.posted' && event.message!.re === null)
              await board.reply(event.message!.id, 'Thanks! Tracking it.')
          },
        },
        seen: { tail: 'firehose', run: ({ event }) => void seen.push(event.type) },
      },
    })
    const julian = caller(board.fetch, await personToken(), {})
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.threadId)).toEqual(['slack:C1:100']))
    expect(s.posts[0]!.text).toContain('Thanks! Tracking it.')

    // The delivery receipt is bookkeeping: only `--all` shows it, and no watcher runs on it.
    const types = async (query: string) =>
      ((await julian('GET', `/events?channel=firehose&after=0${query}`)).body.events as { type: string }[]).map((e) => e.type)
    await vi.waitFor(async () => expect(await types('&all=true')).toContain('message.synced'))
    expect(await types('')).toEqual(['message.posted', 'message.posted'])
    expect(await types('&all=false')).toEqual(['message.posted', 'message.posted'])
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
    const julian = caller(board.fetch, await personToken(), {})
    await julian('POST', '/messages', { channel: 'prs', text: 'no PR here' })
    const pr = (await julian('POST', '/messages', { channel: 'prs', text: 'PR #12', labels: { pr: 'acme/www#12' } })).body.message
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(2))
    await vi.waitFor(() => expect(landed).toHaveLength(1))
    // Each thread delivers on its own lane, so the two roots reach Slack in either order.
    const copy = s.channelPosts.find((post) => post.text.includes('PR #12'))!
    expect(landed[0]).toEqual({ id: pr.id, external: { thread: `slack:C2:${copy.id}`, message: copy.id }, pr: 'acme/www#12' })
  })

  it("gives a text that opens a block a line of its own under its author's label, so the block is still one", async () => {
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    const texts = ['```sh\npnpm check\n```', '- one\n- two', '1. one\n2. two', '# Checkout is down', '> as you said', '| a | b |\n| - | - |\n| 1 | 2 |', 'ran `pnpm check`']
    for (const text of texts) await julian('POST', '/messages', { channel: 'prs', text })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(texts.length))
    // Each thread delivers on its own lane, so the roots reach Slack in any order.
    const sent = s.channelPosts.map((post) => (JSON.parse(post.text) as { markdown: string }).markdown)
    const label = /^\*\*[^*\n]+\*\*:/.exec(sent[0]!)![0]
    expect(sent.sort()).toEqual([...texts.slice(0, -1).map((text) => `${label}\n\n${text}`), `${label} ran \`pnpm check\``].sort())
  })

  it("does the same under the label a renderer of your own opens with, and leaves what else it writes alone", async () => {
    const { board, s } = setup({ slackRender: ({ message, label }) => (message.labels.plain ? `${label} said:\n${message.text}` : `**${label}**: ${message.text}`) })
    const julian = caller(board.fetch, await personToken(), {})
    await julian('POST', '/messages', { channel: 'prs', text: '```sh\npnpm check\n```' })
    await julian('POST', '/messages', { channel: 'prs', text: '- one\n- two', labels: { plain: 'yes' } })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(2))
    const sent = s.channelPosts.map((post) => (JSON.parse(post.text) as { markdown: string }).markdown).sort()
    expect(sent).toEqual([expect.stringMatching(/^\*\*[^*\n]+\*\*:\n\n```sh\npnpm check\n```$/), expect.stringMatching(/^[^*\n]+ said:\n- one\n- two$/)])
  })

  it('mirrors a Slack thread into the board, and board replies back into Slack', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})

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

  it("cleans NUL and lone surrogates from what Slack sends, which the board refuses and stores can't keep", async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    expect((await julian('POST', '/messages', { channel: 'firehose', text: 'a\u0000b' })).status).toBe(400)
    expect((await julian('POST', '/messages', { channel: 'firehose', text: 'a\ud800b' })).status).toBe(400)
    expect((await julian('POST', '/messages', { channel: 'firehose', text: 'ok', id: '\ud800' })).status).toBe(400)
    expect((await julian('POST', '/messages', { channel: 'firehose', text: 'ok', labels: { kind: '\udc00' } })).status).toBe(400)

    // Markdown turns NUL into U+FFFD on the way in, and the board strips any that gets past.
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export\u0000 is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    expect(root).toMatchObject({ from: 'slack' })
    expect(root!.text).toContain('is broken')
    expect(root!.text).not.toContain('\u0000')

    await webhook('slack', { type: 'message', threadId: 'slack:C1:200', id: '200', text: 'half \ud83d of an emoji', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    expect((await read(julian, 'firehose'))[1]!.text).toContain('half \ufffd of an emoji')

    // Cutting a long message to fit can split an emoji in two.
    await webhook('slack', { type: 'message', threadId: 'slack:C1:300', id: '300', text: `${'a'.repeat(9998)}\u{1f600} and more`, user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(3))
    expect((await read(julian, 'firehose'))[2]!.text.endsWith('a\ufffd…')).toBe(true)
  })

  it('hears a Slack thread it was just asked to sync, while its tables catch up', async () => {
    // Writes don't apply their own events, and the tables' consumer is slow: the tables lag the log.
    const store = boardMemory()
    const tables: MessageTables = {
      ...store.tables,
      applyNext: async () => false,
      apply: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        await store.tables.apply(event)
      },
    }
    const { board, webhook } = setup({ store: { ...store, tables } })
    const julian = caller(board.fetch, await personToken(), {})
    const { body: root } = await julian('POST', '/messages', { channel: 'firehose', text: 'incident', noSync: true })
    expect((await julian('POST', `/messages/${root.message.id}/sync`, { target: 'slack:C9:900.1' })).status).toBe(200)

    // C9 isn't mapped: only the request that synced the thread lets its replies in.
    await webhook('slack', { type: 'message', threadId: 'slack:C9:900.1', id: '900.2', text: 'on it', user: 'U_ADA' })
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root.message.id}`)
      expect(body.replies.map((reply: { text: string }) => reply.text)).toEqual(['on it'])
    }, { timeout: 10_000 })
  })

  it("never sends text its author edited away, when a label change's delivery runs after the edit", async () => {
    const { board, s } = setup({ slackRender: ({ message }) => `[${message.labels.state ?? '-'}] ${message.text}` })
    const julian = caller(board.fetch, await personToken(), {})
    // The thread's deliveries back up behind its root's, which waits on Slack.
    let open!: () => void
    const slack = new Promise<void>((resolve) => (open = resolve))
    const post = s.adapter.postChannelMessage!.bind(s.adapter)
    s.adapter.postChannelMessage = async (...args) => {
      await slack
      return post(...args)
    }
    const { body: root } = await julian('POST', '/messages', { channel: 'firehose', text: 'the key is hunter2' })
    await julian('POST', `/messages/${root.message.id}/labels`, { set: { state: 'open' } })
    await julian('POST', `/messages/${root.message.id}/edit`, { text: 'the key is in the vault' })
    open()
    // What Slack got last, a post or an edit, is the root as it is now.
    await vi.waitFor(() => expect([...s.channelPosts, ...s.edits].at(-1)?.text).toContain('[open] the key is in the vault'))
    expect([...s.channelPosts, ...s.edits].map((sent) => sent.text).join('\n')).not.toContain('hunter2')
  })

  it('posts a reply to Slack as written, with no quote of the message it answers', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})

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
        repository: { full_name: 'vercel-labs/board' },
        sender: { login: 'julianbenegas', id: 42 },
        pull_request: { number: 7, title: 'Fix login', html_url: 'https://github.com/vercel-labs/board/pull/7', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'att1' },
    )
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [pr] = await read(julian, 'prs')
    const proof = (await julian('POST', '/messages', { re: pr!.id, text: '', attachments: [await upload('proof.png')] })).body.message
    await vi.waitFor(() => expect(g.posts).toHaveLength(1))
    expect(g.posts[0]!.text).toContain(`📎 proof.png (3 B, on the board: #${proof.id})`)
    expect(g.posts[0]!.text).not.toContain('"files"')

    // A handle no one on the board has goes out as written.
    await julian('POST', '/messages', { re: pr!.id, text: 'cc @TK, not `@tk`' })
    await vi.waitFor(() => expect(g.posts).toHaveLength(2))
    expect(g.posts[1]!.text).toContain('cc @TK, not `@tk`')
  })

  it("starts a Slack thread with a root's files in the same message as its text, and notes them when Slack refuses", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let refuse = false
    const uploads: { channel_id: string; initial_comment: string; file_uploads: { filename: string }[] }[] = []
    const files = {
      delete: async () => ({}),
      uploadV2: async (args: (typeof uploads)[number]) => {
        if (refuse) throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } })
        uploads.push(args)
        return { files: [{ files: [{ id: 'F1' }] }] }
      },
      info: async () => ({ file: { shares: { public: { C1: [{ ts: '1800.1' }] } } } }),
    }
    const { board, s } = setup({
      slackClient: { conversations: { list: async () => ({ channels: [] }), info: async () => ({}) }, files, auth: { test: async () => ({ response_metadata: { scopes: ['files:write', 'files:read'] } }) } },
    })
    // What the real adapter has, that the fake one lacks.
    Object.assign(s.adapter, {
      decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }),
      formatConverter: { toResponseUrlText: ({ markdown }: { markdown: string }) => `mrkdwn(${markdown})` },
    })
    const token = await personToken()
    const julian = caller(board.fetch, token, {})
    const upload = async () => {
      const response = await board.fetch(
        new Request(`${BOARD_URL}/attachments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4', 'x-board-filename': 'after.mp4' },
          body: new Uint8Array([1, 2, 3]),
        }),
      )
      return ((await response.json()) as { attachment: { id: string } }).attachment.id
    }

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'shipped the fix', attachments: [await upload()] })).body.message
    await vi.waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads[0]).toMatchObject({ channel_id: 'C1', initial_comment: expect.stringContaining('shipped the fix'), file_uploads: [{ filename: 'after.mp4' }] })
    // A reply lands under the message the upload made.
    await julian('POST', '/messages', { re: root.id, text: 'rolled out' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]!.threadId).toBe('slack:C1:1800.1')
    expect(s.channelPosts).toEqual([])

    refuse = true
    await julian('POST', '/messages', { channel: 'firehose', text: 'another fix', attachments: [await upload()] })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.text).toContain('another fix')
    expect(s.channelPosts[0]!.text).toContain('📎 after.mp4')
    expect(uploads).toHaveLength(1)
    warn.mockRestore()
  })

  it("uploads a new thread's root with files once, though finding the message it made fails at first", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const uploads: { initial_comment: string }[] = []
    let fails = 1
    const files = {
      delete: async () => ({}),
      uploadV2: async (args: (typeof uploads)[number]) => {
        uploads.push(args)
        return { files: [{ files: [{ id: `F${uploads.length}` }] }] }
      },
      info: async () => {
        if (fails-- > 0) throw Object.assign(new Error('An API error occurred: internal_error'), { data: { error: 'internal_error' } })
        return { file: { shares: { public: { C1: [{ ts: '1800.1' }] } } } }
      },
    }
    const { board, s } = setup({
      slackClient: { conversations: { list: async () => ({ channels: [] }), info: async () => ({}) }, files, auth: { test: async () => ({ response_metadata: { scopes: ['files:write', 'files:read'] } }) } },
    })
    Object.assign(s.adapter, {
      decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }),
      formatConverter: { toResponseUrlText: ({ markdown }: { markdown: string }) => `mrkdwn(${markdown})` },
    })
    const token = await personToken()
    const julian = caller(board.fetch, token, {})
    const response = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4', 'x-board-filename': 'after.mp4' },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    const { attachment } = (await response.json()) as { attachment: { id: string } }
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'shipped the fix', attachments: [attachment.id] })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'rolled out' })
    // Without a scheduler nothing retries on its own; each drain is the next attempt.
    await vi.waitFor(async () => {
      await board.skipHold(board.servers[0]!, 'board')
      await board.servers[0]!.drain('board')
      expect(s.posts).toHaveLength(1)
    })
    expect(uploads).toHaveLength(1)
    expect(s.posts[0]!.threadId).toBe('slack:C1:1800.1')
    expect(s.channelPosts).toEqual([])
    error.mockRestore()
  })

  it("posts a root's text, then its files under it, where the Slack client can't upload them together", async () => {
    const { board, s } = setup({ slackClient: { conversations: { list: async () => ({ channels: [] }), info: async () => ({}) }, files: { delete: async () => ({}) } } })
    const token = await personToken()
    const julian = caller(board.fetch, token, {})
    const response = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-board-filename': 'after.png' },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    const { attachment } = (await response.json()) as { attachment: { id: string } }
    await julian('POST', '/messages', { channel: 'firehose', text: 'shipped the fix', attachments: [attachment.id] })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.channelPosts).toHaveLength(1)
    expect(JSON.parse(s.channelPosts[0]!.text)).toEqual({ markdown: expect.stringContaining('shipped the fix') })
    expect(s.posts[0]!.threadId).toBe(`slack:C1:${s.channelPosts[0]!.id}`)
    expect(JSON.parse(s.posts[0]!.text)).toMatchObject({ markdown: '', files: [{ filename: 'after.png' }] })
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
      expect(body.replies[0]).toMatchObject({ text: "and the recording\n\n📎 run.mov (50.0 MB) didn't come over: over 25 MB", attachments: [] })
    })
    expect(s.fetches).toEqual(['https://files.slack.test/shot.png']) // the big one was never downloaded

    // Slack edits know only the text they show: the file-only root stays empty, and the reply keeps its note.
    await webhook('slack', { type: 'edit', threadId: 'slack:C1:500.1', id: '500.1', text: '', user: 'U1' })
    await webhook('slack', { type: 'edit', threadId: 'slack:C1:500.1', id: '500.2', text: 'and the recording, again', user: 'U1' })
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root!.id}`)
      expect(body.replies[0]).toMatchObject({ text: "and the recording, again\n\n📎 run.mov (50.0 MB) didn't come over: over 25 MB" })
    })
    const { body: after } = await julian('GET', `/messages/${root!.id}`)
    expect(after.message).toMatchObject({ text: '', editedAt: null, attachments: [{ name: 'shot.png' }] })
    expect(s.posts).toHaveLength(0) // nothing echoes back to Slack
  })

  it('brings a Slack file over 4 MB onto the board, since sync fetches it with no request to fit', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    // The 10.9 MB recording from #252, which used to come over as "over 4 MB".
    const video = new Uint8Array(Math.round(10.9 * 1024 * 1024)).fill(7)
    s.served.set('https://files.slack.test/demo.mp4', video)
    await webhook('slack', {
      type: 'message', threadId: 'slack:C1:600.1', id: '600.1', text: 'the demo', user: 'U1',
      files: [{ name: 'demo.mp4', mimeType: 'video/mp4', url: 'https://files.slack.test/demo.mp4', size: video.byteLength }],
    })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = (await read(julian, 'firehose')) as unknown as { text: string; attachments: { id: string; size: number }[] }[]
    expect(root!.text).toBe('the demo')
    expect(root!.attachments).toEqual([{ id: expect.any(String), name: 'demo.mp4', type: 'video/mp4', size: video.byteLength }])
    const file = await board.fetch(new Request(`${BOARD_URL}/attachments/${root!.attachments[0]!.id}`, { headers: { authorization: `Bearer ${await personToken()}` } }))
    expect((await file.arrayBuffer()).byteLength).toBe(video.byteLength)

    // A person's upload still has to fit in one request.
    const big = await board.fetch(new Request(`${BOARD_URL}/attachments`, { method: 'POST', body: video, headers: { authorization: `Bearer ${await personToken()}` } }))
    expect(big.status).toBe(413)
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
      await board.skipHold(inbox, 'inbox:slack:C1')
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
      await board.skipHold(inbox, 'inbox:slack:C1')
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
      await board.skipHold(board.servers[0]!, 'board')
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

  it('delivers a reply, and an edit, as the message is when it goes out: never text its author took back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'incident' })).body.message
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    // Slack is down for a while, so the thread's deliveries back up behind the first.
    const post = s.adapter.postMessage.bind(s.adapter)
    let down = true
    s.adapter.postMessage = async (threadId, message) => {
      if (down) throw Object.assign(new Error('service_unavailable'), { data: { error: 'service_unavailable' } })
      return post(threadId, message)
    }
    await julian('POST', '/messages', { re: root.id, text: 'looking' })
    const edited = (await julian('POST', '/messages', { re: root.id, text: 'the password is hunter2' })).body.message
    await julian('POST', `/messages/${edited.id}/edit`, { text: 'the password is in the vault' })
    const deleted = (await julian('POST', '/messages', { re: root.id, text: 'and the key is swordfish' })).body.message
    await julian('POST', `/messages/${deleted.id}/delete`, {})
    down = false
    await vi.waitFor(async () => {
      await board.skipHold(board.servers[0]!, 'board')
      await board.servers[0]!.drain('board')
      expect(s.posts.map((p) => p.text)).toHaveLength(2)
    })
    const sent = JSON.stringify([s.posts, s.edits, s.deletes])
    expect(sent).not.toContain('hunter2')
    expect(sent).not.toContain('swordfish')
    expect(s.posts.map((p) => JSON.parse(p.text).markdown)).toEqual(['**u_julian**: looking', '**u_julian**: the password is in the vault'])
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
    const julian = caller(board.fetch, await personToken(), {})

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
    const julian = caller(board.fetch, await personToken(), {})
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
    const julian = caller(board.fetch, await personToken(), {})
    await webhook('slack', { type: 'message', threadId: 'slack:C1:200', id: '200', text: 'bug', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    await julian('POST', `/messages/${root!.id}/sync`, { target: 'github:vercel-labs/board:12' })

    const typed = await julian('POST', `/messages/${root!.id}/typing`, {})
    expect(typed).toMatchObject({ status: 200, body: { targets: ['slack:C1:200', 'github:vercel-labs/board:12'] } })
    expect(s.typing).toEqual(['slack:C1:200'])
    expect(g.typing).toEqual(['github:vercel-labs/board:12'])

    s.adapter.startTyping = async () => {
      throw new Error('missing_scope')
    }
    const partial = await julian('POST', `/messages/${root!.id}/typing`, {})
    expect(partial).toMatchObject({ status: 200, body: { targets: ['github:vercel-labs/board:12'] } })
  })

  it('passes a typing status through to Slack, which shows it instead of "Typing…"', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})
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
      alerts: delivering(async (sync) => {
        const { event } = sync
        if (event.kind !== 'message') return
        seen.push(event.text)
        const project = event.text.match(/project: (\S+)/)?.[1] ?? 'unknown'
        await sync.import(`alerts/${project}`)
      }),
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
      alerts: delivering(async (sync) => {
        if (sync.event.kind !== 'message') return
        try {
          await sync.import('alerts/www')
        } catch (error) {
          errors.push((error as Error).message)
        }
      }),
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
      repository: { full_name: 'vercel-labs/board' },
      sender: { login: 'julianbenegas', id: 42 },
      pull_request: { number: 7, title: 'Add sync', html_url: 'https://github.com/vercel-labs/board/pull/7', draft: false, merged: false, ...extra },
    })
    const event = (body: unknown, delivery: string) =>
      webhook('github', body, { 'x-github-event': 'pull_request', 'x-github-delivery': delivery })

    await event(pr('opened'), 'd1')
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    expect(root).toMatchObject({ from: 'github', labels: { pr: 'vercel-labs/board#7', state: 'open' } })
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
        repository: { full_name: 'vercel-labs/board' },
        sender: { login: 'julianbenegas', id: 42, avatar_url: avatar },
        pull_request: { number: 8, title: 'Avatars', html_url: 'https://github.com/vercel-labs/board/pull/8', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'a1' },
    )
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    // Chat SDK's GitHub messages carry no avatar.
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:8', id: 'c1', text: 'nice', user: '42', name: 'julianbenegas' })
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
    const repository = { full_name: 'vercel-labs/board' }
    const sender = { id: 42, login: 'julianbenegas' }
    const pr = { number: 38, title: 'Fix imports', html_url: 'https://github.com/vercel-labs/board/pull/38' }
    await webhook('github', { action: 'opened', repository, sender, pull_request: { ...pr, draft: true } }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'draft-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    expect(root).toMatchObject({ text: `PR #38: Fix imports\n${pr.html_url}`, labels: { pr: 'vercel-labs/board#38', state: 'draft' } })

    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:38', id: 'deploy', text: 'Building', user: '35613825', name: 'vercel[bot]' })
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
    const repository = { full_name: 'vercel-labs/board' }
    const sender = { id: 42, login: 'julianbenegas' }
    const pr = { number: 39, title: 'Spike', html_url: 'https://github.com/vercel-labs/board/pull/39', draft: true }
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
    { name: 'PR', key: 'pull_request', event: 'pull_request', kind: 'PR' },
    { name: 'issue', key: 'issue', event: 'issues', kind: 'Issue' },
  ])("says a retitled $name's new title on its root, and the copies of the root say it too", async ({ key, event, kind }) => {
    const { board, s, g, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() }, issues: { get: vi.fn() } } } })
    const julian = caller(board.fetch, await personToken())
    const item = { number: 42, title: 'Old title', html_url: `https://github.com/vercel-labs/board/pull/42`, draft: false, merged: false }
    const send = (action: string, extra: Record<string, unknown>, delivery: string) =>
      webhook('github', { action, repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'julianbenegas' }, ...extra }, { 'x-github-event': event, 'x-github-delivery': delivery })
    await send('opened', { [key]: item }, 'retitle-opened')
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    expect(root!.text).toBe(`${kind} #42: Old title\n${item.html_url}`)

    // A new description isn't on the board; a new title is.
    await send('edited', { [key]: { ...item, body: 'more detail' }, changes: { body: { from: '' } } }, 'retitle-body')
    await send('edited', { [key]: { ...item, title: 'New title' }, changes: { title: { from: 'Old title' } } }, 'retitle-title')
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root!.id}`)).body.message.text).toBe(`${kind} #42: New title\n${item.html_url}`))
    await vi.waitFor(() => expect(s.edits.map((edit) => edit.text)).toEqual([expect.stringContaining('New title')]))
    expect(g.edits).toEqual([]) // GitHub's own title never goes back to GitHub
  })

  it('keeps the title of a root another PR made when a PR it joined is retitled', async () => {
    const { board, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() } } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
    const sender = { id: 42, login: 'julianbenegas' }
    const pr = (number: number, title: string) => ({ number, title, html_url: `https://github.com/vercel-labs/board/pull/${number}`, draft: false, merged: false })
    await webhook('github', { action: 'opened', repository, sender, pull_request: pr(1, 'First') }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'joined-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    // The same thread is also PR #2's conversation.
    await julian('POST', `/messages/${root!.id}/sync`, { target: 'github:vercel-labs/board:2' })
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:2', id: 'c2', text: 'on #2', user: '43' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root!.id}`)).body.replies.map((m: { text: string }) => m.text)).toEqual(['on #2']))
    await webhook('github', { action: 'edited', repository, sender, pull_request: pr(2, 'Second, renamed'), changes: { title: { from: 'Second' } } }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'joined-retitle' })
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:2', id: 'c3', text: 'after the rename', user: '43' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root!.id}`)).body.replies).toHaveLength(2))
    expect((await julian('GET', `/messages/${root!.id}`)).body.message.text).toBe('PR #1: First\nhttps://github.com/vercel-labs/board/pull/1')
  })

  it("gives a root override the root's labels when a retitle redraws it, as when it was made", async () => {
    const { board, webhook } = setup({
      githubClient: { rest: { pulls: { get: vi.fn() } } },
      github: repos({
        'vercel-labs/board': async (sync) => {
          if (sync.direction === 'out') return sync.deliver()
          await sync.import('prs', { root: (draft) => ({ text: draft.labels.pr ? `[pr] ${draft.text}` : draft.text }) })
        },
      }),
    })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
    const sender = { id: 42, login: 'julianbenegas' }
    const pr = (title: string) => ({ number: 44, title, html_url: 'https://github.com/vercel-labs/board/pull/44', draft: false, merged: false })
    await webhook('github', { action: 'opened', repository, sender, pull_request: pr('Old') }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'override-opened' })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]?.text).toBe('[pr] PR #44: Old\nhttps://github.com/vercel-labs/board/pull/44'))
    await webhook('github', { action: 'edited', repository, sender, pull_request: pr('New'), changes: { title: { from: 'Old' } } }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'override-retitle' })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]?.text).toBe('[pr] PR #44: New\nhttps://github.com/vercel-labs/board/pull/44'))
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
    const julian = caller(board.fetch, await personToken(), {})
    const item = { number: 41, title: 'Ship it', html_url: 'https://github.com/vercel-labs/board/pull/41' }
    await webhook('github', { action: 'opened', repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'julianbenegas' }, [key]: item },
      { 'x-github-event': event, 'x-github-delivery': `react-${key}` })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')

    await julian('POST', `/messages/${root!.id}/reactions`, { emoji: 'rocket' })
    const where = { owner: 'vercel-labs', repo: 'board', issue_number: 41 }
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
    const repository = { full_name: 'vercel-labs/board' }
    const pr = { number: 39, title: 'Deploy me', html_url: 'https://github.com/vercel-labs/board/pull/39' }
    await webhook('github', { action: 'opened', repository, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'vc-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:39', id: 'vc', text: VERCEL_BUILDING, user: '35613825', name: 'vercel[bot]' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect((await read(julian, 'prs'))[1]!.text).toMatch(/^\[vc\]: #/) // the board keeps what Vercel wrote
    const posted = JSON.parse(s.posts[0]!.text).markdown as string
    expect(posted).toContain('**▲ Vercel**\n- ⏳ **[vboard-factory](https://vercel.com/vercel-internal-playground/vboard-factory)** · [Building]')
    expect(posted).not.toContain('[vc]:')
    expect(posted).not.toContain('| Project |')
  })

  it("shows Vercel's deployment comment in Slack as Vercel's own table, one message that follows Vercel's edits, where board has a Slack client to lay it out with", async () => {
    const posted: { text: string; blocks: { type: string; text?: string; rows?: unknown[][] }[] }[] = []
    const updated: ({ ts: string } & (typeof posted)[number])[] = []
    const slackClient = {
      conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
      chat: {
        postMessage: async (args: (typeof posted)[number]) => (posted.push(args), { ts: '1700000000.000900' }),
        update: async (args: (typeof updated)[number]) => void updated.push(args),
      },
      auth: { test: async () => ({ response_metadata: { scopes: ['chat:write'] } }) },
    }
    const { board, s, webhook } = setup({ slackClient, githubClient: { rest: { pulls: { get: vi.fn() } } } })
    Object.assign(s.adapter, { decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }) })
    const julian = caller(board.fetch, await personToken())
    const pr = { number: 43, title: 'Deploy me', html_url: 'https://github.com/vercel-labs/board/pull/43' }
    await webhook('github', { action: 'opened', repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'table-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const thread = 'github:vercel-labs/board:43'
    await webhook('github', { type: 'message', threadId: thread, id: 'vc', text: VERCEL_BUILDING, user: '35613825', name: 'vercel[bot]' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))

    const text = (value: string) => ({ type: 'raw_text', text: value })
    const rich = (...elements: unknown[]) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] })
    const link = (label: string, url: string) => ({ type: 'link', text: label, url })
    const row = (emoji: string, status: string) => [
      rich(link('vboard-factory', 'https://vercel.com/vercel-internal-playground/vboard-factory')),
      rich({ type: 'emoji', name: emoji }, { type: 'text', text: ' ' }, link(status, 'https://vercel.com/vercel-internal-playground/vboard-factory/7ZEaNBTETQjaUF4Bd1VCxbM8rR3n')),
      rich(link('Preview', 'https://vboard-factory-git-pi-224.playground-vercel.tools')),
      // Vercel's `2026-10-06T20:30:32.400Z`, in seconds, which Slack shows as how long ago.
      rich({ type: 'date', timestamp: Date.UTC(2026, 9, 6, 20, 30, 32) / 1000, format: '{ago}', fallback: 'Oct 6, 2026 8:30pm UTC' }),
    ]
    const table = (emoji: string, status: string) => expect.objectContaining({ type: 'data_table', rows: [[text('Project'), text('Deployment'), text('Actions'), text('Updated')], row(emoji, status)] })
    const heading = { type: 'markdown', text: '**vercel[bot] (github)**: **▲ Vercel**' }
    expect(posted[0]!.blocks).toEqual([heading, table('large_yellow_circle', 'Building')])
    // The pull request's own message went out as any other does, through the adapter.
    expect(s.channelPosts).toHaveLength(1)
    expect(s.posts).toEqual([])

    // Vercel edits its one comment as the build ends: the same Slack message is replaced.
    await webhook('github', { type: 'edit', threadId: thread, id: 'vc', text: VERCEL_BUILDING.replaceAll('Building', 'Ready').replaceAll('building', 'ready'), user: '35613825', name: 'vercel[bot]' })
    await vi.waitFor(() => expect(updated).toHaveLength(1))
    expect(updated[0]).toMatchObject({ ts: '1700000000.000900', blocks: [heading, table('large_green_circle', 'Ready')] })
    expect(posted).toHaveLength(1)
    expect(s.edits).toEqual([])
    expect((await read(julian, 'prs'))[1]!.text).toMatch(/^\[vc\]: #/) // the board keeps what Vercel wrote
  })

  it("hands a platform's provider Vercel's deployments with Vercel's own comment, and not with a look-alike anyone posts", async () => {
    // What a provider is asked to post: the protocol a provider of your own implements.
    const asked = vi.spyOn(SlackProvider.prototype, 'post')
    try {
      const { board, s, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() } } } })
      const julian = caller(board.fetch, await personToken())
      const pr = { number: 44, title: 'Deploy me', html_url: 'https://github.com/vercel-labs/board/pull/44' }
      await webhook('github', { action: 'opened', repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'handed-opened' })
      await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
      await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:44', id: 'vc', text: VERCEL_BUILDING, user: '35613825', name: 'vercel[bot]' })
      await vi.waitFor(() => expect(s.posts).toHaveLength(1))
      await julian('POST', '/messages', { channel: 'firehose', text: VERCEL_BUILDING })
      await vi.waitFor(() => expect(s.channelPosts).toHaveLength(2))
      const bodies = asked.mock.calls.map(([, , body]) => body)
      const vercels = bodies.find((body) => body.markdown.includes('▲ Vercel'))!
      expect(vercels.deployments).toMatchObject([{ project: 'vboard-factory', status: 'Building' }])
      // A person's copy of the same text is their text, as written.
      const lookAlike = bodies.find((body) => body.markdown.includes('[vc]: #'))!
      expect(lookAlike).not.toHaveProperty('deployments')
      expect(bodies.filter((body) => body.deployments)).toHaveLength(1)
    } finally {
      asked.mockRestore()
    }
  })

  it("syncs an edit to a long comment, like Vercel's deployment comment going from Building to Ready", async () => {
    const { board, webhook } = setup({ githubClient: { rest: { pulls: { get: vi.fn() } } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
    const pr = { number: 41, title: 'Deploy me', html_url: 'https://github.com/vercel-labs/board/pull/41' }
    await webhook('github', { action: 'opened', repository, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'long-opened' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const thread = 'github:vercel-labs/board:41'
    await webhook('github', { type: 'message', threadId: thread, id: 'vc', text: VERCEL_BUILDING, user: '35613825', name: 'vercel[bot]' })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[1]?.text).toContain('[Building]'))
    const ready = VERCEL_BUILDING.replaceAll('Building', 'Ready').replaceAll('building', 'ready')
    const edited = await webhook('github', { type: 'edit', threadId: thread, id: 'vc', text: ready, user: '35613825' })
    expect(edited.status).toBe(200)
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[1]?.text).toContain('[Ready]'))
  })

  it("answers a webhook whose event the board refuses with 200, since it'd refuse a redelivery too, and one it couldn't store with 500", async () => {
    const { board, webhook } = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const push = vi.spyOn(board.backend, 'inboxPush')
    const message = { type: 'message', threadId: 'slack:C1:500', id: '500', text: 'hello', user: 'U_ADA' }
    push.mockRejectedValueOnce(new HttpError(400, 'bad_request', 'Invalid request: `events[0].id` should NOT be longer than 300 characters.'))
    expect((await webhook('slack', message)).status).toBe(200)
    push.mockRejectedValueOnce(new HttpError(503, 'unavailable', 'the API is down'))
    expect((await webhook('slack', message)).status).toBe(500)
    // Once the board takes it, the redelivery lands.
    expect((await webhook('slack', message)).status).toBe(200)
    const julian = caller(board.fetch, await personToken())
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['hello']))
    logged.mockRestore()
  })

  it("refuses an inbox event ID over 300 characters in-process, as Vercel's API does, and takes one of 300", async () => {
    const { board, webhook } = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const push = board.backend.inboxPush.bind(board.backend)
    // The board's own sync, its event's ID stretched to `length`.
    const stretched = (length: number): typeof push => (caller, input, signal) =>
      push(caller, { ...input, events: input.events.map((event) => ({ ...event, id: event.id.padEnd(length, 'x') })) }, signal)
    const spy = vi.spyOn(board.backend, 'inboxPush')
    spy.mockImplementationOnce(stretched(301))
    expect((await webhook('slack', { type: 'message', threadId: 'slack:C1:600', id: '600', text: 'too long', user: 'U_ADA' })).status).toBe(200)
    expect(logged).toHaveBeenCalledWith('[board] dropped an event the board refuses', expect.objectContaining({ status: 400 }))
    spy.mockImplementationOnce(stretched(300))
    await webhook('slack', { type: 'message', threadId: 'slack:C1:601', id: '601', text: 'just fits', user: 'U_ADA' })
    const julian = caller(board.fetch, await personToken())
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['just fits']))
    logged.mockRestore()
  })

  it('keeps a reply imported with `noSync` on the board, and still delivers the rest of its thread', async () => {
    const { board, s, webhook } = setup({
      githubClient: { rest: { pulls: { get: vi.fn() } } },
      github: repos({
        // Inline review threads stay on GitHub and the board.
        'vercel-labs/board': delivering(async (sync) => void (await sync.import('prs', { noSync: sync.event.subthread !== null }))),
      }),
    })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
    const pr = { number: 40, title: 'Review me', html_url: 'https://github.com/vercel-labs/board/pull/40' }
    await webhook('github', { action: 'opened', repository, sender: { id: 42, login: 'julianbenegas' }, pull_request: pr }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'rv-opened' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:40:rc:9', id: 'rc1', text: 'Fixed in abc123', user: '43', raw: { path: 'src/a.ts', line: 3 } })
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:40', id: 'c1', text: 'Ready for another look', user: '43' })
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
      github: repos({
        'vercel-labs/board': delivering(async ({ event, import: imported }) =>
          void (await imported('prs', { noSync: event.type === 'pr.closed' && event.labels?.state === 'closed' }))),
      }),
    })
    const julian = caller(board.fetch, await personToken())
    const pr = (action: string, merged = false) => ({
      action, repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'julianbenegas' },
      pull_request: { number: 44, title: 'Stale', html_url: 'https://github.com/vercel-labs/board/pull/44', draft: false, merged },
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
    { thread: 'vercel-labs/board:50', issue: false, draft: false, merged: false, state: 'open', expectedState: 'open' },
    { thread: 'vercel-labs/board:50:rc:123', issue: false, draft: true, merged: false, state: 'open', expectedState: 'draft' },
    { thread: 'vercel-labs/board:50', issue: false, draft: false, merged: true, state: 'closed', expectedState: 'merged' },
    { thread: 'vercel-labs/board:issue:50', issue: true, draft: false, merged: false, state: 'closed', expectedState: 'closed' },
  ])('fetches a titled root for an unseen $expectedState thread ($thread)', async ({ thread, issue, draft, merged, state, expectedState }) => {
    const url = `https://github.com/vercel-labs/board/${issue ? 'issues' : 'pull'}/50`
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
      labels: { [issue ? 'issue' : 'pr']: 'vercel-labs/board#50', state: expectedState, 'tag.bug': 'bug', 'assignee.ada': 'ada' },
    })
    expect(comment).toMatchObject({ text: 'Building', re: root!.id, by: { actor: 'github:user:35613825' } })
    const { body } = await julian('GET', `/messages/${root!.id}`)
    expect(body.message.author.avatar).toBe(avatar)
    expect(body.message.origin).toMatchObject({ thread: `github:vercel-labs/board:${issue ? 'issue:' : ''}50`, subthread: null, context: null })
    expect(body.replies[0].origin).toMatchObject({ subthread: thread.endsWith(':rc:123') ? `github:${thread}` : null, context: 'src/index.ts:12' })
    expect(get).toHaveBeenCalledExactlyOnceWith({ owner: 'vercel-labs', repo: 'board', [issue ? 'issue_number' : 'pull_number']: 50 })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.channelPosts).toHaveLength(1)
    expect(s.channelPosts[0]!.text).toContain('Root first')
    expect(s.posts[0]!.threadId).toBe(`slack:C2:${s.channelPosts[0]!.id}`)
    expect(g.posts).toHaveLength(0)

    await webhook('github', { action: 'opened', repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'julianbenegas' },
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
      number: 51, title: 'Try again', html_url: 'https://github.com/vercel-labs/board/pull/51', state: 'open', user: { id: 42, login: 'julianbenegas' },
    } })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { board, s, webhook } = setup({ githubClient: { rest: { pulls: { get } } } })
      const julian = caller(board.fetch, await personToken())
      await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:51', id: 'c1', text: 'Building', user: '35613825', name: 'vercel[bot]' })
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      expect(await read(julian, 'prs')).toHaveLength(0)
      expect(s.channelPosts).toHaveLength(0)
      await vi.waitFor(async () => {
        await board.skipHold(board.servers[1]!, 'inbox:github:vercel-labs/board:pulls')
        await board.servers[1]!.drain('inbox:github:vercel-labs/board:pulls')
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
    const { board, webhook } = setup({ github: repos({ 'vercel-labs/board': seen }), githubClient: { rest: { pulls: { get } } } })
    const julian = caller(board.fetch, await personToken())
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:52', id: 'c1', text: 'Building', user: '35613825' })
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    expect(seen.mock.calls[0]![0].event).toMatchObject({ type: 'comment', text: 'Building' })
    expect(await read(julian, 'prs')).toHaveLength(0)
    expect(get).not.toHaveBeenCalled()
  })

  it("sends a repo's PRs and issues to different channels", async () => {
    const { board, webhook } = setup({ github: repos({ 'vercel-labs/board': { pulls: mirror('prs'), issues: mirror('issues') } }) })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
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
    await webhook('github', { type: 'message', threadId: 'github:vercel-labs/board:issue:10', id: 'c2', text: 'on it', user: '42' })
    await vi.waitFor(async () => expect(await read(julian, 'issues')).toHaveLength(2))
    expect(await read(julian, 'prs')).toHaveLength(1)
  })

  it("mirrors GitHub's labels and assignees as `tag.*` and `assignee.*` labels", async () => {
    const { board, webhook } = setup({ github: repos({ 'vercel-labs/board': { pulls: mirror('prs'), issues: mirror('issues') } }) })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
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
      issue: 'vercel-labs/board#10',
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
      issue: 'vercel-labs/board#10',
      state: 'open',
      status: 'triaged', // not the mirror's
      'tag.good-first-issue': 'good-first-issue',
      'tag.priority-high': 'priority: high',
    })

    const pr = { number: 11, title: 'Draft', html_url: 'https://github.com/x/pull/11', merged: false }
    await send('pull_request', { action: 'opened', pull_request: { ...pr, draft: true } })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [draft] = await read(julian, 'prs')
    expect(draft).toMatchObject({ text: 'PR #11: Draft\nhttps://github.com/x/pull/11', labels: { pr: 'vercel-labs/board#11', state: 'draft' } })
    await send('pull_request', { action: 'labeled', pull_request: { ...pr, draft: true, labels: [{ name: 'wip' }] }, label: { name: 'wip' } })
    await send('pull_request', { action: 'ready_for_review', pull_request: { ...pr, draft: false, labels: [{ name: 'wip' }] } })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]).toMatchObject({ id: draft!.id, labels: { state: 'open', 'tag.wip': 'wip' } }))
    const assigned = { ...pr, labels: [{ name: 'wip' }], assignees: [{ login: 'pi-bot[bot]' }] }
    await send('pull_request', { action: 'assigned', pull_request: assigned, assignee: { login: 'pi-bot[bot]' } })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]!.labels['assignee.pi-bot-bot']).toBe('pi-bot[bot]'))
    expect((await julian('GET', '/messages?label=tag.wip')).body.messages).toHaveLength(1)
  })

  it("keeps a PR's head commit as its `head` label, through new commits", async () => {
    const { board, webhook } = setup({ github: repos({ 'vercel-labs/board': mirror('prs') }) })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
    const sender = { login: 'julianbenegas', id: 42 }
    let delivery = 0
    const send = (body: Record<string, unknown>) =>
      webhook('github', { repository, sender, ...body }, { 'x-github-event': 'pull_request', 'x-github-delivery': `h${++delivery}` })
    const pr = (number: number, sha: string) => ({ number, title: 'Head', html_url: `https://github.com/x/pull/${number}`, draft: false, merged: false, head: { sha } })

    await send({ action: 'opened', pull_request: pr(13, 'aaa1111') })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    expect((await read(julian, 'prs'))[0]!.labels).toMatchObject({ pr: 'vercel-labs/board#13', state: 'open', head: 'aaa1111' })

    await send({ action: 'synchronize', pull_request: pr(13, 'bbb2222') })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]!.labels.head).toBe('bbb2222'))
    await send({ action: 'synchronize', pull_request: pr(13, 'ccc3333') })
    await vi.waitFor(async () => expect((await read(julian, 'prs'))[0]!.labels.head).toBe('ccc3333'))
    // Pushes post nothing: GitHub's timeline already lists them.
    expect(await read(julian, 'prs')).toHaveLength(1)

    // A push to a PR the board never saw doesn't make it a root: only opening, readying, or reopening does.
    await send({ action: 'synchronize', pull_request: pr(14, 'ddd4444') })
    await send({ action: 'opened', pull_request: pr(15, 'eee5555') })
    await vi.waitFor(async () => expect((await read(julian, 'prs')).map((m) => m.labels.pr)).toContain('vercel-labs/board#15'))
    expect((await read(julian, 'prs')).map((m) => m.labels.pr)).not.toContain('vercel-labs/board#14')
  })

  it('leaves `tag.*` or `assignee.*` alone when a payload leaves out `labels` or `assignees`', async () => {
    const { board, webhook } = setup({ github: repos({ 'vercel-labs/board': { pulls: mirror('prs'), issues: mirror('issues') } }) })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'vercel-labs/board' }
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
    const get = vi.fn(async () => ({ data: { number: 3, title: 'Deploy previews', html_url: 'https://github.com/vercel-labs/board/pull/3', state: 'open', user: { id: 42, login: 'julianbenegas' } } }))
    const { board, s, webhook } = setup({ githubClient: { rest: { pulls: { get } } } })
    const julian = caller(board.fetch, await personToken(), {})
    const table = '| Project | Status |\n| --- | --- |\n| www | Ready |'
    await webhook('github', {
      type: 'message',
      threadId: 'github:vercel-labs/board:3',
      id: 'c9',
      text: 'Project Status www Ready', // Chat SDK's flattened text
      user: '35613825',
      name: 'vercel[bot]',
      raw: { comment: { body: table, user: { avatar_url: 'https://avatars.githubusercontent.com/in/8329?v=4' } } },
    })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))
    const [root, comment] = await read(julian, 'prs')
    expect(root!.text).toBe('PR #3: Deploy previews\nhttps://github.com/vercel-labs/board/pull/3')
    expect(comment).toMatchObject({ text: table, re: root!.id })
    expect(get).toHaveBeenCalledExactlyOnceWith({ owner: 'vercel-labs', repo: 'board', pull_number: 3 })
    const { body } = await julian('GET', '/actors')
    expect(body.actors.find((a: { id: string }) => a.id === 'github:user:35613825')).toMatchObject({
      avatar: 'https://avatars.githubusercontent.com/in/8329?v=4',
    })

    await julian('POST', '/messages', { channel: 'firehose', text: '**ship it**' })
    // The GitHub thread mirrored to Slack too: each starts a thread in its channel.
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId).sort()).toEqual(['slack:C1', 'slack:C2']))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(JSON.stringify({ markdown: '**u_julian**: **ship it**' }))
  })

  it('re-renders a copy when a label change changes its rendering, and only then', async () => {
    const { board, s } = setup({ slackRender: ({ message }) => `[${message.labels.state ?? '-'}] ${message.text}` })
    const julian = caller(board.fetch, await personToken(), {})
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
    const julian = caller(board.fetch, await personToken(), {})
    await julian('POST', '/messages', { channel: 'prs', text: 'hi' })
    await webhook('slack', { type: 'message', threadId: 'slack:C2:500', id: '500', text: 'hello', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))

    await julian('POST', '/messages', { channel: 'firehose', text: '@[slack:user:U_ADA] and @julian, see \`@julian\`' })
    await vi.waitFor(() => expect(s.channelPosts.some((p) => p.channelId === 'slack:C1')).toBe(true))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(
      JSON.stringify({ markdown: `${customRender ? '' : '**u_julian**: '}<@U_ADA> and @julian, see \`@julian\`` }),
    )
  })

  it('looks @[email] up on Slack when it posts there, and posts one Slack has no one for as the email', async () => {
    const lookupByEmail = vi.fn(async ({ email }: { email: string }) => {
      if (email === 'missing-id@vercel.com') return { user: { name: 'missing-id' } }
      if (email !== 'ada@vercel.com') throw new Error('users_not_found')
      return { user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada Lovelace' } } }
    })
    const conversations = { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) }
    const { board, s } = setup({ slackClient: { conversations, users: { info: async () => ({}), lookupByEmail } } })
    const julian = caller(board.fetch, await personToken(), {})

    const text = 'owner: @[ada@vercel.com], cc @[nobody@vercel.com], missing: @[missing-id@vercel.com]'
    const { body } = await julian('POST', '/messages', { channel: 'firehose', text })

    // The board keeps what was written, and learns no one from it.
    expect(body.message.text).toBe(text)
    expect(((await julian('GET', '/actors')).body.actors as { id: string }[]).map((actor) => actor.id)).not.toContain('slack:user:U_ADA')
    await vi.waitFor(() => expect(s.channelPosts.some((p) => p.channelId === 'slack:C1')).toBe(true))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(
      JSON.stringify({ markdown: '**u_julian**: owner: <@U_ADA>, cc nobody@vercel.com, missing: missing-id@vercel.com' }),
    )
  })

  it("matches --mentions ada@vercel.com by the email its text names, and never asks Slack who that is", async () => {
    const lookupByEmail = vi.fn(async () => ({ user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada Lovelace' } } }))
    const conversations = { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) }
    const { board } = setup({ slackClient: { conversations, users: { info: async () => ({}), lookupByEmail } } })
    const token = await personToken()
    const julian = caller(board.fetch, token, {})
    const { cursor } = (await julian('GET', '/events?wait=0')).body

    // `vb tail` (a stream) and `vb wait` (a long poll) for mentions of Ada's email, in a channel nothing syncs.
    const controller = new AbortController()
    const stream = await board.fetch(new Request(`${BOARD_URL}/events?mentions=ada@vercel.com&after=${cursor}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    }))
    const waiting = julian('GET', `/events?mentions=ada@vercel.com&after=${cursor}&wait=10`)
    await julian('POST', '/messages', { channel: 'dev', text: '@ada can you look?' })
    await julian('POST', '/messages', { channel: 'dev', text: '@[Ada@vercel.com] can you look?' })

    const { events } = (await waiting).body
    expect(events.map((event: { message?: { text: string } }) => event.message?.text)).toEqual(['@[Ada@vercel.com] can you look?'])
    const reader = stream.body!.getReader()
    let streamed = ''
    while (!streamed.includes('event: board')) streamed += new TextDecoder().decode((await reader.read()).value)
    controller.abort()
    expect(JSON.parse(streamed.match(/^data: (.*)$/m)![1]!).message.text).toBe('@[Ada@vercel.com] can you look?')
    expect(((await julian('GET', '/messages?mentions=ada@vercel.com')).body.messages as { text: string }[]).map((m) => m.text)).toEqual(['@[Ada@vercel.com] can you look?'])
    expect(lookupByEmail).not.toHaveBeenCalled()
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

  it('asks the backend whether a caller may sync a thread before it looks a target up on Slack', async () => {
    const list = vi.fn(async () => ({ channels: [{ id: 'C9', name: 'leak', is_member: true }] }))
    const slackClient = { conversations: { list, info: async () => ({}), join: async () => ({}) }, users: { info: async () => ({}) } }
    const s = fakePlatform('slack', withSlackClient(slackClient, false))
    const board = testBoard({
      sync: { slack: slack({ adapter: s.adapter, client: async () => slackClient as never }, channels({ C1: 'firehose' })) },
    })
    // Marketing's production deployments may read and post in feedback.
    await board.createGrant({ principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { feedback: ['read', 'post'] } })
    const front = caller(board.fetch, await deploymentToken())
    const { body } = await front('POST', '/messages', { channel: 'feedback', text: 'checkout is slow' })
    const denied = await front('POST', `/messages/${body.message.id}/sync`, { target: 'slack:#leak' })
    expect(denied).toMatchObject({ status: 403, body: { error: { message: "this token can't sync in feedback" } } })
    expect(list).not.toHaveBeenCalled()
    // Julian may, so his target goes to Slack to resolve.
    const julian = caller(board.fetch, await personToken())
    expect((await julian('POST', `/messages/${body.message.id}/sync`, { target: 'slack:#leak' })).body).toEqual({ target: 'slack:C9', attached: true })
    expect(list).toHaveBeenCalled()
  })

  it("does nothing on Slack, and writes nothing, for a request before the backend lets it do what it asks", async () => {
    const lookupByEmail = vi.fn(async () => ({ user: { id: 'U_ADA', name: 'ada', profile: { display_name: 'ada', real_name: 'Ada' } } }))
    const conversations = {
      list: vi.fn(async () => ({ channels: [{ id: 'C9', name: 'general', is_member: false, is_private: false }] })),
      info: vi.fn(async () => ({ channel: { id: 'C9', is_member: false, is_private: false } })),
      join: vi.fn(async () => ({ ok: true })),
    }
    const slackClient = { conversations, users: { info: async () => ({}), lookupByEmail } }
    const s = fakePlatform('slack', withSlackClient(slackClient, false))
    const board = testBoard({
      sync: { slack: slack({ adapter: s.adapter, client: async () => slackClient as never }, channels({ C1: 'firehose' })) },
    })
    // Marketing's production deployments may read and post in feedback.
    // Without g2's every project on the team: marketing may do only what its grant says.
    await board.revokeGrant('g2')
    await board.createGrant({ principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { feedback: ['read', 'post'] } })
    const anyone = caller(board.fetch, 'not-a-token')
    const front = caller(board.fetch, await deploymentToken())
    const julian = caller(board.fetch, await personToken())
    // Its first post's delivery resolves the channels the board maps, once.
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'ours' })).body.message
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    const calls = () => [conversations.list, conversations.info, conversations.join, lookupByEmail].reduce((n, fn) => n + fn.mock.calls.length, 0)
    const before = calls()
    const text = 'cc @[ada@vercel.com]'
    const attempts = [
      // No one: a 401 before anything else.
      [anyone, 'POST', '/messages', { channel: 'firehose', text, sync: ['slack:#general'] }, 401],
      [anyone, 'POST', `/messages/${root.id}/edit`, { text }, 401],
      [anyone, 'POST', '/schedules', { channel: 'firehose', text, in: '1h' }, 401],
      [anyone, 'GET', '/inbox/slack?channel=%23general', undefined, 401],
      // Someone who may post only in feedback.
      [front, 'POST', '/messages', { channel: 'firehose', text, sync: ['slack:#general'] }, 403],
      [front, 'POST', '/messages', { re: root.id, text }, 404],
      [front, 'POST', '/messages', { channel: 'feedback', text: 'checkout is slow', sync: ['slack:#general'] }, 403],
      [front, 'POST', `/messages/${root.id}/edit`, { text }, 404],
      [front, 'POST', '/schedules', { channel: 'firehose', text, in: '1h' }, 403],
      [front, 'GET', '/inbox/slack?channel=%23general', undefined, 403],
    ] as const
    for (const [who, method, path, body, status] of attempts) expect((await who(method, path, body)).status, `${method} ${path} ${JSON.stringify(body)}`).toBe(status)
    expect(calls()).toBe(before)
    // Nothing on the board learned who Ada is.
    expect(((await julian('GET', '/actors')).body.actors as { id: string }[]).map((actor) => actor.id)).not.toContain('slack:user:U_ADA')
    // An upload's body isn't read for no one.
    let pulled = false
    const file = new ReadableStream({ pull: (controller) => ((pulled = true), controller.enqueue(new Uint8Array(8)), controller.close()) }, { highWaterMark: 0 })
    const upload = await board.fetch(new Request(`${BOARD_URL}/attachments`, { method: 'POST', body: file, duplex: 'half', headers: { 'content-type': 'image/png' } } as RequestInit))
    expect([upload.status, pulled]).toEqual([401, false])
    // Julian may: his post's target goes to Slack to resolve.
    const posted = await julian('POST', '/messages', { channel: 'firehose', text, sync: ['slack:#general'] })
    expect([posted.status, posted.body.message.text]).toEqual([201, text])
    expect(conversations.join).not.toHaveBeenCalled()
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

  it('takes a retried Slack event that reads differently the second time as the one it has', async () => {
    // Another function instance takes the retry: its own Chat SDK state, the same log.
    const store = boardMemory()
    const first = setup({ store })
    const second = setup({ store })
    const julian = caller(first.board.fetch, await personToken())
    const event = { type: 'message', threadId: 'slack:C1:500', id: '500', text: 'hello', user: 'U_ADA' }

    expect((await first.webhook('slack', { ...event, name: 'Ada' })).status).toBe(200)
    // Slack sends it again, and what it says about Ada changed in between.
    expect((await second.webhook('slack', { ...event, name: 'Ada Lovelace' })).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    expect((await read(julian, 'firehose'))[0]).toMatchObject({ text: 'hello', author: { name: 'Ada' } })
  })

  it('routes Slack events and posts by channel ID without asking Slack about the channels', async () => {
    // A rate-limited conversations.info, which Slack's client waits out for about 30 minutes.
    const conversations = { list: vi.fn(async () => ({ channels: [] })), info: vi.fn(() => new Promise<never>(() => {})), join: vi.fn() }
    const { board, s, webhook } = setup({ slackClient: { conversations } })
    const julian = caller(board.fetch, await personToken())

    expect((await webhook('slack', { type: 'message', threadId: 'slack:C1:500', id: '500', text: 'still syncing', user: 'U_ADA' })).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await julian('POST', '/messages', { channel: 'prs', text: 'and outbound too' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect([conversations.list, conversations.info, conversations.join].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0])
  })

  it('finds mapped Slack channels by name, never joins them, and says which ones need an invite', async () => {
    // The Vercel Connect shape: the bot token resolves asynchronously.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = {
      list: vi.fn(async () => ({
        channels: [
          { id: 'C9', name: 'sf-prs', is_member: true, is_private: false },
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
    expect(conversations.join).not.toHaveBeenCalled()
    expect(conversations.list).toHaveBeenCalledTimes(1) // one listing resolves every name
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invite the app to #sf-secret'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('#sf-prs'))
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
      await board.skipHold(board.servers[0]!, 'board')
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
      const board = testBoard({ sync: { github: github({ adapter: g.adapter }, repos({
        'vercel-labs/board': async (sync) => {
          if (sync.direction !== 'in') return
          const { event, board } = sync
          const selected = event.kind === 'lifecycle' && event.raw.action === action
          const imported = await sync.import('prs', { root: () => ({ labels: { 'tag.custom': 'custom' } }) })
          if (selected) {
            results.push(imported)
            await board.reply(imported.root!, 'ack')
            if (results.length === 1) throw new Error('interrupted after lifecycle import')
          }
        },
      })) } })
      const call = caller(board.fetch, await personToken())
      const send = (action: string, delivery: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
        method: 'POST', headers: { 'x-github-event': issue ? 'issues' : 'pull_request', 'x-github-delivery': delivery },
        body: JSON.stringify({
          action, repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'ada' },
          [issue ? 'issue' : 'pull_request']: { number: 81, title: 'Lifecycle result', html_url: 'https://github.com/vercel-labs/board/pull/81', labels: [] },
        }),
      }))
      if (existing) {
        await send('opened', 'initial')
        await vi.waitFor(async () => expect(await read(call, 'prs')).toHaveLength(1))
      }
      await send(action, 'selected')
      await vi.waitFor(() => expect(error).toHaveBeenCalled())
      await vi.waitFor(async () => {
        await board.skipHold(board.servers[1]!, `inbox:github:vercel-labs/board:${issue ? 'issues' : 'pulls'}`)
        await board.servers[1]!.drain(`inbox:github:vercel-labs/board:${issue ? 'issues' : 'pulls'}`)
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

  it('derives a receipt identity from its trigger, the sync consumer, and the receipt', async () => {
    const { board, s, webhook } = setup()
    const call = caller(board.fetch, await personToken())
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'root', user: 'U1' })
    await vi.waitFor(async () => expect(await read(call, 'firehose')).toHaveLength(1))
    const [root] = await read(call, 'firehose')
    const posted = await call('POST', '/messages', { re: root!.id, text: 'reply' })
    const session = board.servers[0]!.session('board')
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    const history = await session.history()
    const trigger = history.find((event) => event.type === 'message.posted' && String(event.index) === posted.body.message.id)
    const receipt = history.find((event) => event.type === 'message.synced' && String(event.payload.id) === posted.body.message.id)
    if (!trigger || trigger.type !== 'message.posted' || !receipt || receipt.type !== 'message.synced') throw new Error('missing delivery history')
    const reference = createServer({
      contract: boardContract, store: memory(),
      consumers: [
        consumer({ contract: boardContract, name: 'board-sync', types: ['message.posted'] }).run(async (ctx) => {
          await ctx.session.append(`receipt:${posted.body.message.id}:${receipt.payload.target}`, { type: 'message.synced', payload: receipt.payload })
        }),
      ],
    })
    const old = reference.session('board')
    await old.append({ id: trigger.id, type: 'message.posted', payload: trigger.payload })
    await vi.waitFor(async () => {
      const expected = (await old.history()).find((event) => event.type === 'message.synced')
      expect(expected?.id).toBe(receipt.id)
    })
  })

  it('imports a PR whose payload lacks the metadata a function could read', async () => {
    const g = fakePlatform('github')
    const board = testBoard({ sync: { github: github({ adapter: g.adapter }, repos({ 'vercel-labs/board': 'prs' })) } })
    const call = caller(board.fetch, await personToken())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
        method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'trimmed-pr' },
        body: JSON.stringify({
          action: 'opened', repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'ada' },
          pull_request: { number: 72, title: 'Trimmed metadata', html_url: 'https://github.com/vercel-labs/board/pull/72', base: {} },
        }),
      }))
      await vi.waitFor(async () => expect((await read(call, 'prs'))[0]?.text).toBe('PR #72: Trimmed metadata\nhttps://github.com/vercel-labs/board/pull/72'))
    } finally {
      error.mockRestore()
    }
  })

  it.each([
    { action: 'opened', existing: false, rootText: 'event text' },
    { action: 'reopened', existing: false, rootText: 'root draft' },
    { action: 'reopened', existing: true, rootText: 'PR #73: Original\nhttps://github.com/vercel-labs/board/pull/73' },
  ])('defines text/root precedence for $action (existing: $existing)', async ({ action, existing, rootText }) => {
    const g = fakePlatform('github')
    const board = testBoard({ sync: { github: github({ adapter: g.adapter }, repos({
      'vercel-labs/board': async (sync) => {
        if (sync.direction !== 'in') return
        const selected = sync.event.kind === 'lifecycle' && sync.event.raw.action === action
        await sync.import('prs', selected ? {
          text: 'event text',
          root: () => ({ text: 'root draft', labels: { temporary: 'yes' } }),
          unset: ['temporary', 'tag.bug'],
        } : undefined)
      },
    })) } })
    const call = caller(board.fetch, await personToken())
    const send = (action: string, delivery: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
      method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': delivery },
      body: JSON.stringify({
        action, repository: { full_name: 'vercel-labs/board' }, sender: { id: 42, login: 'ada' },
        pull_request: { number: 73, title: 'Original', html_url: 'https://github.com/vercel-labs/board/pull/73', labels: [{ name: 'bug' }] },
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
    expect(() => slack({ adapter }, channels({ C1: 'support' }))).toThrow('public client resolver')
  })


  it("refuses a callback's reply after a message another came after, as a request's", async () => {
    const s = fakePlatform('slack')
    const outcomes: string[] = []
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({
      C1: delivering(async (sync) => {
        const imported = await sync.import('support')
        await sync.board.reply(imported.root!, { text: 'first', after: imported.root! })
        await sync.board.reply(imported.root!, { text: 'late', after: imported.root! }).then(
          () => outcomes.push('landed'),
          (error: { code?: string }) => outcomes.push(error.code ?? 'error'),
        )
      }),
    })) } })
    const call = caller(board.fetch, await personToken())
    await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U1' }) }))
    await vi.waitFor(() => expect(outcomes).toEqual(['newer_message']))
    expect((await read(call, 'support')).map((m) => m.text)).toEqual(['hello', 'first'])
  })

  it("refuses a callback's claim on a label someone holds, as a request's", async () => {
    const s = fakePlatform('slack')
    const outcomes: string[] = []
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({
      C1: delivering(async (sync) => {
        const imported = await sync.import('support')
        await sync.board.label(imported.root!, { set: { owner: 'triage' }, if: { owner: null } })
        await sync.board.label(imported.root!, { set: { owner: 'bot' }, if: { owner: null } }).then(
          () => outcomes.push('landed'),
          (error: { code?: string }) => outcomes.push(error.code ?? 'error'),
        )
      }),
    })) } })
    const call = caller(board.fetch, await personToken())
    await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U1' }) }))
    await vi.waitFor(() => expect(outcomes).toEqual(['label_conflict']))
    expect((await call('GET', '/messages?channel=support')).body.messages[0].labels).toMatchObject({ owner: 'triage' })
  })

  it("refuses a callback's edit at a revision another edit came after, as a request's", async () => {
    const s = fakePlatform('slack')
    const outcomes: string[] = []
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({
      C1: delivering(async (sync) => {
        const imported = await sync.import('support')
        const { id, revision } = await sync.board.reply(imported.root!, 'step 1 of 5')
        await sync.board.edit(id, 'step 2 of 5', { revision })
        await sync.board.edit(id, 'step 2 of 5, again', { revision }).then(
          () => outcomes.push('landed'),
          (error: { code?: string }) => outcomes.push(error.code ?? 'error'),
        )
      }),
    })) } })
    const call = caller(board.fetch, await personToken())
    await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U1' }) }))
    await vi.waitFor(() => expect(outcomes).toEqual(['revision_conflict']))
    expect((await read(call, 'support')).map((m) => m.text)).toEqual(['hello', 'step 2 of 5'])
  })

  it('resumes a failed callback after import without treating the retry as an echo', async () => {
    const s = fakePlatform('slack')
    let attempts = 0
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({
        C1: delivering(async (sync) => {
          const imported = await sync.import('support')
          await sync.board.reply(imported.root!, 'ack')
          if (++attempts === 1) throw new Error('interrupted after import')
        }),
      })) } })
      const call = caller(board.fetch, await personToken())
      await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hello', user: 'U1' }) }))
      await vi.waitFor(() => expect(attempts).toBe(1))
      await vi.waitFor(async () => {
        await board.skipHold(board.servers[1]!, 'inbox:slack:C1')
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
    const board = testBoard({ sync: { work: slack({ adapter: s.adapter }, channels({
      C1: async (sync) => {
        if (sync.direction !== 'in') return
        const { event } = sync
        seen.push(event.type)
        expect(event.platform).toBe('slack')
        expect(event.key).toBe('work')
        expect(Object.isFrozen(event)).toBe(true)
        if (event.kind === 'message') expect(event.files?.[0]?.name).toBe('proof.png')
        await sync.import('support', { labels: { area: 'support' }, text: 'text' in event ? `custom: ${event.text}` : undefined })
      },
    })) } })
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
    expect(imported).toMatchObject({ text: 'custom: hello', labels: { area: 'support' }, by: { actor: 'work:user:U1' } })
    const view = await call('GET', `/messages/${imported!.id}`)
    expect(view.body.message.attachments).toHaveLength(1)
    await receive({ ...root, id: '101', files: root.files, text: 'reply' })
    await vi.waitFor(async () => expect(await read(call, 'support')).toHaveLength(2))
    await receive({ type: 'edit', threadId: root.threadId, id: '101', text: 'edited', user: 'U1' })
    await vi.waitFor(async () => expect((await read(call, 'support'))[1]?.text).toBe('custom: edited'))
    await receive({ type: 'reaction', threadId: root.threadId, messageId: '100', emoji: 'eyes', added: true, user: 'U2' })
    await vi.waitFor(async () => expect((await read(call, 'support'))[0]?.reactions).toEqual({ eyes: ['work:user:U2'] }))
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
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({
      C1: async (sync) => {
        if (sync.direction !== 'in') return
        const { event, permalink } = sync
        if (event.kind === 'deleted') return void links.push(await permalink())
        if (event.kind !== 'message') return
        if (event.text === 'skip') return void skipped++
        links.push(await permalink(), await permalink())
      },
    })) } })
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

  it('imports once per event, refuses calls after the function, and skips an event without disconnecting', async () => {
    const s = fakePlatform('slack')
    let saved!: () => Promise<unknown>
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({
      C1: delivering(async (sync) => {
        saved = async () => sync.import('support')
        if (sync.event.kind === 'message' && sync.event.text === 'skip') return
        const first = await sync.import('support')
        expect(await sync.import('elsewhere')).toBe(first)
      }),
    })) } })
    const call = caller(board.fetch, await personToken())
    const send = (id: string, text: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id, text, user: 'U1' }) }))
    await send('100', 'first')
    await vi.waitFor(async () => expect(await read(call, 'support')).toHaveLength(1))
    // The message is readable as soon as it's written, which can be before the callback returns.
    await vi.waitFor(() => expect(saved()).rejects.toThrow('sync function has finished'))
    await send('101', 'skip')
    await send('102', 'last')
    await vi.waitFor(async () => expect((await read(call, 'support')).map((m) => m.text)).toEqual(['first', 'last']))
    await call('POST', '/messages', { re: (await read(call, 'support'))[0]!.id, text: 'outgoing' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]!.threadId).toBe('slack:C1:100')
  })

  it("starts a new root's platform thread from a function, and hears the thread's replies", async () => {
    const s = fakePlatform('slack')
    const run = vi.fn(async (sync: Sync<SlackEvent>) => {
      if (sync.direction === 'in') await sync.import('support')
    })
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter }, channels({ C1: async (sync) => {
      if (sync.direction === 'in') return run(sync)
      if (sync.target !== null) return sync.deliver()
      if (sync.message.channel === 'support') await sync.start(sync.channel!)
    } })) } })
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
    const item = { number: 70, title: 'Title', html_url: 'https://github.com/vercel-labs/board/pull/70', body: 'Description', draft: true, state: 'open', user: { id: 42, login: 'ada' } }
    const get = vi.fn(async () => ({ data: item }))
    Object.assign(g.adapter, { octokit: { rest: { pulls: { get } } } })
    const seen: { type: string; subject: string }[] = []
    const board = testBoard({ sync: { git: github({ adapter: g.adapter }, repos({
      'vercel-labs/board': async (sync) => {
        if (sync.direction !== 'in') return
        const { event } = sync
        seen.push({ type: event.type, subject: event.subject.type })
        await sync.import(event.subject.type === 'pull_request' ? 'prs' : 'issues', {
          labels: { area: 'board' },
          root: ({ raw }) => {
            const pr = (raw as { pull_request: typeof item }).pull_request
            return { text: `${pr.title}\n\n${pr.body}`, labels: { kind: 'code' } }
          },
        })
      },
    })) } })
    const call = caller(board.fetch, await personToken())
    const opened = () => board.fetch(new Request(`${BOARD_URL}/webhooks/git`, {
      method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'opened-70' },
      body: JSON.stringify({ action: 'opened', repository: { full_name: 'vercel-labs/board' }, sender: item.user, pull_request: item }),
    }))
    const comment = () => board.fetch(new Request(`${BOARD_URL}/webhooks/git`, {
      method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'github:vercel-labs/board:70:rc:12', id: 'c1', text: 'comment', user: '43', raw: { path: 'src/main.ts', line: 4 } }),
    }))
    if (openingFirst) { await opened(); await comment() } else { await comment(); await opened() }
    await vi.waitFor(async () => expect(await read(call, 'prs')).toHaveLength(2))
    const [root, reply] = await read(call, 'prs')
    expect(root).toMatchObject({ text: 'Title\n\nDescription', labels: { state: 'draft', area: 'board', kind: 'code' } })
    expect(reply?.re).toBe(root!.id)
    expect(get).toHaveBeenCalledTimes(openingFirst ? 0 : 1)
    expect(seen).toEqual(openingFirst ? [{ type: 'pr.opened', subject: 'pull_request' }, { type: 'comment', subject: 'pull_request' }] : [{ type: 'comment', subject: 'pull_request' }, { type: 'pr.opened', subject: 'pull_request' }])
  })

  it('does not fetch or import a skipped unknown GitHub conversation', async () => {
    const g = fakePlatform('github')
    const get = vi.fn()
    Object.assign(g.adapter, { octokit: { rest: { pulls: { get } } } })
    const seen = vi.fn()
    const board = testBoard({ sync: { github: github({ adapter: g.adapter }, repos({ 'vercel-labs/board': seen })) } })
    await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'github:vercel-labs/board:99', id: 'c1', text: 'skip', user: '1' }) }))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledOnce())
    expect(seen.mock.calls[0]![0].event).toMatchObject({ type: 'comment', text: 'skip' })
    expect(get).not.toHaveBeenCalled()
  })

  it('lets a fourth provider resolve opaque IDs without changing the core, preserving media fallback', async () => {
    const nativeChannel = 'https://provider.test/team:inbox'
    const Schema = eventSchema('opaque', 'message')
    type OpaqueEvent = z.infer<typeof Schema>
    class OpaqueProvider extends ChatSyncProvider<OpaqueEvent> {
      constructor(adapter: Adapter, sync: SyncFn<OpaqueEvent>) {
        super({
          platform: 'opaque', adapter, canStartThreads: true,
          author: (author) => ({ id: `opaque:tenant:sample:user:${author.userId}`, handle: author.userId, name: author.fullName || author.userId, avatar: null, isBot: author.isBot === true }),
          resolveChannel: async () => nativeChannel,
          resolveTarget: async (target) => ({ target: target === 'inbox' ? nativeChannel : target, channel: nativeChannel, kind: target === 'inbox' || target === nativeChannel ? 'channel' : 'thread' }),
          channelOf: () => nativeChannel,
        }, sync)
      }
      override event(context: SyncContext): OpaqueEvent {
        return Schema.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
      }
    }
    const p = fakePlatform('opaque')
    const receive = p.adapter.handleWebhook.bind(p.adapter)
    p.adapter.handleWebhook = (request, options) => request.headers.get('x-native-signature') === 'valid' ? receive(request, options) : Promise.resolve(new Response('invalid signature', { status: 401 }))
    const provider = new OpaqueProvider(p.adapter, channels({ inbox: 'tickets' }))
    const board = testBoard({ sync: { tickets: provider } })
    const call = caller(board.fetch, await personToken())
    const posted = await call('POST', '/messages', { channel: 'tickets', text: 'opaque root' })
    await vi.waitFor(() => expect(p.channelPosts).toHaveLength(1))
    const thread = `opaque:${nativeChannel}:${p.channelPosts[0]!.id}`
    await board.fetch(new Request(`${BOARD_URL}/webhooks/tickets`, { method: 'POST', headers: { 'x-native-signature': 'valid' }, body: JSON.stringify({ type: 'message', threadId: thread, id: 'response', text: 'native reply', user: '42' }) }))
    await vi.waitFor(async () => expect((await read(call, 'tickets'))[1]?.re).toBe(posted.body.message.id))
    // Its author is a user of the key it came through, which names them.
    expect((await read(call, 'tickets'))[1]?.by.actor).toBe('tickets:tenant:sample:user:42')
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

describe('a thread that stays on the board, and a platform thread one board thread holds', () => {
  it("never sends a `noSync` thread to a platform it's synced with: not its root, nor what's said in it", async () => {
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    // Two board-only threads synced by hand: one with a Slack channel, whose sync would backfill it,
    // and one with a Slack thread, which would get its replies.
    const { body: a } = await julian('POST', '/messages', { channel: 'firehose', text: 'the key is hunter2', noSync: true })
    const { body: b } = await julian('POST', '/messages', { channel: 'firehose', text: 'board only', noSync: true })
    expect((await julian('POST', `/messages/${a.message.id}/sync`, { target: 'slack:C9' })).status).toBe(200)
    expect((await julian('POST', `/messages/${b.message.id}/sync`, { target: 'slack:C9:900.1' })).status).toBe(200)
    await julian('POST', '/messages', { re: b.message.id, text: 'hunter2 again' })
    // A thread that does sync, after them: once it's there, they've had their turn.
    await julian('POST', '/messages', { channel: 'firehose', text: 'shared' })
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text).join()).toContain('shared'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect([...s.channelPosts, ...s.posts].map((post) => post.text).join('\n')).not.toContain('hunter2')
    expect(s.channelPosts).toHaveLength(1)
    expect(s.posts).toEqual([])
  })

  it('lets only one of two threads that ask for a Slack thread at once take it', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    const roots = await Promise.all(['one', 'two'].map(async (text) => (await julian('POST', '/messages', { channel: 'incidents', text })).body.message.id as number))
    const tries = await Promise.all(roots.map((id) => julian('POST', `/messages/${id}/sync`, { target: 'slack:C9:900.1' })))
    expect(tries.map((tried) => tried.status).sort()).toEqual([200, 409])
    const winner = roots[tries.findIndex((tried) => tried.status === 200)]!
    // What Slack says there lands in the thread that took it, and only there.
    await webhook('slack', { type: 'message', threadId: 'slack:C9:900.1', id: '900.2', text: 'on it', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${winner}`)).body.replies.map((m: { text: string }) => m.text)).toEqual(['on it']))
    for (const id of roots) expect((await julian('GET', `/messages/${id}/sync`)).body.targets.length).toBe(id === winner ? 1 : 0)
  })

  it('keeps a Slack thread with the board thread that took it first, whatever a later claim in the log says', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    const { body: first } = await julian('POST', '/messages', { channel: 'incidents', text: 'first', id: 'first' })
    const { body: second } = await julian('POST', '/messages', { channel: 'incidents', text: 'second', id: 'second' })
    expect((await julian('POST', `/messages/${first.message.id}/sync`, { target: 'slack:C9:900.1' })).status).toBe(200)
    // A second claim the log holds, as one that raced the first before writes refused it would.
    await board.session.append({ type: 'thread.synced', payload: { thread: 'second', target: 'slack:C9:900.1', kind: 'thread', cause: 'request', by: first.message.by } })
    await webhook('slack', { type: 'message', threadId: 'slack:C9:900.1', id: '900.2', text: 'on it', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${first.message.id}`)).body.replies.map((m: { text: string }) => m.text)).toEqual(['on it']))
    expect((await julian('GET', `/messages/${second.message.id}`)).body.replies).toEqual([])
    expect((await julian('GET', `/messages/${second.message.id}/sync`)).body.targets).toEqual([])
  })
})
