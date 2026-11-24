import { describe, expect, it } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import * as store from '../src/inspect/app/store.ts'

const ME = { actor: 'vercel:user:u_julian', handle: 'julian' }
const ADA = 'vercel:user:u_ada'

function message(id: number, text: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: String(id),
    version: id,
    revision: id,
    channel: 'ops',
    text,
    re: null,
    replyTo: null,
    thread: `t${id}`,
    labels: {},
    reactions: {},
    by: { actor: ADA, principal: ADA, profile: null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString(),
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: { kind: 'person', handle: 'ada', name: 'Ada', avatar: 'https://example.com/ada.png' },
    ...overrides,
  }
}

const event = (type: 'message.posted' | 'message.edited' | 'message.deleted', m: MessageView, cursor = String(m.version)) =>
  ({ cursor, type, createdAt: m.createdAt, payload: {}, message: m }) as unknown as BoardEventView

const posted = (m: MessageView) => event('message.posted', m)

/** The page before the batch, holding `messages`. */
const holding = (...messages: MessageView[]): store.State => store.merge({ ...store.initialState, me: null }, messages)

const fresh = (state: store.State, events: BoardEventView[]) => store.freshMentions(state, events, ME).map((m) => m.id)

describe('which live messages mention you', () => {
  it('counts your actor ID and your handle, as `--mentions me` does', () => {
    const events = [posted(message(1, `@[${ME.actor}] can you look?`)), posted(message(2, 'ping @Julian when it lands')), posted(message(3, 'no one here'))]
    expect(fresh(store.initialState, events)).toEqual(['1', '2'])
  })

  it("doesn't count a mention of one of your profiles", () => {
    const events = [posted(message(1, `@[${ME.actor}+claude] take this`)), posted(message(2, '@julian/claude take this'))]
    expect(fresh(store.initialState, events)).toEqual([])
  })

  it("doesn't count a mention in code", () => {
    const events = [posted(message(1, 'run `vb read --mentions @julian`')), posted(message(2, `\`\`\`\n@[${ME.actor}]\n\`\`\``))]
    expect(fresh(store.initialState, events)).toEqual([])
  })

  it("doesn't count your own messages, by your actor", () => {
    const mine = message(1, 'note to self, @julian', { by: { actor: ME.actor, principal: ME.actor, profile: null } })
    // Your agent shares your credentials, but it isn't you: its mention of you counts.
    const agent = message(2, '@julian done', { by: { actor: `${ME.actor}+claude`, principal: ME.actor, profile: 'claude' } })
    expect(fresh(store.initialState, [posted(mine), posted(agent)])).toEqual(['2'])
  })

  it("doesn't count a deleted message, or one deleted later in the batch", () => {
    const gone = message(1, '@julian', { deleted: true })
    const later = message(2, '@julian look')
    expect(fresh(store.initialState, [posted(gone), posted(later), event('message.deleted', { ...later, deleted: true, text: '' }, '3')])).toEqual([])
  })

  it('counts an edit that adds a mention', () => {
    const before = message(1, 'can someone look?')
    expect(fresh(holding(before), [event('message.edited', { ...before, text: 'can @julian look?', version: 5 })])).toEqual(['1'])
  })

  it('counts an edit that adds a mention to a post earlier in the batch', () => {
    const post = message(1, 'can someone look?')
    expect(fresh(store.initialState, [posted(post), event('message.edited', { ...post, text: 'can @julian look?', version: 5 })])).toEqual(['1'])
  })

  it('skips an edit of a message that mentioned you already', () => {
    const before = message(1, 'can @julian look?')
    expect(fresh(holding(before), [event('message.edited', { ...before, text: 'can @julian look now?', version: 5 })])).toEqual([])
  })

  it('counts a message once, whether it comes twice in a batch or again after it', () => {
    const m = message(1, '@julian look')
    expect(fresh(store.initialState, [posted(m), posted(m)])).toEqual(['1'])
    expect(fresh(holding(m), [posted(m)])).toEqual([])
  })
})

describe('what a mention notification says', () => {
  it("says who wrote it and where, its first line with each mention by name, and the author's avatar", () => {
    const state = { ...holding(message(7, `\n@[${ME.actor}] the deploy failed\nlogs below`, { channel: 'incidents' })), actors: { [ME.actor]: { kind: 'person', handle: 'julian', name: 'Julian', avatar: null } } } as store.State
    expect(store.notice(state, '7', 'https://team.example/api/board')).toEqual({
      title: 'Ada in #incidents',
      body: '@Julian the deploy failed',
      icon: 'https://example.com/ada.png',
      tag: 'board:https://team.example/api/board:7',
    })
  })

  it('shows no avatar that is not an https URL', () => {
    const state = holding(message(7, '@julian', { author: { kind: 'person', handle: 'ada', name: 'Ada', avatar: 'http://example.com/ada.png' } }))
    expect(store.notice(state, '7', 'b')).not.toHaveProperty('icon')
  })
})
