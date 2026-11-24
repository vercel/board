import { describe, expect, it } from 'vitest'
import type { MessageView, TaskView } from '../src/api/routes.ts'
import * as store from '../src/inspect/app/store.ts'
import { BLOCK, BUBBLE_MS, fitted, GONE_MS, IDLE_MS, sizeOf, spiral, townOf } from '../src/inspect/app/town.ts'

const ME = 'vercel:user:u_julian'
const ADA = 'vercel:user:u_ada'
const FX = 'vercel:user:u_ada+fx'
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

function message(id: number, by: string, channel: string, overrides: Partial<MessageView> = {}): MessageView {
  const principal = by.split('+')[0]!
  return {
    id: String(id),
    version: id,
    revision: id,
    channel,
    text: `message ${id}`,
    re: null,
    replyTo: null,
    thread: `t${id}`,
    labels: {},
    reactions: {},
    by: { actor: by, principal, profile: by.includes('+') ? by.split('+')[1]! : null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: ago(10 * 60_000),
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: null,
    ...overrides,
  } as MessageView
}

const task = (overrides: Partial<TaskView>): TaskView => ({ state: 'ready', owner: ADA, by: ADA, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null, ...overrides }) as TaskView

function stateOf(channels: string[], messages: MessageView[]): store.State {
  return {
    ...store.initialState,
    me: { actor: ME } as store.State['me'],
    channels: Object.fromEntries(channels.map((path) => [path, { path }])),
    messages: Object.fromEntries(messages.map((m) => [m.id, m])),
  }
}

const where = (town: ReturnType<typeof townOf>, actor: string) => town.residents.find((r) => r.actor === actor)

/** A thread: a root and a reply to it, both by `by`, written at once. */
const discussion = (id: number, by: string, channel: string, overrides: Partial<MessageView> = {}) => [
  message(id, by, channel, overrides),
  message(id + 1000, by, channel, { ...overrides, text: 'a reply', re: String(id) }),
]

describe('boardville', () => {
  it('puts each district on blocks of its own: the main street in the middle, wrapping rows within a block', () => {
    const channels = ['www/production', 'dev', 'www/errors', 'deploys', 'www/preview']
    // Three threads in each: standard houses, two to a row across a block.
    const threads = channels.flatMap((channel, c) => [1, 2, 3].flatMap((n) => discussion(c * 10 + n, ADA, channel)))
    const town = townOf(stateOf(channels, threads), NOW)
    expect(town.streets.map((s) => s.name)).toEqual(['main street', 'www'])
    expect(town.blocks.map((b) => b.district)).toEqual(['main street', 'www'])
    const house = (channel: string) => town.houses.find((h) => h.channel === channel)!
    const blockOf = (channel: string) => town.blocks.find((b) => house(channel).x >= b.x && house(channel).x < b.x + BLOCK.width && house(channel).y >= b.y && house(channel).y < b.y + b.depth)!
    // The main street is on the middle block.
    expect(blockOf('dev')).toMatchObject({ x: 0, y: 0, district: 'main street' })
    expect(blockOf('www/errors').district).toBe('www')
    expect(house('deploys').y).toBe(house('dev').y)
    // A third house on a full row goes on the block's next row, under the first.
    expect(house('www/production').x).toBe(house('www/errors').x)
    expect(house('www/production').y).toBeGreaterThan(house('www/errors').y)
    expect(blockOf('www/production')).toBe(blockOf('www/errors'))
    expect(house('www/errors').name).toBe('errors')
  })

  it('walks blocks in a square spiral out from the middle, each number one block', () => {
    const blocks = Array.from({ length: 25 }, (_, n) => spiral(n))
    expect(blocks[0]).toEqual({ bx: 0, by: 0 })
    expect(new Set(blocks.map((b) => `${b.bx},${b.by}`)).size).toBe(25)
    // The first nine are the middle and the ring around it; the next sixteen, the ring around that.
    expect(blocks.slice(0, 9).every((b) => Math.max(Math.abs(b.bx), Math.abs(b.by)) <= 1)).toBe(true)
    expect(blocks.slice(9).every((b) => Math.max(Math.abs(b.bx), Math.abs(b.by)) === 2)).toBe(true)
    // Each block is next to the one before it.
    for (let n = 1; n < 25; n++) expect(Math.abs(blocks[n]!.bx - blocks[n - 1]!.bx) + Math.abs(blocks[n]!.by - blocks[n - 1]!.by)).toBeLessThanOrEqual(2)
  })

  it('puts a district whose houses fit in one row on half a block, and the next small one on the other half', () => {
    const town = townOf(stateOf(['alpha/one', 'alpha/two', 'beta/one', 'gamma/one'], []), NOW)
    const [main, alpha, beta, gamma] = [undefined, ...town.blocks]
    expect(main).toBeUndefined()
    expect(alpha!.depth).toBeLessThan(BLOCK.depth / 2)
    // Beta shares alpha's block, under it; gamma starts the next block.
    expect(beta).toMatchObject({ x: alpha!.x, district: 'beta' })
    expect(beta!.y).toBeGreaterThan(alpha!.y)
    const inAlphasBlock = gamma!.x === alpha!.x && gamma!.y >= alpha!.y && gamma!.y < alpha!.y + BLOCK.depth
    expect(inAlphasBlock).toBe(false)
  })

  it('keeps a city of many channels about square', () => {
    const channels = Array.from({ length: 200 }, (_, i) => `probe-${String(i).padStart(3, '0')}`)
    const town = townOf(stateOf(channels, []), NOW)
    expect(town.houses).toHaveLength(200)
    expect(town.width / town.height).toBeGreaterThan(0.6)
    expect(town.width / town.height).toBeLessThan(1.7)
  })

  it('grows a house with its threads, in steps, up to a hall of sixteen tables', () => {
    const house = (threads: number) => {
      const roots = Array.from({ length: threads }, (_, i) => discussion(i + 1, ADA, 'dev')).flat()
      return townOf(stateOf(['dev'], roots), NOW).houses[0]!
    }
    expect(house(0).width).toBeLessThan(house(2).width)
    expect(house(4).depth).toBeGreaterThan(house(2).depth)
    expect(house(9).width).toBeGreaterThan(house(4).width)
    expect(house(13).tables).toHaveLength(13)
    expect(house(40).tables).toHaveLength(16)
    expect(house(40).width).toBe(house(16).width)
    expect(house(9).width).toBe(sizeOf(9).width)
  })

  it('stands houses of one row on one front line, facing their street', () => {
    // A hall of six tables and a cottage, side by side on the main street's block.
    const big = Array.from({ length: 5 }, (_, i) => discussion(i + 1, ADA, 'dev')).flat()
    const town = townOf(stateOf(['dev', 'prs'], big), NOW)
    const [dev, prs] = town.houses
    expect(dev!.depth).toBeGreaterThan(prs!.depth)
    expect(dev!.y + dev!.depth).toBe(prs!.y + prs!.depth)
  })

  it('makes a house of a channel only the stream has shown', () => {
    const town = townOf(stateOf([], [message(1, ADA, 'incidents')]), NOW)
    expect(town.houses.map((h) => h.channel)).toEqual(['incidents'])
  })

  it('stands everyone at the house of their newest message, and moves them when they post elsewhere', () => {
    const before = stateOf(['dev', 'prs'], [message(1, ADA, 'dev', { createdAt: ago(5 * 60_000) })])
    expect(where(townOf(before, NOW), ADA)?.channel).toBe('dev')
    const after = store.merge(before, [message(2, ADA, 'prs', { createdAt: ago(60_000) })])
    expect(where(townOf(after, NOW), ADA)?.channel).toBe('prs')
  })

  it('tells agents from people', () => {
    const town = townOf(stateOf(['dev'], [message(1, ADA, 'dev'), message(2, FX, 'dev')]), NOW)
    expect(where(town, FX)?.agent).toBe(true)
    expect(where(town, ADA)?.agent).toBe(false)
  })

  it('keeps an agent at work in the house of the task it holds a live claim on', () => {
    const claimed = message(1, ADA, 'work', { task: task({ state: 'claimed', epoch: 1, claim: { actor: FX, until: new Date(NOW + 10 * 60_000).toISOString() } }) } as Partial<MessageView>)
    const town = townOf(stateOf(['work', 'dev'], [claimed, message(2, FX, 'dev', { createdAt: ago(60_000) })]), NOW)
    expect(where(town, FX)).toMatchObject({ channel: 'work', working: true })
    expect(town.houses.find((h) => h.channel === 'work')?.tasks).toBe(1)
    // Once the lease runs out, the agent is back where it last posted.
    const lapsed = townOf(stateOf(['work', 'dev'], [claimed, message(2, FX, 'dev', { createdAt: ago(60_000) })]), NOW + 20 * 60_000)
    expect(where(lapsed, FX)).toMatchObject({ channel: 'dev', working: false })
  })

  it('shows a message over its author while it is fresh, and one bubble to a house, the newest speaker’s', () => {
    const state = stateOf(['dev'], [
      message(1, ADA, 'dev', { text: 'first', createdAt: ago(60_000) }),
      message(2, FX, 'dev', { text: 'over to @[vercel:user:u_ada]', createdAt: ago(30_000) }),
    ])
    const town = townOf(state, NOW)
    expect(where(town, FX)?.bubble).toMatchObject({ id: '2', thread: '2' })
    expect(where(town, ADA)?.bubble).toBeNull()
    expect(where(townOf(state, NOW + BUBBLE_MS), FX)?.bubble).toBeNull()
  })

  it('opens the thread a reply bubble belongs to', () => {
    const town = townOf(stateOf(['dev'], [message(1, ADA, 'dev'), message(2, FX, 'dev', { re: '1', createdAt: ago(10_000) })]), NOW)
    expect(where(town, FX)?.bubble?.thread).toBe('1')
  })

  it('dozes off whoever has been quiet an hour, and sends home whoever has been quiet a day', () => {
    const state = stateOf(['dev'], [message(1, ADA, 'dev', { createdAt: ago(0) })])
    expect(where(townOf(state, NOW + IDLE_MS - 1), ADA)?.idle).toBe(false)
    expect(where(townOf(state, NOW + IDLE_MS + 1), ADA)?.idle).toBe(true)
    expect(where(townOf(state, NOW + GONE_MS + 1), ADA)).toBeUndefined()
  })

  it('stands you at the house you opened', () => {
    const state = stateOf(['dev', 'prs'], [message(1, ME, 'dev')])
    expect(where(townOf(state, NOW), ME)?.channel).toBe('dev')
    expect(where(townOf(state, NOW, { here: 'prs' }), ME)).toMatchObject({ channel: 'prs', you: true })
  })

  it('says over a house who’s in it, the most recent first, and sends everyone in by its door', () => {
    const state = stateOf(['dev'], [message(1, ADA, 'dev', { createdAt: ago(60_000) }), message(2, FX, 'dev', { createdAt: ago(1000) })])
    const town = townOf(state, NOW)
    expect(town.houses[0]!.who.map((w) => [w.name, w.agent])).toEqual([
      ['vercel:user:u_ada+fx', true],
      ['vercel:user:u_ada', false],
    ].map(([id, agent]) => [store.nameOf(state, id as string), agent]))
    const house = town.houses[0]!
    for (const actor of [ADA, FX]) {
      const door = where(town, actor)!.door
      expect(door.y).toBeGreaterThan(house.y + house.depth - 1)
      expect(Math.abs(door.x + 15 - (house.x + house.width / 2))).toBeLessThan(2)
    }
  })

  it('makes a house’s threads its tables: those with someone at them first, then the latest, each saying its root’s first line', () => {
    const threads = Array.from({ length: 20 }, (_, i) => discussion(i + 1, `vercel:user:u_${i % 2}`, 'dev', { text: `thread ${i + 1}\nmore`, createdAt: ago((20 - i) * 60_000) })).flat()
    // Ada last spoke in the oldest thread: it still gets a table, though sixteen are newer.
    const reply = message(99, ADA, 'dev', { re: '1', createdAt: ago(1000) })
    const state = stateOf(['dev'], [...threads.map((m) => ({ ...m, by: { ...m.by, actor: 'vercel:user:u_bob', principal: 'vercel:user:u_bob' } })), reply])
    const house = townOf(state, NOW).houses[0]!
    expect(house.tables).toHaveLength(16)
    expect(house.tables[0]!.thread).toBe('1')
    expect(house.tables[0]!.label).toBe('thread 1')
    expect(house.tables.map((t) => t.thread)).toContain('20')
    expect(house.tables.map((t) => t.thread)).not.toContain('2')
  })

  it('seats each resident at the table of the thread they were last in, and the rest inside the door', () => {
    const state = stateOf(['dev'], [message(1, ADA, 'dev', { createdAt: ago(60_000) }), message(2, FX, 'dev', { re: '1', createdAt: ago(30_000) })])
    const town = townOf(state, NOW, { here: 'dev' })
    const table = town.houses[0]!.tables[0]!
    for (const actor of [ADA, FX]) {
      const seat = where(town, actor)!.inside
      expect(Math.abs(seat.x - table.x)).toBeLessThan(120)
      expect(Math.abs(seat.y - table.y)).toBeLessThan(50)
    }
    // Two at one table don't sit in one seat, and both face it from its far side.
    expect(where(town, ADA)!.inside).not.toEqual(where(town, FX)!.inside)
    expect(where(town, ADA)).toMatchObject({ seated: true, facing: 0 })
    expect(where(town, ADA)!.inside.y).toBeLessThan(table.y)
    // You came in by the door: at no table.
    expect(where(town, ME)).toMatchObject({ thread: null })
    expect(where(town, ME)!.inside.y).toBeGreaterThan(table.y + 50)
  })

  it('sits you at the thread you have open, or else the last one you wrote in, or by the door', () => {
    const state = stateOf(['dev'], [...discussion(1, ADA, 'dev'), ...discussion(2, FX, 'dev'), ...discussion(3, ME, 'dev', { createdAt: ago(60_000) })])
    // Looking at nothing, you sit where you last wrote.
    expect(where(townOf(state, NOW, { here: 'dev' }), ME)).toMatchObject({ thread: '3', seated: true })
    // Open a thread, and you sit at its table.
    expect(where(townOf(state, NOW, { here: 'dev', looking: '2' }), ME)).toMatchObject({ thread: '2', seated: true })
    // A thread in another house is nowhere here: you sit where you last wrote.
    expect(where(townOf(stateOf(['dev', 'prs'], [...state.messages ? Object.values(state.messages) : [], ...discussion(9, ADA, 'prs')]), NOW, { here: 'dev', looking: '9' }), ME)?.thread).toBe('3')
    // Never having written here, and looking at nothing, you stand inside the door.
    expect(where(townOf(stateOf(['dev'], discussion(1, ADA, 'dev')), NOW, { here: 'dev' }), ME)).toMatchObject({ thread: null, seated: false })
  })

  it('keeps every table where it is when someone sits down at one', () => {
    const state = stateOf(['dev'], [1, 2, 3, 4].flatMap((n) => discussion(n, ADA, 'dev', { createdAt: ago((10 - n) * 60_000) })))
    const placed = (town: ReturnType<typeof townOf>) => Object.fromEntries(town.houses[0]!.tables.map((t) => [t.thread, [t.x, t.y]]))
    const before = placed(townOf(state, NOW, { here: 'dev' }))
    // You open the newest thread: it gets you at its table, and no table moves for it.
    expect(placed(townOf(state, NOW, { here: 'dev', looking: '4' }))).toEqual(before)
  })

  it('gives a table to a thread or a task, never to a message no one answered', () => {
    const lone = message(1, ADA, 'dev', { createdAt: ago(1000) })
    const town = townOf(stateOf(['dev'], [lone, ...discussion(2, FX, 'dev')]), NOW, { here: 'dev' })
    expect(town.houses[0]!.tables.map((t) => t.thread)).toEqual(['2'])
    // Who wrote it stands in the room, at no table.
    expect(where(town, ADA)).toMatchObject({ seated: false })
  })

  it('sits an agent at work at its task’s table, and shows the task’s state on it', () => {
    const claimed = message(1, ADA, 'work', { task: task({ state: 'claimed', epoch: 1, claim: { actor: FX, until: new Date(NOW + 10 * 60_000).toISOString() } }) } as Partial<MessageView>)
    const town = townOf(stateOf(['work'], [claimed, message(2, ADA, 'work', { createdAt: ago(1000) })]), NOW)
    expect(where(town, FX)?.thread).toBe('1')
    expect(town.houses[0]!.tables.find((t) => t.thread === '1')?.task).toBe('claimed')
  })
})

describe('names over a table', () => {
  it('shows as many as fit, then how many more', () => {
    expect(fitted(['fx'])).toBe('fx')
    expect(fitted(['glm', 'fx'])).toBe('glm, fx')
    expect(fitted(['glm', 'pr-watch', 'vulns-agent'])).toBe('glm, pr-watch +1')
    // One long name still shows, cut short by its pill.
    expect(fitted(['vulns-agent-with-a-long-name', 'fx'])).toBe('vulns-agent-with-a-long-name +1')
  })
})
