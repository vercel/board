import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The page's navigation, with the browser's History API faked: which URL each move leaves in the
// address bar, and what the page hears.

const address = { pathname: '/', search: '' }
const pushState = vi.fn((_: unknown, __: string, to: string) => go(to))
const replaceState = vi.fn((_: unknown, __: string, to: string) => go(to))
const heard = vi.fn()
const go = (to: string) => {
  const at = to.indexOf('?')
  address.pathname = at === -1 ? to : to.slice(0, at)
  address.search = at === -1 ? '' : to.slice(at)
}

let nav: typeof import('../src/inspect/app/nav.tsx')

beforeAll(async () => {
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('location', address)
  vi.stubGlobal('history', { pushState, replaceState })
  vi.stubGlobal('dispatchEvent', heard)
  vi.stubGlobal('PopStateEvent', class extends Event {})
  nav = await import('../src/inspect/app/nav.tsx')
})

beforeEach(() => {
  go('/')
  pushState.mockClear()
  replaceState.mockClear()
  heard.mockClear()
})

describe("the inspector's page, pointing at a message", () => {
  it('opens the thread at the message', () => {
    nav.pointAt('50', 'dev', '51')
    expect(pushState).toHaveBeenCalledWith({ pointed: expect.any(Number) }, '', '/c/dev?thread=50&message=51')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('drops the message on any other move, keeping the rest', () => {
    nav.pointAt('50', 'dev', '51')
    nav.navigate(nav.here({ params: { label: 'kind=bug' } }))
    expect(address.search).toBe('?thread=50&label=kind%3Dbug')
    nav.pointAt('50', 'dev', '51')
    nav.navigate(nav.here({ thread: '60' }))
    expect(address.search).toBe('?thread=60')
  })

  it('points at the message the URL already points at again, as a new pointing', () => {
    nav.pointAt('50', 'dev', '51')
    const [first] = pushState.mock.calls[0]!
    nav.pointAt('50', 'dev', '51')
    // The same URL, so nothing new in the history; the page hears it, and the pointing is a new one.
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith({ pointed: expect.any(Number) }, '', '/c/dev?thread=50&message=51')
    expect(replaceState.mock.calls[0]![0]).not.toEqual(first)
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
