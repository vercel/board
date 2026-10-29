import {
  deliverSchedulerAppend,
  type A2Scheduler,
  type DrainableServer,
  type SchedulerAppendTask,
} from 'experimental-a2/server'

/** A queue that drains right away and holds timers until `fire` delivers the due ones. */
export function fakeQueue() {
  let servers: DrainableServer[] = []
  const timers: SchedulerAppendTask[] = []
  const drain = (contract: string, sessionId: string) =>
    setTimeout(() => void servers.find((s) => s.contract.name === contract)?.drain(sessionId), 0)
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
