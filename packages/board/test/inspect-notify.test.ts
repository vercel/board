import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'

// The page's data module, as a browser runs it, with the inspector's proxy and the browser's
// Notification faked: which messages show a notification, and what each says.

const ME = 'local:user:julian'
const BOARD = 'https://team.example/api/board'

/** What the board answers next for a route, by `METHOD /path`: each is used once, then the route's usual answer. */
const next = new Map<string, (() => Response)[]>()
const usual: Record<string, () => Response> = {
  'GET /me': () => Response.json({ actor: ME, principal: ME, kind: 'person', handle: 'julian', name: 'julian', avatar: null, profile: null, expiresAt: null, can: { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] } }),
  'GET /': () => Response.json({ version: '1', url: BOARD, audience: BOARD, team_id: null, project_id: null, sync: [] }),
  'GET /channels': () => Response.json({ channels: [{ path: 'dev' }], cursor: '0' }),
}

const message = (id: string, text: string): MessageView =>
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
    by: { actor: 'local:user:ada', principal: 'local:user:ada', profile: null },
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

type Live = MessageView | ['message.edited', MessageView]

/** A page of the feed: each message posted, or edited as it says. */
const feed = (...items: Live[]) => () => {
  const events = items.map((item) => {
    const [type, m] = Array.isArray(item) ? item : (['message.posted', item] as const)
    return { cursor: String(m.version), type, createdAt: m.createdAt, payload: {}, message: m }
  })
  return Response.json({ events, cursor: events.at(-1)?.cursor ?? '0' })
}

/** The notifications the page made, as the browser got them. */
const shown: { title: string; body?: string; tag?: string }[] = []
const notifications: FakeNotification[] = []
let permission: NotificationPermission = 'granted'
const requested = vi.fn(async () => permission)
/** How many of the next notifications the browser refuses, as Chrome on Android does. */
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

const shownOrHidden = new Set<() => void>()
const doc = {
  hidden: false,
  querySelector: () => null,
  addEventListener: (type: string, listener: () => void) => type === 'visibilitychange' && shownOrHidden.add(listener),
}
let frame: (run: () => void) => void = (run) => setTimeout(run, 0)
const listeners = new Map<string, Set<() => void>>()
const focus = vi.fn()
const pushState = vi.fn()

let page: typeof import('../src/inspect/app/board.ts')

beforeAll(async () => {
  vi.stubGlobal('document', doc)
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:4747', pathname: '/', search: '' })
  vi.stubGlobal('window', { focus })
  vi.stubGlobal('history', { pushState })
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
    return next.get(route)?.shift()?.() ?? usual[route]?.() ?? Response.json({ error: { code: 'not_found', message: `no ${route} here` } }, { status: 404 })
  })
  page = await import('../src/inspect/app/board.ts')
})

beforeEach(() => {
  shown.length = 0
  permission = 'granted'
  doc.hidden = false
  frame = (run) => setTimeout(run, 0)
  refuse = 0
})

/** Boots the page on `boot`'s events, then lets the feed bring `live`'s; resolves once the page holds `id`. */
async function run(boot: MessageView[], live: Live[], id: string) {
  next.set('GET /events', [feed(...boot), feed(...live)])
  await page.boot()
  await vi.waitFor(() => expect(page.getState().messages[id]).toBeDefined())
}

describe("the inspector's page, notifying of mentions", () => {
  it('notifies of a live message that mentions you, and of none the page booted with', async () => {
    await run([message('10', '@julian an old one')], [message('11', 'not you'), message('12', `@[${ME}] the deploy failed\nlogs below`)], '12')
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(shown).toEqual([{ title: 'Ada in #dev', body: '@julian the deploy failed', tag: `board:${BOARD}:12` }])
  })

  it("focuses the tab and opens the message's thread when you click it", async () => {
    const reply = { ...message('51', '@julian here'), re: '50', thread: 't50' }
    await run([], [reply], '51')
    await vi.waitFor(() => expect(notifications.at(-1)?.onclick).toBeTypeOf('function'))
    notifications.at(-1)!.onclick!()
    expect(focus).toHaveBeenCalled()
    expect(pushState).toHaveBeenLastCalledWith(null, '', '/c/dev?thread=50')
    expect(notifications.at(-1)!.closed).toBe(true)
  })

  it('shows none once you said no', async () => {
    permission = 'denied'
    await run([], [message('20', '@julian look')], '20')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(shown).toEqual([])
  })

  it('notifies from a hidden tab, which gets no animation frames', async () => {
    doc.hidden = true
    frame = () => {}
    await run([], [message('30', '@julian look')], '30')
    expect(shown).toMatchObject([{ tag: `board:${BOARD}:30` }])
  })

  it('notifies from a tab hidden after it asked for a frame', async () => {
    let asked = false
    frame = () => {
      asked = true
    }
    next.set('GET /events', [feed(), feed(message('35', '@julian look'))])
    await page.boot()
    await vi.waitFor(() => expect(asked).toBe(true))
    doc.hidden = true
    for (const listener of shownOrHidden) listener()
    await vi.waitFor(() => expect(shown).toMatchObject([{ tag: `board:${BOARD}:35` }]))
  })

  it('goes on to the next mention when the browser refuses to show one', async () => {
    refuse = 1
    await run([], [message('60', '@julian one'), message('61', '@julian two')], '61')
    await vi.waitFor(() => expect(shown).toMatchObject([{ tag: `board:${BOARD}:61` }]))
  })

  it('notifies of a message once, even when an edit takes the mention out and puts it back', async () => {
    // A frame at once: each event is its own batch.
    frame = (run) => run()
    const m = message('40', '@julian look')
    await run([], [m, ['message.edited', { ...m, version: 41, text: 'look' }], ['message.edited', { ...m, version: 42, text: '@julian look again' }]], '40')
    await vi.waitFor(() => expect(page.getState().messages['40']?.version).toBe(42))
    expect(shown).toMatchObject([{ body: '@julian look' }])
  })

  it('asks for permission on the first click, and only then', async () => {
    permission = 'default'
    requested.mockClear()
    await run([], [], '10')
    expect(requested).not.toHaveBeenCalled()
    for (const listener of [...(listeners.get('click') ?? [])]) listener()
    for (const listener of [...(listeners.get('keydown') ?? [])]) listener()
    expect(requested).toHaveBeenCalledTimes(1)
  })
})
