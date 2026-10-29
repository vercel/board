import { createServer } from 'experimental-a2/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULES_SESSION, schedulesContract } from '../src/contract/contract.ts'
import { memory } from '../src/store/memory.ts'
import { caller, personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-07T12:00:00.000Z')

/** A caller with a fresh token each time, since the clock jumps days past a token's hour. */
const fresh =
  (handler: (request: Request) => Promise<Response>, user: string, headers: Record<string, string>) =>
  async (method: string, path: string, body?: unknown) =>
    caller(handler, await personToken(user), headers)(method, path, body)

async function setup() {
  const queue = fakeQueue()
  const board = testBoard({ scheduler: queue.scheduler })
  const julian = fresh(board.fetch, 'u_julian', { 'x-board-handle': 'julian' })
  const pi = fresh(board.fetch, 'u_pi', { 'x-board-handle': 'pi' })
  const root = (await julian('POST', '/messages', { channel: 'dev', text: 'PR #12: add schedules' })).body.message
  const replies = async () => (await julian('GET', `/messages/${root.id}`)).body.replies as { text: string; by: { actor: string }; schedule?: unknown }[]
  /** Moves the clock, then lets the queue deliver what's due and the board settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const advance = async (ms: number) => {
    await settle()
    vi.setSystemTime(Date.now() + ms)
    await queue.fire()
    await settle()
  }
  return { board, queue, julian, pi, root, replies, advance }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

describe('scheduled messages', () => {
  it('reply once, later, as whoever scheduled them', async () => {
    const { julian, pi, root, replies, advance } = await setup()
    await pi('GET', '/me')
    await pi('POST', '/messages', { re: root.id, text: 'on it' })
    const { status, body } = await julian('POST', '/schedules', { re: root.id, text: '@pi is the PR still open?', in: '1d' })
    expect(status).toBe(201)
    expect(body.schedule).toMatchObject({ state: 'pending', re: root.id, next: new Date(T0 + DAY).toISOString(), sent: 0 })

    // `vb read` lists what's pending in the thread.
    expect((await julian('GET', `/messages/${root.id}`)).body.schedules).toMatchObject([{ id: body.schedule.id, text: '@pi is the PR still open?' }])
    await advance(DAY - MINUTE)
    expect(await replies()).toHaveLength(1)

    await advance(MINUTE)
    const sent = (await replies()).slice(1)
    expect(sent).toMatchObject([{ text: '@pi is the PR still open?', by: { actor: root.by.actor }, schedule: { id: body.schedule.id, n: 0 } }])
    expect((await julian('GET', `/messages/${root.id}`)).body.schedules).toEqual([])
    expect((await julian('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'done', sent: 1 }])
  })

  it('repeat every 30m until they reach `times`, skipping slots missed while down', async () => {
    const { julian, root, replies, advance } = await setup()
    await julian('POST', '/schedules', { re: root.id, text: 'check prod', every: '30m', times: 3 })
    await advance(30 * MINUTE)
    expect(await replies()).toHaveLength(1)
    // Down for 2h: one send when it's back, not four.
    await advance(2 * HOUR)
    expect(await replies()).toHaveLength(2)
    const [pending] = (await julian('GET', '/schedules')).body.schedules
    expect(pending.next).toBe(new Date(T0 + 3 * HOUR).toISOString())
    await advance(30 * MINUTE)
    expect((await replies()).map((m) => m.schedule)).toEqual([0, 1, 2].map((n) => ({ id: pending.id, n })))
    await advance(DAY)
    expect(await replies()).toHaveLength(3)
    expect((await julian('GET', '/schedules?all=1')).body.schedules[0].state).toBe('done')
  })

  it('repeat until canceled when they have no stop, and manage may cancel any of them', async () => {
    const { julian, pi, root, replies, advance } = await setup()
    const { body } = await julian('POST', '/schedules', { re: root.id, text: 'still monitoring?', every: '30m' })
    for (let i = 0; i < 5; i++) await advance(30 * MINUTE)
    expect(await replies()).toHaveLength(5)

    const canceled = await pi('POST', `/schedules/${body.schedule.id}/cancel`, {})
    expect(canceled.body.canceled).toBe(true)
    expect(canceled.body.schedule).toMatchObject({ state: 'canceled', next: null, canceled: { reason: 'canceled' } })
    // The timer already armed fires into nothing.
    await advance(30 * MINUTE)
    await advance(DAY)
    expect(await replies()).toHaveLength(5)
    expect((await pi('POST', `/schedules/s${body.schedule.id}/cancel`, {})).body).toMatchObject({ canceled: false })
  })

  it('stop repeating after `for`, counted from the first send', async () => {
    const { julian, root, replies, advance } = await setup()
    await julian('POST', '/schedules', { re: root.id, text: 'ping', in: '1h', every: '1h', for: '2h' })
    for (let i = 0; i < 6; i++) await advance(HOUR)
    expect(await replies()).toHaveLength(3)
  })

  it('start new threads when scheduled in a channel', async () => {
    const { julian, advance } = await setup()
    await julian('POST', '/schedules', { channel: 'standup', text: 'standup time', at: new Date(T0 + HOUR).toISOString(), labels: { kind: 'standup' } })
    await advance(HOUR)
    const { body } = await julian('GET', '/messages?channel=standup')
    expect(body.messages).toMatchObject([{ text: 'standup time', re: null, labels: { kind: 'standup' } }])
  })

  it('keep sending after a deploy: a timer an earlier deployment armed goes only to it', async () => {
    // A schedule from before, whose first send waits on the earlier deployment's queue.
    const store = memory()
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null, session: null }
    await createServer({ contract: schedulesContract, store: store.log }).session(SCHEDULES_SESSION).append({
      type: 'schedule.created',
      payload: {
        channel: 'dev', re: null, text: 'standup', labels: {}, noSync: false, first: T0 + HOUR, every: DAY, until: null, times: null,
        as: {
          author: by,
          principal: { id: by.principal, kind: 'person', handle: 'julian' },
          actor: { id: by.actor, kind: 'person', handle: 'julian', name: 'Julian', avatar: null },
        },
      },
    })
    const queue = fakeQueue()
    const board = testBoard({ store, scheduler: queue.scheduler })
    const julian = fresh(board.fetch, 'u_julian', { 'x-board-handle': 'julian' })

    // Any request starts this deployment arming it again.
    await julian('GET', '/me')
    await vi.waitFor(() => expect(queue.timers).toHaveLength(1))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await vi.waitFor(async () => {
      const { body } = await julian('GET', '/messages?channel=dev')
      expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['standup'])
    })
    expect((await julian('GET', '/schedules')).body.schedules).toMatchObject([{ sent: 1, next: new Date(T0 + HOUR + DAY).toISOString() }])
  })

  it('keep sending after a deploy when a schedule has already sent: its next send is armed, not its first', async () => {
    // A daily schedule from before that sent once, its second send waiting on the earlier deployment's queue.
    const store = memory()
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null, session: null }
    const before = createServer({ contract: schedulesContract, store: store.log }).session(SCHEDULES_SESSION)
    await before.append({
      type: 'schedule.created',
      payload: {
        channel: 'dev', re: null, text: 'standup', labels: {}, noSync: false, first: T0 + HOUR, every: DAY, until: null, times: null,
        as: {
          author: by,
          principal: { id: by.principal, kind: 'person', handle: 'julian' },
          actor: { id: by.actor, kind: 'person', handle: 'julian', name: 'Julian', avatar: null },
        },
      },
    })
    await before.append({ type: 'schedule.fired', payload: { id: 1, n: 0, message: 1, next: T0 + HOUR + DAY } })
    const queue = fakeQueue()
    const board = testBoard({ store, scheduler: queue.scheduler })
    const julian = fresh(board.fetch, 'u_julian', { 'x-board-handle': 'julian' })

    await julian('GET', '/me')
    await vi.waitFor(() => expect(queue.timers).toHaveLength(1))
    vi.setSystemTime(T0 + HOUR + DAY)
    await queue.fire()
    await vi.waitFor(async () => {
      const { body } = await julian('GET', '/messages?channel=dev')
      expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['standup'])
    })
    expect((await julian('GET', '/schedules')).body.schedules).toMatchObject([{ sent: 2, next: new Date(T0 + HOUR + 2 * DAY).toISOString() }])
  })

  it('move to each new deployment on its first request: the earlier one stops sending', async () => {
    const store = memory()
    const deploy = (id: string) => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', id)
      const queue = fakeQueue()
      const deployed = testBoard({ store, scheduler: queue.scheduler })
      vi.unstubAllEnvs()
      return { queue, julian: fresh(deployed.fetch, 'u_julian', { 'x-board-handle': 'julian' }) }
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const before = deploy('dpl_before')
    await before.julian('POST', '/schedules', { channel: 'dev', text: 'standup', in: '1h', every: '1d' })
    const after = deploy('dpl_after')
    await after.julian('GET', '/me')
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))
    const standups = async () => (await after.julian('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)

    vi.setSystemTime(T0 + HOUR)
    await before.queue.fire()
    await settle()
    expect(await standups()).toEqual([])
    expect(await after.queue.fire()).toBe(1)
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup']))
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))

    vi.setSystemTime(T0 + HOUR + DAY)
    await before.queue.fire()
    expect(await after.queue.fire()).toBe(1)
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup', 'standup']))
    await settle()
    expect(await standups()).toEqual(['standup', 'standup'])
  })

  it("send when the earlier deployment's timer for the same send lands at the same moment", async () => {
    const store = memory()
    const deploy = (id: string) => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', id)
      const queue = fakeQueue()
      const deployed = testBoard({ store, scheduler: queue.scheduler })
      vi.unstubAllEnvs()
      return { queue, julian: fresh(deployed.fetch, 'u_julian', { 'x-board-handle': 'julian' }) }
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const before = deploy('dpl_before')
    await before.julian('POST', '/schedules', { channel: 'dev', text: 'standup', in: '1h', every: '1d' })
    const after = deploy('dpl_after')
    await after.julian('GET', '/me')
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))
    const standups = async () => (await after.julian('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)

    // Both queues deliver the send together, the earlier deployment's first: its run mustn't take the later one's.
    vi.setSystemTime(T0 + HOUR)
    await Promise.all([before.queue.fire(), after.queue.fire()])
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup']))
    await settle()
    expect(await standups()).toEqual(['standup'])
  })

  it("stay on the newest deployment when an earlier one's timer starts a fresh instance there", async () => {
    const store = memory()
    const deploy = (id: string, queue = fakeQueue()) => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', id)
      const deployed = testBoard({ store, scheduler: queue.scheduler })
      vi.unstubAllEnvs()
      return { queue, scheduler: deployed.scheduler, julian: fresh(deployed.fetch, 'u_julian', { 'x-board-handle': 'julian' }) }
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const before = deploy('dpl_before')
    await before.julian('POST', '/schedules', { channel: 'dev', text: 'standup', in: '1h', every: '1d' })
    const after = deploy('dpl_after')
    await after.julian('GET', '/me')
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))
    const standups = async () => (await after.julian('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)

    // Nobody visits the earlier deployment any more: its own timer cold-starts an instance there, through the scheduler route.
    const revived = deploy('dpl_before', before.queue)
    vi.setSystemTime(T0 + HOUR)
    await before.queue.fire(revived.scheduler)
    await settle()
    await before.queue.fire(revived.scheduler)
    await settle()
    expect(await standups()).toEqual([])

    // The later deployment still sends once, and keeps the next one.
    await before.queue.fire(revived.scheduler)
    await after.queue.fire()
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup']))
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))
    await settle()
    expect(await standups()).toEqual(['standup'])
    expect(before.queue.timers).toEqual([])
  })

  it('wait out more than a queue can delay in hops', async () => {
    const { julian, queue, root, replies, advance } = await setup()
    await julian('POST', '/schedules', { re: root.id, text: 'a week later', in: '8d' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(Math.max(...queue.timers.map((t) => t.dueAt))).toBeLessThanOrEqual(T0 + 5 * DAY)
    await advance(5 * DAY)
    expect(await replies()).toEqual([])
    await advance(3 * DAY)
    expect(await replies()).toMatchObject([{ text: 'a week later' }])
  })

  it('end when the thread they reply in is deleted', async () => {
    const { julian, root, advance } = await setup()
    await julian('POST', '/schedules', { re: root.id, text: 'ping', every: '1h' })
    await julian('POST', `/messages/${root.id}/delete`, {})
    await advance(HOUR)
    expect((await julian('GET', '/schedules?all=1')).body.schedules).toMatchObject([
      { state: 'canceled', sent: 0, canceled: { reason: 'thread_deleted' } },
    ])
  })

  it('refuse what they cannot do', async () => {
    const { julian, root } = await setup()
    const refused = async (body: object) => (await julian('POST', '/schedules', { re: root.id, text: 'x', ...body })).body.error.message
    expect(await refused({})).toContain('say when')
    expect(await refused({ in: '1h', times: 2 })).toContain('add `every`')
    expect(await refused({ every: '10s' })).toContain('at least 1m')
    expect(await refused({ at: '2020-01-01T00:00:00Z' })).toContain('in the past')
    expect(await refused({ every: '1h', times: 2, for: '1d' })).toContain('pick one stop')
    expect(await refused({ in: 'tomorrow' })).toContain('durations look like')
    // Times past what a Date holds would be stored and then break every listing.
    expect(await refused({ in: '100000001d' })).toContain('at most a year out')
    expect(await refused({ in: '1m', every: '1h', for: '100000001d' })).toContain('at most a year out')
    expect(await refused({ every: '100000001d' })).toContain('at most a year')
    expect((await julian('GET', '/schedules?all=1')).status).toBe(200)
    const unknown = await julian('POST', '/schedules', { channel: 'dev', in: '1h', text: 'hey @nobody' })
    expect(unknown).toMatchObject({ status: 201, body: { unknownMentions: ['nobody'] } })

    const plain = caller(testBoard().fetch, await personToken())
    const { body: thread } = await plain('POST', '/messages', { channel: 'dev', text: 'hi' })
    const noScheduler = await plain('POST', '/schedules', { re: thread.message.id, text: 'later', in: '1h' })
    expect(noScheduler).toMatchObject({ status: 501, body: { error: { code: 'no_scheduler' } } })
  })
})
