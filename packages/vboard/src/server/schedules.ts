import { idempotentId, reducer } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import type { ScheduleBodyOutput, ScheduleView, SchedulesQueryOutput } from '../api/routes.ts'
import { duration } from '../client/client.ts'
import {
  SCHEDULES_SESSION,
  schedulesContract,
  type ScheduleEvent,
  type ScheduleEvents,
} from '../contract/contract.ts'
import { actorKind, type Attachment, type Author, type Labels } from '../contract/schemas.ts'
import { authorize, type Access } from './access.ts'
import type { Principal } from './auth.ts'
import { actorsReducer, type ActorsState } from '../contract/reducers.ts'
import { replaceMentions } from '../contract/mentions.ts'
import { resolveMentions } from './actors.ts'
import { badRequest, HttpError, notFound } from './errors.ts'
import { authorizePost, deploymentIdentity, writePost, type Identity, type WriteContext } from './writes.ts'
import { DroppedError } from './middleware.ts'
import { waitUntil } from './wait-until.ts'

/** Vercel Queues delays at most 6 days: a send further out than this goes in hops. */
export const MAX_HOP_MS = 5 * 86_400_000
/** The shortest repeat, so a typo can't flood a thread. */
export const MIN_EVERY_MS = 60_000
/** How far out a schedule reaches: its first send, stop, and repeat. Keeps every time a real date. */
export const MAX_AHEAD_MS = 366 * 86_400_000
/** A timer that fires this early just waits again; any closer counts as on time. */
const EARLY_MS = 1000

export type Schedule = {
  id: number
  channel: string
  re: number | null
  text: string
  labels: Labels
  noSync: boolean
  attachments: Attachment[]
  first: number
  every: number | null
  until: number | null
  times: number | null
  /** Its creator, as plain data: A2 snapshots state, and each send works out the access again. */
  as: Omit<Identity, 'principal'> & { principal: Omit<Principal, 'access'> }
  createdAt: string
  /** Its creator couldn't read its channel when it scheduled it. */
  blind: boolean
  /** Sends posted so far. */
  sent: number
  /** When the next send is due, or null when it's done or canceled. */
  next: number | null
  /** The last message it posted. */
  last: number | null
  canceled: { by: Author; reason: 'canceled' | 'thread_deleted' | 'dropped' | 'revoked' } | null
}

export type SchedulesState = { byId: Record<string, Schedule> }

const identityOf = (as: ScheduleEvent & { type: 'schedule.created' }): Schedule['as'] => {
  const { author, principal, actor } = as.payload.as
  return {
    author,
    principal: { ...principal, expiresAt: null },
    actor: { ...actor, kind: actorKind(actor.kind) },
  }
}

export function foldSchedules(state: SchedulesState, event: ScheduleEvent): SchedulesState {
  switch (event.type) {
    case 'schedule.created': {
      const { payload } = event
      state.byId[event.index] = {
        id: event.index,
        channel: payload.channel,
        re: payload.re,
        text: payload.text,
        labels: { ...payload.labels },
        noSync: payload.noSync,
        attachments: payload.attachments ?? [],
        first: payload.first,
        every: payload.every,
        until: payload.until,
        times: payload.times,
        as: identityOf(event),
        createdAt: new Date(event.createdAt).toISOString(),
        blind: payload.blind ?? false,
        sent: 0,
        next: payload.first,
        last: null,
        canceled: null,
      }
      return state
    }
    case 'schedule.canceled': {
      const schedule = state.byId[event.payload.id]
      if (!schedule || schedule.next === null) return state
      schedule.next = null
      schedule.canceled = { by: event.payload.by, reason: event.payload.reason }
      return state
    }
    case 'schedule.fired': {
      const schedule = state.byId[event.payload.id]
      if (!schedule || schedule.next === null || schedule.sent !== event.payload.n) return state
      schedule.sent++
      schedule.last = event.payload.message
      schedule.next = event.payload.next
      return state
    }
    default:
      return state
  }
}

export const schedulesReducer = reducer({ contract: schedulesContract, name: 'vboard.schedules.v1', initialState: { byId: {} } as SchedulesState })
  .fold(foldSchedules)

/** The send after one due at `at`: the next slot after now, so downtime skips missed slots instead of replaying them. */
export function nextSend(schedule: Pick<Schedule, 'every' | 'until' | 'times'>, n: number, at: number, now: number): number | null {
  if (schedule.every === null) return null
  if (schedule.times !== null && n + 1 >= schedule.times) return null
  const next = at + schedule.every * Math.max(1, Math.floor((now - at) / schedule.every) + 1)
  return schedule.until !== null && next > schedule.until ? null : next
}

/**
 * Whether `principal` is the schedule's creator, as far as seeing and canceling
 * it goes. A principal ID is coarser than access (a repo's workflows share one,
 * and so do the proxies narrowing one token with `x-board-scope`), so it also
 * needs `post` there now, as it would to create it. Where it can't read, the
 * schedule is its own only if it was created without reading too, so a
 * principal ID shared with a caller that reads doesn't reach that caller's.
 */
export const createdBy = (schedule: Schedule, principal: Pick<Principal, 'id' | 'access'>) =>
  schedule.as.principal.id === principal.id &&
  principal.access.can('post', schedule.channel) &&
  (schedule.blind || principal.access.readable(schedule.channel))

export const scheduleView = (schedule: Schedule, actors: ActorsState): ScheduleView => {
  const author = actors.byId[schedule.as.actor.id] ?? schedule.as.actor
  return {
    id: schedule.id,
    channel: schedule.channel,
    re: schedule.re,
    text: schedule.text,
    labels: { ...schedule.labels },
    noSync: schedule.noSync,
    attachments: schedule.attachments,
    first: new Date(schedule.first).toISOString(),
    every: schedule.every,
    until: schedule.until === null ? null : new Date(schedule.until).toISOString(),
    times: schedule.times,
    sent: schedule.sent,
    next: schedule.next === null ? null : new Date(schedule.next).toISOString(),
    last: schedule.last,
    state: schedule.canceled ? 'canceled' : schedule.next === null ? 'done' : 'pending',
    canceled: schedule.canceled,
    by: schedule.as.author,
    author: { kind: author.kind, handle: author.handle, name: author.name, avatar: author.avatar },
    createdAt: schedule.createdAt,
  }
}

const SYSTEM = deploymentIdentity('vboard:schedule', 'schedule')

/** The board's `accessNow`: a stored creator's access under the rules as they are now, or null. */
type AccessNow = (principal: Pick<Principal, 'id' | 'kind' | 'facts' | 'scope'>) => Promise<Access | null>

/** A refusal (a 403, or a 404 for a thread the creator can no longer read) as null; anything else still throws. */
const refused = (error: unknown): null => {
  if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return null
  throw error
}

/**
 * Scheduled messages: `schedule.created` arms the first send as an A2 timer, and
 * each `schedule.due` posts as the schedule's creator, then arms the next.
 */
export function createSchedules(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  let writes: WriteContext | null = null
  let accessNow: AccessNow | null = null

  /** Arms send `n`, due at `at`: the whole way, or one hop toward it. */
  async function arm(ctx: ConsumerContext<ScheduleEvents>, name: string, id: number, n: number, at: number) {
    const hop = Math.min(at, Date.now() + MAX_HOP_MS)
    await ctx.session.schedule(name, { at: new Date(Math.max(hop, Date.now())) }, { type: 'schedule.due', payload: { id, n, at } })
  }

  async function due(ctx: ConsumerContext<ScheduleEvents, 'schedule.due'>) {
    if (!writes || !accessNow) throw new Error('schedules used before the board bound them')
    const { id, n, at } = ctx.event.payload
    const { state } = await ctx.session.state(schedulesReducer)
    const schedule = state.byId[id]
    // Canceled, done, or a stale timer for a send already made.
    if (!schedule || schedule.next !== at || schedule.sent !== n) return
    if (Date.now() < at - EARLY_MS) return arm(ctx, 'hop', id, n, at)

    if (schedule.re !== null) {
      const root = await writes.reads.message(schedule.re, ctx.signal)
      if (!root || root.deleted) {
        await ctx.session.append('ended', {
          type: 'schedule.canceled',
          payload: { id, by: SYSTEM.author, reason: 'thread_deleted' },
        })
        return
      }
    }
    // Each send has its creator's access under the rules as they are now, never what it had then.
    const access = await accessNow(schedule.as.principal)
    const target = schedule.re === null ? { channel: schedule.channel } : { re: schedule.re }
    const proofs = access && (await authorizePost(writes, access, { ...target, labels: schedule.labels }).catch(refused))
    if (!access || !proofs) {
      console.info(`[vboard] schedule s${id}'s creator can no longer post it in ${schedule.channel}`)
      await ctx.session.append('ended', { type: 'schedule.canceled', payload: { id, by: SYSTEM.author, reason: 'revoked' } })
      return
    }
    // A retry after the post landed gets the same event ID, so A2 hands back the message it already posted.
    let posted: number
    try {
      posted = (
      await writePost(writes, {
        via: { kind: 'schedule', id },
        identity: { ...schedule.as, principal: { ...schedule.as.principal, access } },
        proofs,
        id: await idempotentId('vboard-schedule', String(id), String(n)),
        ...(schedule.re === null ? { channel: schedule.channel } : { re: schedule.re }),
        text: schedule.text,
        labels: schedule.labels,
        noSync: schedule.noSync,
        ...(schedule.attachments.length ? { attachments: schedule.attachments } : {}),
        schedule: { id, n },
        // Checked when it was scheduled; a handle that's ambiguous since stays plain text.
        lenientMentions: true,
      })
    ).id
    } catch (error) {
      if (!(error instanceof DroppedError)) throw error
      // Its text never changes, so the middleware would drop every send after this one too.
      console.info(`[vboard] the middleware dropped schedule s${id}: ${error.message}`)
      await ctx.session.append('ended', { type: 'schedule.canceled', payload: { id, by: SYSTEM.author, reason: 'dropped' } })
      return
    }
    const next = nextSend(schedule, n, at, Date.now())
    await ctx.session.append('fired', { type: 'schedule.fired', payload: { id, n, message: posted, next } })
    if (next !== null) await arm(ctx, 'next', id, n + 1, next)
  }

  /**
   * Arms each schedule's next send, as the schedule stands now, from the first schedule on: a queue
   * delivers a timer to the deployment that armed it, so one an earlier deployment armed may never
   * reach this one. The deployment that gets there first sends, and `due` makes the other's a no-op.
   */
  const arming = consumer({
    contract: schedulesContract,
    name: 'vboard-schedules',
    types: ['schedule.created'],
    lane: 'schedules',
    backfill: true,
  }).run(async (ctx) => {
    if (!options.scheduler) return
    // Latest, not through `schedule.created`: one that has sent since waits on a later send.
    const { state } = await ctx.session.state(schedulesReducer, { through: 'latest' })
    const schedule = state.byId[ctx.event.index]
    if (!schedule || schedule.next === null) return
    await arm(ctx, 'first', schedule.id, schedule.sent, schedule.next)
  })

  /** Makes each due send, one schedule at a time. */
  const sending = consumer({
    contract: schedulesContract,
    name: 'vboard-schedule-sends',
    types: ['schedule.due'],
    lane: ({ event }) => `schedule:${event.payload.id}`,
  }).run(due)

  const server = createServer({
    contract: schedulesContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [arming, sending],
  })
  const session = server.session(SCHEDULES_SESSION)

  /**
   * The first request on an instance starts the arming catching up, and doesn't wait: on the
   * first deploy with it, every schedule from before gets its next send armed here.
   */
  let catching: Promise<unknown> | null = null
  function catchUp(): void {
    if (catching || !options.scheduler) return
    catching = session.consume(arming).catch((error: unknown) => {
      console.warn('[vboard] schedules are not caught up:', (error as Error).message)
      catching = null
    })
    waitUntil(catching)
  }

  /** `visible`: which schedules the caller may see. */
  async function list(query: SchedulesQueryOutput & { root?: number }, visible: (schedule: Schedule) => boolean = () => true) {
    if (!writes) throw new Error('schedules used before the board bound them')
    const [{ state }, { state: actors }] = await Promise.all([
      session.state(schedulesReducer),
      writes.session.state(actorsReducer),
    ])
    return Object.values(state.byId)
      .filter(visible)
      .filter((s) => (query.all ? true : s.next !== null))
      .filter((s) => (query.root === undefined ? true : s.re === query.root))
      .filter((s) => (query.channel === undefined ? true : s.channel === query.channel))
      .filter((s) => (query.by === undefined ? true : s.as.actor.id === query.by || s.as.actor.handle.toLowerCase() === query.by.toLowerCase()))
      .sort((a, b) => a.id - b.id)
      .map((s) => scheduleView(s, actors))
  }

  return {
    server,
    session,
    catchUp,
    bind: (binding: { writes: WriteContext; accessNow: AccessNow }) => {
      writes = binding.writes
      accessNow = binding.accessNow
    },
    list,
    /** The pending schedules that reply in the thread rooted at `root`. */
    forThread: (root: number) => list({ root }),

    async create(
      identity: Identity,
      body: ScheduleBodyOutput,
      attachments: Attachment[],
    ): Promise<{ schedule: ScheduleView; unknownMentions?: string[] }> {
      if (!writes) throw new Error('schedules used before the board bound them')
      if (!options.scheduler) throw new HttpError(501, 'no_scheduler', 'this board has no scheduler, so it can\'t schedule messages')
      const now = Date.now()
      const every = body.every === undefined ? null : duration(body.every)
      if (every !== null && every < MIN_EVERY_MS) throw badRequest('`every` is at least 1m')
      if (every !== null && every > MAX_AHEAD_MS) throw badRequest('`every` is at most a year')
      const first = body.at !== undefined ? Date.parse(body.at) : now + duration(body.in ?? body.every!)
      if (first < now - 60_000) throw badRequest('`at` is in the past')
      const until = body.until !== undefined ? Date.parse(body.until) : body.for !== undefined ? first + duration(body.for) : null
      if (until !== null && until < first) throw badRequest('the schedule stops before its first send')
      if (first > now + MAX_AHEAD_MS || (until !== null && until > now + MAX_AHEAD_MS))
        throw badRequest('a schedule reaches at most a year out: its first send and its stop')

      // Mentions fail now, where the person scheduling sees it, not at send time.
      // A handle nobody has stays plain text, and they hear about it now too.
      const { state: known } = await writes.session.state(actorsReducer)
      const withoutEmails = replaceMentions(body.text, (t) => (t.kind === 'actor' && t.actor.includes('@') ? t.actor : null))
      const { unknown } = resolveMentions(withoutEmails, known, identity.actor, false, identity.principal.access.readsAll)

      let channel = body.channel
      let re: number | null = null
      if (body.re !== undefined) {
        const target = await writes.reads.message(body.re)
        if (!target || target.deleted) throw notFound(`message not found: #${body.re}`, 'message_not_found')
        re = target.re ?? target.id
        channel = target.channel
      }
      const [row] = await session.append({
        type: 'schedule.created',
        payload: {
          channel: channel!,
          re,
          text: body.text,
          labels: body.labels ?? {},
          noSync: body.noSync ?? false,
          ...(attachments.length ? { attachments } : {}),
          first,
          every,
          until,
          times: body.times ?? null,
          as: {
            author: identity.author,
            principal: {
              id: identity.principal.id,
              kind: identity.principal.kind,
              handle: identity.principal.handle,
              ...(identity.principal.facts ? { facts: identity.principal.facts } : {}),
              ...(identity.principal.scope !== undefined ? { scope: identity.principal.scope } : {}),
            },
            actor: identity.actor,
          },
          ...(identity.principal.access.readable(channel!) ? {} : { blind: true as const }),
        },
      })
      const { state } = await session.state(schedulesReducer)
      const { state: actors } = await writes.session.state(actorsReducer)
      const schedule = scheduleView(state.byId[row!.index]!, actors)
      // Which handles matched no one says which ones exist: only for a caller that reads the channel.
      return unknown.length && identity.principal.access.readable(channel!) ? { schedule, unknownMentions: unknown } : { schedule }
    },

    /**
     * Its creator may cancel it while they can post there, and so may `manage`
     * in its channel. Anyone else gets 403 where they can read it, and 404
     * where they can't. Canceling twice is a no-op.
     */
    async cancel(identity: Identity, id: number): Promise<{ schedule: ScheduleView; canceled: boolean }> {
      if (!writes) throw new Error('schedules used before the board bound them')
      const { state } = await session.state(schedulesReducer)
      const schedule = state.byId[id]
      const missing = () => notFound(`schedule not found: s${id}`, 'schedule_not_found')
      if (!schedule) throw missing()
      if (!createdBy(schedule, identity.principal)) authorize(identity.principal.access, 'manage', schedule.channel, missing)
      const canceled = schedule.next !== null
      if (canceled) await session.append({ type: 'schedule.canceled', payload: { id, by: identity.author, reason: 'canceled' } })
      const { state: after } = await session.state(schedulesReducer)
      const { state: actors } = await writes.session.state(actorsReducer)
      return { schedule: scheduleView(after.byId[id]!, actors), canceled }
    },
  }
}
