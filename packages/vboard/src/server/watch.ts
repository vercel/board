import { idempotentId } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { BoardEventView } from '../api/routes.ts'
import { parseWatchTail } from '../api/tail.ts'
import type { BoardClient } from '../client/client.ts'
import { watchContract, watchSession, type BoardEvent, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, messagesReducer, type Message, type MessagesState } from '../contract/reducers.ts'
import { compileFilter, eventView, foldEvent, hasCriteria, type ParsedFilters } from './feed.ts'
import { deploymentIdentity, type Identity } from './writes.ts'

/** What a watcher's `run` gets. */
export type WatcherContext = {
  /** Exactly what `vb tail --json` prints. */
  event: BoardEventView
  /** Writes as this watcher. */
  board: BoardClient
}

/** A `vb tail` the board runs for you: every event the tail would print, handed to `run`. */
export type Watcher = {
  /**
   * A `vb tail` expression without `vb tail`: `firehose --label status=needs-agent`. `--all` adds
   * delivery receipts, as in `vb tail`: `message.synced` says where a message landed on a platform.
   */
  tail: string
  /**
   * `matches` (the default) runs on every event the tail prints. `enters` runs only when a
   * message enters the view: it didn't match before the event and does after it.
   */
  when?: 'matches' | 'enters'
  run: (context: WatcherContext) => unknown
}

export const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The events a tail shows, receipts included for `--all`: each concerns a message, and carries its thread for the lane. */
const WATCHED = [
  'message.posted',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'labels.changed',
  'message.sync_failed',
  'message.synced',
  'message.files_synced',
] as const

/** Receipts: only a `--all` tail shows them. */
const RECEIPTS = new Set(['message.synced', 'message.files_synced'])

/**
 * A2 dead-letters a handler after 10 failures, and a dead letter stops its
 * lane, which is the thread's: the watcher would never run on that thread
 * again. So `run` gets a few tries, then the failure is recorded and the
 * thread moves on.
 */
const RUN_ATTEMPTS = 5

/**
 * A run that's killed (a timeout, out of memory) never throws, and A2 doesn't
 * count kills toward a dead letter, so it would retry on the thread's lane
 * forever. Attempts count kills too: this many means runs keep dying.
 */
const KILLED_ATTEMPTS = RUN_ATTEMPTS * 2

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

type Match = { id: string; payload: { thread: string; event: unknown } }

/**
 * One match, on its thread's lane: `run`, retried by A2 while it fails, then
 * given up on (recorded as `watch.failed`) so the thread's next event runs.
 */
export async function runMatch(input: {
  watcher: { id: string; run: Watcher['run'] }
  match: Match
  attempt: number
  board: () => BoardClient
  record: (failure: { matched: string; thread: string; error: string }) => Promise<unknown>
}) {
  const { watcher, match, attempt } = input
  const event = match.payload.event as BoardEventView
  const giveUp = async (error: string) => {
    console.error(`[vboard] watcher ${watcher.id} gave up on event #${event.index} after ${attempt} tries:`, error)
    await input.record({ matched: match.id, thread: match.payload.thread, error })
  }
  if (attempt > KILLED_ATTEMPTS) return giveUp(`its run was cut short ${attempt - 1} times (a timeout, or out of memory)`)
  try {
    await watcher.run({ event, board: input.board() })
  } catch (error) {
    if (attempt < RUN_ATTEMPTS) throw error
    await giveUp(describe(error))
  }
}

/** A watcher writes as itself, and its own writes never wake it. */
const identityOf = (id: string): Identity => deploymentIdentity(`vboard:watch:${id}`, id)

/**
 * Watchers: a board-contract handler matches each event against every
 * watcher's filters, the way a tail does, and appends what matched to that
 * watcher's session, where `run` happens on the thread's lane.
 */
export function createWatchers(options: {
  watch: Record<string, Watcher>
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
}) {
  const watchers = Object.entries(options.watch).map(([id, watcher]) => {
    if (!ID.test(id)) throw new Error(`watch: ids use lowercase letters, numbers, - and _, got: ${id}`)
    let filters: ParsedFilters
    let all: boolean
    try {
      ;({ filters, all } = parseWatchTail(watcher.tail))
    } catch (error) {
      throw new Error(`watch ${id}: ${(error as Error).message}`)
    }
    if (filters.mentions === 'me') throw new Error(`watch ${id}: a watcher has no "me": use --mentions @handle`)
    const criteria = hasCriteria(filters)
    if (watcher.when === 'enters' && !criteria) throw new Error(`watch ${id}: \`when: enters\` needs a filter to enter`)
    return { id, filters, criteria, enters: watcher.when === 'enters', all, identity: identityOf(id), run: watcher.run }
  })
  const byId = new Map(watchers.map((watcher) => [watcher.id, watcher]))

  let clientAs: ((identity: Identity, trigger: string) => BoardClient) | null = null

  const server = createServer({
    contract: watchContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      'watch.matched': {
        lane: ({ event }) => `thread:${event.payload.thread}`,
        handler: async (ctx) => {
          // A watcher removed from config since it matched has nothing left to run.
          const watcher = byId.get(ctx.session.id.slice('watch:'.length))
          if (!watcher) return
          const bound = clientAs
          if (!bound) throw new Error('watchers used before the board bound them')
          await runMatch({
            watcher,
            match: ctx.event,
            attempt: ctx.attempt,
            board: () => bound(watcher.identity, ctx.event.id),
            record: (payload) => ctx.session.append(`failed:${ctx.event.id}`, { type: 'watch.failed', payload }),
          })
        },
      },
    },
  })

  /** Matches one board event; the message before or after it must match, as in a tail. */
  async function dispatch(ctx: HandlerContext<BoardEvents>) {
    const event = ctx.event as BoardEvent
    const through = event.index - 1
    const [{ state: messages }, { state: actors }] = await Promise.all([
      ctx.session.state(messagesReducer, { through }),
      ctx.session.state(actorsReducer, { through }),
    ])
    const { id, before, after } = foldEvent(messages, actors, event)
    const by = (event.payload as { by?: { actor?: string } }).by?.actor
    let view: BoardEventView | undefined
    for (const watcher of watchers) {
      if (by === watcher.identity.actor.id) continue
      if (RECEIPTS.has(event.type) && !watcher.all) continue
      const match = compileFilter(watcher.filters, { me: null, actors, messages })
      if (watcher.enters ? !entered(match, before, after, messages) : !(watcher.criteria ? match(before) || match(after) : id !== null))
        continue
      view ??= eventView(event, after, actors)
      await server.session(watchSession(watcher.id)).append({
        type: 'watch.matched',
        id: await idempotentId('vboard-watch', watcher.id, event.id),
        payload: { thread: (event.payload as { thread: string }).thread, event: view },
      })
    }
  }

  /** Didn't match before and does now; a new reply only counts if its thread wasn't already in view. */
  function entered(
    match: (message: Message | undefined) => boolean,
    before: Message | undefined,
    after: Message | undefined,
    messages: MessagesState,
  ) {
    if (match(before) || !match(after)) return false
    const root = before === undefined && after!.re !== null ? messages.byId[after!.re] : undefined
    return !match(root)
  }

  const lane = ({ event }: { event: { payload: unknown } }) => `thread:${(event.payload as { thread: string }).thread}`
  /** Board-contract handlers, on the same per-thread lanes as sync's. */
  const boardHandlers = Object.fromEntries(WATCHED.map((type) => [type, { lane, handler: dispatch }]))

  return {
    server,
    boardHandlers,
    ids: watchers.map((watcher) => watcher.id),
    bind: (binding: { clientAs: (identity: Identity, trigger: string) => BoardClient }) => {
      clientAs = binding.clientAs
    },
  }
}
