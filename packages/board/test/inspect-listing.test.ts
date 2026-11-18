import { describe, expect, it } from 'vitest'
import type { BoardEventView, MessagesPage, MessageView, ThreadsPage, ThreadSummaryView } from '../src/api/routes.ts'
import { listing, type ListingClient } from '../src/inspect/app/listing.ts'
import * as store from '../src/inspect/app/store.ts'

const ME = 'vercel:user:u_julian'

/** A message in `ops`, written `id` minutes into the day: IDs and times go up together. */
function message(id: number, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: String(id),
    version: id,
    revision: id,
    channel: 'ops',
    text: `message ${id}`,
    re: null,
    replyTo: null,
    thread: `t${id}`,
    labels: {},
    reactions: {},
    by: { actor: ME, principal: ME, profile: null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString(),
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: { kind: 'person', handle: 'julian', name: 'julian', avatar: null },
    ...overrides,
  }
}

const reply = (id: number, re: number) => message(id, { re: String(re), thread: `t${re}`, text: `reply ${id}` })

const posted = (m: MessageView): BoardEventView => ({
  cursor: String(m.version),
  type: 'message.posted',
  createdAt: m.createdAt,
  payload: { channel: m.channel, text: m.text, re: m.re, replyTo: m.replyTo, thread: m.thread, labels: m.labels, noSync: m.noSync, by: m.by, origin: m.origin, from: m.from },
  message: m,
})

/**
 * A board's `ops` channel as `/threads` lists it: `threads`, each with its replies, by latest activity, a page's
 * `older` where its least recently active thread stands. `paged: false` is a board from before `older`.
 */
function fakeBoard(threads: () => { root: MessageView; replies: MessageView[] }[], options: { paged?: boolean; messages?: MessageView[]; answered?: Promise<void> } = {}) {
  const reads = { threads: [] as (string | undefined)[], messages: 0, thread: 0 }
  const summary = ({ root, replies }: { root: MessageView; replies: MessageView[] }): ThreadSummaryView => ({ message: root, replies: replies.length, last: replies.at(-1) ?? null })
  const client: ListingClient & { thread(): Promise<never> } = {
    async threads({ before, limit }) {
      reads.threads.push(before)
      const active = (t: { root: MessageView; replies: MessageView[] }) => t.replies.at(-1) ?? t.root
      const listed = threads()
        .sort((a, b) => store.byWritten(active(b), active(a)))
        .filter((t) => before === undefined || store.byWritten(active(t), JSON.parse(before)) < 0)
      const shown = listed.slice(0, limit)
      const page: ThreadsPage = { threads: shown.toReversed().map(summary), cursor: 'c' }
      // A page read now that reaches the page later.
      await options.answered
      const { createdAt, id } = active(shown.at(-1) ?? listed[0] ?? { root: message(0), replies: [] })
      return options.paged === false ? page : { ...page, older: listed.length > limit ? JSON.stringify({ createdAt, id }) : null }
    },
    async messages(): Promise<MessagesPage> {
      reads.messages++
      return { messages: options.messages ?? [], cursor: 'c' }
    },
    async thread() {
      reads.thread++
      throw new Error('the channel view reads no thread')
    },
  }
  let state: store.State = { ...store.initialState, me: { actor: ME } as store.State['me'] }
  const view = listing(client, () => state, (next) => (state = next(state)), 4)
  const shown = () => store.channelRows(state, 'ops').threads.map((t) => [t.root.id, t.summary.count, t.summary.last?.id ?? null])
  return { reads, view, shown, state: () => state, set: (next: store.State) => (state = next) }
}

/** Lets a refresh that waits a tick run, and its read land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the inspector's channel view", () => {
  it('shows a channel whose newest messages are all replies by its threads, from one read of them', async () => {
    const a = message(1)
    const b = message(2)
    const replies = Array.from({ length: 300 }, (_, i) => reply(3 + i, i % 2 === 0 ? 1 : 2))
    const board = fakeBoard(() => [
      { root: a, replies: replies.filter((r) => r.re === '1') },
      { root: b, replies: replies.filter((r) => r.re === '2') },
    ])
    await board.view.load('ops')
    // Both threads, the one with the latest reply last.
    expect(board.shown()).toEqual([
      ['1', 150, '301'],
      ['2', 150, '302'],
    ])
    expect(board.reads).toEqual({ threads: [undefined], messages: 0, thread: 0 })
  })

  it('pages back by what each page says is older, whatever threads are already here', async () => {
    // T1 to T11, T1 the least recently active, with two replies from before T2 started.
    const roots = Array.from({ length: 11 }, (_, i) => message((i + 1) * 10))
    const early = [reply(11, 10), reply(12, 10)]
    const board = fakeBoard(() => roots.map((root) => ({ root, replies: root.id === '10' ? early : [] })))
    // T1 was opened earlier: it and its replies are here before the channel loads.
    board.set(store.merge(board.state(), [roots[0]!, ...early]))
    await board.view.load('ops')
    expect(await board.view.older('ops')).toBe(true)
    expect(await board.view.older('ops')).toBe(false)
    expect(board.view.hasOlder('ops')).toBe(false)
    expect(board.reads.threads).toHaveLength(3)
    expect(board.shown().map(([id]) => id)).toEqual(['10', '20', '30', '40', '50', '60', '70', '80', '90', '100', '110'])
    expect(board.shown()[0]).toEqual(['10', 2, '12'])
  })

  it('shows a thread that two pages list once, as the newer of the two has it', async () => {
    const roots = Array.from({ length: 6 }, (_, i) => message(i + 1))
    const replies: Record<string, MessageView[]> = {}
    const board = fakeBoard(() => roots.map((root) => ({ root, replies: replies[root.id] ?? [] })))
    await board.view.load('ops')
    // The stream brings a reply to thread 4, and one to thread 1, which isn't here: the first page is read again,
    // listing 4 as it was before its reply.
    board.view.apply([posted(reply(40, 4))])
    replies['1'] = [reply(41, 1)]
    board.view.apply([posted(replies['1'][0]!)])
    await settle()
    await board.view.older('ops')
    expect(board.reads.threads).toHaveLength(3)
    expect(board.shown()).toEqual([
      ['2', 0, null],
      ['3', 0, null],
      ['5', 0, null],
      ['6', 0, null],
      ['4', 1, '40'],
      ['1', 1, '41'],
    ])
  })

  it('moves a known thread on a live reply with no read, and reads the first page once for a burst of replies it lacks', async () => {
    const roots = Array.from({ length: 6 }, (_, i) => message(i + 1))
    const extra: { root: MessageView; replies: MessageView[] }[] = []
    const board = fakeBoard(() => [...roots.map((root) => ({ root, replies: [] })), ...extra])
    await board.view.load('ops')
    board.view.apply([posted(reply(40, 4))])
    expect(board.shown().at(-1)).toEqual(['4', 1, '40'])
    expect(board.reads.threads).toEqual([undefined])

    // Replies to threads past what's loaded: one read of the first page, which now lists them.
    const old = message(0, { createdAt: new Date(Date.UTC(2026, 8, 1)).toISOString() })
    const replies = [reply(41, 0), reply(42, 0), reply(43, 0)]
    extra.push({ root: old, replies })
    board.view.apply([posted(replies[0]!), posted(replies[1]!)])
    board.view.apply([posted(replies[2]!)])
    await settle()
    expect(board.reads.threads).toEqual([undefined, undefined])
    expect(board.shown().at(-1)).toEqual(['0', 3, '43'])
    // A new thread shows at once, with no read.
    board.view.apply([posted(message(50))])
    expect(board.shown().at(-1)).toEqual(['50', 0, null])
    await settle()
    expect(board.reads.threads).toHaveLength(2)
  })

  it('says a channel with no threads is empty, and loads one on a board from before `older` by its messages', async () => {
    const empty = fakeBoard(() => [])
    await empty.view.load('ops')
    expect(empty.state().listings.ops).toEqual({ rows: {}, older: null, loaded: true })
    expect(empty.shown()).toEqual([])
    expect(empty.reads).toEqual({ threads: [undefined], messages: 0, thread: 0 })

    const latest = [message(1), reply(2, 1), message(3)]
    const old = fakeBoard(() => [], { paged: false, messages: latest })
    await old.view.load('ops')
    expect(old.reads).toEqual({ threads: [undefined], messages: 1, thread: 0 })
    expect(old.state().listings.ops).toBeNull()
    expect(store.channelThreads(old.state(), 'ops').threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['1', ['2']],
      ['3', []],
    ])
    // Its newest messages are all the view has: a channel's messages page forward only, so there's no page before them.
    expect([old.view.hasOlder('ops'), await old.view.older('ops')]).toEqual([false, false])
    expect(old.reads).toEqual({ threads: [undefined], messages: 1, thread: 0 })
  })

  it('keeps a live post in a channel named like a built-in, and the rest of its batch', async () => {
    const roots = [message(1)]
    const board = fakeBoard(() => roots.map((root) => ({ root, replies: [] })))
    await board.view.load('ops')
    const built = message(2, { channel: 'constructor' })
    board.set(store.mergeThreads(board.state(), 'constructor', { threads: [{ message: built, replies: 0, last: null }], cursor: 'c', older: null }, 'first'))
    board.view.apply([posted(reply(3, 2)), posted(message(4, { channel: 'constructor' })), posted(message(5))])
    expect(store.channelRows(board.state(), 'constructor').threads.map((t) => [t.root.id, t.summary.count])).toEqual([
      ['2', 1],
      ['4', 0],
    ])
    expect(board.shown().map(([id]) => id)).toEqual(['1', '5'])
    // A channel no one opened, named so, is no listing either.
    const fresh = fakeBoard(() => [])
    fresh.view.apply([posted(reply(6, 1)), posted(message(7))])
    expect(fresh.state().messages['7']).toBeDefined()
    fresh.view.apply([posted(message(8, { channel: 'constructor' })), posted(reply(9, 8))])
    expect(fresh.state().messages['9']).toBeDefined()
  })

  it('keeps a thread started while the first page is on its way, when that page was read before it', async () => {
    let answer!: () => void
    const roots = [message(1), message(2)]
    const board = fakeBoard(() => roots.map((root) => ({ root, replies: [] })), { answered: new Promise((resolve) => (answer = resolve)) })
    const loading = board.view.load('ops')
    board.view.apply([posted(message(3))])
    answer()
    await loading
    expect(board.shown()).toEqual([
      ['1', 0, null],
      ['2', 0, null],
      ['3', 0, null],
    ])
    expect(board.view.hasOlder('ops')).toBe(false)
  })
})

describe('a post from the inspector', () => {
  const pending = (m: MessageView): store.Pending => ({ channel: m.channel, re: m.re, text: m.text, noSync: false, labels: {}, key: `k${m.id}`, createdAt: m.createdAt, error: null })

  it('shows in its channel as soon as the board answers it, before the stream brings it', async () => {
    const board = fakeBoard(() => [{ root: message(1), replies: [] }])
    await board.view.load('ops')
    const root = message(2)
    board.set({ ...board.state(), pending: [pending(root)] })
    board.set(store.sent(board.state(), 'k2', root))
    expect(board.shown()).toEqual([
      ['1', 0, null],
      ['2', 0, null],
    ])
    expect(board.state().pending).toEqual([])
    board.view.apply([posted(root)])
    expect(board.shown()).toEqual([
      ['1', 0, null],
      ['2', 0, null],
    ])
  })

  it("counts every reply in a thread when the board answers yours before the stream brings someone else's", async () => {
    // Three replies the page counts, and only the latest of them loaded.
    const board = fakeBoard(() => [{ root: message(1), replies: [reply(2, 1), reply(3, 1), reply(4, 1)] }])
    await board.view.load('ops')
    const theirs = message(5, { re: '1', thread: 't1', text: 'theirs', by: { actor: 'slack:user:U1', principal: 'slack:user:U1', profile: null } })
    const mine = reply(6, 1)
    board.set({ ...board.state(), pending: [pending(mine)] })
    board.set(store.sent(board.state(), 'k6', mine))
    board.view.apply([posted(theirs), posted(mine)])
    expect(board.shown()).toEqual([['1', 5, '6']])
  })
})
