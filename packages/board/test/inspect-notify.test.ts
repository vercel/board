import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'

// The page's data module, as a browser runs it, with the inspector's proxy and the browser's
// Notification faked: which messages show a notification, and what each says.

const ME = 'local:user:julian'
const BOARD = 'https://team.example/api/board'

/** What the board answers next for a route, by `METHOD /path`: each is used once, then the route's usual answer. */
const next = new Map<string, (() => Response | Promise<Response>)[]>()
const me = (profile: string | null) =>
  Response.json({
    actor: profile ? `${ME}+${profile}` : ME,
    principal: ME,
    kind: profile ? 'agent' : 'person',
    handle: profile ? `julian/${profile}` : 'julian',
    name: profile ?? 'julian',
    avatar: null,
    profile,
    expiresAt: null,
    can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] },
  })
const usual: Record<string, (request: Request) => Response> = {
  // Who the page is: you, or as the profile the request names.
  'GET /me': (request) => me(request.headers.get('x-board-profile')),
  'GET /': () => Response.json({ version: '1', url: BOARD, audience: BOARD, team_id: null, project_id: null, sync: [] }),
  'GET /channels': () => Response.json({ channels: [{ path: 'dev' }], cursor: '0' }),
}

const message = (id: string, text: string, by = 'local:user:ada'): MessageView =>
  ({
    id,
    version: Number(id),
    revision: Number(id),
    channel: 'dev',
    text,
    re: null,
    replyTo: null,
    thread: `t${id}`,
    labels: {},
    reactions: {},
    by: { actor: by, principal: by.split('+')[0], profile: by.includes('+') ? by.split('+')[1] : null },
    noSync: false,
    origin: null,
    from: null,
    blocks: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: { kind: 'person', handle: 'ada', name: 'Ada', avatar: null },
  }) as MessageView

/** A page of the feed, each message posted. */
const feed = (...messages: MessageView[]) => () => {
  const events = messages.map((m) => ({ cursor: String(m.version), type: 'message.posted', createdAt: m.createdAt, payload: {}, message: m }))
  return Response.json({ events, cursor: events.at(-1)?.cursor ?? '0' })
}

/** The notifications the page made, as the browser got them. */
let shown: { title: string; body?: string; tag?: string }[] = []
let notifications: FakeNotification[] = []
let permission: NotificationPermission = 'granted'
/** What the prompt answers: `default` when you close it without choosing. */
let answer: NotificationPermission = 'granted'
const requested = vi.fn(async () => (permission = answer))
/** How many of the next notifications the browser refuses, as most mobile browsers do. */
let refuse = 0
class FakeNotification {
  static get permission() {
    return permission
  }
  static requestPermission = requested
  onclick: (() => void) | null = null
  closed = false
  constructor(title: string, options: NotificationOptions) {
    if (refuse > 0) {
      refuse--
      throw new TypeError('Illegal constructor')
    }
    shown.push({ title, body: options.body, tag: options.tag })
    notifications.push(this)
  }
  close() {
    this.closed = true
  }
}

/** The page's `<meta>` values: `inspect-profile`, `inspect-named`. */
let metas: Record<string, string> = {}
const doc = { querySelector: (selector: string) => ({ content: metas[/name="([^"]+)"/.exec(selector)?.[1] ?? ''] ?? '' }) }
let frame: (run: () => void) => void = (run) => setTimeout(run, 0)
let listeners = new Map<string, Set<() => void>>()
const activation = { isActive: true }
const focus = vi.fn()
const pushState = vi.fn()
const replaceState = vi.fn()

let page: typeof import('../src/inspect/app/board.ts')
let notify: typeof import('../src/inspect/app/notify.ts')

beforeAll(() => {
  vi.stubGlobal('document', doc)
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:4747', pathname: '/', search: '' })
  vi.stubGlobal('window', { focus })
  vi.stubGlobal('navigator', { userActivation: activation })
  vi.stubGlobal('history', { pushState, replaceState, state: null })
  vi.stubGlobal('dispatchEvent', () => true)
  vi.stubGlobal('PopStateEvent', class extends Event {})
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frame(run))
  vi.stubGlobal('addEventListener', (type: string, listener: () => void) => listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)))
  vi.stubGlobal('removeEventListener', (type: string, listener: () => void) => listeners.get(type)?.delete(listener))
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname.slice('/board'.length) || '/'}`
    return next.get(route)?.shift()?.() ?? usual[route]?.(request) ?? Response.json({ error: { code: 'not_found', message: `no ${route} here` } }, { status: 404 })
  })
})

// A fresh page for every test: what one tab saw is no other's.
beforeEach(async () => {
  next.clear()
  shown = []
  notifications = []
  permission = 'granted'
  answer = 'granted'
  refuse = 0
  metas = {}
  frame = (run) => setTimeout(run, 0)
  listeners = new Map()
  activation.isActive = true
  requested.mockClear()
  focus.mockClear()
  pushState.mockClear()
  replaceState.mockClear()
  await reload()
})

/** Loads the page afresh: it reads its `<meta>` values as it loads. */
async function reload() {
  vi.resetModules()
  page = await import('../src/inspect/app/board.ts')
  notify = await import('../src/inspect/app/notify.ts')
}

/** Boots the page on `boot`'s events, as the page does, notifying of mentions; then lets the feed bring `live`'s. */
async function run(boot: MessageView[], live: (() => Response | Promise<Response>) | MessageView[]) {
  next.set('GET /events', [feed(...boot), Array.isArray(live) ? feed(...live) : live])
  notify.notifyMentions()
  await page.boot()
}

/** Resolves once the page has folded `id` in: the feed's event for it has been through `each`. */
const folded = (id: string) => vi.waitFor(() => expect(page.getState().messages[id]).toBeDefined())

const gesture = (type: 'click' | 'keydown') => {
  for (const listener of [...(listeners.get(type) ?? [])]) listener()
}

describe("the inspector's page, notifying of mentions", () => {
  it('notifies of a live message that mentions you, and of none the page booted with', async () => {
    await run([message('10', '@julian an old one')], [message('11', 'not you'), message('12', `@[${ME}] the deploy failed\nlogs below`)])
    await folded('12')
    expect(shown).toEqual([{ title: 'Ada in #dev', body: '@julian the deploy failed', tag: `board:${BOARD}:12` }])
  })

  it("focuses the tab and opens the message's thread at it when you click it", async () => {
    await run([], [{ ...message('51', '@julian here'), re: '50', thread: 't50' }])
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    notifications[0]!.onclick!()
    expect(focus).toHaveBeenCalled()
    expect(pushState).toHaveBeenLastCalledWith({ pointed: 1 }, '', '/c/dev?thread=50&message=51')
    expect(notifications[0]!.closed).toBe(true)
  })

  it('shows none once you said no', async () => {
    permission = 'denied'
    await run([], [message('20', '@julian look')])
    await folded('20')
    expect(shown).toEqual([])
  })

  it('notifies from a hidden tab, which gets no animation frames', async () => {
    frame = () => {}
    await run([], [message('30', '@julian look')])
    await vi.waitFor(() => expect(shown).toMatchObject([{ tag: `board:${BOARD}:30` }]))
  })

  it('goes on to the next mention when the browser refuses to show one', async () => {
    refuse = 1
    await run([], [message('60', '@julian one'), message('61', '@julian two')])
    await folded('61')
    expect(shown).toMatchObject([{ tag: `board:${BOARD}:61` }])
  })

  it('notifies of none this tab posted, as a profile, whether the feed brings it before the board answers or after', async () => {
    metas['inspect-profile'] = JSON.stringify({ name: 'claude' })
    await reload()
    const mine = (id: string, text: string) => message(id, text, `${ME}+claude`)
    // The first post's answer waits until the feed has brought it. The board wrote the `@julian` typed as `@[id]`.
    let answer!: () => void
    const answered = new Promise<void>((resolve) => (answer = resolve))
    next.set('POST /messages', [async () => (await answered, Response.json({ message: mine('90', `@[${ME}] first`) }, { status: 201 })), () => Response.json({ message: mine('91', '@julian second') }, { status: 201 })])
    let second!: () => void
    const later = new Promise<void>((resolve) => (second = resolve))
    await run([], async () => (await later, feed(mine('90', `@[${ME}] first`), mine('91', `@[${ME}] second`), message('92', '@julian from ada'))()))
    const first = page.send({ channel: 'dev', re: null, text: '@julian first', noSync: false, labels: {} })
    await vi.waitFor(() => expect(page.getState().pending).toHaveLength(1))
    await page.send({ channel: 'dev', re: null, text: '@julian second', noSync: false, labels: {} })
    second()
    await folded('92')
    answer()
    await first
    expect(shown).toMatchObject([{ tag: `board:${BOARD}:92` }])
  })

  it('notifies of mentions of you, not of the profile the page posts as', async () => {
    metas['inspect-profile'] = JSON.stringify({ name: 'claude' })
    await reload()
    await run([], [message('70', '@julian done', `${ME}+claude`), message('71', '@julian/claude take this'), message('72', 'note to self, @julian', ME)])
    await folded('72')
    expect(page.getState().me?.actor).toBe(`${ME}+claude`)
    expect(shown).toMatchObject([{ tag: `board:${BOARD}:70` }])
  })

  it('notifies no one on a page served from an app, which has no visitor to be', async () => {
    metas['inspect-named'] = '1'
    permission = 'default'
    await reload()
    await run([], [message('80', '@julian look')])
    await folded('80')
    expect(shown).toEqual([])
    // Nor does it ask to.
    expect(listeners.get('click')?.size ?? 0).toBe(0)
  })
})

describe("the inspector's page, asking to notify", () => {
  it('asks on the first click, and not again once you answer', async () => {
    permission = 'default'
    await run([], [])
    expect(requested).not.toHaveBeenCalled()
    gesture('click')
    await vi.waitFor(() => expect(permission).toBe('granted'))
    gesture('click')
    gesture('keydown')
    expect(requested).toHaveBeenCalledTimes(1)
  })

  it('stops asking once you answered in another tab', async () => {
    permission = 'default'
    await run([], [])
    permission = 'granted'
    gesture('click')
    expect(requested).not.toHaveBeenCalled()
    expect(listeners.get('click')?.size ?? 0).toBe(0)
  })

  it('waits for a key that gives user activation, as Esc does not', async () => {
    permission = 'default'
    await run([], [])
    activation.isActive = false
    gesture('keydown')
    expect(requested).not.toHaveBeenCalled()
    activation.isActive = true
    gesture('keydown')
    expect(requested).toHaveBeenCalledTimes(1)
  })

  it('asks again on the next gesture when you close the prompt without choosing', async () => {
    permission = 'default'
    answer = 'default'
    await run([], [])
    gesture('click')
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    gesture('click')
    expect(requested).toHaveBeenCalledTimes(2)
  })
})
