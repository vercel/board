import { vercelQueues as a2VercelQueues } from 'experimental-a2/scheduler-vercel'
import type { A2Scheduler } from 'experimental-a2/server'

/** What runs a board's timers off the process: pass it to `postgres({ scheduler })`. */
export type Scheduler = { readonly __boardScheduler: true }

/** Mine back from what `vercelQueues()` hands out. */
export const engineScheduler = (scheduler: Scheduler): A2Scheduler => scheduler as unknown as A2Scheduler

export type VercelQueuesOptions = {
  /** The queue topic its timers go on, `[A-Za-z0-9_-]+`: the one the scheduler route's trigger names. Default `board`. */
  topic?: string
}

/**
 * Vercel Queues as a board's scheduler (`npm i @vercel/queue`): scheduled messages, leases running
 * out, and watchers' and sync's retries go out on time with nothing running, each to the
 * deployment that armed it. Mount the backend's `scheduler` in a route the topic triggers.
 */
export function vercelQueues(options: VercelQueuesOptions = {}): Scheduler {
  return a2VercelQueues({ topic: options.topic ?? 'board' }) as unknown as Scheduler
}
