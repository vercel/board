import { afterEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { board, type Middleware, type MiddlewareContext } from '../src/server/index.ts'
import { oidcTokens, type Can, type HostPrincipal } from '../src/access/index.ts'
import { a2 } from '../src/server/a2.ts'
import { http } from '../src/backend-http/index.ts'
import { board as projectBoard, bearer, BOARD_URL, caller, deploymentToken, personToken, testAuth, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

// Who may use a board, and what its writes go through, are board()'s, on any backend: it
// verifies each caller, gives it what its defaults and grants say, and runs the middleware, then
// calls the backend.

/** Where the support app's board is mounted: a board on the team's board, over http(). */
const SUPPORT_URL = 'https://support.test/api/board'
const SUPPORT = 'vercel:project:prj_support:production'
const supportToken = () => deploymentToken('support', 'prj_support', 'production')
const MARKETING = 'vercel:project:prj_marketing:production'

/** The team's board, and a request to it or to the support app's board, as each URL says. */
function team(remote: ReturnType<typeof testBoard>, project: () => { fetch(request: Request): Promise<Response> }) {
  const seen: Request[] = []
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) {
      seen.push(request.clone())
      return remote.fetch(request)
    }
    if (request.url.startsWith(SUPPORT_URL)) return project().fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  return { seen, fetch: bearer(route, supportToken) }
}

/** A request to `fetch` at `url`, as a browser with `cookie` sends it. */
const withCookie = (fetch: (request: Request) => Promise<Response>, cookie: string | null, url = SUPPORT_URL) => async (method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }
  const response = await fetch(new Request(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>) => caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

afterEach(() => vi.useRealTimers())

describe('a board on http()', () => {
  it('serves no request: it verifies none, and nothing reaches the board it uses', async () => {
    const remote = testBoard()
    await remote.createGrant({ principals: [{ kind: 'project', project: 'prj_support', environments: ['production'] }], can: { '*': 'all' } })
    let project: ReturnType<typeof board>
    const { seen, fetch } = team(remote, () => project)
    const authenticate = vi.fn(async (): Promise<HostPrincipal> => ({ id: 'app:user:ada', kind: 'person', handle: 'ada' }))
    // An `authenticate` opens nothing: the board it uses keeps the say.
    project = board({ backend: http(BOARD_URL, { fetch }), url: SUPPORT_URL, authenticate })
    const ada = withCookie(project.fetch, 'session=ada')
    const nothing = { error: { code: 'not_found', message: `${SUPPORT_URL} answers nothing itself` } }
    for (const [method, path, body] of [
      ['GET', '/', undefined],
      ['GET', '/me', undefined],
      ['GET', '/messages', undefined],
      ['POST', '/messages', { channel: 'support', text: 'hi' }],
      ['POST', '/schedules', { channel: 'support', text: 'hi', in: '1h' }],
      ['POST', '/messages/1/sync', { target: 'slack:#general' }],
    ] as const)
      expect(await ada(method, path, body), `${method} ${path}`).toEqual({ status: 404, body: nothing })
    expect(authenticate).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    // Its own code still reaches the board it uses, as the project.
    expect((await project.post('support', 'from the app')).by.principal).toBe(SUPPORT)
  })
})

describe("a local board's own writes, through board()", () => {
  it('sends a schedule as its creator through the middleware, and cancels it once its grants give the creator nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const queue = fakeQueue()
    const seen: Pick<MiddlewareContext, 'source' | 'author' | 'write'>[] = []
    const middleware: Middleware = ({ source, author, write, next }) => {
      seen.push({ source, author, write })
      return next({ text: `${write.text} (checked)` })
    }
    const kept = projectBoard({
      backend: a2({ store: memory(), scheduler: queue.scheduler }),
      url: BOARD_URL,
      authenticate: oidcTokens(testAuth),
      middleware: [middleware],
    })
    // Without g2's every project on the team, its creator may do only what this grant says.
    await kept.revokeGrant('g2')
    const ops = { principals: [{ kind: 'project' as const, project: 'prj_marketing', environments: ['production'] }], can: { ops: ['read' as const, 'post' as const] } }
    const { grant } = await kept.createGrant(ops)
    // A token minted now, since the clock moves past each one's hour.
    const marketing = async (method: string, path: string, body?: unknown) => caller(kept.fetch, await deploymentToken())(method, path, body)
    const advance = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      vi.setSystemTime(Date.now() + 3_600_000)
      await queue.fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const created = await marketing('POST', '/schedules', { channel: 'ops', text: 'nightly check', every: '1h' })
    expect(created.status).toBe(201)
    await advance()
    await vi.waitFor(async () => expect((await marketing('GET', '/messages?channel=ops')).body.messages).toMatchObject([{ text: 'nightly check (checked)', schedule: { n: 0 } }]))
    // The middleware saw the send as any post: the schedule's, by its creator.
    const id = Number(created.body.schedule.id.replace(/^s/, ''))
    expect(seen).toMatchObject([{ source: { kind: 'schedule', id }, author: { id: MARKETING }, write: { kind: 'post', channel: 'ops', text: 'nightly check' } }])

    // The board's grants give the creator nothing now: the next send is canceled, and never reaches the middleware.
    await kept.revokeGrant(grant.id)
    await advance()
    await kept.createGrant(ops)
    expect((await marketing('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ sent: 1, state: 'canceled', canceled: { reason: 'revoked' } }])
    expect(seen).toHaveLength(1)
  })

  it("matches a registered watcher by what the board's grants let its registrant read, at each event", async () => {
    const remote = testBoard()
    // One grant for the project, changed by its ID to change what it gives; g2 would let it in too.
    await remote.revokeGrant('g2')
    const { grant: made } = await remote.createGrant({ principals: [{ kind: 'project', project: 'prj_support', environments: ['production'] }], can: { '*': 'all' } })
    const grant = (can: Can) => remote.updateGrant(made.id, { can: (typeof can === 'object' && !Array.isArray(can) ? can : { '*': can }) as never })
    const support = caller(remote.fetch, await supportToken())
    expect((await support('POST', '/watchers', { watch: { triage: { tail: 'feedback' } } })).status).toBe(200)
    const pulled: string[] = []
    /** Pulls and acks what's matched for the project, as a board pulling on its own would. */
    const pull = async () => {
      for (const match of (await support('GET', '/watchers/matches')).body.matches as { id: string; lease: string; event: { message: { text: string } } }[]) {
        pulled.push(match.event.message.text)
        await support('POST', `/watchers/matches/${match.id}/ack`, { lease: match.lease })
      }
      return pulled
    }
    const julian = await julianOn(remote.fetch)
    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(async () => expect(await pull()).toEqual(['export is broken']))
    // The board's grants no longer let the project read feedback: what's posted there now isn't its
    // match, even once it may read it again by the time it pulls.
    await grant({ support: ['read'] })
    await julian('POST', '/messages', { channel: 'feedback', text: 'import too' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await grant('all')
    await julian('POST', '/messages', { channel: 'feedback', text: 'and search' })
    await vi.waitFor(async () => expect(await pull()).toEqual(['export is broken', 'and search']))
  })
})
