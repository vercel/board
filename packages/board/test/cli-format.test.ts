import { describe, expect, it } from 'vitest'
import { formatMessage, formatSchedule, formatThreads, formatThreadSummaries, principalFlags } from '../src/cli/format.ts'
import type { MessageView, ScheduleView } from '../src/api/routes.ts'

const by = { actor: 'vercel:user:j', principal: 'vercel:user:j', profile: null }
const author = { kind: 'person', handle: 'julian', name: 'Julian', avatar: null } as unknown as MessageView['author']
const file = { id: 'nXHY', name: 'after.png', type: 'image/png', size: 17_000 }
const pictograph = /\p{Extended_Pictographic}/u

describe('CLI output has no emoji', () => {
  it('a scheduled message with a file', () => {
    const message = {
      id: 812, channel: 'dev', text: 'hi', re: null, replyTo: null, thread: 't', labels: {}, reactions: {}, by,
      noSync: false, origin: null, from: null, createdAt: new Date().toISOString(), editedAt: null, deleted: false,
      undelivered: {}, attachments: [file], links: [], schedule: { id: 's12', n: 0 }, author,
    } as unknown as MessageView
    const out = formatMessage(message)
    expect(out).not.toMatch(pictograph)
    expect(out).toMatch(/^#812  Julian · \d+s · scheduled s12\n/)
    expect(out).toContain('      file after.png · image/png · ')
  })

  it('a schedule', () => {
    const schedule = {
      id: 's12', channel: 'dev', re: null, text: 'ping', labels: {}, noSync: false, attachments: [file, file], first: '',
      every: null, until: null, times: null, sent: 0, next: new Date(Date.now() + 120_000).toISOString(), last: null,
      state: 'pending', canceled: null, by, author, createdAt: '',
    } as unknown as ScheduleView
    const out = formatSchedule(schedule)
    expect(out).not.toMatch(pictograph)
    expect(out).toMatch(/^s12  new thread in dev · once · next in 2m \(.+\) · 2 files · by Julian\n    ping$/)
    // An ID is shown as the board gave it: Vercel's are already `sch_…`.
    expect(formatSchedule({ ...schedule, id: 'sch_0eec95f5' })).toMatch(/^sch_0eec95f5  new thread in dev /)
  })
})

describe('an author with a profile', () => {
  const message = (name: string, via: { name: string; environment: string | null }, kind = 'agent') =>
    ({
      id: 9, channel: 'dev', text: 'on it', re: null, replyTo: null, thread: 't', labels: {}, reactions: {}, by,
      noSync: false, origin: null, from: null, createdAt: new Date().toISOString(), editedAt: null, deleted: false,
      undelivered: {}, attachments: [], links: [], schedule: null, author: { kind, handle: 'x', name, avatar: null, via },
    }) as unknown as MessageView

  it('shows who it writes through, unless it is an agent named like them', () => {
    expect(formatMessage(message('claude', { name: 'julian', environment: null }))).toMatch(/^#9  claude via julian · /)
    expect(formatMessage(message('factory', { name: 'factory', environment: 'production' }))).toMatch(/^#9  factory · /)
    expect(formatMessage(message('Factory', { name: 'factory', environment: 'preview' }))).toMatch(/^#9  Factory \(preview\) · /)
    // A platform user's name is their own: one named like the project that imported them still shows through it.
    expect(formatMessage(message('factory', { name: 'factory', environment: 'production' }, 'external'))).toMatch(/^#9  factory via factory · /)
  })
})

describe('read <channel>', () => {
  it("cuts a root's first line to fit 80 columns, and marks that more follows", () => {
    const root = (text: string) =>
      ({
        id: 812, channel: 'dev', text, re: null, labels: {}, reactions: {}, by, from: null,
        createdAt: new Date().toISOString(), deleted: false, attachments: [], author,
      }) as unknown as MessageView
    const shown = (text: string) => formatThreadSummaries([{ message: root(text), replies: 0, last: null }]).split('\n')[1]!
    for (const text of ['x'.repeat(73) + '\nmore', 'x'.repeat(74) + '\nmore', 'x'.repeat(200)]) expect(shown(text)).toBe(`      ${'x'.repeat(73)}…`)
    expect(shown('x'.repeat(74))).toBe(`      ${'x'.repeat(74)}`)
    expect(shown('flaky test\r\nsecond line')).toBe('      flaky test …')
  })

  it("counts the root's reactions under its text, and shows nothing for none", () => {
    const root = (reactions: Record<string, string[]>) =>
      ({
        id: 812, channel: 'dev', text: 'deploys are green', re: null, labels: {}, reactions, by, from: null,
        createdAt: new Date().toISOString(), deleted: false, attachments: [], author,
      }) as unknown as MessageView
    const lines = (reactions: Record<string, string[]>) => formatThreadSummaries([{ message: root(reactions), replies: 0, last: null }]).split('\n')
    expect(lines({ '+1': ['vercel:user:a', 'vercel:user:b'], eyes: ['vercel:user:a'] }).slice(1)).toEqual(['      deploys are green', '      👍 2   👀 1', '      no replies'])
    expect(lines({}).slice(1)).toEqual(['      deploys are green', '      no replies'])
  })
})

describe('reactions', () => {
  it('name the first three, count the rest, and use names from outside the thread', () => {
    const reactors = Array.from({ length: 12 }, (_, n) => `vercel:user:u${n}`)
    const message = {
      id: 812, channel: 'dev', text: 'hi', re: null, labels: {}, reactions: { eyes: reactors, tada: [by.actor] }, by,
      from: null, createdAt: new Date().toISOString(), deleted: false, attachments: [], author,
    } as unknown as MessageView
    const out = formatThreads([message], new Map([['vercel:user:u0', 'Ada'], ['vercel:user:u1', 'claude via ada']]))
    expect(out.split('\n').at(-1)).toMatch(/^      \S+ Ada, claude via ada, vercel:user:u2 \+9   \S+ Julian$/)
  })
})

describe('grants', () => {
  it("lists an app by the name the board knows it by, or else its client ID, so two apps don't look alike", () => {
    expect(principalFlags({ kind: 'app', clientId: 'oac_1', name: 'ship' })).toBe('--app ship')
    expect(principalFlags({ kind: 'app', clientId: 'cl_ship', name: null })).toBe('--app cl_ship')
  })
})
