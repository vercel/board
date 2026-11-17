import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { github, repos } from '../src/sync/github.ts'
import { channels, mirror } from '../src/sync/fn.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

afterEach(() => vi.restoreAllMocks())

const config = { botToken: 'xoxb-test', botUserId: 'U_BOT', signingSecret: 'test-secret' }

/** The real Slack adapter, with Slack's Web API answering from here: `sent` is the text of each message Slack was asked to post. */
function slackApi() {
  const sent: unknown[] = []
  vi.spyOn(Object.getPrototypeOf(createSlackAdapter(config).webClient), 'apiCall').mockImplementation(async (method: unknown, options: unknown) => {
    const given = (options ?? {}) as { markdown_text?: string; text?: string }
    if (method === 'auth.test') return { ok: true, user_id: 'U_BOT', bot_id: 'B_BOT', team_id: 'T1' }
    if (method === 'chat.postMessage') {
      sent.push(given.markdown_text ?? given.text)
      return { ok: true, ts: `900.${sent.length}`, channel: 'C1' }
    }
    throw new Error(`Unexpected Slack API call: ${method}`)
  })
  return { adapter: createSlackAdapter(config), sent }
}

describe('a mention of a platform user the board has never met', () => {
  it("reaches Slack as its own mention from the user's ID alone, under the key of the sync that posts it", async () => {
    const { adapter, sent } = slackApi()
    const board = testBoard({ sync: { 'slack-eu': slack({ adapter }, channels({ C1: mirror('firehose') })) } })
    const julian = caller(board.fetch, await personToken('julian'), {})
    // No one by these IDs has written or been mentioned here: Grace is Slack's, through this board's sync.
    const text = 'cc @[slack-eu:user:U_GRACE], not @[slack:user:U_OTHER] or @[github:user:42]'
    expect((await julian('POST', '/messages', { channel: 'firehose', text })).status).toBe(201)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toContain('cc <@U_GRACE>, not @[slack:user:U_OTHER] or @[github:user:42]')
  })

  it("never lets what isn't a user's ID into Slack's own markup", async () => {
    const { adapter, sent } = slackApi()
    const board = testBoard({ sync: { slack: slack({ adapter }, channels({ C1: mirror('firehose') })) } })
    const julian = caller(board.fetch, await personToken('julian'), {})
    const text = 'cc @[slack:user:U1><!channel] and @[slack:user:u_lower]'
    expect((await julian('POST', '/messages', { channel: 'firehose', text })).status).toBe(201)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toContain('cc @[slack:user:U1><!channel] and @[slack:user:u_lower]')
  })

  it('stays as written on a platform that mentions by more than an ID, as GitHub does by login', async () => {
    const hub = fakePlatform('github')
    const board = testBoard({ sync: { github: github({ adapter: hub.adapter }, repos({ 'acme/web': mirror('prs') })) } })
    const julian = caller(board.fetch, await personToken('julian'), {})
    await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' },
      body: JSON.stringify({ action: 'opened', repository: { full_name: 'acme/web' }, sender: { id: 42, login: 'ada' }, pull_request: { number: 7, title: 'Add sync', html_url: 'https://github.com/acme/web/pull/7', user: { id: 42, login: 'ada' }, draft: false, merged: false, state: 'open', body: '' } }),
    }))
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=prs')).body.messages).toHaveLength(1))
    const [opened] = (await julian('GET', '/messages?channel=prs')).body.messages as { id: string }[]
    expect((await julian('POST', '/messages', { re: opened!.id, text: 'over to @[github:user:999]' })).status).toBe(201)
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1))
    expect(JSON.parse(hub.posts[0]!.text).markdown).toContain('over to @[github:user:999]')
  })
})

describe('a Slack channel read on demand', () => {
  it('shows each user a message mentions by their ID, under the sync key, as an import brings one in', async () => {
    const web = {
      conversations: {
        list: async () => ({ channels: [{ id: 'CKIT', name: 'kit', is_member: true }] }),
        info: async () => ({ channel: { id: 'CKIT', name: 'kit', is_member: true } }),
        history: async () => ({ messages: [{ ts: '1791389583.493629', user: 'U_ADA', text: 'cc <@U_GRACE> and <@U_KAI|kai>, see `code`' }], has_more: false }),
      },
      users: { info: async ({ user }: { user: string }) => ({ user: { id: user, real_name: 'Ada Lovelace' } }) },
    }
    const read = async (key: string) => {
      const board = testBoard({ sync: { [key]: slack({ adapter: createSlackAdapter(config), client: async () => web as unknown as SlackClient }, channels({ C1: 'firehose' })) } })
      const answer = await caller(board.fetch, await personToken())('GET', `/sources/${key}/read?target=CKIT`)
      expect(answer.status).toBe(200)
      return (answer.body.messages as { text: string }[]).map((message) => message.text)
    }
    expect(await read('slack')).toEqual(['cc @[slack:user:U_GRACE] and @[slack:user:U_KAI], see `code`'])
    expect(await read('slack-eu')).toEqual(['cc @[slack-eu:user:U_GRACE] and @[slack-eu:user:U_KAI], see `code`'])
  })
})
