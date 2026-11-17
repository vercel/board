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
  const julian = fresh(board.fetch, 'u_julian', {})
  const pi = fresh(board.fetch, 'u_pi', {})
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
  it('wake the watcher that scheduled them, which none of its other writes do', async () => {
    const queue = fakeQueue()
    const ran: [type: string, text: string][] = []
    /** How many of the watcher's runs have returned. */
    let returned = 0
    const board = testBoard({
      scheduler: queue.scheduler,
      watch: {
        ci: {
          tail: 'dev',
          run: async ({ event, board: own }) => {
            ran.push([event.type, event.message!.text])
            try {
              if (event.type !== 'message.posted') return
              // For anything but its check-in, it asks to be woken later.
              if (!event.message!.schedule) return void (await own.schedule({ re: event.message!.id }, { text: 'check on CI', in: '5m' }))
              await own.react(event.message!.id, 'eyes')
              await own.reply(event.message!.id, 'still red')
            } finally {
              returned += 1
            }
          },
        },
      },
    })
    const julian = fresh(board.fetch, 'u_julian', {})
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const root = (await julian('POST', '/messages', { channel: 'dev', text: 'the build is red' })).body.message
    // The clock moves past the check-in only once the watcher's first run has returned and the board
    // has recorded it: under a run still in flight, a jump makes the board take it for dead and run it again.
    while (returned < 1) await settle()
    await settle()
    expect(ran).toEqual([['message.posted', 'the build is red']])
    vi.setSystemTime(Date.now() + 5 * MINUTE)
    const replies = async () => (await julian('GET', `/messages/${root.id}`)).body.replies as { text: string; by: { actor: string } }[]
    // The schedule shows before the queue holds its timer, so one fire could find nothing due: fire
    // until the watcher has answered its check-in, or for 3 seconds, so a watcher that never runs fails below.
    for (const giveUp = performance.now() + 3_000; (await replies()).length < 2 && performance.now() < giveUp; ) {
      await queue.fire()
      await settle()
    }
    await settle()
    expect((await replies()).map((reply) => [reply.text, reply.by.actor])).toEqual([
      ['check on CI', 'board:watch:ci'],
      ['still red', 'board:watch:ci'],
    ])
    // It ran on its check-in, and on nothing it then wrote: not its reaction to the check-in, nor its reply.
    expect(ran).toEqual([
      ['message.posted', 'the build is red'],
      ['message.posted', 'check on CI'],
    ])
  })

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
    expect((await julian('GET', '/schedules?all=false')).body.schedules).toEqual([])
    expect((await julian('GET', '/schedules?all=yes')).status).toBe(400)
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
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null }
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
    const julian = fresh(board.fetch, 'u_julian', {})

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

  it("send one made before handles were checked as what verified its creator, not the name its creator's client sent", async () => {
    // A board from before kept the actor a person's CLI named: any handle and name it chose.
    const store = memory()
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null }
    const before = createServer({ contract: schedulesContract, store: store.log }).session(SCHEDULES_SESSION)
    await before.append({
      type: 'schedule.created',
      payload: {
        channel: 'dev', re: null, text: 'from the CEO', labels: {}, noSync: false, first: T0 + HOUR, every: null, until: null, times: null,
        as: {
          author: by,
          principal: { id: by.principal, kind: 'person', handle: 'u_julian' },
          actor: { id: by.actor, kind: 'person', handle: 'ceo', name: 'The CEO', avatar: 'https://example.com/ceo.png' },
        },
      },
    })
    const queue = fakeQueue()
    const board = testBoard({ store, scheduler: queue.scheduler })
    const julian = fresh(board.fetch, 'u_julian', {})
    await julian('GET', '/me')
    await vi.waitFor(() => expect(queue.timers).toHaveLength(1))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=dev')).body.messages).toHaveLength(1))
    const [sent] = (await julian('GET', '/messages?channel=dev')).body.messages
    expect(sent.author).toEqual({ kind: 'person', handle: 'u_julian', name: 'u_julian', avatar: null, verified: true })
  })

  it('stop one made with a board token, from when boards issued them, at its next send', async () => {
    const store = memory()
    const by = { actor: 'vercel:user:u_julian+helper', principal: 'vercel:user:u_julian', profile: 'helper' }
    await createServer({ contract: schedulesContract, store: store.log }).session(SCHEDULES_SESSION).append({
      type: 'schedule.created',
      payload: {
        channel: 'dev', re: null, text: 'standup', labels: {}, noSync: false, first: T0 + HOUR, every: DAY, until: null, times: null,
        as: {
          author: by,
          principal: { id: by.principal, kind: 'person', handle: 'julian', scope: '*=read,post', token: 't12' },
          actor: { id: by.actor, kind: 'agent', handle: 'julian/helper', name: 'helper', avatar: null },
        },
      },
    })
    const queue = fakeQueue()
    const board = testBoard({ store, scheduler: queue.scheduler })
    const julian = fresh(board.fetch, 'u_julian', {})
    await julian('GET', '/me')
    await vi.waitFor(() => expect(queue.timers).toHaveLength(1))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await vi.waitFor(async () => expect((await julian('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ sent: 0, state: 'canceled', canceled: { reason: 'revoked' } }]))
    expect((await julian('GET', '/messages?channel=dev')).body.messages).toEqual([])
  })

  it('keep sending after a deploy when a schedule has already sent: its next send is armed, not its first', async () => {
    // A daily schedule from before that sent once, its second send waiting on the earlier deployment's queue.
    const store = memory()
    const by = { actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null }
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
    const julian = fresh(board.fetch, 'u_julian', {})

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
      return { queue, julian: fresh(deployed.fetch, 'u_julian', {}) }
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
      return { queue, julian: fresh(deployed.fetch, 'u_julian', {}) }
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
      return { queue, scheduler: deployed.scheduler, julian: fresh(deployed.fetch, 'u_julian', {}) }
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

  it("send from the newest deployment when a scheduler brings an earlier one's timer there", async () => {
    const store = memory()
    const deploy = (id: string) => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', id)
      const queue = fakeQueue()
      const deployed = testBoard({ store, scheduler: queue.scheduler })
      vi.unstubAllEnvs()
      return { queue, scheduler: deployed.scheduler, julian: fresh(deployed.fetch, 'u_julian', {}) }
    }
    const before = deploy('dpl_before')
    await before.julian('POST', '/schedules', { channel: 'dev', text: 'standup', in: '1h', every: '1d' })
    const after = deploy('dpl_after')
    await after.julian('GET', '/me')
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))
    const standups = async () => (await after.julian('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)

    // A scheduler that delivers to one URL, the production alias, as qstash does.
    vi.setSystemTime(T0 + HOUR)
    await before.queue.fire(after.scheduler)
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup']))
  })

  it('arm a send more than a hop out once, however many instances take over', async () => {
    const store = memory()
    const queue = fakeQueue()
    const instance = () => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_after')
      const deployed = testBoard({ store, scheduler: queue.scheduler })
      vi.unstubAllEnvs()
      return fresh(deployed.fetch, 'u_julian', {})
    }
    const first = instance()
    // The first instance takes over before the schedule exists. Its first call starts the takeover
    // without waiting for it, and a takeover that reads the schedules after one was created arms
    // its send again, under the takeover's name, beside the timer its creation armed.
    await first('GET', '/me')
    const takeovers = async () => (await store.log.read(`board-schedules\u001f${SCHEDULES_SESSION}`)).filter((e) => e.type === 'schedule.takeover')
    await vi.waitFor(async () => expect(await takeovers()).toHaveLength(1))
    await first('POST', '/schedules', { channel: 'dev', text: 'a week later', in: '8d' })
    await vi.waitFor(() => expect(queue.timers).toHaveLength(1))
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    // The next instance arms it again under the takeover's name, which every instance after it shares.
    vi.setSystemTime(T0 + MINUTE)
    await instance()('GET', '/me')
    await vi.waitFor(() => expect(queue.timers).toHaveLength(2))
    vi.setSystemTime(T0 + 2 * MINUTE)
    await instance()('GET', '/me')
    await settle()
    expect(queue.timers).toHaveLength(2)
  })

  it('send one created on the newest deployment when an earlier one catches up on it first', async () => {
    const store = memory()
    const deploy = (id: string, drains = true) => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', id)
      const queue = fakeQueue()
      // Without `drains`, the schedules session waits for another deployment to drain it.
      const scheduler: typeof queue.scheduler = {
        ...queue.scheduler,
        schedule: async (task) => (drains || task.kind !== 'drain' || task.sessionId !== 'schedules' ? queue.scheduler.schedule(task) : undefined),
      }
      const deployed = testBoard({ store, scheduler })
      vi.unstubAllEnvs()
      return { queue, deployed, julian: fresh(deployed.fetch, 'u_julian', {}) }
    }
    const before = deploy('dpl_before')
    await before.julian('GET', '/me')
    const after = deploy('dpl_after', false)
    await after.julian('GET', '/me')
    await after.julian('POST', '/schedules', { channel: 'dev', text: 'standup', in: '1h' })
    await before.deployed.servers[2]!.drain('schedules')
    const standups = async () => (await after.julian('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)

    vi.setSystemTime(T0 + HOUR)
    await before.queue.fire()
    await after.queue.fire()
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup']))
  })

  it('keep repeating when arming the next send failed after one went out', async () => {
    const queue = fakeQueue()
    // The queue refuses the second send's timer once, as if it were down for a moment.
    let refused = false
    const scheduler: typeof queue.scheduler = {
      ...queue.scheduler,
      schedule: async (task) => {
        const due = task.kind === 'append' ? (task.events[0]?.payload as { n?: number } | undefined) : undefined
        if (!refused && due?.n === 1) {
          refused = true
          throw new Error('queue unavailable')
        }
        return queue.scheduler.schedule(task)
      },
    }
    const board = testBoard({ scheduler })
    const julian = fresh(board.fetch, 'u_julian', {})
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    await julian('POST', '/schedules', { channel: 'dev', text: 'standup', in: '1h', every: '1d' })
    const standups = async () => (await julian('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup']))
    await vi.waitFor(() => expect(refused).toBe(true))

    // The failed attempt runs again, and arms the next send this time.
    await vi.waitFor(async () => {
      await board.skipHold(board.servers[2]!, 'schedules')
      await board.servers[2]!.drain('schedules')
      expect(queue.timers.map((t) => (t.events[0]!.payload as { n: number }).n)).toContain(1)
    })
    vi.setSystemTime(T0 + HOUR + DAY)
    await queue.fire()
    await vi.waitFor(async () => expect(await standups()).toEqual(['standup', 'standup']))
    await settle()
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

  it('send a text as it was settled when the schedule was made: a handle that mentioned no one then mentions no one later', async () => {
    const { julian, pi, root, replies, advance } = await setup()
    // A Vercel login's handle is its user ID, and Pi hasn't written: no one goes by u_pi yet.
    const made = await julian('POST', '/schedules', { re: root.id, in: '1h', text: 'standup, @u_pi' })
    expect(made.body.mentions).toEqual([{ written: '@u_pi', actor: null, candidates: [] }])
    await pi('POST', '/messages', { channel: 'dev', text: 'hi' })
    await advance(3_600_000)
    expect((await replies()).map((reply) => reply.text)).toEqual(['standup, @u_pi'])
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
    // A handle no one has is no reason to refuse: it's kept as typed, and the answer says it mentions no one.
    const unknown = await julian('POST', '/schedules', { channel: 'dev', in: '1h', text: 'hey @nobody and @[vercel:user:u_nobody]' })
    expect([unknown.status, unknown.body.schedule.text, unknown.body.mentions]).toEqual([201, 'hey @nobody and @[vercel:user:u_nobody]', [{ written: '@nobody', actor: null, candidates: [] }]])

    const plain = caller(testBoard().fetch, await personToken())
    const { body: thread } = await plain('POST', '/messages', { channel: 'dev', text: 'hi' })
    const noScheduler = await plain('POST', '/schedules', { re: thread.message.id, text: 'later', in: '1h' })
    expect(noScheduler).toMatchObject({ status: 501, body: { error: { code: 'no_scheduler' } } })
  })
})
