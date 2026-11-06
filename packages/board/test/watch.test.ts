import { describe, expect, it, vi } from 'vitest'
import type { BoardEventView } from '../src/api/routes.ts'
import { parseTail, parseWatchTail, words } from '../src/api/tail.ts'
import type { Watcher } from '../src/server/index.ts'
import { runMatch } from '../src/server/watch.ts'
import { caller, personToken, testBoard } from './harness.ts'

/** A watcher that records every event it runs on. */
function recorder(tail: string) {
  const events: BoardEventView[] = []
  const watcher: Watcher = { tail, run: ({ event }) => void events.push(event) }
  return { watcher, events, types: () => events.map((event) => event.type) }
}

describe('tail expressions', () => {
  it('split like a shell and parse like the CLI', () => {
    expect(words(`firehose --text "deploy failed" --label 'state=open|draft' a\\ b`)).toEqual([
      'firehose',
      '--text',
      'deploy failed',
      '--label',
      'state=open|draft',
      'a b',
    ])
    expect(parseTail('prs/ --label pr --mentions @claude --re #12')).toEqual({
      channel: 'prs/',
      label: [['pr', null]],
      mentions: 'claude',
      re: '12',
    })
    expect(parseTail('--mentions')).toEqual({ mentions: 'me' })
    expect(parseTail('')).toEqual({})
    expect(parseWatchTail('prs --label pr --all')).toEqual({ filters: { channel: 'prs', label: [['pr', null]] }, all: true })
    expect(parseWatchTail('prs').all).toBe(false)
  })

  it('reject what a filter is not', () => {
    expect(() => parseTail('firehose --after 3')).toThrow("--after isn't a filter")
    expect(() => parseTail('firehose prs')).toThrow('expected one channel, got: firehose prs')
    expect(() => parseTail('--text "open')).toThrow('unterminated "')
    expect(() => parseTail('-x')).toThrow("-x isn't a filter")
    expect(() => parseTail('--toString')).toThrow("--toString isn't a filter")
    expect(() => parseTail('dev --re')).toThrow('--re needs a value')
    expect(() => parseTail('dev --text --label pr')).toThrow('--text needs a value')
    expect(() => parseWatchTail('dev --all=yes')).toThrow('--all takes no value')
  })

  it('take values as the CLI takes them', () => {
    expect(parseTail('--label a --label=b dev --text=-1 --re 1 --re 2')).toEqual({ channel: 'dev', label: [['a', null], ['b', null]], text: '-1', re: '2' })
    expect(parseTail('--text - dev')).toEqual({ channel: 'dev', text: '-' })
    expect(parseTail('-- --label')).toEqual({ channel: '--label' })
  })

  it('take an email or me after --mentions as its value, as the docs write it, and nothing past --', () => {
    expect(parseTail('dev --mentions ada@vercel.com')).toEqual({ channel: 'dev', mentions: 'ada@vercel.com' })
    expect(parseTail('--mentions ada@vercel.com dev')).toEqual({ channel: 'dev', mentions: 'ada@vercel.com' })
    expect(parseTail('--mentions me dev')).toEqual({ channel: 'dev', mentions: 'me' })
    // A channel after a bare --mentions is still the channel.
    expect(parseTail('--mentions dev')).toEqual({ channel: 'dev', mentions: 'me' })
    expect(parseTail('-- --mentions')).toEqual({ channel: '--mentions' })
    expect(parseTail('--mentions --text=ada@vercel.com')).toEqual({ mentions: 'me', text: 'ada@vercel.com' })
  })
})

describe('watchers', () => {
  it('run on what the same `vb tail` prints, exactly as it prints it', async () => {
    const triage = recorder('firehose')
    const { fetch } = testBoard({ watch: { triage: triage.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    await julian('POST', '/messages', { channel: 'other', text: 'unrelated' })
    await julian('POST', `/messages/${root.body.message.id}/reactions`, { emoji: 'eyes' })

    await vi.waitFor(() => expect(triage.types()).toEqual(['message.posted', 'reaction.added']))
    const tail = await julian('GET', '/events?channel=firehose&after=0')
    expect(triage.events).toEqual(tail.body.events)
  })

  it('wake when a thread enters their view, then on its replies', async () => {
    const wake = recorder('--label status=needs-agent')
    const { fetch } = testBoard({ watch: { wake: wake.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    await julian('POST', `/messages/${root.id}/labels`, { set: { status: 'needs-agent' } })
    await julian('POST', '/messages', { re: root.id, text: 'still broken' })

    await vi.waitFor(() => expect(wake.types()).toEqual(['labels.changed', 'message.posted']))
    expect(wake.events[1]!.message).toMatchObject({ text: 'still broken', re: root.id })
  })

  it('wake on replies in labeled threads only, like a review watcher on `prs --label pr`', async () => {
    const review = recorder('prs --label pr')
    const { fetch } = testBoard({ watch: { review: review.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const pr = (await julian('POST', '/messages', { channel: 'prs', text: 'PR #12', labels: { pr: 'acme/www#12' } })).body.message
    const chat = (await julian('POST', '/messages', { channel: 'prs', text: 'who owns the release?' })).body.message
    await julian('POST', '/messages', { re: chat.id, text: 'me' })
    await julian('POST', '/messages', { re: pr.id, text: 'looks good' })

    await vi.waitFor(() => expect(review.events.map((event) => event.message?.text)).toEqual(['PR #12', 'looks good']))
  })

  it('wake for any of a label\'s values, and not for others', async () => {
    const wake = recorder('--label kind=bug|feature|question')
    const { fetch } = testBoard({ watch: { wake: wake.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const noise = (await julian('POST', '/messages', { channel: 'firehose', text: 'lunch?' })).body.message
    await julian('POST', `/messages/${noise.id}/labels`, { set: { kind: 'noise' } })
    await julian('POST', '/messages', { re: noise.id, text: 'pizza' })
    const feature = (await julian('POST', '/messages', { channel: 'firehose', text: 'add exports' })).body.message
    await julian('POST', `/messages/${feature.id}/labels`, { set: { kind: 'feature' } })
    await julian('POST', '/messages', { re: feature.id, text: 'csv please' })

    await vi.waitFor(() => expect(wake.types()).toEqual(['labels.changed', 'message.posted']))
    expect(wake.events.map((event) => event.message?.re ?? event.message?.id)).toEqual([feature.id, feature.id])
  })

  it('match mentions by handle', async () => {
    const pinged = recorder('--mentions @ada')
    const { fetch } = testBoard({ watch: { pinged: pinged.watcher } })
    const ada = caller(fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    await ada('POST', '/messages', { channel: 'firehose', text: 'hi' })
    await julian('POST', '/messages', { channel: 'firehose', text: '@ada can you look?' })

    await vi.waitFor(() => expect(pinged.events.map((event) => event.message?.text)).toEqual(['@ada can you look?']))
  })

  it('match authors by handle, with or without the @', async () => {
    const fromAda = recorder('firehose --by @ada')
    const { fetch } = testBoard({ watch: { 'from-ada': fromAda.watcher } })
    const ada = caller(fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    await julian('POST', '/messages', { channel: 'firehose', text: 'from julian' })
    await ada('POST', '/messages', { channel: 'firehose', text: 'from ada' })

    await vi.waitFor(() => expect(fromAda.events.map((event) => event.message?.text)).toEqual(['from ada']))
  })

  it("write as themselves, and their own writes don't wake them", async () => {
    const seen = recorder('firehose')
    const board = testBoard({
      watch: {
        triage: {
          tail: 'firehose',
          run: async ({ event, board }) => {
            if (event.type === 'message.posted') await board.reply(event.message!.id, 'Thanks! Tracking it.')
          },
        },
        seen: seen.watcher,
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    await vi.waitFor(() => expect(seen.types()).toEqual(['message.posted', 'message.posted']))
    expect(seen.events[1]!.message).toMatchObject({
      text: 'Thanks! Tracking it.',
      by: { actor: 'board:watch:triage' },
      author: { handle: 'triage', kind: 'deployment' },
    })
    // Matches are recorded before anything runs, so triage's session is final: one match, not two.
    const watchServer = board.servers.at(-1)!
    expect(await watchServer.session('watch:triage').history()).toHaveLength(1)
  })

  it.each(['/api/board', '/api/board/'])('read and write through a board mounted at an explicit basePath %s', async (basePath) => {
    const results: unknown[] = []
    const board = testBoard({
      basePath,
      watch: {
        triage: {
          tail: 'firehose',
          run: async ({ event, board }) => {
            if (event.type !== 'message.posted' || event.message!.re !== null) return
            try {
              await board.react(event.message!.id, 'eyes')
              await board.reply(event.message!.id, 'on it')
              results.push((await board.thread(event.message!.id)).replies.length)
            } catch (error) {
              results.push((error as Error).message)
            }
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    await vi.waitFor(() => expect(results).toEqual([1]))
    const after = (await julian('GET', `/messages/${root.id}`)).body
    expect(after.message.reactions).toEqual({ eyes: ['board:watch:triage'] })
  })

  it("fail on their own: a broken watcher doesn't hold up writes or other watchers", async () => {
    const ok = recorder('firehose')
    const { fetch } = testBoard({
      watch: {
        broken: {
          tail: 'firehose',
          run: () => {
            throw new Error('boom')
          },
        },
        ok: ok.watcher,
      },
    })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    expect(root.status).toBe(201)
    expect((await julian('POST', '/messages', { re: root.body.message.id, text: 'still broken' })).status).toBe(201)
    await vi.waitFor(() => expect(ok.types()).toEqual(['message.posted', 'message.posted']))
  })

  it("give up on an event that keeps failing, and keep running on the thread's later events", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const board = testBoard({
      watch: {
        flaky: {
          tail: 'firehose',
          run: ({ event }) => {
            if (event.message?.text === 'boom') throw new Error('sandbox setup failed')
            seen.push(event.message!.text)
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'boom' })
    await julian('POST', '/messages', { re: root.body.message.id, text: 'are you alive?' })

    // Without a scheduler nothing retries on its own; each drain is the next try.
    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:flaky')
      await watches.drain('watch:flaky')
      expect(seen).toEqual(['are you alive?'])
    })
    const failed = (await watches.session('watch:flaky').history()).filter((event) => event.type === 'watch.failed')
    expect(failed).toEqual([expect.objectContaining({ payload: expect.objectContaining({ thread: root.body.message.thread, error: 'sandbox setup failed' }) })])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('watcher flaky gave up on event'), 'sandbox setup failed')
    error.mockRestore()
  })

  it('give up without running once runs keep getting killed, which never throw, until a retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn()
    const recorded: unknown[] = []
    const match = { id: 'm1', payload: { thread: 't1', event: { cursor: '7', type: 'message.posted' } } }
    const input = { watcher: { id: 'pi', run }, match, board: () => ({}) as never, record: async (failure: unknown) => void recorded.push(failure) }

    // Short of twice the tries, a run gets another go: earlier attempts may have been kills.
    await runMatch({ ...input, attempt: 9 })
    expect(run).toHaveBeenCalledTimes(1)
    // The 10th is the last A2 hands out (it counts each kill as a failure at the next takeover,
    // and dead-letters at 10): give up, don't run again.
    await runMatch({ ...input, attempt: 10 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual([{ matched: 'm1', thread: 't1', error: 'its run was cut short 9 times (a timeout, or out of memory)' }])
    expect(error).toHaveBeenCalledWith('[board] watcher pi gave up on event #7 after 10 tries:', 'its run was cut short 9 times (a timeout, or out of memory)')

    // Retried from a dead letter, A2 keeps counting: the run gets A2's fresh tries, and a throw goes back to A2.
    await runMatch({ ...input, attempt: 11 })
    expect(run).toHaveBeenCalledTimes(2)
    run.mockRejectedValueOnce(new Error('still down'))
    await expect(runMatch({ ...input, attempt: 16 })).rejects.toThrow('still down')
    expect(recorded).toHaveLength(1)
    error.mockRestore()
  })

  it('fail the boot when one is misconfigured', () => {
    const run = () => {}
    expect(() => testBoard({ watch: { triage: { tail: 'firehose --after 3', run } } })).toThrow(
      "watch triage: --after isn't a filter",
    )
    expect(() => testBoard({ watch: { triage: { tail: '--mentions', run } } })).toThrow(
      'watch triage: a watcher has no "me": use --mentions @handle',
    )
    expect(() => testBoard({ watch: { Triage: { tail: '', run } } })).toThrow('watch: ids use lowercase')
  })
})

describe("the board's handle in its own deployment", () => {
  it('writes as `board:client`, or `board:client:<profile>` with `as`, and wakes watchers', async () => {
    const report = recorder('firehose --label state=done')
    const app = testBoard({ watch: { report: report.watcher } })
    const julian = caller(app.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message

    const hook = app.as('v0-hook')
    await hook.label(root.id, { set: { state: 'done' } })
    const reply = await hook.reply(root.id, 'fixed in #31')

    expect(reply.by).toMatchObject({ actor: 'board:client:v0-hook' })
    expect((await app.reply(root.id, 'and deployed')).by).toMatchObject({ actor: 'board:client' })
    expect((await app.me()).actor).toBe('board:client')
    await vi.waitFor(() => expect(report.types()).toEqual(['labels.changed', 'message.posted', 'message.posted']))
  })

  it("posts once per id, so a redelivered webhook does not post twice, and keeps each profile's ids its own", async () => {
    const app = testBoard()
    const julian = caller(app.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message

    const hook = app.as('v0-hook')
    const first = await hook.reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })
    const again = await app.as('v0-hook').reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })
    const other = await hook.reply(root.id, { text: 'fixed in #31', id: 'delivery-2' })
    const unkeyed = [await hook.reply(root.id, 'a'), await hook.reply(root.id, 'a')]

    expect(again.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
    expect(unkeyed[0]!.id).not.toBe(unkeyed[1]!.id)
    expect((await hook.posted('delivery-1')).id).toBe(first.id)
    // Another profile's, or the handle's own, with the same id is a post of its own.
    expect((await app.as('deploys').reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })).id).not.toBe(first.id)
    expect((await app.reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })).id).not.toBe(first.id)
    // And no request can post with it first: what it derives is the board's own kind of ID.
    const taken = await julian('POST', '/messages', { re: root.id, text: 'mine now', id: 'delivery-3' })
    expect(taken.status).toBe(201)
    expect((await hook.reply(root.id, { text: 'fixed in #32', id: 'delivery-3' })).text).toBe('fixed in #32')
  })

  it('rejects a profile a watcher id would reject', async () => {
    await expect(testBoard().as('V0 Hook').me()).rejects.toThrow('as: profiles use lowercase letters')
  })
})
