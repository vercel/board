import { createHmac } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'

afterEach(() => vi.restoreAllMocks())

/** Slack's own people, as `users.info` answers for them: Grace has never written where the app is. */
const USERS: Record<string, object> = {
  U_ADA: { id: 'U_ADA', name: 'ada', real_name: 'Ada Lovelace', profile: { display_name: 'ada', real_name: 'Ada Lovelace', image_72: 'https://avatars.test/ada.png' } },
  U_GRACE: { id: 'U_GRACE', name: 'grace', real_name: 'Grace Hopper', profile: { display_name: 'Grace Hopper', real_name: 'Grace Hopper', image_72: 'https://avatars.test/grace.png' } },
}

/** The real Slack adapter, with Slack's Web API answering from here, and what a signed webhook of `event` brings the board. */
async function received(event: Record<string, unknown>): Promise<ReceivedEvent[]> {
  const config = { botToken: 'xoxb-test', botUserId: 'U_BOT', signingSecret: 'test-secret' }
  vi.spyOn(Object.getPrototypeOf(createSlackAdapter(config).webClient), 'apiCall').mockImplementation(async (method: unknown, options: unknown) => {
    if (method === 'users.info') {
      const user = USERS[(options as { user: string }).user]
      return user ? { ok: true, user } : Promise.reject(Object.assign(new Error('user_not_found'), { data: { error: 'user_not_found' } }))
    }
    if (method === 'auth.test') return { ok: true, user_id: 'U_BOT', bot_id: 'B_BOT', team_id: 'T1' }
    if (method === 'conversations.replies') return { ok: true, messages: [] }
    throw new Error(`Unexpected Slack API call: ${method}`)
  })
  const adapter = createSlackAdapter(config)
  const provider = slack({ adapter }, channels({ C1: 'dev' }))
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { channel: 'C1', channel_type: 'channel', team: 'T1', ...event } })
  const signature = createHmac('sha256', 'test-secret').update(`v0:${timestamp}:${body}`).digest('hex')
  const request = new Request('https://board.test/webhooks/slack', {
    method: 'POST', body, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` },
  })
  const events: ReceivedEvent[] = []
  const response = await provider.receive('slack', request, async (event) => void events.push(event))
  expect(response.status).toBe(200)
  return events
}

const GRACE = { id: 'slack:user:U_GRACE', handle: 'Grace Hopper', name: 'Grace Hopper', avatar: 'https://avatars.test/grace.png', isBot: false }

it("brings a Slack mention in by the user's ID, with who they are, though they never wrote", async () => {
  const [got] = await received({ type: 'message', user: 'U_ADA', ts: '100.1', text: 'cc <@U_GRACE>, and again <@U_GRACE>' })
  expect(got?.event).toMatchObject({
    kind: 'message',
    author: { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada Lovelace' },
    text: 'cc @[slack:user:U_GRACE], and again @[slack:user:U_GRACE]',
    mentioned: [GRACE],
  })
})

it('names a mentioned user Slack will not describe by their ID, and still mentions them', async () => {
  const [got] = await received({ type: 'message', user: 'U_ADA', ts: '100.2', text: 'over to <@U_GONE>' })
  expect(got?.event).toMatchObject({
    text: 'over to @[slack:user:U_GONE]',
    mentioned: [{ id: 'slack:user:U_GONE', handle: 'U_GONE', name: 'U_GONE', avatar: null, isBot: false }],
  })
})

it('says of a message that mentions no Slack user only what it says: a name someone typed is text', async () => {
  const [got] = await received({ type: 'message', user: 'U_ADA', ts: '100.3', text: 'ask @grace about @vercel/board' })
  expect(got?.event).toMatchObject({ text: 'ask @grace about @vercel/board' })
  expect(got?.event).not.toHaveProperty('mentioned')
})

it('says who an edit now mentions', async () => {
  const [got] = await received({
    type: 'message', subtype: 'message_changed', ts: '100.5',
    message: { type: 'message', user: 'U_ADA', ts: '100.4', text: 'over to <@U_GRACE>', edited: { user: 'U_ADA', ts: '100.5' } },
    previous_message: { type: 'message', user: 'U_ADA', ts: '100.4', text: 'over to someone' },
  })
  expect(got?.event).toMatchObject({ kind: 'edited', message: '100.4', text: 'over to @[slack:user:U_GRACE]', mentioned: [GRACE] })
})
