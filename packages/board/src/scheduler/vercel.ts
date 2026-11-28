import { vercelQueues as a2VercelQueues } from 'experimental-a2/scheduler-vercel'
import type { A2Scheduler } from 'experimental-a2/server'

const ENGINE = Symbol('board.scheduler.engine')
const ATTACH = Symbol('board.scheduler.attach')

/**
 * What runs a board's timers off the process: pass it to `postgres({ scheduler })`, and mount it,
 * as the route its queue calls: `export { scheduler as POST }`.
 */
export type Scheduler = ((request: Request) => Promise<Response>) & { readonly __boardScheduler: true }

/** A scheduler on `engine`, whose route delivers to the board it's passed to. */
export function boardScheduler(engine: A2Scheduler): Scheduler {
  let deliver: ((request: Request) => Promise<Response>) | null = null
  const route = async (request: Request): Promise<Response> => {
    if (!deliver)
      return Response.json(
        { error: { code: 'no_board', message: 'this scheduler serves no board yet: pass it to postgres({ scheduler })' } },
        { status: 500 },
      )
    return deliver(request)
  }
  return Object.assign(route, {
    [ENGINE]: engine,
    [ATTACH]: (to: (request: Request) => Promise<Response>) => {
      if (deliver) throw new Error('this scheduler already serves a board: create one per postgres()')
      deliver = to
    },
  }) as unknown as Scheduler
}

/** The engine's scheduler behind one `boardScheduler()` made. */
export const engineScheduler = (scheduler: Scheduler): A2Scheduler => (scheduler as unknown as { [ENGINE]: A2Scheduler })[ENGINE]

/** Points `scheduler`'s route at the board that runs on it. */
export const attachScheduler = (scheduler: Scheduler, deliver: (request: Request) => Promise<Response>): void =>
  (scheduler as unknown as { [ATTACH]: (to: typeof deliver) => void })[ATTACH](deliver)

export type VercelQueuesOptions = {
  /** The queue topic its timers go on, `[A-Za-z0-9_-]+`: the one the scheduler route's trigger names. Default `board`. */
  topic?: string
}

/**
 * Vercel Queues as a board's scheduler (`npm i @vercel/queue`): scheduled messages, leases running
 * out, and watchers' and sync's retries go out on time with nothing running, each to the
 * deployment that armed it. It's also the route the topic calls: mount it as `POST` in a route of
 * its own, which `vercel.json` gives a `queue/v2beta` trigger on the topic.
 */
export function vercelQueues(options: VercelQueuesOptions = {}): Scheduler {
  return boardScheduler(a2VercelQueues({ topic: options.topic ?? 'board' }))
}
