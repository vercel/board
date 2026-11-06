import { describe, expect, it } from 'vitest'
import { caller, personToken, testBoard, workflowToken } from './harness.ts'

describe('creating a channel', () => {
  it('makes it once, however many ask at the same time', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const answers = await Promise.all(Array.from({ length: 5 }, () => julian('POST', '/channels', { path: 'ops' })))
    // One made it, and said so; the rest found it there.
    expect(answers.map((answer) => [answer.status, answer.body.created]).sort()).toEqual([[200, false], [200, false], [200, false], [200, false], [201, true]])
    expect((await julian('GET', '/events?after=0&all=1')).body.events.filter((event: { type: string }) => event.type === 'channel.created')).toHaveLength(1)
    expect((await julian('GET', '/channels')).body.channels).toEqual([{ path: 'ops', lastIndex: 0, messages: 0, threads: 0 }])
  })

  it("refuses a key it doesn't know, rather than make a channel that isn't what was asked for", async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const asked = await julian('POST', '/channels', { path: 'vault', private: true })
    expect([asked.status, asked.body.error.code]).toEqual([400, 'invalid_request'])
    expect((await julian('GET', '/channels')).body.channels).toEqual([])
  })

  it('answers one a post is making at the same time as there already, or makes it first', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const [created, posted] = await Promise.all([julian('POST', '/channels', { path: 'race' }), julian('POST', '/messages', { channel: 'race', text: 'first' })])
    expect(posted.status).toBe(201)
    expect(created.status).toBe(created.body.created ? 201 : 200)
    // Whichever landed first, the channel holds the post, and a create after says it was there.
    const { body } = await julian('POST', '/channels', { path: 'race' })
    expect(body).toEqual({ channel: { path: 'race', lastIndex: Number(posted.body.message.id), messages: 1, threads: 1 }, created: false })
  })

  it("refuses a caller that posts where it can't read, alike whether the channel is there or not", async () => {
    const board = testBoard()
    const { fetch } = board
    await board.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'feedback/': ['post'] } })
    const julian = caller(fetch, await personToken())
    const widget = caller(fetch, await workflowToken())
    expect((await julian('POST', '/messages', { channel: 'feedback/acme', text: 'from acme' })).status).toBe(201)
    const there = await widget('POST', '/channels', { path: 'feedback/acme' })
    const not = await widget('POST', '/channels', { path: 'feedback/nobody' })
    expect([there.status, there.body.error.code]).toEqual([403, 'forbidden'])
    expect([not.status, not.body.error.code]).toEqual([403, 'forbidden'])
    expect(there.body.error.message.replace('acme', 'nobody')).toBe(not.body.error.message)
    // Posting still makes one, as it always has.
    expect((await widget('POST', '/messages', { channel: 'feedback/nobody', text: 'hello' })).status).toBe(201)
    expect((await julian('GET', '/channels')).body.channels.map((channel: { path: string }) => channel.path)).toEqual(['feedback/acme', 'feedback/nobody'])
  })
})
