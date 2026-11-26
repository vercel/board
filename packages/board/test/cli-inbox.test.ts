import { beforeEach, describe, expect, it } from 'vitest'
import { personToken } from './harness.ts'
import { url, useBoard, vb } from './cli-harness.ts'

useBoard()

const JULIAN = 'vercel:user:u_julian'

/** Ada, another person on the board: what she writes reaches Julian, who every other run is. */
const ada = async (args: string[]) => vb(args, { BOARD_TOKEN: await personToken('u_ada', url) })

/** What a run printed, or the failure that says it printed nothing. */
const said = (run: { code: number; stdout: string; stderr: string }) => {
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  return run.stdout.trimEnd()
}

/** Posts as Ada, and answers the new message's ID. */
const adaPosts = async (channel: string, text: string) => said(await ada(['post', channel, text]))
const adaReplies = async (id: string, text: string) => said(await ada(['reply', id, text]))

/** Julian's inbox as `--json` answers it: each item's thread, message, reasons, and unread. */
const items = async (...options: string[]) =>
  (JSON.parse((await vb(['inbox', '--json', ...options])).stdout) as { items: { thread: string; message: string | null; reasons: string[]; unread: number }[] }).items.map(
    ({ thread, message, reasons, unread }) => ({ thread, message, reasons, unread }),
  )

/** Takes everything out of an inbox, and follows nothing from it, so each test starts on an empty one: they share a board, and Julian. */
async function empty(...as: string[]) {
  for (const which of [[], ['--snoozed']])
    for (const { thread, message } of await items(...which, ...as)) await vb(['inbox', 'remove', message ?? thread, ...as])
  const { follows } = JSON.parse((await vb(['inbox', 'follows', '--json', ...as])).stdout) as { follows: { channel?: string; thread?: string }[] }
  for (const follow of follows) await vb(['inbox', 'unfollow', follow.channel ?? follow.thread!, ...as])
}

describe('vb inbox', () => {
  beforeEach(async () => {
    await empty()
    await empty('--as', 'claude')
  })

  it('lists what reached you, a row an item, and says when nothing has', async () => {
    expect(said(await vb(['inbox', '--as', 'nobody-yet']))).toBe("nothing in nobody-yet's inbox")
    const mention = await adaPosts('inbox-list', `can you look at the refresh endpoint? @[${JULIAN}]`)
    await adaReplies(mention, `it 500s on an expired token @[${JULIAN}]`)
    expect(said(await vb(['inbox', 'follow', 'inbox-list']))).toBe('following inbox-list')
    const followed = await adaPosts('inbox-list', 'db is down')
    expect(said(await vb(['inbox'])).split('\n')).toEqual([
      `#${followed}  inbox-list  u_ada: db is down                                channel · 1 new`,
      `#${mention}  inbox-list  u_ada: can you look at the refresh endpoint? @…  mention · 2 new`,
    ])
    // A row fits 80 columns: its text is what's cut.
    for (const row of said(await vb(['inbox'])).split('\n')) expect(row.length).toBeLessThanOrEqual(80)
    expect(said(await vb(['inbox', '--read']))).toBe('nothing read in your inbox')
    expect(said(await vb(['inbox', '--snoozed']))).toBe('nothing snoozed in your inbox')
    expect(said(await vb(['inbox', '--label', 'board.task=blocked']))).toBe('nothing in your inbox with board.task=blocked')
    // One document with --json, as the board answered it.
    const page = JSON.parse((await vb(['inbox', '--unread', '--json'])).stdout)
    expect(Object.keys(page)).toEqual(['items', 'cursor', 'older'])
    expect(page.items.map((item: { thread: string }) => item.thread)).toEqual([followed, mention])
    await vb(['inbox', 'unfollow', 'inbox-list'])
  })

  it('reads, unreads, snoozes, and removes an item, and says what each did', async () => {
    const root = await adaPosts('inbox-item', `one for @[${JULIAN}]`)
    expect(said(await vb(['inbox', 'mark', root]))).toBe(`read ${root}`)
    expect(await items('--unread')).toEqual([])
    expect(said(await vb(['inbox', '--read']))).toBe(`#${root}  inbox-item  u_ada: one for @u_julian  mention`)
    expect(said(await vb(['inbox', 'mark', root, '--unread']))).toBe(`unread ${root}`)
    expect(await items('--unread')).toEqual([{ thread: root, message: null, reasons: ['mention'], unread: 1 }])
    // A snooze, by how long from now: its line says until when, and the list leaves it out.
    const snoozed = said(await vb(['inbox', 'snooze', root, '--until', '3h']))
    expect(snoozed).toMatch(new RegExp(`^snoozed ${root} until \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$`))
    expect(Date.parse(snoozed.split(' ').at(-1)!) - Date.now()).toBeGreaterThan(3 * 3_600_000 - 60_000)
    expect(await items()).toEqual([])
    expect(said(await vb(['inbox', '--snoozed']))).toBe(`#${root}  inbox-item  u_ada: one for @u_julian  mention · 1 new · back in 3h`)
    expect(said(await vb(['inbox', 'unsnooze', root]))).toBe(`unsnoozed ${root}`)
    expect((await items()).map((item) => item.thread)).toEqual([root])
    expect(said(await vb(['inbox', 'remove', root]))).toBe(`removed ${root}`)
    expect(said(await vb(['inbox', 'remove', root]))).toBe(`${root} wasn't in your inbox`)
    expect(JSON.parse((await vb(['inbox', 'remove', root, '--json'])).stdout)).toEqual({ removed: false, outcome: 'unchanged' })
  })

  it('adds a thread, or a message by itself, and follows and leaves channels and threads', async () => {
    const root = await adaPosts('inbox-follow', 'a thread Julian never posted in')
    const reply = await adaReplies(root, 'its reply')
    expect(said(await vb(['inbox', 'add', root]))).toBe(`added ${root}`)
    expect(said(await vb(['inbox', 'add', reply]))).toBe(`added ${reply}`)
    expect(said(await vb(['inbox', 'add', root, '--alone']))).toBe(`added ${root}`)
    expect(await items()).toEqual([
      { thread: root, message: root, reasons: ['added'], unread: 1 },
      { thread: root, message: reply, reasons: ['added'], unread: 1 },
      { thread: root, message: null, reasons: ['added'], unread: 1 },
    ])
    for (const id of [root, root, reply]) await vb(['inbox', 'remove', id])
    // A thread by any message of it, a channel, and a subtree.
    expect(said(await vb(['inbox', 'follow', `#${reply}`]))).toBe(`following ${root}`)
    expect(said(await vb(['inbox', 'follow', 'inbox-follow/']))).toBe('following inbox-follow/')
    expect(said(await vb(['inbox', 'follows']))).toBe(`inbox-follow/  asked\n#${root}${' '.repeat('inbox-follow/'.length - root.length - 1)}  asked`)
    expect(JSON.parse((await vb(['inbox', 'follow', root, '--json'])).stdout)).toMatchObject({ follow: { thread: root, by: 'asked' }, outcome: 'followed' })
    expect(said(await vb(['inbox', 'unfollow', root]))).toBe(`unfollowed ${root}`)
    expect(said(await vb(['inbox', 'unfollow', root]))).toBe(`not following ${root}`)
    expect(said(await vb(['inbox', 'unfollow', 'inbox-follow/']))).toBe('unfollowed inbox-follow/')
    expect(said(await vb(['inbox', 'follows']))).toBe('following nothing')
  })

  it('reads the inbox of the profile it runs as, and with --under, yours with your agents’', async () => {
    // Claude has written, so the board knows the handle a mention of it shows by.
    said(await vb(['post', 'inbox-elsewhere', 'here', '--as', 'claude']))
    const forClaude = await adaPosts('inbox-under', `@[${JULIAN}+claude] can you look?`)
    const forJulian = await adaPosts('inbox-under', `@[${JULIAN}] and you?`)
    expect(await items('--as', 'claude')).toEqual([{ thread: forClaude, message: null, reasons: ['mention'], unread: 1 }])
    expect(said(await vb(['inbox', '--as', 'claude']))).toBe(`#${forClaude}  inbox-under  u_ada: @u_julian/claude can you look?  mention · 1 new`)
    expect(said(await vb(['inbox', '--under'])).split('\n')).toEqual([
      `you     #${forJulian}  inbox-under  u_ada: @u_julian and you?              mention · 1 new`,
      `claude  #${forClaude}  inbox-under  u_ada: @u_julian/claude can you look?  mention · 1 new`,
    ])
  })

  it('waits for the next change, and says where the next wait goes on from', async () => {
    const waiting = vb(['inbox', '--wait', '20s'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const root = await adaPosts('inbox-wait', `one for @[${JULIAN}]`)
    const [row, next] = said(await waiting).split('\n')
    expect(row).toBe(`#${root}  inbox-wait  u_ada: one for @u_julian  mention · 1 new`)
    expect(next).toMatch(/^next: vb inbox --wait 20s --after \d+$/)
    // From where it stopped: the removal after it, and then nothing in time.
    const after = next!.split(' ').at(-1)!
    await vb(['inbox', 'remove', root])
    expect(said(await vb(['inbox', '--wait', '20s', '--after', after])).split('\n')[0]).toBe(`removed ${root}`)
    const none = await vb(['inbox', '--wait', '1s', '--json'])
    expect(none.code).toBe(1)
    expect(JSON.parse(none.stderr)).toMatchObject({ status: 'error', reason: 'timeout', message: 'Nothing changed in your inbox within 1s.' })
  })

  it('says what it could not do, and how to go on', async () => {
    const root = await adaPosts('inbox-errors', 'not in the inbox')
    const mark = await vb(['inbox', 'mark', root])
    expect(mark).toMatchObject({ code: 1, stdout: '' })
    expect(mark.stderr).toBe(`error: #${root} isn't in your inbox.\n\n  Add it:\n    vb inbox add ${root}\n`)
    expect((await vb(['inbox', 'mark', '99999'])).stderr).toBe("error: Couldn't find message #99999.\n")
    // What the list takes isn't a verb's, and what a verb takes isn't the list's.
    expect((await vb(['inbox', 'follow', 'dev', '--unread'])).stderr).toContain('Unknown option --unread for vb inbox follow.')
    expect((await vb(['inbox', '--until', '3h'])).stderr).toContain('Unknown option --until for vb inbox.')
    expect((await vb(['inbox', '--unread', '--read'])).stderr).toContain('--unread and --read contradict each other')
    expect((await vb(['inbox', 'snooze', root])).stderr).toContain('Missing --until')
    expect((await vb(['inbox', 'snooze', root, '--until', 'soonish'])).stderr).toContain("--until takes a time like 2026-10-08T09:00:00Z, or how long from now like 3h, and soonish isn't one.")
    expect((await vb(['inbox', 'follow'])).code).toBe(2)
    expect((await vb(['inbox', 'follow', 'dev', 'ops'])).code).toBe(2)
  })

  it('still lists a sync entry’s raw events when the word after it is a key', async () => {
    // This board syncs nothing, so the key names no inbox: the route is sync's, and says so.
    const run = await vb(['inbox', 'slack', '--json'])
    expect(JSON.parse(run.stdout)).toEqual({ events: [] })
  })
})
