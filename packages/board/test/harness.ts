import { vi, expect } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { createBoard, type Board, type BoardOptions } from '../src/server/board.ts'
import type { Serving } from '../src/server/policy.ts'
import { a2, type A2Options } from '../src/server/a2.ts'
import { memoryBlob } from '../src/server/blob.ts'
import { local } from '../src/backend-local/index.ts'
import { oidcTokens, type OidcTokensOptions } from '../src/access/index.ts'
import { BOARD_URL, PROJECT_ID, TEAM_ID, testAuth, testLocal } from './tokens.ts'

export * from './tokens.ts'

/**
 * A clock that keeps real time and can skip ahead. A2 holds a failed event back
 * before retrying it (one second, doubling to 30) by its store's clock, so a
 * test that drives retries skips the hold instead of waiting it out.
 */
export function testClock() {
  let ahead = 0
  return {
    now: () => new Date(Date.now() + ahead),
    /** Past any retry hold. */
    skip: (ms = 30_000) => void (ahead += ms),
  }
}

/**
 * Where these tests' boards run: in the test project (`PROJECT_ID`, on `TEAM_ID`), as a board
 * deployed in it finds itself in its environment, with nothing read from disk.
 */
const environment = async (): Promise<Serving> => ({
  oidcTokens: (await import('../src/server/serving.ts')).oidcTokens,
  ownProjectId: async () => PROJECT_ID,
  ownTeamId: async () => TEAM_ID,
  discoveryIdentity: async () => ({ projectId: PROJECT_ID, teamId: TEAM_ID }),
})

/** `board()`, as a deployment of the test project runs it. Tests pass the backend. */
export function board(options: BoardOptions): Board {
  return createBoard(options, {
    backend: () => {
      throw new Error('a test passes board() its backend')
    },
    sync: () => import('../src/sync/engine.ts'),
    serving: environment,
  })
}

/**
 * board()'s options and the local board engine's, side by side, as tests write them. `auth` is
 * `oidcTokens()`'s options, for board()'s `authenticate`. Without a store, it's one in memory.
 */
export type MountOptions = Partial<A2Options> & Omit<BoardOptions, 'backend' | 'fetch'> & { auth?: OidcTokensOptions }

/** A board on the local board's engine: each option to the one that takes it. It has the engine's extras, for tests to look inside. */
export function mount(options: MountOptions) {
  const { store, scheduler, blob, transport, auth, ...rest } = options
  const backend = a2({ store: store ?? memory(), ...(scheduler ? { scheduler } : {}), ...(blob ? { blob } : {}), ...(transport ? { transport } : {}) })
  const { url, ...given } = rest
  const created = board({
    ...given,
    backend,
    ...(!rest.authenticate && auth ? { authenticate: oidcTokens(auth) } : {}),
    ...('url' in options ? { url } : {}),
  })
  // Read when a test asks.
  const lazy = (read: () => unknown) => ({ get: read, enumerable: true })
  return Object.defineProperties(Object.assign(created, { backend, scheduler: backend.scheduler }), {
    servers: lazy(() => backend.servers),
    session: lazy(() => backend.session),
    store: lazy(() => backend.store),
  }) as typeof created & { backend: typeof backend; scheduler: typeof backend.scheduler } & Pick<typeof backend, 'servers' | 'session' | 'store'>
}

/**
 * A board on a memory store, with its files in memory, whose tokens come from a local test issuer.
 * It has no scheduler unless a test passes one, and `blob: undefined` keeps no files.
 */
export function testBoard(options: MountOptions = {}) {
  const clock = testClock()
  const store = memory({ clock })
  const created = mount({
    store,
    blob: memoryBlob(),
    // A local issuer too, as `vb serve` has: its tokens are the board's local user's, its owner.
    auth: { ...testAuth, local: testLocal },
    ...options,
    // `url: undefined` lets the board infer its URL from requests, as the CLI's tests do.
    url: 'url' in options ? options.url : BOARD_URL,
  })
  /**
   * Lets a failed event's next attempt run now, once no attempt is running on
   * `session`: skipping past a running attempt's claim would let a drain take it
   * over, and run the event twice at once.
   */
  const skipHold = async (server: { contract: { name: string } }, session: string) => {
    // Skipping the clock lapses every claim in the store, so nothing may be running on the board either:
    // a delivery in flight there would be taken over, and post twice.
    const sessions = [`${server.contract.name}\u001f${session}`, 'board\u001fboard']
    await vi.waitFor(async () => {
      for (const at of sessions) {
        const cursors = await store.log.cursors(at)
        expect(cursors.filter((cursor) => cursor.claimHolder !== null)).toEqual([])
      }
    })
    clock.skip()
  }
  return Object.assign(created, { clock, skipHold })
}

/**
 * A board as `local({ memory: true })` keeps one, with its scheduler in this process, whose tokens
 * come from a local test issuer: what a test that needs only a board, end to end, runs against.
 */
export function localBoard(options: Omit<BoardOptions, 'backend' | 'fetch'> & { auth?: OidcTokensOptions } = {}) {
  const { auth, url, ...rest } = options
  const backend = local({ memory: true })
  const created = board({
    ...rest,
    backend,
    authenticate: rest.authenticate ?? oidcTokens(auth ?? { ...testAuth, local: testLocal }),
    // `url: undefined` lets the board infer its URL from requests, as the CLI's tests do.
    ...('url' in options ? (url !== undefined ? { url } : {}) : { url: BOARD_URL }),
  })
  return Object.assign(created, { close: () => backend.close() })
}
