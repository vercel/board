import { idempotentId, reducer } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { ScheduleBodyOutput, ScheduleView, SchedulesQueryOutput } from '../api/routes.ts'
import { duration } from '../client/client.ts'
import {
  SCHEDULES_SESSION,
  schedulesContract,
  type ScheduleEvent,
  type ScheduleEvents,
} from '../contract/contract.ts'
import { actorKind, type Attachment, type Author, type Labels } from '../contract/schemas.ts'
import { FULL_ACCESS } from './access.ts'
import { actorsReducer, messagesReducer, type ActorsState } from '../contract/reducers.ts'
import { replaceMentions } from '../contract/mentions.ts'
import { resolveMentions } from './actors.ts'
import { badRequest, HttpError, notFound } from './errors.ts'
import { deploymentIdentity, writePost, type Identity, type WriteContext } from './writes.ts'
import { DroppedError } from './middleware.ts'

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
  as: Identity
  createdAt: string
  /** Sends posted so far. */
  sent: number
  /** When the next send is due, or null when it's done or canceled. */
  next: number | null
  /** The last message it posted. */
  last: number | null
  canceled: { by: Author; reason: 'canceled' | 'thread_deleted' | 'dropped' } | null
}

export type SchedulesState = { byId: Record<string, Schedule> }

const identityOf = (as: ScheduleEvent & { type: 'schedule.created' }): Identity => {
  const { author, principal, actor } = as.payload.as
  return {
    author,
    principal: { ...principal, access: FULL_ACCESS, expiresAt: null },
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

/**
 * Scheduled messages: `schedule.created` arms the first send as an A2 timer, and
 * each `schedule.due` posts as the schedule's creator, then arms the next.
 */
export function createSchedules(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  let writes: WriteContext | null = null

  /** Arms send `n`, due at `at`: the whole way, or one hop toward it. */
  async function arm(ctx: HandlerContext<ScheduleEvents>, name: string, id: number, n: number, at: number) {
    const hop = Math.min(at, Date.now() + MAX_HOP_MS)
    await ctx.session.schedule(name, { at: new Date(Math.max(hop, Date.now())) }, { type: 'schedule.due', payload: { id, n, at } })
  }

  async function due(ctx: HandlerContext<ScheduleEvents, 'schedule.due'>) {
    if (!writes) throw new Error('schedules used before the board bound them')
    const { id, n, at } = ctx.event.payload
    const { state } = await ctx.session.state(schedulesReducer)
    const schedule = state.byId[id]
    // Canceled, done, or a stale timer for a send already made.
    if (!schedule || schedule.next !== at || schedule.sent !== n) return
    if (Date.now() < at - EARLY_MS) return arm(ctx, 'hop', id, n, at)

    const { state: messages } = await writes.session.state(messagesReducer)
    if (schedule.re !== null) {
      const root = messages.byId[schedule.re]
      if (!root || root.deleted) {
        await ctx.session.append('ended', {
          type: 'schedule.canceled',
          payload: { id, by: SYSTEM.author, reason: 'thread_deleted' },
        })
        return
      }
    }
    // A retry after the post landed gets the same event ID, so A2 hands back the message it already posted.
    let posted: number
    try {
      posted = (
      await writePost(writes, {
        via: { kind: 'schedule', id },
        identity: schedule.as,
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

  const server = createServer({
    contract: schedulesContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      'schedule.created': {
        lane: 'schedules',
        handler: async (ctx) => {
          if (!options.scheduler) return
          await arm(ctx, 'first', ctx.event.index, 0, ctx.event.payload.first)
        },
      },
      'schedule.due': {
        lane: ({ event }) => `schedule:${event.payload.id}`,
        handler: due,
      },
    },
  })
  const session = server.session(SCHEDULES_SESSION)

  async function list(query: SchedulesQueryOutput & { root?: number }) {
    if (!writes) throw new Error('schedules used before the board bound them')
    const [{ state }, { state: actors }] = await Promise.all([
      session.state(schedulesReducer),
      writes.session.state(actorsReducer),
    ])
    return Object.values(state.byId)
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
    bind: (binding: { writes: WriteContext }) => {
      writes = binding.writes
    },
    list,
    /** The pending schedules that reply in the thread rooted at `root`. */
    forThread: (root: number) => list({ root }),

    async create(identity: Identity, body: ScheduleBodyOutput, attachments: Attachment[]): Promise<ScheduleView> {
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
      const { state: known } = await writes.session.state(actorsReducer)
      const withoutEmails = replaceMentions(body.text, (t) => (t.kind === 'actor' && t.actor.includes('@') ? t.actor : null))
      resolveMentions(withoutEmails, known, identity.actor)

      let channel = body.channel
      let re: number | null = null
      if (body.re !== undefined) {
        const { state: messages } = await writes.session.state(messagesReducer)
        const target = messages.byId[body.re]
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
            principal: { id: identity.principal.id, kind: identity.principal.kind, handle: identity.principal.handle },
            actor: identity.actor,
          },
        },
      })
      const { state } = await session.state(schedulesReducer)
      const { state: actors } = await writes.session.state(actorsReducer)
      return scheduleView(state.byId[row!.index]!, actors)
    },

    /** Anyone may cancel: the board has no per-person permissions. Canceling twice is a no-op. */
    async cancel(identity: Identity, id: number): Promise<{ schedule: ScheduleView; canceled: boolean }> {
      if (!writes) throw new Error('schedules used before the board bound them')
      const { state } = await session.state(schedulesReducer)
      const schedule = state.byId[id]
      if (!schedule) throw notFound(`schedule not found: s${id}`, 'schedule_not_found')
      const canceled = schedule.next !== null
      if (canceled) await session.append({ type: 'schedule.canceled', payload: { id, by: identity.author, reason: 'canceled' } })
      const { state: after } = await session.state(schedulesReducer)
      const { state: actors } = await writes.session.state(actorsReducer)
      return { schedule: scheduleView(after.byId[id]!, actors), canceled }
    },
  }
}
