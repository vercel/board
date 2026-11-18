import { describe, expect, it } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { chatSdk } from '../src/sync/chat-sdk.ts'
import { channels } from '../src/sync/fn.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { displayText, vercelDeployments, VERCEL_BOT } from '../src/contract/bots.ts'
import { VERCEL_BUILDING, VERCEL_WITH_SKIPPED } from './vercel-fixtures.ts'

const thread = 'C1:1700000000.000100'
const LABEL = '**vercel[bot] (github)**: '

/** Vercel's comment as sync hands it to a platform: the markdown that lists its deployments a line each, and the deployments. */
const comment = (text: string, label = LABEL) => ({ markdown: `${label}${displayText(text, true)}`, deployments: vercelDeployments(text)! })
/** Vercel's comment about one project, with its status changed. */
const withStatus = (status: string) => VERCEL_BUILDING.replaceAll('Building', status).replaceAll('building', status.toLowerCase())

const cell = (text: string) => ({ type: 'raw_text', text })
/** A cell of formatted text. */
const rich = (...elements: unknown[]) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] })
const link = (text: string, url: string) => ({ type: 'link', text, url })
/** A status beside its color: its emoji, a space, and Vercel's word for it, linking to the deployment's page. */
const status = (emoji: string, name: string, url: string) => rich({ type: 'emoji', name: emoji }, { type: 'text', text: ' ' }, link(name, url))
const HEADERS = [cell('Project'), cell('Deployment'), cell('Actions'), cell('Updated')]
/** The row of the project in `VERCEL_BUILDING`, as its links and its time (`2026-10-06T20:30:32.400Z`) have it. */
const factory = 'https://vercel.com/acme/acme-agents'
const builtRow = (emoji: string, name: string) => [
  rich(link('acme-agents', factory)),
  status(emoji, name, `${factory}/7ZEaNBTETQjaUF4Bd1VCxbM8rR3n`),
  rich(link('Preview', 'https://acme-agents-git-pi-224.acme.dev')),
  // In seconds, which Slack shows as how long ago, with Vercel's own words for a client that can't.
  rich({ type: 'date', timestamp: Date.UTC(2026, 9, 6, 20, 30, 32) / 1000, format: '{ago}', fallback: 'Oct 6, 2026 8:30pm UTC' }),
]
const table = (rows: unknown[][]) => ({ type: 'data_table', caption: 'Vercel deployments', page_size: rows.length - 1, rows })
const heading = { type: 'markdown', text: '**vercel[bot] (github)**: **▲ Vercel**' }

/** The real Slack adapter, kept off the network: board's own client is a fake, and so are the adapter's post and edit. */
function slackWith(scopes: string[], chat: 'all' | 'no update' | 'none' = 'all', refuses: { post?: string; update?: string } = {}) {
  const adapter = createSlackAdapter({ signingSecret: 'secret', botToken: 'xoxb-test' })
  const internals = adapter as unknown as { initialize(chat: unknown): Promise<void>; chat: unknown }
  internals.initialize = async function (chat) {
    internals.chat = chat
  }
  const viaAdapter: unknown[] = []
  adapter.postMessage = async (threadId, message) => {
    viaAdapter.push(message)
    return { id: '1700000000.000300', threadId, raw: {} }
  }
  const editsViaAdapter: unknown[] = []
  adapter.editMessage = async (threadId, id, message) => {
    editsViaAdapter.push(message)
    return { id, threadId, raw: {} }
  }
  const posted: Record<string, unknown>[] = []
  const updated: Record<string, unknown>[] = []
  const client: SlackClient = {
    conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
    ...(chat === 'none'
      ? {}
      : {
          chat: {
            postMessage: async (args) => {
              // Slack's Web API client throws what Slack answered, under `data`.
              if (refuses.post) throw Object.assign(new Error(refuses.post), { data: { error: refuses.post } })
              posted.push(args)
              return { ts: '1700000000.000200' }
            },
            ...(chat === 'all'
              ? {
                  update: async (args) => {
                    if (refuses.update) throw Object.assign(new Error(refuses.update), { data: { error: refuses.update } })
                    updated.push(args)
                  },
                }
              : {}),
          },
        }),
    auth: { test: async () => ({ response_metadata: { scopes } }) },
  }
  const provider = slack({ adapter, client: async () => client }, channels({}))
  return { provider, posted, updated, viaAdapter, editsViaAdapter }
}

describe("Vercel's deployment comment in Slack", () => {
  it('is the table Vercel posts on a pull request, with the deployments it skipped in a line under it', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const sent = await provider.post(thread, 'thread', comment(VERCEL_WITH_SKIPPED))
    expect(posted).toEqual([
      {
        channel: 'C1',
        thread_ts: '1700000000.000100',
        // What a notification shows: the text as Slack's mrkdwn, and the deployments in plain words.
        text: '*vercel[bot] (github)*: *▲ Vercel*\nacme-agents: Building\n1 skipped: <https://vercel.com/acme/vboard|vboard>',
        blocks: [
          heading,
          table([
            HEADERS,
            [
              rich(link('acme-agents', factory)),
              status('large_yellow_circle', 'Building', `${factory}/AKYQCQiM4Vf5Zp1AAcH6nQDYUC4n`),
              rich(link('Preview', 'https://acme-agents-git-changeset-release-main.acme.dev')),
              rich({ type: 'date', timestamp: Date.UTC(2026, 9, 6, 17, 25, 54) / 1000, format: '{ago}', fallback: 'Oct 6, 2026 5:25pm UTC' }),
            ],
          ]),
          { type: 'markdown', text: '1 skipped: [vboard](https://vercel.com/acme/vboard)' },
        ],
        unfurl_links: false,
        unfurl_media: false,
      },
    ])
    expect(viaAdapter).toEqual([])
    expect(sent).toEqual({ thread, message: '1700000000.000200' })
  })

  it("gives each status its color, in Vercel's words, and one it doesn't know a white dot", async () => {
    const { provider, posted } = slackWith(['chat:write'])
    const statuses = ['Queued', 'Initializing', 'Building', 'Ready', 'Error', 'Failed', 'Canceled', 'Promoting']
    for (const name of statuses) await provider.post(thread, 'thread', comment(withStatus(name)))
    const shown = posted.map((post) => (post.blocks as { rows?: { elements: { elements: { name?: string; text?: string }[] }[] }[][] }[])[1]!.rows![1]![1]!.elements[0]!.elements)
    expect(shown.map(([emoji, , word]) => [emoji!.name, word!.text])).toEqual([
      ['white_circle', 'Queued'],
      ['large_yellow_circle', 'Initializing'],
      ['large_yellow_circle', 'Building'],
      ['large_green_circle', 'Ready'],
      ['red_circle', 'Error'],
      ['red_circle', 'Failed'],
      ['black_circle', 'Canceled'],
      ['white_circle', 'Promoting'],
    ])
  })

  it('leaves out what a deployment has none of: a preview, a time Slack can count from, any time at all', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    const noPreview = VERCEL_BUILDING.replace(/\[Preview\]\([^)]*\)/, '')
    // An older comment's time: Vercel's words, with no time behind them.
    const wordsOnly = VERCEL_BUILDING.replace(/<relative-time[^>]*>([^<]*)<\/relative-time>/, '$1')
    const noTime = VERCEL_BUILDING.replace(/<relative-time[^>]*>[^<]*<\/relative-time>/, '')
    for (const text of [noPreview, wordsOnly, noTime]) await provider.post(thread, 'thread', comment(text))
    const rows = posted.map((post) => (post.blocks as { rows?: unknown[][] }[])[1]!.rows!)
    const [project, state, preview, ago] = builtRow('large_yellow_circle', 'Building')
    expect(rows).toEqual([
      [HEADERS, [project, state, cell(' '), ago]],
      [HEADERS, [project, state, preview, cell('Oct 6, 2026 8:30pm UTC')]],
      // No deployment says when: no Updated column.
      [HEADERS.slice(0, 3), [project, state, preview]],
    ])
  })

  it('starts a thread with it, and replaces its text and table on an edit', async () => {
    const { provider, posted, updated, editsViaAdapter } = slackWith(['chat:write'])
    const sent = await provider.post('C1', 'channel', comment(VERCEL_BUILDING))
    expect(posted[0]).not.toHaveProperty('thread_ts')
    expect(sent).toEqual({ thread: 'C1:1700000000.000200', message: '1700000000.000200' })
    await provider.edit(thread, '1700000000.000200', comment(withStatus('Ready')))
    expect(updated).toEqual([
      {
        channel: 'C1',
        ts: '1700000000.000200',
        text: '*vercel[bot] (github)*: *▲ Vercel*\nacme-agents: Ready',
        blocks: [heading, table([HEADERS, builtRow('large_green_circle', 'Ready')])],
      },
    ])
    expect(editsViaAdapter).toEqual([])
  })

  it("goes out under its author's name, the label dropped, where the board checked who that is and the app may name a sender", async () => {
    const as = { name: 'vercel[bot] (github)', avatar: 'https://cdn.example.com/vercel.png' }
    const named = slackWith(['chat:write', 'chat:write.customize'])
    await named.provider.post(thread, 'thread', { ...comment(VERCEL_BUILDING), as })
    expect(named.posted).toEqual([expect.objectContaining({ username: as.name, icon_url: as.avatar, blocks: [{ type: 'markdown', text: '**▲ Vercel**' }, table([HEADERS, builtRow('large_yellow_circle', 'Building')])] })])
    const unnamed = slackWith(['chat:write'])
    await unnamed.provider.post(thread, 'thread', { ...comment(VERCEL_BUILDING), as })
    expect(unnamed.posted).toEqual([expect.objectContaining({ blocks: [heading, expect.objectContaining({ type: 'data_table' })] })])
    expect(unnamed.posted[0]).not.toHaveProperty('username')
  })

  it('gives Slack the text around the table as the adapter would, and a notification text no longer than Slack takes', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    // A renderer's own words before the list, with the Chat SDK's placeholder for an emoji, which the adapter writes as Slack's name for it.
    await provider.post(thread, 'thread', comment(VERCEL_BUILDING, 'deployed {{emoji:thumbs_up}}\n\n'))
    expect(posted[0]).toMatchObject({ text: 'deployed :+1:\n\n*▲ Vercel*\nacme-agents: Building', blocks: [{ type: 'markdown', text: 'deployed :+1:\n\n**▲ Vercel**' }, expect.objectContaining({ type: 'data_table' })] })
    const long = 'word '.repeat(1200).trim()
    await provider.post(thread, 'thread', comment(VERCEL_BUILDING, `${long}\n\n`))
    const { text, blocks } = posted[1] as { text: string; blocks: { text?: string }[] }
    // An edit's text over 4,000 characters is refused: the notification is cut, the message isn't.
    expect([text.length, text.endsWith('…'), text.startsWith('word word')]).toEqual([3900, true, true])
    expect(blocks[0]!.text).toBe(`${long}\n\n**▲ Vercel**`)
  })
})

describe('the comment goes out as markdown, a line per deployment, as before', () => {
  const body = comment(VERCEL_WITH_SKIPPED)
  const markdown = body.markdown

  it("on a platform that doesn't lay them out, whose adapter gets the markdown alone", async () => {
    const discord = fakePlatform('discord')
    const provider = chatSdk({ adapter: discord.adapter }, channels({}))
    await provider.post('C1:100', 'thread', body)
    await provider.edit('C1:100', 'm1', body)
    // What the Chat SDK is handed, as the fake adapter recorded it: no deployments for it to trip on.
    expect(discord.posts.map((post) => JSON.parse(post.text))).toEqual([{ markdown }])
    expect(discord.edits.map((edit) => JSON.parse(edit.text))).toEqual([{ markdown }])
  })

  it('with files, which go with its text', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const files = [{ data: Buffer.from('x'), filename: 'a.txt' }]
    await provider.post(thread, 'thread', { ...body, files })
    expect(posted).toEqual([])
    // The adapter gets the text and the files, and nothing it has no use for.
    expect(viaAdapter).toEqual([{ markdown, files }])
  })

  it("when a renderer wrote the deployments its own way, so there's no list to put a table in place of", async () => {
    const { provider, posted, updated, viaAdapter, editsViaAdapter } = slackWith(['chat:write'])
    const own = { markdown: 'Vercel is building acme-agents', deployments: body.deployments }
    await provider.post(thread, 'thread', own)
    await provider.edit(thread, '1700000000.000200', own)
    expect([viaAdapter, editsViaAdapter]).toEqual([[{ markdown: own.markdown }], [{ markdown: own.markdown }]])
    expect([posted, updated]).toEqual([[], []])
  })

  it('when Vercel built none of them', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const onlySkipped = comment(VERCEL_WITH_SKIPPED.replace(/\| <a[^\n]*Building[^\n]*\n/, ''))
    expect(onlySkipped.deployments.map((deployment) => deployment.skipped)).toEqual([true])
    await provider.post(thread, 'thread', onlySkipped)
    expect(posted).toEqual([])
    expect(viaAdapter).toEqual([{ markdown: onlySkipped.markdown }])
  })

  it("when Slack won't take the layout, on a post or an edit: nothing was sent, so it isn't lost", async () => {
    for (const refusal of ['invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'block_mismatch']) {
      const { provider, viaAdapter, editsViaAdapter } = slackWith(['chat:write'], 'all', { post: refusal, update: refusal })
      const sent = await provider.post(thread, 'thread', body)
      await provider.edit(thread, '1700000000.000200', body)
      expect([refusal, viaAdapter, editsViaAdapter]).toEqual([refusal, [{ markdown }], [{ markdown }]])
      // The adapter's message is the one that went out.
      expect(sent).toEqual({ thread, message: '1700000000.000300' })
    }
  })

  it('but not when Slack refuses for another reason, which is the delivery failing', async () => {
    const { provider, viaAdapter, editsViaAdapter } = slackWith(['chat:write'], 'all', { post: 'channel_not_found', update: 'message_not_found' })
    await expect(provider.post(thread, 'thread', body)).rejects.toThrow('channel_not_found')
    await expect(provider.edit(thread, '1700000000.000200', body)).rejects.toThrow('message_not_found')
    expect([viaAdapter, editsViaAdapter]).toEqual([[], []])
  })

  it("when board has no client to post with, or one that can't edit", async () => {
    const none = slackWith(['chat:write'], 'none')
    await none.provider.post(thread, 'thread', body)
    await none.provider.edit(thread, '1700000000.000200', body)
    expect([none.viaAdapter, none.editsViaAdapter]).toEqual([[{ markdown }], [{ markdown }]])
    const noUpdate = slackWith(['chat:write'], 'no update')
    await noUpdate.provider.edit(thread, '1700000000.000200', body)
    expect(noUpdate.editsViaAdapter).toEqual([{ markdown }])
  })
})
