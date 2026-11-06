import { createServer } from 'experimental-a2/server'
import { memory as a2Memory } from 'experimental-a2/store-memory'
import { describe, expect, it, vi } from 'vitest'
import { boardContract } from '../src/contract/contract.ts'
import { BOARD_SESSION } from '../src/contract/events.ts'
// The engine itself, as a2() starts it.
import { mount as board } from './harness.ts'
import { createReads, tablesConsumer } from '../src/server/reads.ts'
import { waitUntil } from '../src/server/wait-until.ts'
import { sqlTables } from '../src/store/sql.ts'
import { sqliteDb } from '../src/store/sqlite-db.ts'
import { BOARD_URL, caller, PROJECT_ID, personToken, TEAM_ID, testAuth } from './harness.ts'

describe('list reads', () => {
  it('start the tables catching up from the log, and answer at once', async () => {
    // A log from before the tables: posts no tables consumer has read.
    const log = a2Memory()
    const earlier = createServer({ contract: boardContract, store: log }).session(BOARD_SESSION)
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null, session: null }
    for (const [n, text] of ['one', 'two', 'three'].entries()) {
      await earlier.append({
        id: `post-${n}`,
        type: 'message.posted',
        payload: { channel: 'dev', text, re: null, replyTo: null, thread: `post-${n}`, labels: {}, noSync: false, mentions: [], by, origin: null, from: null },
      })
    }

    // The deploy that adds them. Nothing appends or reads by ID, so only the list read can start them.
    const tables = sqlTables(sqliteDb(':memory:'))
    const deployed = board({
      store: { log, tables, close: () => tables.close() },
      url: BOARD_URL,
      auth: testAuth,
    })
    const reader = caller(deployed.fetch, await personToken())
    expect((await reader('GET', '/threads?channel=dev')).status).toBe(200)

    await vi.waitFor(async () => {
      const threads = await reader('GET', '/threads?channel=dev')
      expect(threads.body.threads.map((thread: { message: { text: string } }) => thread.message.text)).toEqual([
        'one',
        'two',
        'three',
      ])
    })
    expect(await tables.position()).toBe(3)
  })

  it('keep their catch-up running after the response on Vercel, and run it on elsewhere', async () => {
    const task = Promise.resolve()
    expect(() => waitUntil(task)).not.toThrow()
    const kept: Promise<unknown>[] = []
    const context = Symbol.for('@vercel/request-context')
    Reflect.set(globalThis, context, { get: () => ({ waitUntil: (task: Promise<unknown>) => void kept.push(task) }) })
    try {
      waitUntil(task)
    } finally {
      Reflect.deleteProperty(globalThis, context)
    }
    expect(kept).toHaveLength(1)
    expect(kept[0]).toBe(task)
  })

  it("keep the board session's place, whatever another session of its contract holds", async () => {
    const log = a2Memory()
    const tables = sqlTables(sqliteDb(':memory:'))
    const deployed = board({
      store: { log, tables, close: () => tables.close() },
      url: BOARD_URL,
      auth: testAuth,
    })
    const julian = caller(deployed.fetch, await personToken())
    await julian('POST', '/messages', { channel: 'dev', text: 'one' })
    const head = await tables.position()

    // Another session of the board's contract, further along, run through the same projection.
    const projection = tablesConsumer(tables)
    const other = createServer({ contract: boardContract, store: log, consumers: [projection] }).session('other')
    const by = { actor: 'vercel:user:u_other', principal: 'vercel:user:u_other', profile: null, session: null }
    for (let n = 0; n < head + 5; n += 1) {
      await other.append({
        id: `other-${n}`,
        type: 'message.posted',
        payload: { channel: 'dev', text: `other ${n}`, re: null, replyTo: null, thread: `other-${n}`, labels: {}, noSync: false, mentions: [], by, origin: null, from: null },
      })
    }
    await other.consume(projection)
    expect(await tables.position()).toBe(head)
    expect((await julian('POST', '/messages', { channel: 'dev', text: 'two' })).status).toBe(201)
    const listed = await julian('GET', '/messages?channel=dev')
    expect(listed.body.messages.map((m: { text: string }) => m.text)).toEqual(['one', 'two'])
  })
})

describe('reads by ID', () => {
  it("wait for the whole log on new tables, so a message shows what came after it", async () => {
    // A log from before the tables: a thread, a reply, then a reaction on the root.
    const log = a2Memory()
    const earlier = createServer({ contract: boardContract, store: log }).session(BOARD_SESSION)
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null, session: null }
    const post = (id: string, text: string, re: number | null) => ({
      id, type: 'message.posted' as const,
      payload: { channel: 'dev', text, re, replyTo: null, thread: 'root', labels: {}, noSync: false, mentions: [], by, origin: null, from: null },
    })
    await earlier.append(post('root', 'deploys are down', null))
    await earlier.append(post('reply', 'looking', 1))
    await earlier.append({ id: 'eyes', type: 'reaction.added', payload: { id: 1, thread: 'root', emoji: 'eyes', by, from: null } })

    const tables = sqlTables(sqliteDb(':memory:'))
    const deployed = board({
      store: { log, tables, close: () => tables.close() },
      url: BOARD_URL,
      auth: testAuth,
    })
    const reader = caller(deployed.fetch, await personToken())
    const { body } = await reader('GET', '/messages/1')
    expect(body.message.reactions).toEqual({ eyes: ['vercel:user:u_julian'] })
    expect(body.replies.map((reply: { text: string }) => reply.text)).toEqual(['looking'])
  })

  it('stop waiting for the catch-up when their signal aborts, and leave it running', async () => {
    // A catch-up that never finishes unless it's aborted.
    const consumes: (AbortSignal | undefined)[] = []
    const session = {
      consume: (_: unknown, options?: { signal?: AbortSignal }) => {
        consumes.push(options?.signal)
        return new Promise(() => {})
      },
    }
    const reads = createReads({ position: async () => 0 } as never, session as never, {} as never)
    const timeout = AbortSignal.timeout(50)
    await expect(reads.ensure(5, timeout)).rejects.toMatchObject({ name: 'TimeoutError' })
    // The whole-log catch-up isn't the caller's to stop: it ran without the caller's signal.
    expect(consumes).toEqual([undefined])
  })
})
