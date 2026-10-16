import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from './http.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Adapter } from 'chat'
import { fakePlatform } from './sync-fixtures.ts'
import { slack } from '../src/sync/slack.ts'
import { github } from '../src/sync/github.ts'
import { withUserTokens, type UserTokens } from '../src/sync/users.ts'
import type { ProviderOptions } from '../src/sync/provider.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'

type Read = { id: number; text: string; by: { actor: string }; author: { handle: string; person?: { id: string; handle: string } } | null }

/** People's tokens, as a test controls them: `signIn` is the sign-in completing. */
function fakeTokens() {
  const tokens = new Map<string, string>()
  const users: UserTokens = {
    authorize: async (principal) => `https://connect.test/authorize?subject=${encodeURIComponent(principal)}`,
    token: async (principal) => tokens.get(principal) ?? null,
  }
  return { users, signIn: (principal: string, token: string) => void tokens.set(principal, token), signOut: (principal: string) => void tokens.delete(principal) }
}

/**
 * Slack's adapter runs calls with another token through `withBotToken`; this one
 * records which token each post, edit, and delete ran with, and who a token is.
 */
function slackAs(owners: Record<string, string>, onPost?: (post: { threadId: string; id: string; token: string | null }) => unknown) {
  const context = new AsyncLocalStorage<string>()
  const ran: { op: 'post' | 'edit' | 'delete'; threadId: string; id: string; text: string; token: string | null }[] = []
  return {
    ran,
    extend(adapter: Adapter) {
      const post = adapter.postMessage.bind(adapter)
      const postChannel = adapter.postChannelMessage!.bind(adapter)
      const edit = adapter.editMessage.bind(adapter)
      const remove = adapter.deleteMessage.bind(adapter)
      Object.assign(adapter, {
        withBotToken: <T>(token: string, fn: () => T) => context.run(token, fn),
        webClient: {
          auth: { test: async () => ({ user_id: owners[context.getStore() ?? ''] ?? 'U_BOT', user: 'someone' }) },
          users: { info: async ({ user }: { user: string }) => ({ user: { id: user, name: user.toLowerCase(), profile: { display_name: user.toLowerCase(), real_name: `Real ${user}` } } }) },
          conversations: { list: async () => ({ channels: [] }), info: async () => ({}), join: async () => ({}) },
        },
        postMessage: async (threadId: string, message: never) => {
          const sent = await post(threadId, message)
          const token = context.getStore() ?? null
          ran.push({ op: 'post', threadId, id: sent.id, text: JSON.stringify(message), token })
          await onPost?.({ threadId, id: sent.id, token })
          return sent
        },
        postChannelMessage: async (channelId: string, message: never) => {
          const sent = await postChannel(channelId, message)
          const token = context.getStore() ?? null
          ran.push({ op: 'post', threadId: sent.threadId, id: sent.id, text: JSON.stringify(message), token })
          await onPost?.({ threadId: sent.threadId, id: sent.id, token })
          return sent
        },
        editMessage: async (threadId: string, id: string, message: never) => {
          ran.push({ op: 'edit', threadId, id, text: JSON.stringify(message), token: context.getStore() ?? null })
          return edit(threadId, id, message)
        },
        deleteMessage: async (threadId: string, id: string) => {
          ran.push({ op: 'delete', threadId, id, text: '', token: context.getStore() ?? null })
          return remove(threadId, id)
        },
      })
    },
  }
}

function setup(options: { users?: UserTokens; owners?: Record<string, string>; githubUsers?: UserTokens; onPost?: Parameters<typeof slackAs>[1]; url?: string | undefined; slackRender?: ProviderOptions['render'] } = {}) {
  const as = slackAs(options.owners ?? {}, options.onPost)
  const s = fakePlatform('slack', as.extend)
  const g = fakePlatform('github')
  const board = testBoard({
    sync: {
      slack: slack({
        adapter: options.users ? withUserTokens(s.adapter, options.users) : s.adapter,
        client: async () => (s.adapter as unknown as { webClient: never }).webClient,
        channels: { C1: 'firehose' },
        render: options.slackRender,
      }),
      github: github({ adapter: options.githubUsers ? withUserTokens(g.adapter, options.githubUsers) : g.adapter, repos: { 'basehub-ai/vboard': 'prs' } }),
    },
    ...('url' in options ? { url: options.url } : {}),
  })
  const webhook = (key: string, body: unknown, headers: Record<string, string> = {}) =>
    board.fetch(new Request(`${BOARD_URL}/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  return { board, s, g, as, webhook }
}

const read = async (call: ReturnType<typeof caller>, query: string) => (await call('GET', `/messages?${query}`)).body.messages as Read[]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('linking accounts with a one-time code', () => {
  it('links the Slack account that posts the code, without importing it, and `--by` follows the link', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const claude = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian', 'x-board-profile': 'claude' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'from the board', noSync: true })
    await claude('POST', '/messages', { channel: 'firehose', text: 'from my agent', noSync: true })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'from Slack', user: 'U_JULIAN', name: 'jb' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(3))
    // Before linking, the Slack account is someone else; your agents are already you.
    expect((await read(julian, 'by=julian')).map((m) => m.text)).toEqual(['from the board', 'from my agent'])
    expect((await julian('GET', '/identity')).body.unlinked).toEqual(['slack', 'github'])

    const challenge = (await julian('POST', '/identity/link', { sync: 'slack' })).body
    expect(challenge).toMatchObject({ method: 'code', sync: 'slack', platform: 'slack', code: expect.stringMatching(/^vb-[A-Z2-9]{4}-[A-Z2-9]{4}$/) })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: ` ${challenge.code.toLowerCase()} `, user: 'U_JULIAN', name: 'jb' })
    await vi.waitFor(async () => expect((await julian('GET', '/identity')).body.links).toHaveLength(1))
    expect((await julian('GET', '/identity')).body).toMatchObject({
      principal: 'vercel:user:u_julian',
      links: [{ actor: 'slack:user:U_JULIAN', handle: 'jb', method: 'code' }],
      unlinked: ['github'],
    })
    // The code never reaches the board, and Slack gets a check mark on it.
    expect((await read(julian, 'channel=firehose')).map((m) => m.text)).not.toContain(challenge.code)
    expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: '101', emoji: 'check', added: true }])

    // `--by julian` is all of them: the board, the agent, the linked account. `--by jb` (the Slack handle) too.
    expect((await read(julian, 'by=julian')).map((m) => m.text)).toEqual(['from the board', 'from my agent', 'from Slack'])
    expect((await read(julian, 'by=jb')).map((m) => m.text)).toEqual(['from the board', 'from my agent', 'from Slack'])
    // An agent is still just itself.
    expect((await read(julian, 'by=julian/claude')).map((m) => m.text)).toEqual(['from my agent'])
    // Views say whose the account is; history keeps the original actor.
    const [slackMessage] = await read(julian, 'from=slack')
    expect(slackMessage).toMatchObject({ by: { actor: 'slack:user:U_JULIAN' }, author: { handle: 'jb', person: { id: 'vercel:user:u_julian', handle: 'julian' } } })
    const actors = (await julian('GET', '/actors')).body.actors as { id: string; person?: { handle: string } }[]
    expect(actors.find((a) => a.id === 'slack:user:U_JULIAN')?.person).toMatchObject({ handle: 'julian' })
  })

  it('mentions a linked person natively on that platform, and `--mentions` follows the link', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const ada = caller(board.fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'hi', noSync: true })
    const { code } = (await julian('POST', '/identity/link', { sync: 'slack' })).body
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'a thread', user: 'U_ADA' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: code, user: 'U_JULIAN', name: 'jb' })
    await vi.waitFor(async () => expect((await julian('GET', '/identity')).body.links).toHaveLength(1))

    const [root] = await read(ada, 'channel=firehose&from=slack')
    await ada('POST', '/messages', { re: root!.id, text: '@julian can you look?' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toEqual([expect.stringContaining('<@U_JULIAN> can you look?')]))

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '102', text: '@jb ping', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await read(ada, 'mentions=julian')).map((m) => m.text)).toEqual(['@julian can you look?', '@jb ping']))
    expect((await read(julian, 'mentions=me')).map((m) => m.text)).toEqual(['@julian can you look?', '@jb ping'])
  })

  it('carries a person across platforms: their GitHub account reads as their Slack one', async () => {
    const seen: (string | null)[] = []
    let owner: string | null = null
    const { board, s, webhook } = setup({
      slackRender: ({ message, label, mentionOf }) => {
        seen.push(mentionOf(message.by.actor))
        owner = mentionOf('vercel:user:u_julian')
        return `**${label}**: ${message.text}`
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const ada = caller(board.fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'hi', noSync: true })
    const forSlack = (await julian('POST', '/identity/link', { sync: 'slack' })).body.code
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: forSlack, user: 'U_JULIAN', name: 'jb' })
    // Julian, as GitHub knows them, opens a PR, and links that account from it.
    await webhook(
      'github',
      {
        action: 'opened',
        repository: { full_name: 'basehub-ai/vboard' },
        sender: { login: 'julianbenegas', id: 42 },
        pull_request: { number: 8, title: 'Links', html_url: 'https://github.com/basehub-ai/vboard/pull/8', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' },
    )
    await vi.waitFor(async () => expect(await read(ada, 'channel=prs')).toHaveLength(1))
    const forGitHub = (await julian('POST', '/identity/link', { sync: 'github' })).body.code
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:8', id: 'c0', text: forGitHub, user: '42', name: 'julianbenegas' })
    await vi.waitFor(async () => expect((await julian('GET', '/identity')).body.links).toHaveLength(2))

    // The PR's thread goes to Slack, where only the links map GitHub to Slack.
    const [root] = await read(ada, 'channel=prs')
    await ada('POST', `/messages/${root!.id}/sync`, { target: 'slack:C9' })
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId)).toEqual(['slack:C9']))
    // The default label stays the name; a renderer that wants the person gets their Slack mention.
    expect(JSON.parse(s.channelPosts[0]!.text).markdown).toMatch(/^\*\*julianbenegas \(github\)\*\*: PR #8: Links/)
    expect(seen.at(-1)).toBe('<@U_JULIAN>')
    expect(owner).toBe('<@U_JULIAN>')

    // A mention of the GitHub account reads as the Slack one.
    await ada('POST', '/messages', { re: root!.id, text: '@[github:user:42] can you look?' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toContainEqual(expect.stringContaining('<@U_JULIAN> can you look?')))
    // Someone with no Slack account has no mention there.
    expect(seen.at(-1)).toBeNull()

    // Unlinked, the GitHub account is just itself again.
    await julian('POST', '/identity/unlink', { actor: 'github:user:42' })
    seen.length = 0
    await ada('POST', `/messages/${root!.id}/labels`, { set: { review: 'yes' } })
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.every((mention) => mention === null)).toBe(true)
    await ada('POST', '/messages', { re: root!.id, text: '@[github:user:42] again' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toContainEqual(expect.stringContaining('julianbenegas again')))
  })

  it('imports an expired, foreign, or already used code as a message, and the first account keeps it', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'a thread', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(1))

    const { code } = (await julian('POST', '/identity/link', { sync: 'slack' })).body
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: code, user: 'U_JULIAN' })
    await vi.waitFor(async () => expect((await julian('GET', '/identity')).body.links).toHaveLength(1))
    // Someone who saw it in the channel posts it too: it's just their message.
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '102', text: code, user: 'U_MALLORY' })
    await vi.waitFor(async () => expect((await read(julian, 'channel=firehose')).map((m) => m.text)).toContain(code))
    expect((await julian('GET', '/identity')).body.links.map((l: { actor: string }) => l.actor)).toEqual(['slack:user:U_JULIAN'])

    // A code for GitHub, posted in Slack, and an expired one: messages too.
    const forGitHub = (await julian('POST', '/identity/link', { sync: 'github' })).body.code
    vi.useFakeTimers({ toFake: ['Date'] })
    const stale = (await julian('POST', '/identity/link', { sync: 'slack' })).body.code
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '103', text: forGitHub, user: 'U_BOB' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '104', text: stale, user: 'U_BOB' })
    await vi.waitFor(async () => expect((await read(julian, 'channel=firehose')).map((m) => m.text)).toEqual(expect.arrayContaining([forGitHub, stale])))
    vi.useRealTimers()
    expect((await julian('GET', '/identity')).body.links).toHaveLength(1)
  })

  it('imports a used code reposted by the account that used it as a message, with no check mark', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'a thread', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(1))
    const { code } = (await julian('POST', '/identity/link', { sync: 'slack' })).body
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: code, user: 'U_JULIAN' })
    await vi.waitFor(async () => expect((await julian('GET', '/identity')).body.links).toHaveLength(1))
    await julian('POST', '/identity/unlink', { actor: 'slack:user:U_JULIAN' })

    // Long after its ten minutes, the same account posts the used code again: it's just a message.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 20 * 60_000)
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '105', text: code, user: 'U_JULIAN' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '106', text: 'after', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await read(julian, 'channel=firehose')).map((m) => m.text)).toContain('after'))
    vi.useRealTimers()
    expect((await read(julian, 'channel=firehose')).map((m) => m.text)).toEqual(['a thread', code, 'after'])
    expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: '101', emoji: 'check', added: true }])
    expect((await julian('GET', '/identity')).body.links).toEqual([])
  })

  it('unlinks an account, by handle; only people link, and only their own accounts', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const ada = caller(board.fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    vi.stubEnv('VERCEL_ENV', 'production')
    const deployment = caller(board.fetch, await deploymentToken('board', 'prj_board'))
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'from Slack', user: 'U_JULIAN', name: 'jb' })
    const { code } = (await julian('POST', '/identity/link', { sync: 'slack' })).body
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: code, user: 'U_JULIAN', name: 'jb' })
    // Julian never wrote on the board: their principal ID still names them.
    await vi.waitFor(async () => expect((await read(julian, 'by=vercel:user:u_julian')).map((m) => m.text)).toEqual(['from Slack']))

    expect((await deployment('POST', '/identity/link', { sync: 'slack' })).body.error.message).toBe('only people link platform accounts')
    expect((await ada('POST', '/identity/unlink', { actor: '@jb' })).body.error.code).toBe('not_linked')
    expect((await julian('POST', '/identity/unlink', { actor: '@jb' })).body).toEqual({ ok: true, actor: 'slack:user:U_JULIAN' })
    expect((await julian('GET', '/identity')).body.links).toEqual([])
    expect(await read(julian, 'by=vercel:user:u_julian')).toEqual([])
  })
})

describe('signing in, and posting as yourself', () => {
  it('links the account a sign-in authorized, then posts what you write on the board as you', async () => {
    const tokens = fakeTokens()
    const { board, as, webhook } = setup({ users: tokens.users, owners: { 'xoxp-julian': 'U_JULIAN' } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const claude = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian', 'x-board-profile': 'claude' })

    const challenge = (await julian('POST', '/identity/link', { sync: 'slack' })).body
    expect(challenge).toEqual({ method: 'consent', sync: 'slack', platform: 'slack', url: 'https://connect.test/authorize?subject=vercel%3Auser%3Au_julian' })
    // A code is still there for the asking.
    expect((await julian('POST', '/identity/link', { sync: 'slack', method: 'code' })).body.method).toBe('code')
    // GitHub can't sign anyone in here.
    expect((await julian('POST', '/identity/link', { sync: 'github', method: 'consent' })).status).toBe(400)

    expect((await julian('POST', '/identity/check', { sync: 'slack' })).body).toEqual({ linked: null })
    tokens.signIn('vercel:user:u_julian', 'xoxp-julian')
    expect((await julian('POST', '/identity/check', { sync: 'slack' })).body.linked).toMatchObject({ actor: 'slack:user:U_JULIAN', handle: 'u_julian', name: 'Real U_JULIAN', method: 'consent' })
    expect((await julian('GET', '/identity')).body.links).toHaveLength(1)

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(1))
    const [root] = await read(julian, 'channel=firehose')

    // Yours goes as you, with no name in front; your agent's goes as the app, as before.
    const mine = (await julian('POST', '/messages', { re: root!.id, text: 'looking into it' })).body.message
    await vi.waitFor(() => expect(as.ran.filter((r) => r.op === 'post')).toHaveLength(1))
    await claude('POST', '/messages', { re: root!.id, text: 'found it' })
    await vi.waitFor(() => expect(as.ran.filter((r) => r.op === 'post')).toHaveLength(2))
    const [asYou, asApp] = as.ran
    expect(asYou).toMatchObject({ threadId: 'slack:C1:100', token: 'xoxp-julian' })
    expect(JSON.parse(asYou!.text)).toEqual({ markdown: 'looking into it' })
    expect(asApp).toMatchObject({ token: null })
    expect(asApp!.text).toContain('claude via julian')

    // Its copy came back through the webhook as yours: the receipt says it's the same one.
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: asYou!.id, text: 'looking into it', user: 'U_JULIAN' })
    // Editing and deleting it need your token too: the app can't change your message.
    await julian('POST', `/messages/${mine.id}/edit`, { text: 'looking into it now' })
    await vi.waitFor(() => expect(as.ran.find((r) => r.op === 'edit')).toMatchObject({ id: asYou!.id, token: 'xoxp-julian' }))
    expect(JSON.parse(as.ran.find((r) => r.op === 'edit')!.text)).toEqual({ markdown: 'looking into it now' })
    await julian('POST', `/messages/${mine.id}/delete`)
    await vi.waitFor(() => expect(as.ran.find((r) => r.op === 'delete')).toMatchObject({ id: asYou!.id, token: 'xoxp-julian' }))
    expect((await read(julian, 'channel=firehose')).map((m) => m.text)).toEqual(['export is broken', '', 'found it'])

    // Signed out: back to the app.
    tokens.signOut('vercel:user:u_julian')
    await julian('POST', '/messages', { re: root!.id, text: 'still here' })
    await vi.waitFor(() => expect(as.ran.filter((r) => r.op === 'post')).toHaveLength(3))
    expect(as.ran.filter((r) => r.op === 'post')[2]).toMatchObject({ token: null })
  })

  it("holds back your copy when it comes back before its receipt, so it's never imported twice", async () => {
    const tokens = fakeTokens()
    let echo: Promise<Response> | undefined
    let deliver: (post: { threadId: string; id: string; token: string | null }) => unknown = () => {}
    const { board, as, webhook } = setup({ users: tokens.users, owners: { 'xoxp-julian': 'U_JULIAN' }, onPost: (post) => deliver(post) })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    tokens.signIn('vercel:user:u_julian', 'xoxp-julian')
    await julian('POST', '/identity/check', { sync: 'slack' })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(1))
    const [root] = await read(julian, 'channel=firehose')
    // Slack's webhook for the copy lands while the board is still posting it.
    // and the board reads it before the post returns.
    deliver = async (post) => {
      if (!post.token) return
      echo = webhook('slack', { type: 'message', threadId: post.threadId, id: post.id, text: 'on it', user: 'U_JULIAN' })
      await echo
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    await julian('POST', '/messages', { re: root!.id, text: 'on it' })
    await vi.waitFor(() => expect(echo).toBeDefined())
    await echo
    await vi.waitFor(async () => {
      const events = (await julian('GET', '/events?after=0&all=true')).body.events as { type: string }[]
      expect(events.map((e) => e.type)).toContain('message.synced')
    })
    // Let the held copy retry past its receipt.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await read(julian, 'channel=firehose')).map((m) => m.text)).toEqual(['export is broken', 'on it'])
    expect(as.ran.filter((r) => r.op === 'post')).toHaveLength(1)
  })

  it('holds back the copy of a new thread you started, which comes back before the board knows its Slack thread', async () => {
    const tokens = fakeTokens()
    let echo: Promise<Response> | undefined
    const { board, as, webhook } = setup({
      users: tokens.users,
      owners: { 'xoxp-julian': 'U_JULIAN' },
      onPost: async (post) => {
        if (!post.token) return
        echo = webhook('slack', { type: 'message', threadId: post.threadId, id: post.id, text: 'new thread', user: 'U_JULIAN' })
        await echo
        await new Promise((resolve) => setTimeout(resolve, 300))
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    tokens.signIn('vercel:user:u_julian', 'xoxp-julian')
    await julian('POST', '/identity/check', { sync: 'slack' })

    await julian('POST', '/messages', { channel: 'firehose', text: 'new thread' })
    await vi.waitFor(() => expect(echo).toBeDefined())
    await echo
    await vi.waitFor(async () => {
      const events = (await julian('GET', '/events?after=0&all=true')).body.events as { type: string; payload: { external?: { asUser?: boolean } } }[]
      expect(events.find((e) => e.type === 'message.synced')?.payload.external?.asUser).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await read(julian, 'channel=firehose')).map((m) => [m.text, m.by.actor])).toEqual([['new thread', 'vercel:user:u_julian']])
    expect(as.ran.filter((r) => r.op === 'post')).toMatchObject([{ token: 'xoxp-julian', threadId: expect.stringMatching(/^slack:C1:/) }])
  })

  it('posts as you only while the account you signed in with is linked', async () => {
    const tokens = fakeTokens()
    const { board, as, webhook } = setup({ users: tokens.users, owners: { 'xoxp-julian': 'U_JULIAN' } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'a thread', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(1))
    const [root] = await read(julian, 'channel=firehose')
    const posts = () => as.ran.filter((r) => r.op === 'post')

    // Signed in (`--no-wait`) but never checked: nothing's linked, so the app posts.
    tokens.signIn('vercel:user:u_julian', 'xoxp-julian')
    await julian('POST', '/messages', { re: root!.id, text: 'one' })
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]).toMatchObject({ token: null })

    await julian('POST', '/identity/check', { sync: 'slack' })
    const two = (await julian('POST', '/messages', { re: root!.id, text: 'two' })).body.message
    await vi.waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1]).toMatchObject({ token: 'xoxp-julian' })

    // Unlinked: the app posts again, though Connect still has the token; the copy that went as you stays yours to edit.
    await julian('POST', '/identity/unlink', { actor: 'slack:user:U_JULIAN' })
    await julian('POST', '/messages', { re: root!.id, text: 'three' })
    await vi.waitFor(() => expect(posts()).toHaveLength(3))
    expect(posts()[2]).toMatchObject({ token: null })
    await julian('POST', `/messages/${two.id}/edit`, { text: 'two!' })
    await vi.waitFor(() => expect(as.ran.find((r) => r.op === 'edit')).toMatchObject({ id: posts()[1]!.id, token: 'xoxp-julian' }))
  })

  it('posts a GitHub comment as you through the API, and links the account the token is', async () => {
    const tokens = fakeTokens()
    const calls: { method: string; url: string; auth: string | null; body: unknown }[] = []
    const real = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.startsWith('https://api.github.com/')) return real(input, init)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/user')) return Response.json({ id: 40034115, login: 'NicolasMontone', avatar_url: 'https://avatars.test/n', type: 'User' })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ id: 9001 })
    })
    const { board, g, webhook } = setup({ githubUsers: tokens.users })
    const monto = caller(board.fetch, await personToken('u_monto'), { 'x-board-handle': 'nmonto' })
    tokens.signIn('vercel:user:u_monto', 'ghu_monto')
    expect((await monto('POST', '/identity/check', { sync: 'github' })).body.linked).toMatchObject({ actor: 'github:user:40034115', handle: 'NicolasMontone' })

    await webhook(
      'github',
      {
        action: 'opened',
        repository: { full_name: 'basehub-ai/vboard' },
        sender: { login: 'julianbenegas', id: 42 },
        pull_request: { number: 12, title: 'Identity', html_url: 'https://github.com/basehub-ai/vboard/pull/12', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'd1' },
    )
    await vi.waitFor(async () => expect(await read(monto, 'channel=prs')).toHaveLength(1))
    const [root] = await read(monto, 'channel=prs')
    const reply = (await monto('POST', '/messages', { re: root!.id, text: 'LGTM' })).body.message
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1))
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST', url: 'https://api.github.com/repos/basehub-ai/vboard/issues/12/comments', auth: 'Bearer ghu_monto', body: { body: 'LGTM' },
    })
    expect(g.posts).toHaveLength(0) // not through the app's adapter

    await monto('POST', `/messages/${reply.id}/edit`, { text: 'LGTM!' })
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: 'https://api.github.com/repos/basehub-ai/vboard/issues/comments/9001', body: { body: 'LGTM!' } }))
    await monto('POST', `/messages/${reply.id}/delete`)
    await vi.waitFor(() => expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ url: 'https://api.github.com/repos/basehub-ai/vboard/issues/comments/9001', auth: 'Bearer ghu_monto' }))
    expect(g.edits).toHaveLength(0)
    expect(g.deletes).toHaveLength(0)
  })

  it('posts as the app when posting as you fails', async () => {
    const tokens = fakeTokens()
    const { board, s, as, webhook } = setup({ users: tokens.users, owners: { 'xoxp-julian': 'U_JULIAN' } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    tokens.signIn('vercel:user:u_julian', 'xoxp-julian')
    await julian('POST', '/identity/check', { sync: 'slack' })
    const failing = s.adapter.postMessage
    s.adapter.postMessage = async (threadId, message) => {
      if (JSON.stringify(message) === '{"markdown":"hello"}')
        throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } })
      return failing(threadId, message)
    }
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'a thread', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'channel=firehose')).toHaveLength(1))
    const [root] = await read(julian, 'channel=firehose')
    await julian('POST', '/messages', { re: root!.id, text: 'hello' })
    await vi.waitFor(() => expect(as.ran.filter((r) => r.op === 'post')).toHaveLength(1))
    expect(as.ran[0]).toMatchObject({ token: null })
    expect(as.ran[0]!.text).toContain('hello')
  })
})

describe('vb identity', () => {
  const CLI = join(import.meta.dirname, '../src/cli/main.ts')
  const run = (url: string, token: string, args: string[], onLine?: (line: string) => void) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|VBOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)))
      const home = mkdtempSync(join(tmpdir(), 'vboard-identity-'))
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...clean, VBOARD_URL: url, VBOARD_TOKEN: token, VBOARD_HANDLE: 'julian', HOME: home, XDG_CONFIG_HOME: home },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => {
        stdout += data
        for (const line of String(data).split('\n')) onLine?.(line)
      })
      child.stderr.on('data', (data) => (stderr += data))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      child.stdin.end()
    })

  it('prints a code, waits for it to be posted, then lists and unlinks the account', async () => {
    const { board, webhook } = setup({ url: undefined })
    const server = await serve(board.fetch)
    try {
      const url = `${server.origin}/api/board`
      const token = await personToken('u_julian', url)
      // It names the sync entries left to link, so an agent knows what to offer.
      expect(await run(url, token, ['identity'])).toMatchObject({ code: 0, stdout: 'no linked accounts\nnot linked  slack, github  (vb identity link <key>)\n' })
      expect(JSON.parse((await run(url, token, ['identity', '--json'])).stdout).unlinked).toEqual(['slack', 'github'])

      let posted: Promise<Response> | undefined
      const linking = await run(url, token, ['identity', 'link', 'slack'], (line) => {
        const code = /^\s+(vb-\S+)$/.exec(line)?.[1]
        if (code && !posted) posted = webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: code, user: 'U_JULIAN', name: 'jb' })
      })
      expect(linking).toMatchObject({ code: 0, stderr: '' })
      expect(linking.stdout).toMatch(/^From your slack account, post this as a message anywhere the board syncs, within 10 minutes:\n\n  vb-[A-Z2-9]{4}-[A-Z2-9]{4}\n\nlinked @jb \(slack:user:U_JULIAN\)\n$/)

      expect((await run(url, token, ['identity'])).stdout).toMatch(/^@jb  slack:user:U_JULIAN  by code · \d{4}-\S+\nnot linked  github  \(vb identity link <key>\)\n$/)
      expect(await run(url, token, ['identity', 'unlink', '@jb'])).toMatchObject({ code: 0, stdout: 'unlinked slack:user:U_JULIAN\n' })
      expect((await run(url, token, ['identity', 'nope'])).code).toBe(2)
    } finally {
      server.close()
    }
  }, 20_000)

  it('prints the sign-in URL, and waits for the sign-in', async () => {
    const tokens = fakeTokens()
    const { board } = setup({ url: undefined, users: tokens.users, owners: { 'xoxp-julian': 'U_JULIAN' } })
    const server = await serve(board.fetch)
    try {
      const url = `${server.origin}/api/board`
      const token = await personToken('u_julian', url)
      const linking = await run(url, token, ['identity', 'link', 'slack', '--no-open'], (line) => {
        if (line.includes('connect.test')) setTimeout(() => tokens.signIn('vercel:user:u_julian', 'xoxp-julian'), 500)
      })
      expect(linking).toMatchObject({ code: 0, stderr: '' })
      expect(linking.stdout).toBe(
        'Sign in to slack as yourself to link it (and to post as you there):\n\n  https://connect.test/authorize?subject=vercel%3Auser%3Au_julian\n\n' +
          'Only open it yourself: whoever completes it links their account to you.\nlinked @u_julian (slack:user:U_JULIAN)\n',
      )
    } finally {
      server.close()
    }
  }, 20_000)
})
