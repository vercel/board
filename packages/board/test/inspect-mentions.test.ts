import { describe, expect, it } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import { notice } from '../src/inspect/app/notify.ts'
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

const event = (type: 'message.posted' | 'message.edited', m: MessageView) =>
  ({ cursor: String(m.version), type, createdAt: m.createdAt, payload: {}, message: m }) as unknown as BoardEventView

const mentioned = (...events: BoardEventView[]) => events.flatMap((e) => store.mentionOf(e, ME)?.id ?? [])
const posted = (id: number, text: string, overrides: Partial<MessageView> = {}) => event('message.posted', message(id, text, overrides))

describe('which live messages mention you', () => {
  it('counts your actor ID and your handle, as `--mentions me` does', () => {
    expect(mentioned(posted(1, `@[${ME.actor}] can you look?`), posted(2, 'ping @Julian when it lands'), posted(3, 'no one here'))).toEqual(['1', '2'])
  })

  it("doesn't count a mention of one of your profiles", () => {
    expect(mentioned(posted(1, `@[${ME.actor}+claude] take this`), posted(2, '@julian/claude take this'))).toEqual([])
  })

  it("doesn't count a mention in code", () => {
    expect(mentioned(posted(1, 'run `vb read --mentions @julian`'), posted(2, `\`\`\`\n@[${ME.actor}]\n\`\`\``))).toEqual([])
  })

  it("doesn't count your own posts, by your actor, and counts your agents'", () => {
    const mine = posted(1, 'note to self, @julian', { by: { actor: ME.actor, principal: ME.actor, profile: null } })
    // Your agent shares your credentials, but it isn't you.
    const agent = posted(2, '@julian done', { by: { actor: `${ME.actor}+claude`, principal: ME.actor, profile: 'claude' } })
    expect(mentioned(mine, agent)).toEqual(['2'])
  })

  it("doesn't count a deleted message", () => {
    expect(mentioned(posted(1, '@julian', { deleted: true }))).toEqual([])
  })

  it('counts new posts only, not edits', () => {
    expect(mentioned(event('message.edited', message(1, 'can @julian look?')))).toEqual([])
  })
})

describe('what a mention notification says', () => {
  it("says who wrote it and where, its first line with each mention by name, and the author's avatar", () => {
    expect(notice(message(7, `\n@[${ME.actor}] the deploy failed\nlogs below`, { channel: 'incidents' }), { [ME.actor]: 'Julian' }, 'https://team.example/api/board')).toEqual({
      title: 'Ada in #incidents',
      body: '@Julian the deploy failed',
      icon: 'https://example.com/ada.png',
      tag: 'board:https://team.example/api/board:7',
    })
  })

  it('shows no avatar that is not an https URL', () => {
    expect(notice(message(7, '@julian', { author: { kind: 'person', handle: 'ada', name: 'Ada', avatar: 'http://example.com/ada.png' } }), {}, 'b')).not.toHaveProperty('icon')
  })
})
