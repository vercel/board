import {
  deliverSchedulerAppend,
  type A2Scheduler,
  type DrainableServer,
  type SchedulerAppendTask,
} from 'experimental-a2/server'
import { waitUntil } from '../src/server/wait-until.ts'

/** A queue that drains right away and holds timers until `fire` delivers the due ones. */
export function fakeQueue() {
  let servers: DrainableServer[] = []
  const timers: SchedulerAppendTask[] = []
  // A drain the queue starts runs on after it's asked for, as a function the queue invokes does: the
  // platform keeps it, so `backgroundWork` waits for it with the rest.
  const drain = (contract: string, sessionId: string) =>
    waitUntil(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const run = Promise.resolve(servers.find((s) => s.contract.name === contract)?.drain(sessionId))
          // It ends either way; a drain that throws still throws where nothing awaits it, as before.
          void run.then(
            () => resolve(),
            (error: unknown) => {
              resolve()
              throw error
            },
          )
        }, 0),
      ),
    )
  const scheduler: A2Scheduler = {
    schedule: async (task) => {
      if (task.kind === 'drain') drain(task.contract, task.sessionId)
      // board never clears a session, so the only other task is a timer.
      else if (task.kind === 'append' && !timers.some((t) => t.id === task.id)) timers.push(task)
    },
    handler: (...mounted) => {
      servers = mounted
      // A delivery through the board's scheduler route: the task is the body.
      return async (request) => {
        const task = (await request.json()) as SchedulerAppendTask
        await deliverSchedulerAppend(servers.find((s) => s.contract.name === task.contract)!, task)
        return new Response(null, { status: 204 })
      }
    },
  }
  return {
    scheduler,
    timers,
    /**
     * Delivers every timer due by now, as the queue would: straight to the A2 server, or through
     * `route`, a board's scheduler callback, the way Vercel Queues reaches a deployment.
     */
    async fire(route?: (request: Request) => Promise<Response>) {
      const due = timers.filter((t) => t.dueAt <= Date.now())
      for (const task of due) {
        timers.splice(timers.indexOf(task), 1)
        if (route) await route(new Request('https://queue.test/', { method: 'POST', body: JSON.stringify(task) }))
        else await deliverSchedulerAppend(servers.find((s) => s.contract.name === task.contract)!, task)
      }
      return due.length
    },
  }
}

/**
 * Keeps the work a board and A2 hand the platform to run on after a response, as Vercel's request
 * context does (`waitUntil`), so a test waits for that work to end instead of for time to pass: a
 * write's drain, the timer it arms, and a fake queue's drains. `stop` puts the global back.
 */
export function backgroundWork() {
  const context = Symbol.for('@vercel/request-context')
  const before = Reflect.get(globalThis, context) as unknown
  const running = new Set<Promise<unknown>>()
  const keep = (task: Promise<unknown>) => {
    running.add(task)
    const drop = () => void running.delete(task)
    void task.then(drop, drop)
  }
  Reflect.set(globalThis, context, { get: () => ({ waitUntil: keep }) })
  return {
    /** Resolves once nothing kept is running: work that sets off more is waited for too, however long the machine takes. */
    async settled() {
      while (running.size > 0) await Promise.allSettled([...running])
    },
    stop() {
      if (before === undefined) Reflect.deleteProperty(globalThis, context)
      else Reflect.set(globalThis, context, before)
    },
  }
}
