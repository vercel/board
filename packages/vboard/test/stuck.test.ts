import { describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './sync-fixtures.ts'
import { slack } from '../src/sync/slack.ts'
import { githubActions } from '../src/server/auth.ts'
import { memoryBlob, type BlobStore } from '../src/server/blob.ts'
import { formatStuck } from '../src/cli/format.ts'
import { BOARD_URL, caller, personToken, testBoard, workflowToken } from './harness.ts'

/** A board whose blob store is down until `up()`: a Slack file then can't come over, and its message dead-letters. */
function setup() {
  const s = fakePlatform('slack')
  const files = memoryBlob()
  let down = true
  const blob: BlobStore = {
    put: async (...args) => {
      if (down) throw new Error('blob store unavailable')
      return files.put(...args)
    },
    get: (key) => files.get(key),
  }
  const board = testBoard({
    blob,
    sync: { slack: slack({ adapter: s.adapter, channels: { C1: 'firehose' } }) },
    access: [githubActions({ repository: 'basehub-ai/www', workflow: '.github/workflows/deploy.yml', can: ['post'] })],
  })
  s.served.set('https://files.slack.test/shot.png', new Uint8Array([1, 2, 3]))
  const webhook = (body: unknown) =>
    board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const withFile = (threadId: string, id: string) =>
    webhook({ type: 'message', threadId, id, text: 'see shot', user: 'U1', files: [{ name: 'shot.png', mimeType: 'image/png', url: 'https://files.slack.test/shot.png', size: 3 }] })
  const inbox = board.servers[1]!
  /** Drains an inbox until A2 gives up on its event: 10 failures. */
  const deadLetter = async (call: ReturnType<typeof caller>, channel: string) =>
    vi.waitFor(async () => {
      await inbox.drain(`inbox:${channel}`)
      expect((await call('GET', '/stuck')).body.stuck).toHaveLength(1)
    }, { timeout: 10_000, interval: 5 })
  return { board, webhook, withFile, inbox, deadLetter, up: () => void (down = false) }
}

const texts = async (call: ReturnType<typeof caller>) =>
  ((await call('GET', '/messages?channel=firehose')).body.messages as { text: string }[]).map((m) => m.text)

describe('stuck events', () => {
  it('lists an event that stopped its thread, and retries it once the cause is fixed', async () => {
    const { board, webhook, withFile, deadLetter, up } = setup()
    const julian = caller(board.fetch, await personToken())
    expect((await julian('GET', '/stuck')).body).toEqual({ stuck: [] })

    await withFile('slack:C1:500.1', '500.1')
    await deadLetter(julian, 'slack:C1')
    // The thread's next message waits behind it.
    await webhook({ type: 'message', threadId: 'slack:C1:500.1', id: '500.2', text: 'any luck?', user: 'U1' })
    const [stuck] = (await julian('GET', '/stuck')).body.stuck
    expect(stuck).toMatchObject({
      session: 'inbox:slack:C1',
      type: 'external.received',
      lane: 'thread:slack:C1:500.1',
      thread: null, // it never reached the board
      root: null,
      external: 'slack:C1:500.1',
      failures: 10,
      error: expect.stringContaining('blob store unavailable'),
    })
    expect(await texts(julian)).toEqual([])
    expect(formatStuck(stuck, Date.parse(stuck.failedAt) + 120_000)).toBe(
      `inbox:slack:C1#${stuck.index}  external.received  slack:C1:500.1  failed 10× · stopped 2m ago\n    ${stuck.error.split('\n')[0]}`,
    )

    up()
    expect((await julian('POST', '/stuck/redrive', { session: 'inbox:slack:C1', index: stuck.index, action: 'retry' })).body).toEqual({ redriven: true })
    // It lands, and then the message that waited behind it.
    await vi.waitFor(async () => expect(await texts(julian)).toEqual(['see shot', 'any luck?']))
    expect((await julian('GET', '/stuck')).body).toEqual({ stuck: [] })
    // Redriving what isn't stuck anymore does nothing.
    expect((await julian('POST', '/stuck/redrive', { session: 'inbox:slack:C1', index: stuck.index, action: 'retry' })).body).toEqual({ redriven: false })
  })

  it('skips an event so the rest of its thread goes on', async () => {
    const { board, webhook, withFile, deadLetter } = setup()
    const julian = caller(board.fetch, await personToken())
    await webhook({ type: 'message', threadId: 'slack:C1:700.1', id: '700.1', text: 'root', user: 'U1' })
    await vi.waitFor(async () => expect(await texts(julian)).toEqual(['root']))
    await withFile('slack:C1:700.1', '700.2')
    await deadLetter(julian, 'slack:C1')
    await webhook({ type: 'message', threadId: 'slack:C1:700.1', id: '700.3', text: 'after', user: 'U1' })

    const [stuck] = (await julian('GET', '/stuck')).body.stuck
    const { body } = await julian('GET', '/messages?channel=firehose')
    // The thread is on the board now, so the stuck event names it.
    expect(stuck).toMatchObject({ thread: expect.any(String), root: body.messages[0].id, external: 'slack:C1:700.1' })
    expect((await julian('POST', '/stuck/redrive', { session: stuck.session, index: stuck.index, action: 'skip' })).body).toEqual({ redriven: true })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${stuck.root}`)).body.replies.map((r: { text: string }) => r.text)).toEqual(['after']))
  })

  it("finds a synced thread's inbox outside the mapped channels", async () => {
    const { board, withFile, deadLetter } = setup()
    const julian = caller(board.fetch, await personToken())
    const { body: root } = await julian('POST', '/messages', { channel: 'firehose', text: 'incident', noSync: true })
    expect((await julian('POST', `/messages/${root.message.id}/sync`, { target: 'slack:C9:900.1' })).status).toBe(200)

    await withFile('slack:C9:900.1', '900.2')
    await deadLetter(julian, 'slack:C9')
    expect((await julian('GET', '/stuck')).body.stuck[0]).toMatchObject({ session: 'inbox:slack:C9', root: root.message.id })
  })

  it('needs manage, and only redrives sessions the board has', async () => {
    const { board } = setup()
    const workflow = caller(board.fetch, await workflowToken())
    for (const [method, path, body] of [['GET', '/stuck'], ['POST', '/stuck/redrive', { session: 'board', index: 1, action: 'skip' }]] as const) {
      const denied = await workflow(method, path, body)
      expect(denied.status).toBe(403)
      expect(denied.body.error.message).toContain('needs manage on every channel')
    }
    const julian = caller(board.fetch, await personToken())
    expect((await julian('POST', '/stuck/redrive', { session: 'elsewhere', index: 1, action: 'skip' })).status).toBe(404)
    expect((await julian('POST', '/stuck/redrive', { session: 'board', index: 0, action: 'skip' })).status).toBe(400)
  })
})
