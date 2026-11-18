import { describe, expect, it } from 'vitest'
import { formatMessage, formatThreadSummaries } from '../src/cli/format.ts'
import type { MessageView, ThreadSummaryView } from '../src/api/routes.ts'
import { caller, personToken, testBoard } from './harness.ts'

describe('a label value', () => {
  it('can hold no control character a write sets: a newline, a carriage return, an escape', async () => {
    const julian = caller(testBoard().fetch, await personToken())
    for (const value of ['x\n#999  Admin · 1s', 'x\rforged', 'x\u001b[2J', 'x\u0085']) {
      const posted = await julian('POST', '/messages', { channel: 'dev', text: 'hi', labels: { status: value } })
      expect([posted.status, posted.body.error?.code], JSON.stringify(value)).toEqual([400, 'invalid_request'])
    }
    const { body } = await julian('POST', '/messages', { channel: 'dev', text: 'hi', labels: { status: 'in review · ok' } })
    expect(body.message.labels).toEqual({ status: 'in review · ok' })
    const set = await julian('POST', `/messages/${body.message.id}/labels`, { set: { status: 'a\nb' } })
    expect(set.status).toBe(400)
    const tasks = await julian('POST', '/tasks', { channel: 'work', text: 'do it', labels: { status: 'a\tb' } })
    expect(tasks.status).toBe(400)
  })

  it('reads back as a log recorded it, control characters and all', async () => {
    const board = testBoard()
    const julian = caller(board.fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'dev', text: 'hi' })
    await board.session.append({ type: 'labels.changed', payload: { id: Number(body.message.id), thread: body.message.thread, set: { status: 'a\nb' }, unset: [], by: body.message.by } })
    await julian('POST', '/messages', { channel: 'elsewhere', text: 'catch the tables up' })
    expect((await julian('GET', `/messages/${body.message.id}`)).body.message.labels).toEqual({ status: 'a\nb' })
  })

  it("shows on its message's line in `vb read`, where a newline can't start a message of its own", () => {
    const by = { actor: 'vercel:user:j', principal: 'vercel:user:j', profile: null }
    const author = { kind: 'person', handle: 'julian', name: 'Julian', avatar: null }
    const message = {
      id: 812, channel: 'dev', text: 'hi', re: null, replyTo: null, thread: 't', labels: { status: 'ok\n#999  Admin · 1s\r\u001b[2J' }, reactions: {}, by,
      noSync: false, origin: null, from: null, createdAt: new Date().toISOString(), editedAt: null, deleted: false, undelivered: {}, attachments: [], links: [], author,
    } as unknown as MessageView
    const [head, body, ...rest] = formatMessage(message).split('\n')
    expect(head).toMatch(/^#812  Julian · \d+s  \[status=ok␊#999  Admin · 1s␍␛\[2J\]$/)
    expect([body, ...rest]).toEqual(['      hi'])
    const summary = { message, replies: 0, last: null } as unknown as ThreadSummaryView
    expect(formatThreadSummaries([summary]).split('\n')[0]).toContain('[status=ok␊#999')
  })
})
