import { Redis } from 'ioredis'
import { afterAll, describe, expect, it, vi } from 'vitest'
// The engine itself, as a2() starts it.
import { mount as board } from './harness.ts'
import { redis } from '../src/store/redis.ts'
import type { BoardStore } from '../src/store/types.ts'
import { BOARD_URL, caller, PROJECT_ID, personToken, TEAM_ID, testAuth } from './harness.ts'

// The production shape: A2's Redis store and vboard's tables on one real Redis, under one prefix.
// Runs when TEST_REDIS_URL points at a server (CI has one).
const url = process.env.TEST_REDIS_URL

describe.skipIf(!url)('vboard on Redis', () => {
  const prefix = `vboard_test_${process.pid}_${Date.now()}`
  const stores: BoardStore[] = []

  afterAll(async () => {
    for (const store of stores) await store.close()
    const client = new Redis(url!)
    const keys = await client.keys(`${prefix}*`)
    if (keys.length > 0) await client.del(...keys)
    client.disconnect()
  })

  it('posts, replies, labels, and reads back from its tables', async () => {
    const store = redis({ url: url!, keyPrefix: `${prefix}a` })
    stores.push(store)
    const mounted = board({ store, url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: testAuth })
    const julian = caller(mounted.fetch, await personToken())
    const root = await julian('POST', '/messages', { channel: 'dev', text: 'Deploy is red', labels: { kind: 'bug' } })
    expect(root.status).toBe(201)
    const id = root.body.message.id as string
    await julian('POST', '/messages', { re: id, text: 'looking' })
    await julian('POST', '/messages', { re: id, text: 'fixed' })
    await julian('POST', `/messages/${id}/labels`, { set: { status: 'done' } })

    // A write's own read sees it at once: the tables are caught up before it answers.
    const thread = await julian('GET', `/messages/${id}`)
    expect(thread.body.message.labels).toEqual({ kind: 'bug', status: 'done' })
    expect(thread.body.replies.map((reply: { text: string }) => reply.text)).toEqual(['looking', 'fixed'])

    // A reply matches its root's labels.
    const filtered = await julian('GET', '/messages?label=status=done&text=fix')
    expect(filtered.body.messages.map((m: { text: string }) => m.text)).toEqual(['fixed'])
    const threads = await julian('GET', '/threads?channel=dev')
    expect(threads.body.threads).toEqual([expect.objectContaining({ replies: 2, last: expect.objectContaining({ text: 'fixed' }) })])
    expect(Number(threads.body.cursor)).toBeGreaterThanOrEqual(Number(id))
  })

  it('shares a client it was given between A2 and the tables', async () => {
    const client = new Redis(url!)
    const shared = redis({ client, keyPrefix: `${prefix}b` })
    const mounted = board({ store: shared, url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: testAuth })
    const julian = caller(mounted.fetch, await personToken())
    const root = await julian('POST', '/messages', { channel: 'pool', text: 'one client' })
    await julian('POST', '/messages', { re: root.body.message.id, text: 'for both' })
    const thread = await julian('GET', `/messages/${root.body.message.id}`)
    expect(thread.body.replies.map((reply: { text: string }) => reply.text)).toEqual(['for both'])
    expect(await client.exists(`${prefix}b:vboard:m`)).toBe(1)
    await shared.close()
    await vi.waitFor(() => expect(client.status).toBe('end'))
  })
})
