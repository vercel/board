import type { BoardEventView, MessagesPage, ThreadsPage } from '../../api/routes.ts'
import * as store from './store.ts'

// How a channel's view loads: a page of its threads at a time, by latest activity, from the board's
// thread list. A board whose pages have no `older` is from before it, and its channels load by
// messages, as they did.

/** What the view reads of the board. */
export type ListingClient = {
  threads(query: { channel: string; limit: number; before?: string }): Promise<ThreadsPage>
  messages(query: { channel: string; limit: number; before?: string }): Promise<MessagesPage>
}

const THREADS = 25
const MESSAGES = 200

export function listing(client: ListingClient, get: () => store.State, set: (next: (state: store.State) => store.State) => void, limit = THREADS) {
  /** Channels loaded by messages whose oldest is here. */
  const exhausted = new Set<string>()
  /** A first page being read again, per channel, and whether something asked for it once more since. */
  const refreshing = new Map<string, { again: boolean }>()

  async function messages(channel: string, before?: string) {
    const page = await client.messages({ channel, limit: MESSAGES, ...(before !== undefined ? { before } : {}) })
    if (page.messages.length < MESSAGES) exhausted.add(channel)
    set((s) => store.merge(s, page.messages))
  }

  /** The channel's first page of threads, or on a board from before `older`, its latest messages. */
  async function load(channel: string) {
    set((s) => store.listing(s, channel))
    const page = await client.threads({ channel, limit }).catch((error: unknown) => {
      set((s) => store.unlisted(s, channel))
      throw error
    })
    if (!('older' in page)) {
      set((s) => store.unpaged(s, channel))
      return messages(channel)
    }
    set((s) => store.mergeThreads(s, channel, page, 'first'))
  }

  /** The next older page, from where the last one said it starts. Whether there's more. */
  async function older(channel: string): Promise<boolean> {
    const listed = store.listingOf(get(), channel)
    if (listed) {
      // Its first page is still on its way: try again once it's in.
      if (!listed.loaded) return true
      if (listed.older === null) return false
      const page = await client.threads({ channel, before: listed.older, limit })
      set((s) => store.mergeThreads(s, channel, page, 'older'))
      return (page.older ?? null) !== null
    }
    const oldest = Object.values(get().messages)
      .filter((m) => m.channel === channel)
      .sort(store.byWritten)[0]
    if (exhausted.has(channel) || !oldest) return false
    await messages(channel, oldest.id)
    return !exhausted.has(channel)
  }

  const hasOlder = (channel: string) => {
    const listed = store.listingOf(get(), channel)
    return listed ? !listed.loaded || listed.older !== null : !exhausted.has(channel)
  }

  /** Reads a channel's first page again, once for every burst that asks while it waits or reads. */
  function refresh(channel: string) {
    const running = refreshing.get(channel)
    if (running) {
      running.again = true
      return
    }
    const entry = { again: true }
    refreshing.set(channel, entry)
    void (async () => {
      try {
        // Asked for again in the same tick: still one read.
        await Promise.resolve()
        while (entry.again) {
          entry.again = false
          const page = await client.threads({ channel, limit })
          set((s) => store.mergeThreads(s, channel, page, 'first'))
        }
      } catch {
        // The next reply to a thread it doesn't have asks again.
      } finally {
        refreshing.delete(channel)
      }
    })()
  }

  /** Folds live events in; a reply to a thread a channel's listing doesn't have reads its first page again. */
  function apply(events: BoardEventView[]) {
    set((s) => events.reduce(store.applyEvent, s))
    const state = get()
    for (const event of events) {
      const channel = store.unlistedReply(state, event)
      if (channel !== null) refresh(channel)
    }
  }

  return { load, older, hasOlder, apply }
}
