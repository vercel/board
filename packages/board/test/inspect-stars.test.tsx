import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '../src/api/routes.ts'
import type { State } from '../src/inspect/app/store.ts'

// Starred channels in the inspector's sidebar, rendered as the page renders it, with the browser's
// storage faked: which channels show under "starred", and that a star stays in this browser, per board.

const storage = new Map<string, string>()
const ONE = 'https://one.example/api/board'
const TWO = 'https://two.example/api/board'

/** The page as a fresh load finds it: nothing kept in memory, only what the browser stored. */
async function load() {
  vi.resetModules()
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('location', { origin: 'http://localhost:4747', host: 'localhost:4747', pathname: '/', search: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  })
  const [{ Sidebar }, { toggleStar }, { initialState }] = await Promise.all([
    import('../src/inspect/app/sidebar.tsx'),
    import('../src/inspect/app/stars.ts'),
    import('../src/inspect/app/store.ts'),
  ])
  const me = { actor: 'local:user:ada', principal: 'local:user:ada', kind: 'person', handle: 'ada', name: 'Ada', avatar: null, profile: null, expiresAt: null, can: {} } as Me
  const paths = ['general', 'incidents', 'random', 'team/api', 'team/web']
  /** The sidebar's lines, top to bottom: section headings bare, channels with their `#`. */
  const sidebar = (url: string) => {
    const state: State = { ...initialState, me, discovery: { url } as State['discovery'], channels: Object.fromEntries(paths.map((path) => [path, { path }])) }
    const html = renderToStaticMarkup(<Sidebar state={state} current={{ view: 'activity' }} onCollapse={() => {}} />)
    const scroll = html.slice(html.indexOf('sidebar-scroll'), html.indexOf('sidebar-foot'))
    return [...scroll.matchAll(/<h2>([^<]+)|<span class="name">(#[^<]+)/g)].map((m) => (m[1] ?? m[2])!.trim())
  }
  return { sidebar, toggleStar }
}

beforeEach(() => storage.clear())

describe('starred channels', () => {
  it('lists nothing under starred until you star a channel', async () => {
    const { sidebar } = await load()
    expect(sidebar(ONE)).toEqual(['channels', '#general', '#incidents', '#random', 'team', '#api', '#web'])
  })

  it('lists starred channels above the rest, by full path, and out of their groups', async () => {
    const { sidebar, toggleStar } = await load()
    toggleStar(ONE, 'team/web')
    toggleStar(ONE, 'incidents')
    expect(sidebar(ONE)).toEqual(['starred', '#incidents', '#team/web', 'channels', '#general', '#random', 'team', '#api'])
  })

  it('puts an unstarred channel back in its group', async () => {
    const { sidebar, toggleStar } = await load()
    toggleStar(ONE, 'team/web')
    toggleStar(ONE, 'team/web')
    expect(sidebar(ONE)).toEqual(['channels', '#general', '#incidents', '#random', 'team', '#api', '#web'])
  })

  it('keeps stars across a reload, and each board’s apart', async () => {
    const first = await load()
    first.toggleStar(ONE, 'random')
    first.toggleStar(TWO, 'general')
    const { sidebar } = await load()
    expect(sidebar(ONE).slice(0, 2)).toEqual(['starred', '#random'])
    expect(sidebar(TWO).slice(0, 2)).toEqual(['starred', '#general'])
  })
})
