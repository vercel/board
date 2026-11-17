import { describe, expect, it, vi } from 'vitest'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'
import { forwardText, slack, slackLinks, type SlackClient } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { formatMessage } from '../src/cli/format.ts'
import type { MessageView } from '../src/api/routes.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

/** The thread #321 was in: a Slack root's permalink and its ts. */
const TS = '1791322095.443859'
/** A public channel the app is in: the only kind it reads links from itself. */
const joined = async ({ channel }: { channel: string }) => ({ channel: { id: channel, is_member: true } })
const permalink = (channel: string, ts = TS) => `https://acme.slack.com/archives/${channel}/p${ts.replace('.', '')}`

/** The app can read the message that links, in C1, which a test's own `replies` needn't model: posted by U_JB. */
const withPoster = (replies: NonNullable<SlackClient['conversations']['replies']>): NonNullable<SlackClient['conversations']['replies']> =>
  async (args) => {
    if (args.channel !== 'C1') return replies(args)
    const read = await Promise.resolve(replies(args)).catch(() => undefined)
    return read?.messages?.some((message) => message.ts === args.oldest) ? read : { messages: [{ ts: args.oldest, user: 'U_JB', text: '' }] }
  }
/** Who Slack says U_JB is: a full member of the workspace, unless a test says otherwise. */
const member: NonNullable<SlackClient['users']> = { info: async () => ({ user: { id: 'U_JB' } }) }

function setup(client?: Partial<SlackClient['conversations']>, users: SlackClient['users'] = member) {
  const web = client
    ? { conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}), ...client, ...(client.replies ? { replies: withPoster(client.replies) } : {}) }, users }
    : undefined
  const s = fakePlatform('slack', web ? withSlackClient(web, false) : undefined)
  const board = testBoard({
    sync: {
      slack: slack({ adapter: s.adapter, ...(web ? { client: async () => web as SlackClient } : {}) }, channels({ C1: 'firehose' })),
    },
  })
  const webhook = (body: unknown) =>
    board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { board, s, webhook }
}

type Read = { id: number; text: string; editedAt: string | null; links: MessageView['links'] }
const messages = async (call: ReturnType<typeof caller>) =>
  (await call('GET', '/messages?channel=firehose')).body.messages as Read[]

/** A Slack message whose mrkdwn links `url`, with whatever Slack attached. */
const linking = (id: string, url: string, attachments: unknown[] = []) => ({
  type: 'message', threadId: `slack:C1:${id}`, id, text: `see ${url}`, user: 'U_JB',
  raw: { type: 'message', ts: id, text: `see <${url}>`, attachments },
})

describe('slack message links', () => {
  it('finds permalinks in mrkdwn, replies included, and the unfurl Slack sent for each', () => {
    const reply = `${permalink('C9', '1791322585.618629')}?thread_ts=${TS}&amp;cid=C9`
    const links = slackLinks('slack', `<${permalink('C1')}|this> and <${reply}> and <${permalink('C1')}>`, [
      { is_msg_unfurl: true, channel_id: 'C1', ts: TS, author_name: 'Julian Benegas', text: 'export is broken', files: [{ name: 'shot.png', permalink: 'https://acme.slack.com/files/shot' }] },
    ])
    expect(links).toEqual([
      { url: permalink('C1'), thread: `slack:C1:${TS}`, message: TS, snapshot: {
        author: 'Julian Benegas', text: 'export is broken', createdAt: new Date(Number(TS) * 1000).toISOString(),
        files: [{ name: 'shot.png', url: 'https://acme.slack.com/files/shot' }],
      } },
      { url: reply.replace('&amp;', '&'), thread: `slack:C9:${TS}`, message: '1791322585.618629', snapshot: null },
    ])
  })

  it('links the message a forward shares, which Slack sends only as an attachment', () => {
    const reply = '1791322585.618629'
    const share = { is_share: true, is_msg_unfurl: true, from_url: permalink('C9'), channel_id: 'C9', ts: TS, author_name: 'Ada', text: 'deploys are *down*' }
    const threaded = { is_share: true, from_url: `${permalink('C9', reply)}?thread_ts=${TS}&amp;cid=C9`, channel_id: 'C9', ts: reply, author_name: 'Ada', text: 'still down' }
    expect(slackLinks('slack', '', [share, threaded])).toEqual([
      { url: permalink('C9'), thread: `slack:C9:${TS}`, message: TS, snapshot: expect.objectContaining({ author: 'Ada', text: 'deploys are *down*' }) },
      { url: `${permalink('C9', reply)}?thread_ts=${TS}&cid=C9`, thread: `slack:C9:${TS}`, message: reply, snapshot: expect.objectContaining({ author: 'Ada', text: 'still down' }) },
    ])
    // A forward with a comment that also links the shared message links it once.
    expect(slackLinks('slack', `look <${permalink('C9')}>`, [share])).toHaveLength(1)
    // ...and keeps the share's snapshot when Slack didn't also mark it an unfurl.
    expect(slackLinks('slack', `look <${permalink('C9')}>`, [{ ...share, is_msg_unfurl: false }])).toEqual([
      expect.objectContaining({ url: permalink('C9'), snapshot: expect.objectContaining({ author: 'Ada', text: 'deploys are *down*' }) }),
    ])
  })

  it('quotes a forward that opens with a block with its author on a line of their own', () => {
    const link = (text: string) => slackLinks('slack', '', [{ is_share: true, from_url: permalink('C9'), channel_id: 'C9', ts: TS, author_name: 'Ada', text }])
    expect(forwardText(link('```\nError: deploy failed\n```'))).toBe(`> **Ada**:\n> \`\`\`\n> Error: deploy failed\n> \`\`\`\n\n${permalink('C9')}`)
    expect(forwardText(link('- one\n- two'))).toBe(`> **Ada**:\n> - one\n> - two\n\n${permalink('C9')}`)
    expect(forwardText(link('plain'))).toBe(`> **Ada**: plain\n\n${permalink('C9')}`)
  })

  it('imports a forward with no text of its own as the message it shares', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const id = '1791322999.000009'
    await webhook({
      type: 'message', threadId: `slack:C1:${id}`, id, text: '', user: 'U_JB',
      raw: { type: 'message', ts: id, text: '', attachments: [{ is_share: true, is_msg_unfurl: true, from_url: permalink('C9'), channel_id: 'C9', ts: TS, author_name: 'Ada', text: 'deploys are down\nsince noon', fallback: '[October 16th] ada: deploys are down' }] },
    })
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    const [forward] = await messages(julian)
    expect(forward!.text).toBe(`> **Ada**: deploys are down\n> since noon\n\n${permalink('C9')}`)
    expect(forward!.links).toEqual([{ url: permalink('C9'), message: null, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada', text: 'deploys are down\nsince noon' }) }])
  })

  it('links a synced message to its board copy', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), {})
    await webhook({ type: 'message', threadId: `slack:C1:${TS}`, id: TS, text: 'export is broken', user: 'U_ADA', name: 'Ada' })
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    await webhook(linking('1791322999.000001', permalink('C1')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(2))
    const [target, linker] = await messages(julian)
    expect(linker!.text).toBe(`see <${permalink('C1')}>`) // the text stays as written
    expect(linker!.links).toEqual([{ url: permalink('C1'), message: target!.id, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada', text: 'export is broken' }) }])
  })

  it("snapshots a board copy only in the linking message's own channel: another's comes from Slack's unfurl", async () => {
    // C9 is private and synced to security; the link is posted in C1, synced to firehose.
    const info = async ({ channel }: { channel: string }) => ({ channel: { id: channel, is_member: true, is_private: channel === 'C9' } })
    const web = { conversations: { list: async () => ({ channels: [] }), info, join: async () => ({}), replies: vi.fn() } }
    const s = fakePlatform('slack', withSlackClient(web, false))
    const board = testBoard({ sync: { slack: slack({ adapter: s.adapter, client: async () => web as SlackClient }, channels({ C1: 'firehose', C9: 'security' })) } })
    const webhook = (body: unknown) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const julian = caller(board.fetch, await personToken())
    await webhook({ type: 'message', threadId: `slack:C9:${TS}`, id: TS, text: 'the key is hunter2', user: 'U_ADA', name: 'Ada' })
    await webhook({ type: 'message', threadId: 'slack:C1:1791322000.000001', id: '1791322000.000001', text: 'export is broken', user: 'U_ADA', name: 'Ada' })
    const id = '1791322999.000005'
    await webhook(linking(id, permalink('C9')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(2))
    const linker = async () => (await messages(julian)).find((message) => message.text.includes(permalink('C9')))!
    // Nothing of security's message, and no pointer to it: the app read nothing of C9 either, since it's private.
    expect((await linker()).links).toEqual([{ url: permalink('C9'), message: null, snapshot: null, unavailable: 'private_channel' }])
    expect(web.conversations.replies).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'C9' }))
    // Slack's unfurl, which it checked against who posted the link, comes a moment later as a links-only edit.
    const text = `see <${permalink('C9')}>`
    await webhook({ type: 'event_callback', event: {
      type: 'message', subtype: 'message_changed', channel: 'C1',
      message: { type: 'message', ts: id, user: 'U_JB', text, attachments: [{ is_msg_unfurl: true, channel_id: 'C9', ts: TS, author_name: 'Ada', text: 'what Slack shows the channel' }] },
      previous_message: { type: 'message', ts: id, user: 'U_JB', text },
    } })
    await vi.waitFor(async () => expect((await linker()).links).toEqual([{ url: permalink('C9'), message: null, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada', text: 'what Slack shows the channel' }) }]))
    expect(JSON.stringify(await messages(julian))).not.toContain('hunter2')
    // A link to firehose's own message is still that board message.
    const same = permalink('C1', '1791322000.000001')
    await webhook(linking('1791322999.000006', same))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(3))
    const [root] = await messages(julian)
    expect((await messages(julian)).find((message) => message.text.includes(same))!.links).toEqual([
      { url: same, message: root!.id, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada', text: 'export is broken' }) },
    ])
  })

  it("snapshots an unsynced message from Slack's unfurl, without asking Slack", async () => {
    const replies = vi.fn()
    const { board, webhook } = setup({ replies })
    const julian = caller(board.fetch, await personToken())
    await webhook(linking('1791322999.000002', permalink('C9'), [{ is_msg_unfurl: true, channel_id: 'C9', ts: TS, author_subname: 'Ada', text: 'deploys are *down*' }]))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    const [linker] = await messages(julian)
    expect(linker!.links).toEqual([{ url: permalink('C9'), message: null, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada', text: 'deploys are *down*' }) }])
    expect(replies).not.toHaveBeenCalled()
  })

  it('reads an unsynced message from Slack when no unfurl came', async () => {
    const replies = vi.fn(async () => ({ messages: [{ ts: TS, user: 'U_ADA', text: 'the root, in <#C9>' }] }))
    const users = { info: vi.fn(async () => ({ user: { real_name: 'Ada Lovelace' } })) }
    const { board, webhook } = setup({ replies, info: joined }, users)
    const julian = caller(board.fetch, await personToken())
    await webhook(linking('1791322999.000003', permalink('C9')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    expect(replies).toHaveBeenCalledWith({ channel: 'C9', ts: TS, oldest: TS, latest: TS, inclusive: true, limit: 1 })
    const [linker] = await messages(julian)
    expect(linker!.links).toEqual([{ url: permalink('C9'), message: null, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada Lovelace', text: 'the root, in <#C9>' }) }])
  })

  it("names an agent's message by the name Slack shows it under, not the app's", async () => {
    const replies = vi.fn(async () => ({ messages: [{ ts: TS, bot_profile: { name: 'board' }, username: 'clever-lemur via vboard-factory', text: 'on it' }] }))
    const { board, webhook } = setup({ replies, info: joined })
    const julian = caller(board.fetch, await personToken())
    await webhook(linking('1791322999.000004', permalink('C9')))
    await vi.waitFor(async () => expect((await messages(julian))[0]?.links[0]?.snapshot).toMatchObject({ author: 'clever-lemur via vboard-factory', text: 'on it' }))
  })

  it("says why it couldn't read a link, then fills it in when Slack's unfurl arrives", async () => {
    const replies = vi.fn(async () => { throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } }) })
    const { board, webhook } = setup({ replies, info: joined })
    const julian = caller(board.fetch, await personToken())
    const id = '1791322999.000004'
    await webhook(linking(id, permalink('C9')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    expect((await messages(julian))[0]!.links).toEqual([{ url: permalink('C9'), message: null, snapshot: null, unavailable: 'not_in_channel' }])

    const text = `see <${permalink('C9')}>`
    const unfurled = { type: 'event_callback', event: {
      type: 'message', subtype: 'message_changed', channel: 'C1',
      message: { type: 'message', ts: id, user: 'U_JB', text, attachments: [{ is_msg_unfurl: true, channel_id: 'C9', ts: TS, author_name: 'Ada', text: 'private thoughts' }] },
      previous_message: { type: 'message', ts: id, user: 'U_JB', text },
    } }
    expect((await webhook(unfurled)).status).toBe(200)
    await webhook(unfurled) // Slack retries: once is enough
    await vi.waitFor(async () => expect((await messages(julian))[0]!.links[0]!.snapshot).toMatchObject({ author: 'Ada', text: 'private thoughts' }))
    const [linker] = await messages(julian)
    expect(linker).toMatchObject({ text: `see <${permalink('C9')}>`, editedAt: null }) // links changed, the text didn't
    const events = (await julian('GET', '/events?channel=firehose&after=0')).body.events as { type: string }[]
    expect(events.map((e) => e.type)).toEqual(['message.posted', 'message.linked'])
  })

  it.each([
    ['a guest', { is_restricted: true }],
    ['a single-channel guest', { is_ultra_restricted: true }],
    ['someone from another organization', { is_stranger: true }],
    ['someone Slack will not name', null],
  ])('reads nothing from a public channel for %s who posted the link', async (_who, user) => {
    const replies = vi.fn(async () => ({ messages: [{ ts: TS, user: 'U_ADA', text: 'only members were in this channel' }] }))
    const users = { info: vi.fn(async () => (user ? { user } : Promise.reject(new Error('user_not_found')))) } as NonNullable<SlackClient['users']>
    const { board, webhook } = setup({ replies, info: joined }, users)
    const julian = caller(board.fetch, await personToken())
    await webhook(linking('1791322999.000020', permalink('C9')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    expect((await messages(julian))[0]!.links).toEqual([{ url: permalink('C9'), message: null, snapshot: null, unavailable: 'poster_cannot_read' }])
    expect(replies).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'C9' }))
  })

  it("reads nothing from a channel shared with another organization, whoever posted the link", async () => {
    const replies = vi.fn(async () => ({ messages: [{ ts: TS, user: 'U_ADA', text: 'a partner is in this channel' }] }))
    const { board, webhook } = setup({ replies, info: async ({ channel }) => ({ channel: { id: channel, is_member: true, is_ext_shared: channel === 'C9' } }) })
    const julian = caller(board.fetch, await personToken())
    await webhook(linking('1791322999.000021', permalink('C9')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    expect((await messages(julian))[0]!.links).toEqual([{ url: permalink('C9'), message: null, snapshot: null, unavailable: 'shared_channel' }])
    expect(replies).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'C9' }))
  })

  it("keeps Slack's unfurl when it arrives before the message it unfurls", async () => {
    const id = '1791322999.000010'
    const text = `see <${permalink('C9')}>`
    const unfurl = { is_msg_unfurl: true, channel_id: 'C9', ts: TS, author_name: 'Ada', text: 'what Slack shows the channel' }
    // Slack has the unfurl on the linking message by now; the app isn't in C9, so it can't read the linked one.
    const replies = vi.fn(async ({ channel, ts }: { channel: string; ts: string }) =>
      ({ messages: channel === 'C1' && ts === id ? [{ ts: id, user: 'U_JB', text, attachments: [unfurl] }] : [] }))
    const { board, webhook } = setup({ replies, info: async ({ channel }) => ({ channel: { id: channel, is_member: channel === 'C1' } }) })
    const julian = caller(board.fetch, await personToken())
    await webhook({ type: 'event_callback', event: {
      type: 'message', subtype: 'message_changed', channel: 'C1',
      message: { type: 'message', ts: id, user: 'U_JB', text, attachments: [unfurl] },
      previous_message: { type: 'message', ts: id, user: 'U_JB', text },
    } })
    await webhook(linking(id, permalink('C9')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    expect((await messages(julian))[0]!.links).toEqual([
      { url: permalink('C9'), message: null, unavailable: null, snapshot: expect.objectContaining({ author: 'Ada', text: 'what Slack shows the channel' }) },
    ])
    expect(replies).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'C9' }))
  })

  it("never reads a private channel, a DM, or a channel it isn't in with the app's token: only Slack's unfurl can", async () => {
    const channels: Record<string, object> = {
      CPRIV: { id: 'CPRIV', is_private: true, is_member: true },
      D0DM: { id: 'D0DM', is_im: true },
      COUT: { id: 'COUT', is_member: false },
    }
    const replies = vi.fn(async () => ({ messages: [{ ts: TS, user: 'U_ADA', text: 'layoffs friday' }] }))
    const { board, webhook } = setup({ replies, info: async ({ channel }) => ({ channel: channels[channel] }) })
    const julian = caller(board.fetch, await personToken())
    await webhook(linking('1791322999.000005', permalink('CPRIV')))
    await webhook(linking('1791322999.000006', permalink('D0DM')))
    await webhook(linking('1791322999.000007', permalink('COUT')))
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(3))
    expect((await messages(julian)).map((m) => m.links[0])).toEqual([
      { url: permalink('CPRIV'), message: null, snapshot: null, unavailable: 'private_channel' },
      { url: permalink('D0DM'), message: null, snapshot: null, unavailable: 'private_channel' },
      { url: permalink('COUT'), message: null, snapshot: null, unavailable: 'not_in_channel' },
    ])
    for (const channel of Object.keys(channels)) expect(replies).not.toHaveBeenCalledWith(expect.objectContaining({ channel }))
  })

  it('keeps the links Slack did not unfurl when it unfurls the others', async () => {
    const replies = vi.fn(async () => ({ messages: [{ ts: TS, user: 'U_ADA', text: 'public root' }] }))
    const { board, webhook } = setup({ replies, info: async ({ channel }) => ({ channel: { id: channel, is_member: true, is_private: channel === 'CPRIV' } }) })
    const julian = caller(board.fetch, await personToken())
    const id = '1791322999.000008'
    const text = `see <${permalink('C9')}> and <${permalink('CPRIV')}>`
    await webhook({ type: 'message', threadId: `slack:C1:${id}`, id, text: `see ${permalink('C9')} and ${permalink('CPRIV')}`, user: 'U_JB', raw: { ts: id, text } })
    await vi.waitFor(async () => expect(await messages(julian)).toHaveLength(1))
    expect((await messages(julian))[0]!.links.map((link) => link.snapshot?.text ?? link.unavailable)).toEqual(['public root', 'private_channel'])
    await webhook({ type: 'event_callback', event: {
      type: 'message', subtype: 'message_changed', channel: 'C1',
      message: { ts: id, user: 'U_JB', text, attachments: [{ is_msg_unfurl: true, channel_id: 'CPRIV', ts: TS, author_name: 'Ada', text: 'shown to the channel by Slack' }] },
      previous_message: { ts: id, user: 'U_JB', text },
    } })
    await vi.waitFor(async () => expect((await messages(julian))[0]!.links.map((link) => link.snapshot?.text ?? link.unavailable)).toEqual(['public root', 'shown to the channel by Slack']))
  })

  it('quotes linked messages under the message in `vb read`', () => {
    const base = { id: '7', version: 7, revision: 7, channel: 'dev', text: 'see these', re: '6', replyTo: null, thread: 't', labels: {}, reactions: {}, noSync: false, origin: null, from: 'slack', blocks: [], createdAt: new Date().toISOString(), editedAt: null, deleted: false, undelivered: {}, attachments: [], author: null, by: { actor: 'slack:user:U_JB', principal: 'slack:user:U_JB', profile: null } }
    const view = { ...base, links: [
      { url: permalink('C1'), message: '5', unavailable: null, snapshot: { author: 'Ada', text: 'export is broken\nsince monday', createdAt: null, files: [{ name: 'shot.png', url: null }] } },
      { url: permalink('C9'), message: null, snapshot: null, unavailable: 'not_in_channel' },
    ] } satisfies MessageView
    expect(formatMessage(view, { reply: true }).split('\n').slice(2)).toEqual([
      `    ↪ Ada · #5 · ${permalink('C1')}`,
      '    > export is broken',
      '    > since monday',
      '    > file shot.png',
      `    ↪ ${permalink('C9')} (couldn't read it: not_in_channel)`,
    ])
  })
})
