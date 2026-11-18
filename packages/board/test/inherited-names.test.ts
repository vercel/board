import { describe, expect, it } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { caller, personToken, testBoard } from './harness.ts'

// `constructor` and `__proto__` are names every JavaScript object has. The board keeps
// emoji, label keys, handles, and channels as keys of plain objects, where these read
// what an object inherits unless the board looks only at its own.

/**
 * A store whose log keeps the emoji, label keys, and handles `rename` names as it says:
 * what a board before this one could have written, since it didn't refuse these names.
 */
function olderStore(rename: Record<string, string>) {
  const store = memory()
  const log = store.log!
  const append = log.append.bind(log)
  const renamed = (name: string) => (Object.hasOwn(rename, name) ? rename[name]! : name)
  log.append = ((session, events, options) =>
    append(
      session,
      events.map((event: any) => {
        const { type, payload } = event
        if (type === 'reaction.added' || type === 'reaction.removed') return { ...event, payload: { ...payload, emoji: renamed(payload.emoji) } }
        if (type === 'actor.seen') return { ...event, payload: { ...payload, handle: renamed(payload.handle) } }
        if (type === 'labels.changed') {
          const set = Object.fromEntries(Object.entries(payload.set).map(([key, value]) => [renamed(key), value]))
          return { ...event, payload: { ...payload, set, unset: payload.unset.map(renamed) } }
        }
        return event
      }),
      options,
    )) as typeof log.append
  return store
}

describe('names every object has', () => {
  it('are refused as emoji and label keys', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const id = (await julian('POST', '/messages', { channel: 'dev', text: 'root' })).body.message.id
    for (const emoji of ['constructor', '__proto__', 'prototype']) {
      const refused = await julian('POST', `/messages/${id}/reactions`, { emoji })
      expect(refused.status).toBe(400)
      expect(JSON.stringify(refused.body)).toContain('emoji name is a reserved name')
    }
    for (const key of ['constructor', 'prototype']) {
      expect((await julian('POST', `/messages/${id}/labels`, { set: { [key]: 'open' } })).status).toBe(400)
      expect((await julian('POST', `/messages/${id}/labels`, { unset: [key] })).status).toBe(400)
      expect((await julian('POST', '/messages', { channel: 'dev', text: 'labeled', labels: { [key]: 'open' } })).status).toBe(400)
    }
    const read = await julian('GET', `/messages/${id}`)
    expect(read.body.message).toMatchObject({ reactions: {}, labels: {} })
  })

  it('fold from a log that already holds them, and the board keeps answering', async () => {
    const store = olderStore({ eyes: 'constructor', rocket: '__proto__', status: 'constructor', u_ada: '__proto__' })
    const board = testBoard({ store })
    const julian = caller(board.fetch, await personToken('u_julian'))
    const ada = caller(board.fetch, await personToken('u_ada'), {})
    const id = (await julian('POST', '/messages', { channel: 'dev', text: 'root' })).body.message.id
    for (const emoji of ['eyes', 'rocket']) expect((await julian('POST', `/messages/${id}/reactions`, { emoji })).status).toBe(200)
    expect((await ada('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })).status).toBe(200)
    expect((await julian('POST', `/messages/${id}/labels`, { set: { status: 'open' } })).status).toBe(200)
    await julian('POST', '/messages', { channel: 'dev', text: 'another thread' })

    // Reading a later message waits for the tables to apply every event before it.
    const later = (await julian('POST', '/messages', { re: id, text: 'still here' })).body.message.id
    const read = await julian('GET', `/messages/${later}`)
    expect(read.status).toBe(200)
    expect(read.body.message.reactions).toEqual({ constructor: ['vercel:user:u_julian', 'vercel:user:u_ada'], ['__proto__']: ['vercel:user:u_julian'] })
    expect(read.body.message.labels).toEqual({ constructor: 'open' })
    expect((await julian('GET', '/actors')).body.actors).toContainEqual(expect.objectContaining({ id: 'vercel:user:u_ada', handle: '__proto__' }))

    const events = await julian('GET', '/events?after=0')
    expect(events.status).toBe(200)
    expect(events.body.events.map((event: { type: string }) => event.type)).toEqual([
      'message.posted', 'reaction.added', 'reaction.added', 'reaction.added', 'labels.changed', 'message.posted', 'message.posted',
    ])
    // The labeled thread matches from its label on; the other thread, which every object would match, doesn't.
    const labeled = await julian('GET', '/events?after=0&label=constructor')
    expect(labeled.body.events.map((event: { type: string; message: { text: string } }) => [event.type, event.message.text])).toEqual([
      ['labels.changed', 'root'],
      ['message.posted', 'still here'],
    ])

    for (const emoji of ['eyes', 'rocket']) expect((await julian('POST', `/messages/${id}/reactions`, { emoji, remove: true })).status).toBe(200)
    expect((await julian('POST', `/messages/${id}/labels`, { unset: ['status'] })).status).toBe(200)
    const again = (await julian('POST', '/messages', { re: id, text: 'and again' })).body.message.id
    expect((await julian('GET', `/messages/${again}`)).body.message).toMatchObject({ reactions: { constructor: ['vercel:user:u_ada'] }, labels: {} })
  })

  it('are handles like any other, and never actors by themselves', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken('u_julian'), {})
    expect((await julian('POST', '/messages', { channel: 'dev', text: 'thanks @constructor' })).status).toBe(201)
    for (const actor of ['constructor', 'toString', '__proto__'])
      expect((await julian('POST', '/messages', { channel: 'dev', text: `cc @[${actor}]` })).status).toBe(201)

    // A Vercel login's handle is its user ID, which may be one of them.
    const named = caller(fetch, await personToken('constructor'), {})
    expect((await named('POST', '/messages', { channel: 'dev', text: 'hi' })).status).toBe(201)
    const texts = async (query: string) => (await julian('GET', `/threads?${query}`)).body.threads.map((t: { message: { text: string } }) => t.message.text)
    expect(await texts('mentions=vercel:user:constructor')).toEqual(['thanks @constructor', 'cc @[constructor]'])
    expect(await texts('mentions=__proto__')).toEqual(['cc @[__proto__]'])
    expect(await texts('by=constructor')).toEqual(['hi'])
  })

  it('are channels like any other', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const root = (await julian('POST', '/messages', { channel: 'constructor', text: 'one' })).body.message.id
    await julian('POST', '/messages', { re: root, text: 'two' })
    const { body } = await julian('GET', '/channels')
    expect(body.channels).toEqual([expect.objectContaining({ path: 'constructor', messages: 2, threads: 1 })])
  })
})
