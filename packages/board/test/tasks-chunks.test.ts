import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { board, createTasksInChunks, TasksInChunksError, type TaskInBatch } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'
import { as, fakeMessageboard } from './messageboard.ts'
import { fakeQueue } from './queue.ts'

// createTasksInChunks: a plan longer than one batch holds, made with a handle's own tasks.createMany.

type Batch = { id?: string; tasks: { key?: string; text: string; needs?: (string | { key: string })[] }[] }

/**
 * A person's handle on a local board, every batch it sent, and `fail`: what a test sets to answer
 * the next batch request itself, in place of the board.
 */
function localTeam() {
  const kept = testBoard({ scheduler: fakeQueue().scheduler })
  const sent: Batch[] = []
  const front: { fail: ((request: Request, nth: number) => Response | null | Promise<Response | null>) | null } = { fail: null }
  const team = board({
    backend: http(BOARD_URL, {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        request.headers.set('authorization', `Bearer ${await personToken('u_ada')}`)
        if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/tasks/batch')) {
          sent.push((await request.clone().json()) as Batch)
          const answered = await front.fail?.(request, sent.length)
          if (answered) return answered
        }
        return kept.fetch(request)
      },
    }),
  }).as(null)
  return { team, sent, front, kept }
}

/** A plan of `count` steps, each waiting for the one before it, and the first for the last of all: no order as given makes it. */
const steps = (count: number): TaskInBatch[] =>
  Array.from({ length: count }, (_, n) => ({ key: `step-${n}`, text: `step ${n}`, ...(n > 1 ? { needs: [{ key: `step-${n - 1}` }] } : n === 1 ? {} : { needs: [{ key: `step-${count - 1}` }] }) }))

const all = async (team: ReturnType<typeof board>, channel = 'work'): Promise<MessageView[]> => {
  const found: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ channel, state: 'all', limit: 500, ...(after !== undefined ? { after } : {}) })
    found.push(...page.tasks.map((task) => task.message))
    if (page.tasks.length < 500) return found
    after = page.cursor
  }
}

describe('createTasksInChunks', () => {
  it('makes a plan longer than a batch holds in as many batches as it takes: each task after the ones it waits for, and those an earlier batch made named by their IDs', async () => {
    const { team, sent } = localTeam()
    const plan = steps(230)
    const made = await createTasksInChunks(team, 'work', plan)
    // The tasks, in the order given, each waiting for the task its key named, whichever batch made that one.
    expect(made.map((root) => root.text)).toEqual(plan.map((task) => task.text))
    expect(made.map((root) => root.task?.needs)).toEqual(made.map((_, n) => (n > 1 ? [made[n - 1]!.id] : n === 1 ? [] : [made[229]!.id])))
    expect(made.map((root) => root.task?.state)).toEqual(made.map((_, n) => (n === 1 ? 'ready' : 'waiting')))
    expect((await all(team)).map((root) => root.id).sort()).toEqual(made.map((root) => root.id).sort())
    // Three batches, none over what one holds. The first step waits for the last, so it's made last, after it.
    expect(sent.map((batch) => batch.tasks.length)).toEqual([100, 100, 30])
    expect([sent[0]!.tasks[0]!.text, sent[2]!.tasks.at(-1)!.text]).toEqual(['step 1', 'step 0'])
    // Within a batch a task names another by its place there; across batches, by the ID that one got. The plan's
    // last task says the plan ends with it.
    expect(sent[0]!.tasks[1]).toEqual({ key: '1', text: 'step 2', needs: [{ key: '0' }] })
    expect(sent[1]!.tasks[0]).toEqual({ key: '0', text: 'step 101', needs: [made[100]!.id] })
    expect(sent[2]!.tasks.at(-1)).toEqual({ key: 'end', text: 'step 0', needs: [{ key: '28' }] })
    expect(sent.flatMap((batch) => batch.tasks.map((task) => task.key)).filter((key) => key === 'end')).toHaveLength(1)
    // A task waits for what was there by its ID, as it's given.
    const [after] = await createTasksInChunks(team, 'work', [{ text: 'after the plan', needs: [made[0]!.id] }])
    expect(after!.task).toMatchObject({ state: 'waiting', needs: [made[0]!.id] })
  })

  it("halves a batch a board says is more than it holds, as Vercel's does by what its tasks carry, and goes on from there", async () => {
    const api = fakeMessageboard()
    const sent: Batch[] = []
    const team = board({
      backend: vercel({
        team: 'team_test',
        api: 'http://localhost',
        files: api.files,
        fetch: async (input, init) => {
          const request = new Request(input, init)
          if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/tasks/batch')) sent.push((await request.clone().json()) as Batch)
          return as(api, 'user:u_jb')(input, init)
        },
      }),
    })
    const plan = steps(40)
    const made = await createTasksInChunks(team, 'plans', plan)
    expect(made.map((root) => root.text)).toEqual(plan.map((task) => task.text))
    expect(made.map((root) => root.task?.needs)).toEqual(made.map((_, n) => (n > 1 ? [made[n - 1]!.id] : n === 1 ? [] : [made[39]!.id])))
    // 40, 25, and 13 were more than one of the API's writes holds: it made none of those, and took them seven at a time.
    expect(sent.map((batch) => batch.tasks.length)).toEqual([40, 25, 13, 7, 7, 7, 7, 7, 5])
    expect((await team.tasks.list({ channel: 'plans', state: 'all', limit: 100 })).tasks).toHaveLength(40)
    // Long texts are more bytes than one of its requests holds before they're more than it counts: the same refusal, halved the same way.
    sent.length = 0
    const long: TaskInBatch[] = Array.from({ length: 12 }, (_, n) => ({ key: `long-${n}`, text: `${n} ${'x'.repeat(9990)}`, ...(n > 0 ? { needs: [{ key: `long-${n - 1}` }] } : {}) }))
    const texts = await createTasksInChunks(team, 'long', long)
    expect(texts.map((root) => root.text.length)).toEqual(long.map((task) => task.text.length))
    expect(texts.map((root) => root.task?.needs)).toEqual(texts.map((_, n) => (n > 0 ? [texts[n - 1]!.id] : [])))
    expect(sent.map((batch) => batch.tasks.length)).toEqual([12, 7, 4, 4, 4])
  })

  it("keeps a plan's id to its tasks on Vercel's board, where the API tells one request from another: none more once it finished, and the rest of one that stopped", async () => {
    const api = fakeMessageboard()
    const sent: Batch[] = []
    const down = { at: 0 }
    const team = board({
      backend: vercel({
        team: 'team_test',
        api: 'http://localhost',
        files: api.files,
        fetch: async (input, init) => {
          const request = new Request(input, init)
          if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/tasks/batch')) {
            sent.push((await request.clone().json()) as Batch)
            if (sent.length === down.at) return Response.json({ error: { code: 'internal_server_error', message: 'try again' } }, { status: 500 })
          }
          return as(api, 'user:u_jb')(input, init)
        },
      }),
    })
    const ids = async (channel: string) => (await team.tasks.list({ channel, state: 'all', limit: 100 })).tasks.map((task) => task.message.id).sort()
    // 26 plain tasks are four of the API's writes there, seven at a time: the plan ends where the fourth one does.
    const plain = Array.from({ length: 26 }, (_, n): TaskInBatch => ({ text: `plain ${n}` }))
    const whole = await createTasksInChunks(team, 'plain', plain, { id: 'plain-1' })
    expect(sent.map((batch) => batch.tasks.length)).toEqual([26, 25, 13, 7, 7, 7, 5])
    // One more, or as many again: neither is the plan that finished, and none of them is made.
    for (const more of [1, 26])
      await expect(createTasksInChunks(team, 'plain', [...plain, ...Array.from({ length: more }, (_, n) => ({ text: `more ${n}` }))], { id: 'plain-1' })).rejects.toMatchObject({ name: 'TasksInChunksError', code: 'duplicate_id', status: 409 })
    expect(await ids('plain')).toEqual(whole.map((root) => root.id).sort())
    expect((await createTasksInChunks(team, 'plain', plain, { id: 'plain-1' })).map((root) => root.id)).toEqual(whole.map((root) => root.id))
    expect(await ids('plain')).toHaveLength(26)

    // A plan that stops at its second write: the API is down for it, after 40, 25, and 13 were too many and 7 landed.
    const plan = Array.from({ length: 40 }, (_, n): TaskInBatch => ({ text: `step ${n}` }))
    sent.length = 0
    down.at = 5
    const stopped = await createTasksInChunks(team, 'steps', plan, { id: 'steps-1' }).then(
      () => null,
      (error: unknown) => error as TasksInChunksError,
    )
    down.at = 0
    expect(stopped).toMatchObject({ name: 'TasksInChunksError', status: 500 })
    const first = stopped!.created.filter((root) => root !== undefined).map((root) => root.id)
    expect(first).toHaveLength(7)
    expect(await ids('steps')).toEqual([...first].sort())
    // A step it hadn't reached reworded, and a task longer: the write that landed is found by the size it had, whatever
    // the plan's length now, and the rest are made.
    const changed: TaskInBatch[] = [...plan.map((task, n) => (n === 20 ? { text: 'step 20, reworded' } : task)), { text: 'and one more' }]
    const made = await createTasksInChunks(team, 'steps', changed, { id: 'steps-1' })
    expect(made.slice(0, 7).map((root) => root.id)).toEqual(first)
    expect(made.map((root) => root.text)).toEqual(changed.map((task) => task.text))
    expect(await ids('steps')).toEqual(made.map((root) => root.id).sort())
  })

  it("sends each batch under an id made from the caller's and its place, so calling again answers what landed and makes the rest", async () => {
    const { team, sent, front } = localTeam()
    const plan = steps(230)
    // The second batch never reaches the board: the first one landed, and the call fails with what it made.
    front.fail = (_request, nth) => (nth === 2 ? Response.json({ error: { code: 'unavailable', message: 'try again' } }, { status: 503 }) : null)
    const failed = await createTasksInChunks(team, 'work', plan, { id: 'release-42' }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(TasksInChunksError)
    const { created, code, status, message } = failed as TasksInChunksError
    expect([code, status, message]).toEqual(['unavailable', 503, 'try again'])
    // What was made, at each task's own place among those given: steps 1 to 100, and neither step 0 nor the rest.
    expect(created).toHaveLength(230)
    expect(created.map((root) => root?.text)).toEqual(plan.map((task, n) => (n >= 1 && n <= 100 ? task.text : undefined)))
    expect((await all(team)).map((root) => root.id)).toEqual(created.slice(1, 101).map((root) => root!.id))
    // The same call again: the batch that landed is answered, not made again, and the rest are made.
    front.fail = null
    sent.length = 0
    const made = await createTasksInChunks(team, 'work', plan, { id: 'release-42' })
    expect(made.slice(1, 101).map((root) => root.id)).toEqual(created.slice(1, 101).map((root) => root!.id))
    expect(made.map((root) => root.task?.needs)).toEqual(made.map((_, n) => (n > 1 ? [made[n - 1]!.id] : n === 1 ? [] : [made[229]!.id])))
    expect(await all(team)).toHaveLength(230)
    // The batch that landed was found again, not sent again: only the two that hadn't were.
    expect(sent.map((batch) => batch.tasks.length)).toEqual([100, 30])
    // And once more makes nothing: every batch is answered as it stands.
    expect((await createTasksInChunks(team, 'work', plan, { id: 'release-42' })).map((root) => root.id)).toEqual(made.map((root) => root.id))
    expect(await all(team)).toHaveLength(230)
    // Without an id each batch is new: the same plan again is as many tasks again.
    await createTasksInChunks(team, 'work', steps(3))
    await createTasksInChunks(team, 'work', steps(3))
    expect(await all(team)).toHaveLength(236)
  })

  it('refuses other tasks under an id it made a plan with, and makes none of them beside the first ones', async () => {
    const { team } = localTeam()
    const plan = steps(230)
    const made = await createTasksInChunks(team, 'work', plan, { id: 'release-42' })
    const refused = async (other: TaskInBatch[]) =>
      createTasksInChunks(team, 'work', other, { id: 'release-42' }).then(
        () => null,
        (error: unknown) => error as TasksInChunksError,
      )
    // One task more at the end: the batches that are the same are found, and the one that isn't is refused, whole.
    const longer = await refused([...plan, { text: 'one more' }])
    expect(longer).toMatchObject({ name: 'TasksInChunksError', code: 'duplicate_id', status: 409 })
    expect(longer!.created.filter((root) => root !== undefined)).toHaveLength(200)
    // One task changed in the first batch: nothing of the plan is this id's.
    const changed = await refused(plan.map((task, n) => (n === 70 ? { ...task, text: 'another step 70' } : task)))
    expect(changed).toMatchObject({ code: 'duplicate_id', status: 409 })
    expect(changed!.created.every((root) => root === undefined)).toBe(true)
    expect((await all(team)).map((root) => root.id).sort()).toEqual(made.map((root) => root.id).sort())
  })

  it('takes no more tasks under the id of a plan that finished, wherever its batches happened to end', async () => {
    const { team, sent, front } = localTeam()
    const refused = async (channel: string, tasks: TaskInBatch[], id: string) =>
      createTasksInChunks(team, channel, tasks, { id }).then(
        () => null,
        (error: unknown) => error as TasksInChunksError,
      )
    const ids = async (channel: string) => (await all(team, channel)).map((root) => root.id).sort()
    // Two full batches: the plan ends where the second one does. One task more starts where no batch of the first call did.
    const plan = steps(200)
    const made = await createTasksInChunks(team, 'work', plan, { id: 'release-42' })
    expect(sent.map((batch) => batch.tasks.length)).toEqual([100, 100])
    const longer = await refused('work', [...plan, { text: 'one more' }], 'release-42')
    expect(longer).toMatchObject({ name: 'TasksInChunksError', code: 'duplicate_id', status: 409 })
    expect(await ids('work')).toEqual(made.map((root) => root.id).sort())
    // The first batch is still the plan's, found as it landed: what it answered is what the first call made.
    expect(longer!.created.filter((root) => root !== undefined).map((root) => root.id)).toEqual(made.slice(1, 101).map((root) => root.id))
    // One full batch, and a plan that grew by more than one.
    const one = Array.from({ length: 100 }, (_, n): TaskInBatch => ({ text: `task ${n}` }))
    const whole = await createTasksInChunks(team, 'one', one, { id: 'one-batch' })
    expect(await refused('one', [...one, { text: 'one more' }, { text: 'and another', needs: [whole[0]!.id] }], 'one-batch')).toMatchObject({ code: 'duplicate_id', status: 409 })
    expect(await ids('one')).toEqual(whole.map((root) => root.id).sort())
    // Batches an earlier call halved, on a board that held 50 then: the plan ends where the second of them does.
    front.fail = async (request) => (((await request.clone().json()) as Batch).tasks.length > 50 ? Response.json({ error: { code: 'batch_too_large', message: 'this board holds 50 tasks in a write' } }, { status: 400 }) : null)
    const halved = await createTasksInChunks(team, 'halved', one, { id: 'halved-1' })
    front.fail = null
    expect(await refused('halved', [...one, { text: 'one more' }], 'halved-1')).toMatchObject({ code: 'duplicate_id', status: 409 })
    expect(await ids('halved')).toEqual(halved.map((root) => root.id).sort())
    // A plan a task shorter isn't the one that finished either.
    expect(await refused('one', one.slice(0, 99), 'one-batch')).toMatchObject({ code: 'duplicate_id', status: 409 })
    // The same plans again are still answered, as they stand, and nothing is sent.
    sent.length = 0
    expect((await createTasksInChunks(team, 'work', plan, { id: 'release-42' })).map((root) => root.id)).toEqual(made.map((root) => root.id))
    expect((await createTasksInChunks(team, 'one', one, { id: 'one-batch' })).map((root) => root.id)).toEqual(whole.map((root) => root.id))
    expect((await createTasksInChunks(team, 'halved', one, { id: 'halved-1' })).map((root) => root.id)).toEqual(halved.map((root) => root.id))
    expect(sent).toEqual([])
    expect([await ids('work'), await ids('one'), await ids('halved')].map((found) => found.length)).toEqual([200, 100, 100])
  })

  it("makes the rest of a plan that stopped midway, with what wasn't made changed: what landed stays as it is", async () => {
    const { team } = localTeam()
    const refused = async (tasks: TaskInBatch[]) =>
      createTasksInChunks(team, 'work', tasks, { id: 'release-42' }).then(
        () => null,
        (error: unknown) => error as TasksInChunksError,
      )
    // Step 150 also waits for a task that isn't there: the first batch lands, steps 1 to 100, and the board refuses the second, whole.
    const plan = steps(230).map((task, n) => (n === 150 ? { ...task, needs: [...task.needs!, '999999'] } : task))
    const stopped = await refused(plan)
    expect(stopped).toMatchObject({ code: 'invalid_needs', status: 400 })
    const first = stopped!.created.slice(1, 101).map((root) => root!.id)
    expect((await all(team)).map((root) => root.id)).toEqual(first)
    // What landed can't change, even while the plan isn't finished: nothing is made of a plan that rewords step 70.
    expect(await refused(plan.map((task, n) => (n === 150 ? steps(230)[150]! : n === 70 ? { ...task, text: 'another step 70' } : task)))).toMatchObject({ code: 'duplicate_id', status: 409 })
    expect(await all(team)).toHaveLength(100)
    // The plan fixed, with a step it hadn't reached reworded, a task more at its end, and one at its start that's made
    // after the steps it waits for: the first hundred are found, and the rest made.
    const fixed: TaskInBatch[] = [
      { key: 'audit', text: 'audit the release', needs: [{ key: 'step-229' }] },
      ...steps(230).map((task, n) => (n === 180 ? { ...task, text: 'step 180, reworded' } : task)),
      { text: 'and one more', needs: [{ key: 'audit' }, first[0]!] },
    ]
    const made = await createTasksInChunks(team, 'work', fixed, { id: 'release-42' })
    expect(made.slice(2, 102).map((root) => root.id)).toEqual(first)
    expect(made.map((root) => root.text)).toEqual(fixed.map((task) => task.text))
    expect(made[0]!.task?.needs).toEqual([made[230]!.id])
    expect([...made[231]!.task!.needs].sort()).toEqual([first[0]!, made[0]!.id].sort())
    expect((await all(team)).map((root) => root.id).sort()).toEqual(made.map((root) => root.id).sort())
    // It finished: now it takes no more.
    expect(await refused([...fixed, { text: 'yet another' }])).toMatchObject({ code: 'duplicate_id', status: 409 })
    expect(await all(team)).toHaveLength(232)
  })

  it('finds the batches an earlier call halved, when the board would now take them whole', async () => {
    const { team, sent, front } = localTeam()
    const plan = steps(230)
    // A board that holds 50 tasks in a write: the first call halves down to that.
    front.fail = async (request) => (((await request.clone().json()) as Batch).tasks.length > 50 ? Response.json({ error: { code: 'batch_too_large', message: 'this board holds 50 tasks in a write' } }, { status: 400 }) : null)
    const made = await createTasksInChunks(team, 'work', plan, { id: 'release-42' })
    expect(sent.map((batch) => batch.tasks.length)).toEqual([100, 50, 50, 50, 50, 30])
    // The same call once it holds 100: each id is taken by the 50 the first call made under it, and that's what it asks for next.
    front.fail = null
    sent.length = 0
    const again = await createTasksInChunks(team, 'work', plan, { id: 'release-42' })
    expect(again.map((root) => root.id)).toEqual(made.map((root) => root.id))
    expect(sent).toEqual([])
    expect(await all(team)).toHaveLength(230)
  })

  it('stops at the first batch a board refuses, with what the batches before it made, and makes nothing of a plan it can not order', async () => {
    const { team, sent } = localTeam()
    // The 151st task waits for a task that isn't there: the board refuses its batch, whole.
    const plan: TaskInBatch[] = Array.from({ length: 230 }, (_, n) => ({ text: `step ${n}`, ...(n === 150 ? { needs: ['999999'] } : {}) }))
    const failed = await createTasksInChunks(team, 'work', plan).then(
      () => null,
      (error: unknown) => error as TasksInChunksError,
    )
    expect(failed).toMatchObject({ name: 'TasksInChunksError', code: 'invalid_needs', status: 400, message: "needs: #999999 isn't a task", origin: 'board' })
    expect(failed!.created.map((root) => root?.text)).toEqual(plan.map((task, n) => (n < 100 ? task.text : undefined)))
    expect((await all(team)).map((root) => root.text)).toEqual(plan.slice(0, 100).map((task) => task.text))
    expect(sent.map((batch) => batch.tasks.length)).toEqual([100, 100])
    // Tasks that can't be put in an order can't be made in parts: it says so itself, and sends nothing.
    sent.length = 0
    for (const [unordered, why] of [
      [[{ text: 'waits for no one here', needs: [{ key: 'nobody' }] }], /no task of the batch has the key "nobody"/],
      [[{ key: 'a', text: 'one a' }, { key: 'a', text: 'another a' }], /two tasks of the batch have the key "a"/],
      [[{ key: 'x', text: 'x', needs: [{ key: 'y' }] }, { key: 'y', text: 'y', needs: [{ key: 'x' }] }], /"x", "y" wait for each other/],
    ] as const)
      await expect(createTasksInChunks(team, 'elsewhere', [...steps(150), ...unordered] as TaskInBatch[])).rejects.toMatchObject({ name: 'BoardError', code: 'invalid_needs', status: 400, origin: 'handle', message: expect.stringMatching(why) })
    expect(sent).toEqual([])
    expect(await all(team, 'elsewhere')).toEqual([])
  })

  it('gives up on a task a board holds none of, rather than ask for it again', async () => {
    const { team, sent, front } = localTeam()
    front.fail = () => Response.json({ error: { code: 'batch_too_large', message: 'this board makes no batches' } }, { status: 400 })
    const failed = await createTasksInChunks(team, 'work', steps(5)).then(
      () => null,
      (error: unknown) => error as TasksInChunksError,
    )
    expect(failed).toMatchObject({ name: 'TasksInChunksError', code: 'batch_too_large', status: 400 })
    expect(failed!.created).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(sent.map((batch) => batch.tasks.length)).toEqual([5, 4, 2, 1])
  })

  it("is not one write: a ready task of an earlier batch can be claimed before a later batch lands, unless the plan waits for a task of the caller's own", async () => {
    const { team, front } = localTeam()
    const plan: TaskInBatch[] = Array.from({ length: 150 }, (_, n) => ({ text: `step ${n}` }))
    // Someone claims the next ready task there while the second batch is on its way.
    const taken: (string | null)[] = []
    front.fail = async (_request, nth) => {
      if (nth === 2) taken.push((await team.tasks.claim({ channel: 'work' }))?.task.text ?? null)
      return null
    }
    await createTasksInChunks(team, 'work', plan)
    expect(taken).toEqual(['step 0'])
    // A plan that must not start early waits for a task of its maker's, where no worker claims: nothing of it is ready until that completes.
    const { task: gate } = await team.tasks.create('plans', { text: 'the plan is being made' })
    front.fail = async (_request, nth) => {
      if (nth === 4) taken.push((await team.tasks.claim({ channel: 'gated' }))?.task.text ?? null)
      return null
    }
    const gated = await createTasksInChunks(team, 'gated', plan.map((task) => ({ ...task, needs: [gate.id] })))
    expect(taken).toEqual(['step 0', null])
    expect(gated.every((root) => root.task?.state === 'waiting')).toBe(true)
    await (await team.tasks.claim(gate.id)).complete('made')
    expect((await team.tasks.claim({ channel: 'gated' }))?.task.text).toBe('step 0')
  })
})
