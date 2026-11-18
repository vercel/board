import { describe, expect, it, vi } from 'vitest'
import { formatSynced } from '../src/cli/format.ts'
import { github, repos } from '../src/sync/github.ts'
import { channels, mirror } from '../src/sync/fn.ts'
import { envelope, type ProviderEvent } from '../src/sync/events.ts'
import { SyncProvider, type ProviderPost, type Receive, type ResolvedTarget, type SyncContext } from '../src/sync/provider.ts'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { BOARD_URL, caller, personToken, testBoard, workflowToken } from './harness.ts'
import { fakePlatform } from './sync-fixtures.ts'

const author = { id: 'opaque:user:42', handle: 'ada', name: 'Ada', avatar: null, isBot: false }

/** A platform with one channel, `inbox`, whose threads and messages have URLs: `https://opaque.test/inbox:t1/m2`. */
class Opaque extends SyncProvider {
  posts: { target: string; kind: ResolvedTarget['kind']; text: string }[] = []

  constructor(channel = 'tickets') {
    super({ platform: 'opaque', canStartThreads: true }, channels({ inbox: channel }))
  }

  override async receive(key: string, request: Request, emit: Receive) {
    const input = (await request.json()) as { id: string; text: string; thread: string }
    await emit({
      dedupe: input.id,
      raw: input,
      event: { kind: 'message', channel: `${key}:inbox`, thread: `${key}:${input.thread}`, subthread: null, message: input.id, text: input.text, isRoot: false, context: null, author },
    })
    return new Response('ok')
  }
  override event(context: SyncContext): ProviderEvent {
    return { ...envelope(this.platform, context.key, context.event, context.raw, context.id), type: context.event.kind }
  }
  override async resolveChannel() { return 'inbox' }
  override async resolveTarget(target: string): Promise<ResolvedTarget> { return { target, channel: 'inbox', kind: target === 'inbox' ? 'channel' : 'thread' } }
  override async post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost) {
    const n = this.posts.push({ target, kind, text: body.markdown })
    return { thread: kind === 'channel' ? `inbox:t${n}` : target, message: `m${n}` }
  }
  override locate(url: string) {
    const found = /^https:\/\/opaque\.test\/(inbox:[a-z0-9]+)(?:\/([a-z0-9]+))?$/.exec(url)
    return found ? { thread: found[1]!, message: found[2] ?? null } : null
  }
  override async url(thread: string, message: string) { return `https://opaque.test/${thread}/${message}` }
}

async function setup() {
  const provider = new Opaque()
  const board = testBoard({ sync: { tickets: provider } })
  // The outsider's workflow may read only open.
  await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { open: ['read'] } })
  const ada = caller(board.fetch, await personToken())
  const outsider = caller(board.fetch, await workflowToken())
  const webhook = (body: unknown) => board.fetch(new Request(`${BOARD_URL}/webhooks/tickets`, { method: 'POST', body: JSON.stringify(body) }))
  return { provider, board, ada, outsider, webhook }
}

const linked = (url: string) => `/links?url=${encodeURIComponent(url)}`

describe('where a thread is synced, and the message a platform link names', () => {
  it("lists a thread's targets with each copy's link, and finds the thread from a link to a message or the thread", async () => {
    const { provider, ada, webhook } = await setup()
    const root = (await ada('POST', '/messages', { channel: 'tickets', text: 'printer on fire' })).body.message.id
    await vi.waitFor(() => expect(provider.posts).toHaveLength(1))
    const reply = (await ada('POST', '/messages', { re: root, text: 'on it' })).body.message.id
    await vi.waitFor(() => expect(provider.posts).toHaveLength(2))
    await webhook({ id: 'x9', text: 'from opaque', thread: 'inbox:t1' })
    let inbound = ''
    await vi.waitFor(async () => {
      const { replies } = (await ada('GET', `/messages/${root}`)).body
      inbound = replies.find((message: { text: string }) => message.text === 'from opaque')?.id
      expect(inbound).toBeTruthy()
    })

    await vi.waitFor(async () => expect((await ada('GET', `/messages/${reply}/sync`)).body.targets[0]?.message).toBe('m2'))
    expect((await ada('GET', `/messages/${root}/sync`)).body).toEqual({
      targets: [{ target: 'tickets:inbox', key: 'tickets', thread: 'tickets:inbox:t1', message: 'm1', url: 'https://opaque.test/inbox:t1/m1', undelivered: null }],
    })
    // One that came in from the platform is its own copy there.
    expect((await ada('GET', `/messages/${inbound}/sync`)).body.targets).toMatchObject([{ target: 'tickets:inbox', message: 'x9', url: 'https://opaque.test/inbox:t1/x9' }])

    for (const url of ['https://opaque.test/inbox:t1/m2', 'https://opaque.test/inbox:t1/x9', 'https://opaque.test/inbox:t1']) {
      const { status, body } = await ada('GET', linked(url))
      expect(status, url).toBe(200)
      expect(body.message.id).toBe(root)
    }
  })

  it("answers a link the board synced nothing for, and one to a channel the caller can't read, the same way", async () => {
    const { provider, ada, outsider } = await setup()
    const root = (await ada('POST', '/messages', { channel: 'tickets', text: 'printer on fire' })).body.message.id
    await vi.waitFor(() => expect(provider.posts).toHaveLength(1))
    const open = (await ada('POST', '/messages', { channel: 'open', text: 'hello' })).body.message.id

    const unknown = await outsider('GET', linked('https://opaque.test/inbox:t9/m9'))
    const unreadable = await outsider('GET', linked('https://opaque.test/inbox:t1/m1'))
    expect([unknown.status, unreadable.status]).toEqual([404, 404])
    expect(unreadable.body).toEqual(unknown.body)
    expect((await outsider('GET', linked('https://elsewhere.test/inbox:t1/m1'))).body).toEqual(unknown.body)
    expect((await outsider('GET', `/messages/${root}/sync`)).status).toBe(404)
    expect((await outsider('GET', `/messages/${open}/sync`)).body).toEqual({ targets: [] })
  })

  it('finds a link through any entry of its platform, not only the first that reads it', async () => {
    // Two workspaces of one platform: both read every link of it, and each keeps its own records.
    const first = new Opaque('tickets')
    const second = new Opaque('support')
    const board = testBoard({ sync: { first, second } })
    const ada = caller(board.fetch, await personToken())
    const root = (await ada('POST', '/messages', { channel: 'support', text: 'printer on fire' })).body.message.id
    await vi.waitFor(() => expect(second.posts).toHaveLength(1))
    expect(first.posts).toEqual([])
    await vi.waitFor(async () => expect((await ada('GET', linked('https://opaque.test/inbox:t1/m1'))).body.message?.id).toBe(root))
    expect((await ada('GET', `/messages/${root}/sync`)).body.targets).toMatchObject([{ target: 'second:inbox', key: 'second', url: 'https://opaque.test/inbox:t1/m1' }])
  })
})

describe("Slack's and GitHub's links", () => {
  it('reads a Slack permalink as its channel, thread, and ts, and asks Slack for a message’s', async () => {
    const permalinks: unknown[] = []
    const client = { chat: { getPermalink: async (args: unknown) => (permalinks.push(args), { permalink: 'https://acme.slack.com/archives/C0123ABC/p1727000001000200?thread_ts=1727000000.123456&cid=C0123ABC' }) } }
    const provider = slack({ adapter: fakePlatform('slack').adapter, client: async () => client as unknown as SlackClient }, channels({ C0123ABC: 'dev' }))
    expect(provider.locate('https://acme.slack.com/archives/C0123ABC/p1727000000123456')).toEqual({ thread: 'C0123ABC:1727000000.123456', message: '1727000000.123456' })
    expect(provider.locate('https://acme.enterprise.slack.com/archives/C0123ABC/p1727000001000200?thread_ts=1727000000.123456&cid=C0123ABC')).toEqual({
      thread: 'C0123ABC:1727000000.123456',
      message: '1727000001.000200',
    })
    expect(provider.locate('https://github.com/acme/www/pull/12')).toBeNull()
    expect(await provider.url('C0123ABC:1727000000.123456', '1727000001.000200')).toContain('/archives/C0123ABC/p1727000001000200')
    expect(permalinks).toEqual([{ channel: 'C0123ABC', message_ts: '1727000001.000200' }])
  })

  it("reads a GitHub URL as its PR's or issue's thread and comment, and makes one from them", async () => {
    const provider = github({ adapter: fakePlatform('github').adapter as never }, repos({ 'acme/www': 'dev' }))
    expect(provider.locate('https://github.com/acme/www/pull/12')).toEqual({ thread: 'acme/www:12', message: null })
    expect(provider.locate('https://github.com/acme/www/pull/12#issuecomment-301')).toEqual({ thread: 'acme/www:12', message: '301' })
    expect(provider.locate('https://github.com/acme/www/issues/3#issuecomment-4')).toEqual({ thread: 'acme/www:issue:3', message: '4' })
    // A review comment's link names only the comment, so it's read in the PR's thread, where the board finds it.
    expect(provider.locate('https://github.com/acme/www/pull/12/files#discussion_r345')).toEqual({ thread: 'acme/www:12', message: '345' })
    expect(provider.locate('https://github.com/acme/www/issues/3#discussion_r345')).toBeNull()
    expect(provider.locate('https://acme.slack.com/archives/C0123ABC/p1727000000123456')).toBeNull()
    expect(await provider.url('acme/www:12', 'root:delivery-1')).toBe('https://github.com/acme/www/pull/12')
    expect(await provider.url('acme/www:12', '301')).toBe('https://github.com/acme/www/pull/12#issuecomment-301')
    expect(await provider.url('acme/www:issue:3', '4')).toBe('https://github.com/acme/www/issues/3#issuecomment-4')
    expect(await provider.url('acme/www:12:rc:345', '346')).toBe('https://github.com/acme/www/pull/12#discussion_r346')
  })
})

describe('a GitHub review comment, by its own link', () => {
  it("finds a reply in a review thread, which its link names only by the reply's ID, and the thread's first comment", async () => {
    const g = fakePlatform('github')
    const board = testBoard({ sync: { github: github({ adapter: g.adapter as never }, repos({ 'acme/www': 'dev' })) } })
    const ada = caller(board.fetch, await personToken())
    const webhook = (body: unknown, headers: Record<string, string> = {}) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
    await webhook(
      { action: 'opened', repository: { full_name: 'acme/www' }, sender: { id: 42, login: 'ada' }, pull_request: { number: 12, title: 'Links', html_url: 'https://github.com/acme/www/pull/12', draft: false, merged: false } },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'review-links-opened' },
    )
    // A review thread is named by its first comment, 345; 346 replies in it.
    await webhook({ type: 'message', threadId: 'github:acme/www:12:rc:345', id: '345', text: 'nit: rename this', user: '43', raw: { path: 'src/a.ts', line: 3 } })
    await webhook({ type: 'message', threadId: 'github:acme/www:12:rc:345', id: '346', text: 'done', user: '42' })
    await vi.waitFor(async () => expect((await ada('GET', '/messages?channel=dev')).body.messages).toHaveLength(3))
    const root = (await ada('GET', '/messages?channel=dev')).body.messages.find((message: { re: string | null }) => message.re === null).id
    for (const comment of ['345', '346']) {
      const { status, body } = await ada('GET', linked(`https://github.com/acme/www/pull/12#discussion_r${comment}`))
      expect(status, comment).toBe(200)
      expect(body.message.id).toBe(root)
    }
    expect((await ada('GET', linked('https://github.com/acme/www/pull/12#discussion_r999'))).status).toBe(404)
  })

  it("finds the board's own reply in a review thread by the link vb sync gives it", async () => {
    const g = fakePlatform('github')
    // GitHub names a comment by its number.
    const post = g.adapter.postMessage.bind(g.adapter)
    g.adapter.postMessage = async (thread, message) => ({ ...(await post(thread, message)), id: '400' })
    const board = testBoard({ sync: { github: github({ adapter: g.adapter as never }, repos({ 'acme/www': mirror('dev') })) } })
    const ada = caller(board.fetch, await personToken())
    const webhook = (body: unknown, headers: Record<string, string> = {}) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
    await webhook(
      { action: 'opened', repository: { full_name: 'acme/www' }, sender: { id: 42, login: 'ada' }, pull_request: { number: 12, title: 'Links', html_url: 'https://github.com/acme/www/pull/12', draft: false, merged: false } },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'own-reply-opened' },
    )
    await webhook({ type: 'message', threadId: 'github:acme/www:12:rc:345', id: '345', text: 'nit: rename this', user: '43', raw: { path: 'src/a.ts', line: 3 } })
    let comment = ''
    await vi.waitFor(async () => {
      comment = (await ada('GET', '/messages?channel=dev')).body.messages.find((message: { text: string }) => message.text === 'nit: rename this')?.id
      expect(comment).toBeTruthy()
    })
    // Answering the inline comment posts into its review thread.
    const reply = (await ada('POST', '/messages', { re: comment, text: 'renamed' })).body.message.id
    await vi.waitFor(() => expect(g.posts.map((sent) => sent.threadId)).toEqual(['github:acme/www:12:rc:345']))
    let link = ''
    await vi.waitFor(async () => {
      link = (await ada('GET', `/messages/${reply}/sync`)).body.targets[0]?.url
      expect(link).toBe('https://github.com/acme/www/pull/12#discussion_r400')
    })
    const { status, body } = await ada('GET', linked(link))
    expect(status).toBe(200)
    expect(body.replies.map((message: { id: string }) => message.id)).toContain(reply)
  })

  it('refuses a review thread as a target, and names the PR to sync instead', async () => {
    const board = testBoard({ sync: { github: github({ adapter: fakePlatform('github').adapter as never }, repos({ 'acme/www': 'dev' })) } })
    const ada = caller(board.fetch, await personToken())
    const root = (await ada('POST', '/messages', { channel: 'dev', text: 'rename the helper' })).body.message.id
    const refused = await ada('POST', `/messages/${root}/sync`, { target: 'github:acme/www:12:rc:345' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toBe("can't sync to github:acme/www:12:rc:345: a review thread can't be a target; sync its PR, acme/www:12")
    expect((await ada('POST', `/messages/${root}/sync`, { target: 'github:acme/www:12' })).status).toBe(200)
  })
})

describe('vb sync <id>', () => {
  it('prints a row a target: its key, where, and the link or why it didn’t reach it', () => {
    expect(
      formatSynced([
        { target: 'slack:C0123ABCDEF', key: 'slack', thread: 'slack:C0123ABCDEF:1.2', message: '1.2', url: 'https://acme.slack.com/archives/C0123ABCDEF/p12', undelivered: null },
        { target: 'github:acme/www:12', key: 'github', thread: 'github:acme/www:12', message: null, url: null, undelivered: 'rate limited' },
        { target: 'slack:C0INCIDENTS', key: 'slack', thread: null, message: null, url: null, undelivered: null },
      ]),
    ).toBe(
      [
        'slack   C0123ABCDEF  https://acme.slack.com/archives/C0123ABCDEF/p12',
        "github  acme/www:12  didn't reach it: rate limited",
        'slack   C0INCIDENTS  no copy yet',
      ].join('\n'),
    )
  })
})
