import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { as, fakeMessageboard } from './messageboard.ts'

const API = 'http://localhost'

/** A handle on the fake's board through vercel(), as `principal`. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb') =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files }) })

/** The requests the API got since `from`, without the board they name. */
const asked = (api: ReturnType<typeof fakeMessageboard>, from: number) => api.requests.slice(from).map((request) => request.replace(/\/boards\/[^/]+/, ''))

describe("vercel()'s inbox", () => {
  it('asks the API by its routes: the message in the path, a follow by what it follows', async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const root = await ada.post('dev', 'new empty states')
    const reply = await ada.reply(root.id, 'mock attached')
    const from = api.requests.length

    await jb.inbox.add(root.id)
    await jb.inbox.add(root.id, { message: true })
    await jb.inbox.mark(reply.id)
    await jb.inbox.mark(root.id, { unread: true })
    await jb.inbox.snooze(root.id, new Date(Date.now() + 60_000).toISOString())
    await jb.inbox.remove(root.id)
    await jb.inbox.follow({ channel: 'www/' })
    await jb.inbox.follow({ thread: reply.id })
    await jb.inbox.unfollow({ thread: root.id })
    await jb.inbox.unfollow({ channel: 'www/' })

    const writes = asked(api, from).filter((request) => request.startsWith('POST '))
    expect(writes).toEqual([
      `POST /me/inbox/items/${root.id}`,
      `POST /me/inbox/items/${root.id}`,
      `POST /me/inbox/items/${reply.id}/read`,
      `POST /me/inbox/items/${root.id}/read`,
      `POST /me/inbox/items/${root.id}/snooze`,
      `POST /me/inbox/items/${root.id}/remove`,
      'POST /me/inbox/follows/channels',
      `POST /me/inbox/follows/threads/${reply.id}`,
      `POST /me/inbox/follows/threads/${root.id}/remove`,
      'POST /me/inbox/follows/channels/remove',
    ])
  })

  it('answers a thread by its root, a message by itself, and times as ISO strings', async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const root = await ada.post('dev', 'new empty states')
    const reply = await ada.reply(root.id, 'mock attached')
    await ada.reply(root.id, 'and the dark one')

    const thread = await jb.inbox.add(root.id)
    expect(thread).toMatchObject({ thread: root.id, message: null, reader: 'vercel:user:u_jb', reasons: ['added'], unread: 1, snoozed: null })
    expect([thread.first.text, thread.last.text, thread.first.channel]).toEqual(['new empty states', 'and the dark one', 'dev'])
    expect(new Date(thread.at).toISOString()).toBe(thread.at)

    // A message by itself is its own item's last, whatever came after it.
    const alone = await jb.inbox.add(reply.id)
    expect(alone).toMatchObject({ thread: root.id, message: reply.id, unread: 1 })
    expect([alone.first.text, alone.last.text]).toEqual(['new empty states', 'mock attached'])
    expect(await jb.inbox.add(root.id, { message: true })).toMatchObject({ thread: root.id, message: root.id })

    const until = new Date(Date.now() + 3_600_000).toISOString()
    expect((await jb.inbox.snooze(root.id, until)).snoozed).toBe(until)
    expect((await jb.inbox.snooze(root.id, null)).snoozed).toBeNull()
  })

  it('refuses an ID that names no message without asking the API', async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    await jb.post('dev', 'so the board is there')
    const from = api.requests.length
    for (const act of [() => jb.inbox.add('812'), () => jb.inbox.mark('nonsense'), () => jb.inbox.remove('msg_1'), () => jb.inbox.follow({ thread: 'thr_x' })]) {
      await expect(act()).rejects.toMatchObject({ status: 404, code: 'message_not_found' })
    }
    expect(asked(api, from).filter((request) => request.includes('/me/inbox'))).toEqual([])
  })

  it("pages what its reader follows by the API's cursor, channels first", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const root = await ada.post('dev', 'one')
    await jb.inbox.follow({ channel: 'www/' })
    await jb.inbox.follow({ channel: 'incidents' })
    await jb.inbox.follow({ thread: root.id })

    const first = await jb.inbox.follows({ limit: 2 })
    expect(first.follows.map((follow) => follow.channel ?? follow.thread)).toEqual(['incidents', 'www/'])
    expect(first.older).not.toBeNull()
    const rest = await jb.inbox.follows({ limit: 2, before: first.older! })
    expect(rest).toMatchObject({ follows: [{ thread: root.id, by: 'asked' }], older: null })
  })

  it('holds a read of what changed for as long as it waits, asking the API again as each part of the wait runs out', async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const root = await ada.post('dev', 'wait for it')
    const { cursor } = await jb.inbox.items()
    const waiting = jb.inbox.poll({ after: cursor, wait: 20 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await jb.inbox.add(root.id)
    const read = await waiting
    expect(read.events).toMatchObject([{ type: 'inbox.item', item: { thread: root.id } }])
    // And then what its reader removed, told by its thread.
    await jb.inbox.remove(root.id)
    expect((await jb.inbox.poll({ after: read.cursor })).events).toEqual([{ type: 'inbox.removed', cursor: expect.any(String), thread: root.id, message: null, reader: 'vercel:user:u_jb' }])
  })

  it("tells a person what changed in their agents' inboxes too, with under", async () => {
    const api = fakeMessageboard()
    const jb = handleOn(api)
    const ada = handleOn(api, 'user:u_ada')
    const root = await ada.post('dev', 'one for each')
    const { cursor } = await jb.inbox.items()
    await jb.inbox.add(root.id)
    await jb.as('claude').inbox.add(root.id)

    const readers = async (query: { under?: boolean }) => (await jb.inbox.poll({ after: cursor, ...query })).events.map((event) => (event.type === 'inbox.item' ? event.item.reader : null))
    expect(await readers({})).toEqual(['vercel:user:u_jb'])
    expect(await readers({ under: true })).toEqual(['vercel:user:u_jb', 'vercel:user:u_jb+claude'])
  })
})
