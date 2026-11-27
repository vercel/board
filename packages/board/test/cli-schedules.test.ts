import { isScheduleId } from '../src/cli/main.ts'
import { describe, expect, it, vi } from 'vitest'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'
import { url, useBoard, vb } from './cli-harness.ts'

useBoard()

describe('cli schedules', () => {
  it('schedules a reply, shows it in the thread, sends it, and cancels a repeat', async () => {
    const queue = fakeQueue()
    const scheduled = await serve(testBoard({ url: undefined, scheduler: queue.scheduler }).fetch)
    const board = `${scheduled.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    try {
      const root = (await vb(['post', 'dev', 'PR #12 is open'], as)).stdout.trim()
      const once = await vb(['schedule', root, 'friendly ping: review?', '--in', '1s'], as)
      expect(once).toMatchObject({ code: 0, stderr: '' })
      expect(once.stdout).toMatch(new RegExp(`^s\\d+  #${root} · once · next in 1s \\(.+\\) · by u_julian\\n    friendly ping: review\\?\\n$`))
      const repeat = await vb(['schedule', root, 'check prod', '--every', '30m', '--for', '1d', '--json'], as)
      const { id } = JSON.parse(repeat.stdout).schedule
      expect(id).toMatch(/^s\d+$/)

      const before = (await vb(['read', root], as)).stdout
      expect(before).toContain('  s1  #')
      expect(before).toContain(`  ${id}  #${root} · every 30m · until `)
      expect((await vb(['schedules', root], as)).stdout.match(/^s\d+  /gm)).toHaveLength(2)
      // `--by me` is the caller's own and nobody else's: not what their agent scheduled.
      const agents = await vb(['schedule', 'elsewhere', 'from the agent', '--in', '1h', '--as', 'claude', '--json'], as)
      const theirs = JSON.parse(agents.stdout).schedule.id
      const mine = (await vb(['schedules', '--by', 'me'], as)).stdout
      expect(mine.match(/^s\d+  /gm)).toHaveLength(2)
      expect(mine).not.toContain(`${theirs}  `)
      expect((await vb(['schedules', '--by', 'me', '--as', 'claude'], as)).stdout).toMatch(new RegExp(`^${theirs}  new thread in elsewhere`))
      expect((await vb(['schedule', 'cancel', theirs, '--as', 'claude'], as)).stdout).toBe(`canceled ${theirs}\n`)

      await new Promise((resolve) => setTimeout(resolve, 1100))
      await queue.fire()
      await vi.waitFor(async () => expect((await vb(['read', root], as)).stdout).toMatch(/↳ #\d+  u_julian · \d+s · scheduled s1\n {4}friendly ping: review\?/))

      // What `schedules` prints cancels it, as do the bare number an older client sends and the `ss2` an older CLI prints.
      expect((await vb(['schedule', 'cancel', id], as)).stdout).toBe(`canceled ${id}\n`)
      for (const given of [id.slice(1), `s${id}`]) expect((await vb(['schedule', 'cancel', given], as)).stdout).toBe(`${id} is already canceled\n`)
      expect((await vb(['schedules', root], as)).stdout).toBe('no pending schedules\n')
      expect((await vb(['schedules', '--all'], as)).stdout).toMatch(/· done · 1 sent · by u_julian[\s\S]*· canceled · by u_julian/)
      // Its own ID shows the one schedule, canceled as it is: how to see that a cancel went through.
      expect(await vb(['schedules', id], as)).toMatchObject({ code: 0, stdout: expect.stringMatching(new RegExp(`^${id}  #${root} · every 30m[^\\n]* · canceled · by u_julian\\n`)) })
      expect((await vb(['schedules', id.toUpperCase()], as)).stdout).toMatch(new RegExp(`^${id}  #${root} · every 30m`))
      expect(await vb(['schedules', 's99999'], as)).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: Couldn't find schedule s99999\.\n/) })
      // Vercel's board names a schedule sch_…: that is one too, and no message's ID (a number, or msg_…) is.
      expect(['s12', 'S12', 'sch_01HZX3'].every(isScheduleId)).toBe(true)
      expect(['12', '#12', 'msg_ab12_3', 'schedules', 's', 'standup'].some(isScheduleId)).toBe(false)

      expect(await vb(['schedule', root, 'when?'], as)).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Can't schedule a message without a time: pass --in 1d, --at <time>, or --every 30m\.\n/) })
      expect((await vb(['schedule', root, 'x', '--at', 'soonish'], as)).code).toBe(2)
    } finally {
      await scheduled.close()
    }
  }, 30_000)

  it('says so when the board has no scheduler', async () => {
    // A board on a2() without one: a local board always has one.
    const unscheduled = await serve(testBoard({ url: undefined }).fetch)
    const board = `${unscheduled.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    try {
      const root = (await vb(['post', 'dev', 'no queue here'], as)).stdout.trim()
      const later = await vb(['schedule', root, 'later', '--in', '1h', '--json'], as)
      expect(later).toMatchObject({ code: 1, stdout: '' })
      expect(JSON.parse(later.stderr)).toMatchObject({
        reason: 'no_scheduler',
        message: `Can't schedule a message in #${root}. This board doesn't support it.`,
        data: { error: { message: "this board has no scheduler, so it can't send later" } },
      })
    } finally {
      await unscheduled.close()
    }
  })
})
