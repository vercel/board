import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBoardClient, type BoardClient } from '../src/client/client.ts'
import { memory } from '../src/store/memory.ts'
import { BOARD_URL, deploymentToken, localBoard, personToken, testBoard } from './harness.ts'

type Team = Pick<ReturnType<typeof testBoard>, 'fetch'>

/** A person's handle on the board, over its HTTP handler, with a profile when they write as an agent. */
async function as(board: Team, user: string, profile: string | null = null): Promise<BoardClient> {
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => board.fetch(new Request(input, init))) as typeof globalThis.fetch
  return createBoardClient({ url: BOARD_URL, token: await personToken(user), fetch, profile })
}

const JULIAN = 'vercel:user:u_julian'
const CLAUDE = `${JULIAN}+claude`

/** Julian and Ada on one board, and Julian's agent. */
async function people(board: Team = testBoard()) {
  return { board, julian: await as(board, 'u_julian'), ada: await as(board, 'u_ada'), claude: await as(board, 'u_julian', 'claude') }
}

/** An inbox at a glance: each item's thread, why it's there, and how much of it is unread. */
const glance = async (reader: BoardClient, query: Parameters<BoardClient['inbox']['items']>[0] = {}) =>
  (await reader.inbox.items(query)).items.map((item) => ({ thread: item.thread, message: item.message, reasons: item.reasons, unread: item.unread }))

afterEach(() => {
  vi.useRealTimers()
})

describe('what reaches an inbox', () => {
  it('a mention adds its thread, wherever it is, with the thread and the message that arrived', async () => {
    const { julian, ada } = await people()
    expect((await julian.inbox.items()).items).toEqual([])
    const root = await ada.post('dev', `can you look at the refresh endpoint? @[${JULIAN}]`)
    const { items } = await julian.inbox.items()
    expect(items).toMatchObject([{ thread: root.id, message: null, reader: JULIAN, reasons: ['mention'], unread: 1, snoozed: null, first: { id: root.id, channel: 'dev' }, last: { id: root.id } }])
    // And nobody else's: Ada wrote it, and nothing in it is for her.
    expect((await ada.inbox.items()).items).toEqual([])
  })

  it('a followed channel adds what is written there, one item a thread however many messages it has', async () => {
    const { julian, ada } = await people()
    const before = await ada.post('dev', 'written before anyone followed')
    expect(await julian.inbox.follow({ channel: 'dev' })).toMatchObject({ channel: 'dev', by: 'asked' })
    const root = await ada.post('dev', 'db is down')
    const reply = await ada.reply(root.id, 'back up')
    await ada.post('ops', 'elsewhere')
    const { items } = await julian.inbox.items()
    expect(items).toMatchObject([{ thread: root.id, reasons: ['channel'], unread: 2, first: { id: root.id }, last: { id: reply.id } }])
    // A reply in a thread that was there before the follow arrives too: it's written there now.
    const late = await ada.reply(before.id, 'and one more')
    expect(await glance(julian)).toEqual([
      { thread: before.id, message: null, reasons: ['channel'], unread: 1 },
      { thread: root.id, message: null, reasons: ['channel'], unread: 2 },
    ])
    expect((await julian.inbox.items()).items[0]!.last.id).toBe(late.id)
  })

  it('a followed subtree covers the channel and every channel under it, and nothing beside it', async () => {
    const { julian, ada } = await people()
    await julian.inbox.follow({ channel: 'www/' })
    const top = await ada.post('www', 'top')
    const under = await ada.post('www/production', 'under')
    await ada.post('www-next', 'beside')
    expect((await glance(julian)).map((item) => item.thread)).toEqual([under.id, top.id])
  })

  it('posting in a thread follows it, and your own writes add nothing', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', 'who owns the refresh endpoint?')
    await julian.reply(root.id, 'looking')
    // Julian's own reply reaches Ada, who started the thread, and not Julian.
    expect(await glance(julian)).toEqual([])
    expect(await glance(ada)).toEqual([{ thread: root.id, message: null, reasons: ['thread'], unread: 1 }])
    await ada.reply(root.id, 'thanks')
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['thread'], unread: 1 }])
  })

  it('nothing its reader wrote reaches them: not in a thread or a channel they follow, nor by mentioning themselves', async () => {
    const { julian, ada } = await people()
    await julian.inbox.follow({ channel: 'dev' })
    const mine = await julian.post('dev', `a thread of my own, for @[${JULIAN}]`)
    await julian.reply(mine.id, 'and a reply to myself')
    const theirs = await ada.post('ops', 'elsewhere')
    await julian.reply(theirs.id, 'once')
    await julian.reply(theirs.id, 'twice, now that I follow it')
    expect(await glance(julian)).toEqual([])
  })

  it('a message written while its reader followed reaches them, though they leave before the board has passed it on', async () => {
    // A board whose store lets Julian unfollow the channel right as a post there lands, before anything is done with it.
    const store = memory()
    const append = store.log.append.bind(store.log)
    let leave: (() => Promise<unknown>) | null = null
    store.log.append = async (session, events, options) => {
      const landed = await append(session, events, options)
      if (leave && events.some((event) => event.type === 'message.posted' && (event.payload as { text?: string }).text === 'written while followed')) {
        const leaving = leave
        leave = null
        await leaving()
      }
      return landed
    }
    const { julian, ada } = await people(testBoard({ store }))
    await julian.inbox.follow({ channel: 'dev' })
    leave = () => julian.inbox.unfollow({ channel: 'dev' })
    const root = await ada.post('dev', 'written while followed')
    expect(leave).toBeNull()
    await ada.post('dev', 'written after')
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['channel'], unread: 1 }])
  })

  it('a reaction, a label, an edit, and a delete add nothing', async () => {
    const { julian, ada } = await people()
    const root = await julian.post('dev', 'the fix is up')
    await ada.react(root.id, 'thumbs_up')
    await ada.label(root.id, { set: { state: 'seen' } })
    const mine = await ada.post('dev', 'a thread of my own')
    await ada.edit(mine.id, `now it mentions @[${JULIAN}]`)
    await ada.delete(mine.id)
    expect(await glance(julian)).toEqual([])
  })

  it('a note kept on the board reaches a profile, and no person', async () => {
    const { julian, ada, claude } = await people()
    const root = await ada.post('dev', 'who owns the refresh endpoint?')
    await julian.reply(root.id, 'me')
    await claude.reply(root.id, 'and me')
    await ada.reply(root.id, { text: 'working notes: tried the cache first', noSync: true })
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['thread'], unread: 1 }])
    expect(await glance(claude)).toEqual([{ thread: root.id, message: null, reasons: ['thread'], unread: 1 }])
    // The note is the second thing in it for claude, and nothing for Julian.
    await julian.inbox.mark(root.id)
    await claude.inbox.mark(root.id)
    const note = await ada.reply(root.id, { text: `more notes @[${JULIAN}] @[${CLAUDE}]`, noSync: true })
    expect(await glance(julian, { unread: true })).toEqual([])
    expect(await claude.inbox.items({ unread: true })).toMatchObject({ items: [{ thread: root.id, reasons: ['mention', 'thread'], unread: 1, last: { id: note.id } }] })
  })

  it('a profile has an inbox of its own, and `under` reads a person’s with their agents’', async () => {
    const { julian, ada, claude } = await people()
    await claude.post('general', 'hello')
    const forClaude = await ada.post('dev', `@[${CLAUDE}] can you look?`)
    const forJulian = await ada.post('dev', `@[${JULIAN}] and you?`)
    expect(await glance(claude)).toEqual([{ thread: forClaude.id, message: null, reasons: ['mention'], unread: 1 }])
    expect(await glance(julian)).toEqual([{ thread: forJulian.id, message: null, reasons: ['mention'], unread: 1 }])
    const under = await julian.inbox.items({ under: true })
    expect(under.items.map((item) => [item.reader, item.thread])).toEqual([
      [JULIAN, forJulian.id],
      [CLAUDE, forClaude.id],
    ])
    // Nothing is under an agent, and Ada's isn't under anyone but her.
    expect(await glance(claude, { under: true })).toEqual([{ thread: forClaude.id, message: null, reasons: ['mention'], unread: 1 }])
    expect(await glance(ada, { under: true })).toEqual([])
  })

  it('reaches a person the board never met by their own ID, and makes up no profile under them', async () => {
    const { julian, ada, claude } = await people()
    // Julian has written nothing, and nobody has written as his claude, or as a profile he never had.
    const root = await ada.post('dev', `@[${JULIAN}] @[${CLAUDE}] @[${JULIAN}+made-up]`)
    expect((await julian.inbox.items({ under: true })).items.map((item) => [item.reader, item.thread])).toEqual([[JULIAN, root.id]])
    expect(await glance(claude)).toEqual([])
    // Once claude has written, the board knows it, and a mention reaches it.
    await claude.post('general', 'hello')
    const again = await ada.post('dev', `@[${CLAUDE}] now?`)
    expect(await glance(claude)).toEqual([{ thread: again.id, message: null, reasons: ['mention'], unread: 1 }])
  })

  it('holds what a deployment is mentioned in, as anyone’s', async () => {
    const board = testBoard()
    const { julian } = await people(board)
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => board.fetch(new Request(input, init))) as typeof globalThis.fetch
    // The board's own project's deployment, which the board lets in.
    const www = createBoardClient({ url: BOARD_URL, token: await deploymentToken('board', 'prj_board'), fetch, profile: null })
    const said = await www.post('deploys', 'deployed a1b2c3')
    const me = await www.me()
    await julian.reply(said.id, `nice @[${me.actor}]`)
    expect(await glance(www)).toEqual([{ thread: said.id, message: null, reasons: ['mention', 'thread'], unread: 1 }])
  })
})

describe('what a reader does to their inbox', () => {
  it('reading leaves an item where it is, and lists by read or unread', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', `@[${JULIAN}] one`)
    const second = await ada.reply(root.id, 'two')
    await ada.reply(root.id, `three @[${JULIAN}]`)
    // The mention made the item, and Julian doesn't follow the thread: only what mentions him arrives.
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['mention'], unread: 2 }])
    expect(await julian.inbox.mark(root.id)).toMatchObject({ thread: root.id, unread: 0 })
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['mention'], unread: 0 }])
    expect(await glance(julian, { unread: true })).toEqual([])
    expect((await glance(julian, { read: true })).map((item) => item.thread)).toEqual([root.id])
    await expect(julian.inbox.items({ read: true, unread: true })).rejects.toMatchObject({ status: 400 })
    // Unread again, from a message on: what others wrote from there.
    expect(await julian.inbox.mark(second.id, { unread: true })).toMatchObject({ thread: root.id, unread: 2 })
    expect((await glance(julian, { unread: true })).map((item) => item.thread)).toEqual([root.id])
    expect(await glance(julian, { read: true })).toEqual([])
    // And read up to a message: what arrived after it stays unread.
    expect(await julian.inbox.mark(second.id)).toMatchObject({ unread: 1 })
  })

  it('removing isn’t unfollowing: what arrives next brings the thread back, unread', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', 'who owns the refresh endpoint?')
    await julian.reply(root.id, 'me')
    await ada.reply(root.id, 'thanks')
    expect(await julian.inbox.remove(root.id)).toBe(true)
    expect(await glance(julian)).toEqual([])
    expect(await julian.inbox.remove(root.id)).toBe(false)
    await ada.reply(root.id, 'one more thing')
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['thread'], unread: 1 }])
  })

  it('unfollowing a thread stops it, a mention still arrives, and posting follows it again, read up to the post', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', 'who owns the refresh endpoint?')
    await julian.reply(root.id, 'me')
    expect(await julian.inbox.unfollow({ thread: root.id })).toBe(true)
    expect(await julian.inbox.unfollow({ thread: root.id })).toBe(false)
    await ada.reply(root.id, 'thanks')
    expect(await glance(julian)).toEqual([])
    await ada.reply(root.id, `@[${JULIAN}] still there?`)
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['mention'], unread: 1 }])
    await julian.reply(root.id, 'on it')
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['mention'], unread: 0 }])
    await ada.reply(root.id, 'great')
    expect(await glance(julian)).toEqual([{ thread: root.id, message: null, reasons: ['mention', 'thread'], unread: 1 }])
  })

  it('unfollowing a channel stops what is written there, and leaves the threads you posted in', async () => {
    const { julian, ada } = await people()
    await julian.inbox.follow({ channel: 'dev' })
    const mine = await ada.post('dev', 'one')
    await julian.reply(mine.id, 'here')
    expect(await julian.inbox.unfollow({ channel: 'dev' })).toBe(true)
    expect(await julian.inbox.unfollow({ channel: 'dev' })).toBe(false)
    await julian.inbox.remove(mine.id)
    await ada.post('dev', 'two')
    expect(await glance(julian)).toEqual([])
    await ada.reply(mine.id, 'for you')
    expect(await glance(julian)).toEqual([{ thread: mine.id, message: null, reasons: ['thread'], unread: 1 }])
  })

  it('adding by hand puts a thread, or one message by itself, in the inbox, and follows nothing', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', 'a thread Julian never posted in')
    const reply = await ada.reply(root.id, 'its reply')
    expect(await julian.inbox.add(root.id)).toMatchObject({ thread: root.id, message: null, reasons: ['added'], unread: 1, last: { id: reply.id } })
    // A reply by its own ID is that message, as an item of its own; a root is with `message`.
    expect(await julian.inbox.add(reply.id)).toMatchObject({ thread: root.id, message: reply.id, reasons: ['added'], unread: 1, last: { id: reply.id } })
    expect(await julian.inbox.add(root.id, { message: true })).toMatchObject({ thread: root.id, message: root.id, last: { id: root.id } })
    await ada.reply(root.id, 'nothing new for Julian')
    expect(await glance(julian)).toEqual([
      { thread: root.id, message: root.id, reasons: ['added'], unread: 1 },
      { thread: root.id, message: reply.id, reasons: ['added'], unread: 1 },
      { thread: root.id, message: null, reasons: ['added'], unread: 1 },
    ])
    // Each is its own to read and to remove.
    expect(await julian.inbox.mark(reply.id)).toMatchObject({ message: reply.id, unread: 0 })
    expect(await julian.inbox.remove(reply.id)).toBe(true)
    expect((await glance(julian)).map((item) => item.message)).toEqual([root.id, null])
    // Adding what's there leaves it as it is.
    await julian.inbox.mark(root.id)
    expect(await julian.inbox.add(root.id, { message: true })).toMatchObject({ message: root.id, unread: 0 })
  })

  it('a snoozed item is out of the list until its time, or until anything arrives in it', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', `@[${JULIAN}] one`)
    const other = await ada.post('dev', `@[${JULIAN}] another`)
    const until = new Date(Date.now() + 600_000).toISOString()
    expect(await julian.inbox.snooze(root.id, until)).toMatchObject({ thread: root.id, snoozed: until })
    await julian.inbox.snooze(other.id, until)
    expect(await glance(julian)).toEqual([])
    expect((await glance(julian, { snoozed: true })).map((item) => item.thread)).toEqual([other.id, root.id])
    // Something new ends one.
    await ada.reply(root.id, `@[${JULIAN}] and now?`)
    expect(await julian.inbox.items()).toMatchObject({ items: [{ thread: root.id, snoozed: null, unread: 2 }] })
    // Its time ends the other, which is back on top.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 600_001 })
    expect((await glance(julian)).map((item) => item.thread)).toEqual([other.id, root.id])
    expect(await glance(julian, { snoozed: true })).toEqual([])
    vi.useRealTimers()
    // And a snooze ended by hand.
    await julian.inbox.snooze(other.id, new Date(Date.now() + 3_600_000).toISOString())
    expect(await julian.inbox.snooze(other.id, null)).toMatchObject({ thread: other.id, snoozed: null })
    expect((await glance(julian)).length).toBe(2)
    await expect(julian.inbox.snooze(other.id, new Date(Date.now() - 1000).toISOString())).rejects.toMatchObject({ status: 400 })
  })

  it('lists by the labels of an item’s thread, which is how a reader finds what waits for them', async () => {
    const { julian, ada } = await people()
    await julian.inbox.follow({ channel: 'work' })
    const held = await ada.tasks.create('work', 'ship the fix')
    await ada.tasks.block(held.task.id, 'which branch?')
    const plain = await ada.post('work', 'just talk')
    expect((await glance(julian)).map((item) => item.thread)).toEqual([plain.id, held.task.id])
    expect((await glance(julian, { label: { 'board.task': 'blocked' } })).map((item) => item.thread)).toEqual([held.task.id])
    expect(await glance(julian, { label: ['board.task=ready'] })).toEqual([])
  })

  it('answers a page at a time, the item that changed last first', async () => {
    const { julian, ada } = await people()
    await julian.inbox.follow({ channel: 'dev' })
    const threads: string[] = []
    for (const text of ['one', 'two', 'three', 'four', 'five']) threads.push((await ada.post('dev', text)).id)
    // What arrives in an older thread moves it to the top.
    await ada.reply(threads[0]!, 'again')
    const order = [threads[0], threads[4], threads[3], threads[2], threads[1]]
    const first = await julian.inbox.items({ limit: 2 })
    expect(first.items.map((item) => item.thread)).toEqual(order.slice(0, 2))
    expect(first.older).not.toBeNull()
    const second = await julian.inbox.items({ limit: 2, before: first.older! })
    expect(second.items.map((item) => item.thread)).toEqual(order.slice(2, 4))
    const third = await julian.inbox.items({ limit: 2, before: second.older! })
    expect(third.items.map((item) => item.thread)).toEqual(order.slice(4))
    expect(third.older).toBeNull()
  })

  it('names what an item is by any message of its thread, and says when a message names none', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', `@[${JULIAN}] one`)
    const reply = await ada.reply(root.id, 'two')
    const elsewhere = await ada.post('dev', 'not in the inbox')
    // A reply names its thread's item.
    expect(await julian.inbox.mark(reply.id)).toMatchObject({ thread: root.id, message: null })
    await expect(julian.inbox.mark(elsewhere.id)).rejects.toMatchObject({ status: 404, code: 'not_in_inbox' })
    await expect(julian.inbox.snooze(elsewhere.id, new Date(Date.now() + 1000).toISOString())).rejects.toMatchObject({ status: 404, code: 'not_in_inbox' })
    await expect(julian.inbox.mark('999')).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
    await expect(julian.inbox.add('999')).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
  })
})

describe('what a reader follows', () => {
  it('lists the channels asked for and the threads posted in or asked for, less what was left', async () => {
    const { julian, ada } = await people()
    await julian.inbox.follow({ channel: 'www/' })
    await julian.inbox.follow({ channel: 'ops' })
    const posted = await ada.post('dev', 'one')
    await julian.reply(posted.id, 'here')
    const asked = await ada.post('dev', 'two')
    expect(await julian.inbox.follow({ thread: asked.id })).toMatchObject({ thread: asked.id, by: 'asked' })
    const left = await ada.post('dev', 'three')
    await julian.reply(left.id, 'here too')
    await julian.inbox.unfollow({ thread: left.id })
    // Following what's followed says how it is.
    expect(await julian.inbox.follow({ thread: posted.id })).toMatchObject({ thread: posted.id, by: 'posted' })
    expect(await julian.inbox.follow({ channel: 'ops' })).toMatchObject({ channel: 'ops', by: 'asked' })
    const { follows, older } = await julian.inbox.follows()
    expect(follows.map(({ at: _at, ...follow }) => follow)).toEqual([
      { channel: 'ops', by: 'asked' },
      { channel: 'www/', by: 'asked' },
      { thread: asked.id, by: 'asked' },
      { thread: posted.id, by: 'posted' },
    ])
    expect(older).toBeNull()
    // A thread asked for arrives like one posted in.
    await ada.reply(asked.id, 'for whoever follows')
    await ada.reply(left.id, 'for nobody')
    expect(await glance(julian)).toEqual([{ thread: asked.id, message: null, reasons: ['thread'], unread: 1 }])
  })

  it('refuses a channel pattern that names no channel or subtree', async () => {
    const { julian } = await people()
    await expect(julian.inbox.follow({ channel: '*' })).rejects.toMatchObject({ status: 400 })
    await expect(julian.inbox.follow({ channel: 'Dev' })).rejects.toMatchObject({ status: 400 })
  })
})

describe('what changes in an inbox', () => {
  it('is read from a cursor: each item that changed, as it is now, and each one removed', async () => {
    const { julian, ada } = await people()
    const { cursor } = await julian.inbox.items()
    const root = await ada.post('dev', `@[${JULIAN}] one`)
    await ada.reply(root.id, `@[${JULIAN}] two`)
    const arrived = await julian.inbox.poll({ after: cursor })
    // Two arrivals in one thread are one item, as it is now.
    expect(arrived.events).toMatchObject([{ type: 'inbox.item', item: { thread: root.id, unread: 2, reader: JULIAN } }])
    expect((await julian.inbox.poll({ after: arrived.cursor })).events).toEqual([])
    await julian.inbox.mark(root.id)
    const read = await julian.inbox.poll({ after: arrived.cursor })
    expect(read.events).toMatchObject([{ type: 'inbox.item', item: { thread: root.id, unread: 0 } }])
    await julian.inbox.remove(root.id)
    const removed = await julian.inbox.poll({ after: read.cursor })
    expect(removed.events).toEqual([{ type: 'inbox.removed', cursor: removed.cursor, thread: root.id, message: null, reader: JULIAN }])
  })

  it('holds a read until the next change, and answers nothing when none comes', async () => {
    const { julian, ada } = await people()
    const waiting = julian.inbox.wait({}, { timeout: '5s' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const root = await ada.post('dev', `@[${JULIAN}] one`)
    expect(await waiting).toMatchObject({ type: 'inbox.item', item: { thread: root.id } })
    expect(await julian.inbox.wait({}, { timeout: 100 })).toBeNull()
  })

  it('follows a person’s inbox and their agents’ in one stream', async () => {
    const { julian, ada, claude } = await people()
    await claude.post('general', 'hello')
    const controller = new AbortController()
    const seen: string[] = []
    const following = (async () => {
      for await (const event of julian.inbox.events({ under: true }, { signal: controller.signal })) {
        if (event.type === 'inbox.item') seen.push(`${event.item.reader} ${event.item.thread}`)
        if (seen.length === 2) controller.abort()
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const forClaude = await ada.post('dev', `@[${CLAUDE}] can you look?`)
    const forJulian = await ada.post('dev', `@[${JULIAN}] and you?`)
    await following
    expect(seen).toEqual([`${CLAUDE} ${forClaude.id}`, `${JULIAN} ${forJulian.id}`])
  })

  it('says a snooze is over to whoever is waiting when its time comes', async () => {
    const { julian, ada } = await people()
    const root = await ada.post('dev', `@[${JULIAN}] one`)
    await julian.inbox.snooze(root.id, new Date(Date.now() + 300).toISOString())
    const { cursor } = await julian.inbox.items()
    const woke = await julian.inbox.poll({ after: cursor, wait: 5 })
    expect(woke.events).toMatchObject([{ type: 'inbox.item', item: { thread: root.id, snoozed: null } }])
  })
})

describe('an inbox on a board with a scheduler', () => {
  it('has a message as soon as its post has answered', async () => {
    const board = localBoard()
    try {
      const { julian, ada } = await people(board)
      await julian.inbox.follow({ channel: 'dev' })
      const posted: string[] = []
      for (const text of ['one', 'two', 'three']) posted.push((await ada.post('dev', text)).id)
      expect((await glance(julian)).map((item) => item.thread)).toEqual(posted.reverse())
    } finally {
      await board.close()
    }
  })
})
