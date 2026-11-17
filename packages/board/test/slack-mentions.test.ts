import { afterEach, expect, it, vi } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'

afterEach(() => vi.restoreAllMocks())

const thread = 'C1:1700000000.000100'

/** The real Slack adapter, with Slack's Web API answering from here: `sent` is the text of each message it was asked to post or change. */
function slackApi(client?: SlackClient) {
  const config = { botToken: 'xoxb-test', botUserId: 'U_BOT', signingSecret: 'test-secret' }
  const sent: unknown[] = []
  vi.spyOn(Object.getPrototypeOf(createSlackAdapter(config).webClient), 'apiCall').mockImplementation(async (method: unknown, options: unknown) => {
    const { markdown_text, text } = (options ?? {}) as { markdown_text?: string; text?: string }
    if (method === 'chat.postMessage' || method === 'chat.update') {
      sent.push(markdown_text ?? text)
      return { ok: true, ts: '1700000000.000200', channel: 'C1' }
    }
    // Slack's own Malte, whom the adapter comes to know by his display name.
    if (method === 'users.info') return { ok: true, user: { id: 'U_MALTE', name: 'malte', profile: { display_name: 'malte' } } }
    if (method === 'auth.test') return { ok: true, user_id: 'U_BOT', bot_id: 'B_BOT', team_id: 'T1' }
    throw new Error(`Unexpected Slack API call: ${method}`)
  })
  const adapter = createSlackAdapter(config)
  return { adapter, sent, provider: slack(client ? { adapter, client: async () => client } : { adapter }, channels({ C1: 'dev' })) }
}

// What the engine hands a provider: the mentions it resolved are Slack's own already, and the rest is text.
const markdown = 'Sure, @prj_x/user-u0456 and <@U0456>: see @vercel/board, or write ada@vercel.com'

it('posts what board left as text as its author wrote it: a handle no one has and a package name, beside a mention it resolved', async () => {
  const { provider, sent } = slackApi()
  await provider.post(thread, 'thread', { markdown })
  expect(sent).toEqual([markdown])
})

it('changes a message to what its author wrote, the same way', async () => {
  const { provider, sent } = slackApi()
  await provider.edit(thread, '1700000000.000200', { markdown })
  expect(sent).toEqual([markdown])
})

it("posts it as written under its author's name too, where board's own client sends it", async () => {
  const named: unknown[] = []
  const client: SlackClient = {
    conversations: { list: async () => ({}), info: async () => ({}) },
    chat: {
      postMessage: async (args) => {
        named.push(args.markdown_text)
        return { ts: '1700000000.000200' }
      },
    },
    auth: { test: async () => ({ response_metadata: { scopes: ['chat:write', 'chat:write.customize'] } }) },
  }
  const { provider } = slackApi(client)
  await provider.post(thread, 'thread', { markdown: `**factory**: ${markdown}`, as: { name: 'factory', avatar: null } })
  expect(named).toEqual([markdown])
})

it("leaves a name to board: one it didn't resolve pings no one, though the adapter knows a Slack user by it", async () => {
  const { adapter, provider, sent } = slackApi()
  await provider.post(thread, 'thread', { markdown: 'first' })
  // The adapter has met Malte in Slack, and would mention him for any `@malte`.
  await (adapter as unknown as { lookupUser(id: string): Promise<unknown> }).lookupUser('U_MALTE')
  await provider.post(thread, 'thread', { markdown: '@malte have a look' })
  expect(sent).toEqual(['first', '@malte have a look'])
})

it('keeps them in the comment of a new thread that carries files, which Slack takes as its older mrkdwn', async () => {
  const comments: string[] = []
  const client = {
    conversations: { list: async () => ({}), info: async () => ({}) },
    files: {
      delete: async () => ({}),
      uploadV2: async (args: { initial_comment: string; file_uploads: { filename: string }[] }) => {
        comments.push(args.initial_comment)
        return { files: [{ files: args.file_uploads.map((file) => ({ id: `F_${file.filename}` })) }] }
      },
      info: async () => ({ file: { shares: { public: { C1: [{ ts: '1700000000.000400' }] } } } }),
    },
    auth: { test: async () => ({ response_metadata: { scopes: ['files:write', 'files:read'] } }) },
  }
  const { provider } = slackApi(client as SlackClient)
  const text = 'see @vercel/board, cc @nobody and <@U0456>'
  await provider.post('C1', 'channel', { markdown: text, files: [{ data: new Uint8Array([1]), filename: 'shot.png', mimeType: 'image/png' }] })
  expect(comments).toEqual([text])
})
