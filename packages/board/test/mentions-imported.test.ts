import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import type { Can } from '../src/access/index.ts'
import { slack } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'

type Kept = { id: string; text: string; by: { actor: string } }
type Known = { id: string; handle: string; name: string; kind: string; platform?: string }

const read = async (call: ReturnType<typeof caller>, channel: string) => (await call('GET', `/messages?channel=${channel}`)).body.messages as Kept[]
const actors = async (call: ReturnType<typeof caller>) => (await call('GET', '/actors')).body.actors as Known[]
const julianOn = async (fetch: (request: Request) => Promise<Response>) => caller(fetch, await personToken('julian'), {})

const ADA = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
const GRACE = { id: 'slack:user:U_GRACE', handle: 'grace', name: 'Grace Hopper', avatar: null, isBot: false }

describe("a mention that comes in from Slack, on the board's own sync", () => {
  afterEach(() => vi.restoreAllMocks())

  /** Slack's own people, as `users.info` answers for them. */
  const USERS: Record<string, object> = {
    U_ADA: { id: 'U_ADA', name: 'ada', real_name: 'Ada', profile: { display_name: 'ada', real_name: 'Ada' } },
    U_GRACE: { id: 'U_GRACE', name: 'grace', real_name: 'Grace Hopper', profile: { display_name: 'grace', real_name: 'Grace Hopper' } },
  }

  /**
   * A board that mirrors Slack's C1 as `firehose` through the real Slack adapter, with Slack's Web
   * API answering from here: `sent` is the text of each message Slack was asked to post, and
   * `says` delivers a signed webhook of a message there, or of a `change` to one.
   */
  function mirrored(key = 'slack') {
    const config = { botToken: 'xoxb-test', botUserId: 'U_BOT', signingSecret: 'test-secret' }
    const sent: unknown[] = []
    vi.spyOn(Object.getPrototypeOf(createSlackAdapter(config).webClient), 'apiCall').mockImplementation(async (method: unknown, options: unknown) => {
      const given = (options ?? {}) as { user?: string; markdown_text?: string; text?: string }
      if (method === 'users.info') return USERS[given.user ?? ''] ? { ok: true, user: USERS[given.user!] } : Promise.reject(new Error('user_not_found'))
      if (method === 'auth.test') return { ok: true, user_id: 'U_BOT', bot_id: 'B_BOT', team_id: 'T1' }
      if (method === 'conversations.replies') return { ok: true, messages: [] }
      if (method === 'chat.postMessage') {
        sent.push(given.markdown_text ?? given.text)
        return { ok: true, ts: `900.${sent.length}`, channel: 'C1' }
      }
      throw new Error(`Unexpected Slack API call: ${method}`)
    })
    const board = testBoard({ sync: { [key]: slack({ adapter: createSlackAdapter(config) }, channels({ C1: 'firehose' })) } })
    const says = async (user: string, ts: string, text: string, change?: Record<string, unknown>) => {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const event = change ? { ts, ...change } : { user, ts, text }
      const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `Ev${ts}`, event: { type: 'message', channel: 'C1', channel_type: 'channel', team: 'T1', ...event } })
      const signature = createHmac('sha256', 'test-secret').update(`v0:${timestamp}:${body}`).digest('hex')
      const response = await board.fetch(new Request(`${BOARD_URL}/webhooks/${key}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` } }))
      expect(response.status).toBe(200)
    }
    return { board, sent, says }
  }

  it('meets the Slack user a message mentions, whom a reply on the board then mentions back in Slack by name', async () => {
    const { board, sent, says } = mirrored()
    const julian = await julianOn(board.fetch)
    await says('U_ADA', '500.1', 'cc <@U_GRACE>')
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((kept) => kept.text)).toEqual(['cc @[slack:user:U_GRACE]']))
    // Grace has written nothing, and the board knows him by the names Slack gives him.
    expect((await actors(julian)).find((actor) => actor.id === GRACE.id)).toMatchObject({ handle: 'grace', name: 'Grace Hopper', kind: 'external', platform: 'slack' })

    const [root] = await read(julian, 'firehose')
    const reply = await julian('POST', '/messages', { re: root!.id, text: '@grace, over to you' })
    expect(reply.body.mentions).toEqual([{ written: '@grace', actor: { id: GRACE.id, handle: 'grace', name: 'Grace Hopper' }, candidates: [] }])
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toContain('<@U_GRACE>, over to you')
  })

  it("mentions a Slack app's bot, which Slack can't mention by its bot ID, by its name instead", async () => {
    const { board, sent, says } = mirrored()
    const julian = await julianOn(board.fetch)
    await says('', '600.1', 'building it', { subtype: 'bot_message', bot_id: 'B_RAVEN', username: 'raven', text: 'building it' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    const raven = (await actors(julian)).find((actor) => actor.id === root!.by.actor)!
    expect(raven.id).toContain('B_RAVEN')
    const reply = await julian('POST', '/messages', { re: root!.id, text: `@${raven.handle} keep it` })
    expect(reply.body.mentions).toMatchObject([{ actor: { id: raven.id } }])
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).not.toContain('<@B_RAVEN>')
    expect(sent[0]).toContain(`${raven.name} keep it`)
  })

  it('names them under the sync key the mention came through, as it names who wrote', async () => {
    const { board, says } = mirrored('slack-eu')
    const julian = await julianOn(board.fetch)
    await says('U_ADA', '500.1', 'cc <@U_GRACE>')
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((kept) => [kept.text, kept.by.actor])).toEqual([['cc @[slack-eu:user:U_GRACE]', 'slack-eu:user:U_ADA']]))
    expect((await actors(julian)).find((actor) => actor.id === 'slack-eu:user:U_GRACE')).toMatchObject({ handle: 'grace', name: 'Grace Hopper' })
  })

  it('names every user a message mentions under its key, and meets the first fifty', async () => {
    const { board, says } = mirrored('slack-eu')
    const julian = await julianOn(board.fetch)
    const users = Array.from({ length: 51 }, (_, n) => `U_${n}`)
    await says('U_ADA', '500.1', users.map((user) => `<@${user}>`).join(' '))
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((kept) => kept.text)).toEqual([users.map((user) => `@[slack-eu:user:${user}]`).join(' ')]))
    const met = (await actors(julian)).map((actor) => actor.id)
    expect(users.filter((user) => met.includes(`slack-eu:user:${user}`))).toEqual(users.slice(0, 50))
  })

  it('shows them to a caller that reads only where they were mentioned, and to no caller held elsewhere', async () => {
    const { board, says } = mirrored()
    const julian = await julianOn(board.fetch)
    await says('U_ADA', '500.1', 'cc <@U_GRACE>')
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const held = async (can: string) => (await actors(caller(board.fetch, await personToken('julian'), { 'x-board-can': can }))).map((actor) => actor.id)
    expect(await held('firehose=read')).toContain(GRACE.id)
    expect(await held('elsewhere=read')).not.toContain(GRACE.id)
  })

  it('meets who an edit in Slack comes to mention', async () => {
    const { board, says } = mirrored()
    const julian = await julianOn(board.fetch)
    await says('U_ADA', '500.1', 'over to someone')
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await says('U_ADA', '500.2', '', { subtype: 'message_changed', message: { type: 'message', user: 'U_ADA', ts: '500.1', text: 'over to <@U_GRACE>', edited: { user: 'U_ADA', ts: '500.2' } }, previous_message: { type: 'message', user: 'U_ADA', ts: '500.1', text: 'over to someone' } })
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((kept) => kept.text)).toEqual(['over to @[slack:user:U_GRACE]']))
    expect((await actors(julian)).find((actor) => actor.id === GRACE.id)).toMatchObject({ handle: 'grace', name: 'Grace Hopper' })
  })
})

describe('a mention that comes in through a sync elsewhere', () => {
  /** The support project, which runs its own Slack sync and imports through the team's board. */
  const SUPPORT = 'vercel:project:prj_support:production'
  async function team() {
    const board = testBoard()
    const can = { '*': 'all' } as unknown as Can
    for (const one of await board.grants()) if (one.id === 'g2') await board.revokeGrant('g2')
    await board.createGrant({ principals: [{ kind: 'project', project: 'prj_support', environments: ['production'] }], can: can as never })
    const support = caller(board.fetch, await deploymentToken('support', 'prj_support', 'production'))
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    return { support, julian: await julianOn(board.fetch) }
  }
  const imported = (text: string, mentioned: (typeof GRACE)[]) => ({ op: 'post', author: ADA, from: 'slack', channel: 'firehose', text, mentioned })

  it('names them as the project names its users: the same actor they are once they write', async () => {
    const { support, julian } = await team()
    expect((await support('POST', '/sync/imports', imported('cc @[slack:user:U_GRACE]', [GRACE]))).status).toBe(200)
    expect((await read(julian, 'firehose')).map((kept) => [kept.text, kept.by.actor])).toEqual([[`cc @[${SUPPORT}+slack:user:U_GRACE]`, `${SUPPORT}+slack:user:U_ADA`]])
    const known = Object.fromEntries((await actors(julian)).map((actor) => [actor.id, [actor.handle, actor.name]]))
    expect(known[`${SUPPORT}+slack:user:U_ADA`]).toEqual(['support/ada', 'Ada'])
    expect(known[`${SUPPORT}+slack:user:U_GRACE`]).toEqual(['support/grace', 'Grace Hopper'])
    // He writes: the message is by the actor the mention named.
    expect((await support('POST', '/sync/imports', { op: 'post', author: GRACE, from: 'slack', channel: 'firehose', text: 'here' })).status).toBe(200)
    expect((await read(julian, 'firehose')).at(-1)?.by.actor).toBe(`${SUPPORT}+slack:user:U_GRACE`)
  })

  it("introduces no one its text doesn't mention, and says who an edit now does", async () => {
    const { support, julian } = await team()
    const ids = async () => (await actors(julian)).map((actor) => actor.id)
    const made = await support('POST', '/sync/imports', { ...imported('nobody here', [GRACE]), origin: { thread: 'slack:C1:500', subthread: null, message: '500', context: null } })
    expect(made.status).toBe(200)
    expect(await ids()).not.toContain(`${SUPPORT}+slack:user:U_GRACE`)
    const edited = await support('POST', '/sync/imports', { op: 'edit', author: ADA, from: 'slack', origin: { thread: 'slack:C1:500', message: '500' }, text: 'cc @[slack:user:U_GRACE]', mentioned: [GRACE] })
    expect(edited.status).toBe(200)
    expect((await read(julian, 'firehose')).map((kept) => kept.text)).toEqual([`cc @[${SUPPORT}+slack:user:U_GRACE]`])
    expect(await ids()).toContain(`${SUPPORT}+slack:user:U_GRACE`)
  })

  it("keeps the board's record of someone it knows: a mention only introduces", async () => {
    const { support, julian } = await team()
    // Grace writes first, as his own message names him; then a mention of him says otherwise.
    expect((await support('POST', '/sync/imports', { op: 'post', author: GRACE, from: 'slack', channel: 'firehose', text: 'here' })).status).toBe(200)
    expect((await support('POST', '/sync/imports', imported('cc @[slack:user:U_GRACE]', [{ ...GRACE, handle: 'someone', name: 'Someone Else' }]))).status).toBe(200)
    expect((await actors(julian)).find((actor) => actor.id === `${SUPPORT}+slack:user:U_GRACE`)).toMatchObject({ handle: 'support/grace', name: 'Grace Hopper' })
  })

  it('keeps a mention as it came where the name the board gives it would outgrow a message, and still meets them', async () => {
    const { support, julian } = await team()
    // 10,000 characters as it came: the project's name in the ID would make it longer.
    const text = `${'x'.repeat(9_976)} @[slack:user:U_GRACE]`
    expect((await support('POST', '/sync/imports', imported(text, [GRACE]))).status).toBe(200)
    expect((await read(julian, 'firehose')).map((kept) => kept.text === text)).toEqual([true])
    expect((await actors(julian)).map((actor) => actor.id)).toContain(`${SUPPORT}+slack:user:U_GRACE`)
  })

  it("refuses to introduce anyone who isn't a user of the key it came through", async () => {
    const { support, julian } = await team()
    const foreign = { ...GRACE, id: 'vercel:user:julian' }
    const refused = await support('POST', '/sync/imports', imported('cc @[vercel:user:julian]', [foreign]))
    expect([refused.status, await read(julian, 'firehose')]).toEqual([403, []])
  })
})
