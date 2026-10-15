import { describe, expect, it } from 'vitest'
import { routes, type RouteName } from '../src/api/routes.ts'
import { githubActions } from '../src/server/index.ts'
import { BOARD_URL, caller, personToken, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

/**
 * Every route, called by a workflow that reads `open` and nothing else. A
 * target in `secret` must answer as if it didn't exist (404), or the request
 * must be refused (403); a write to a target in `open`, which it reads, is a
 * 403. A new route fails the first test until it has an entry here.
 */
type Fixture = {
  secret: { root: number; reply: number; schedule: number; file: string }
  open: { root: number; schedule: number }
}
type Call = { method: 'GET' | 'POST'; path: string; body?: unknown; status: number; check?: (body: any) => void }
type Walk = 'public' | ((fixture: Fixture) => Call[])

const nothingFrom = (field: string) => (body: any) => expect(JSON.stringify(body[field])).not.toContain('secret')

const WALK: Record<RouteName, Walk> = {
  // Unauthenticated: they show nothing a channel holds.
  discovery: 'public',
  avatar: 'public',
  openapi: 'public',
  webhook: 'public',
  // About the caller.
  me: () => [{ method: 'GET', path: '/me', status: 200, check: (body) => expect(body.access).toEqual({ open: ['read'] }) }],
  identity: () => [{ method: 'GET', path: '/identity', status: 200 }],
  identityLink: () => [{ method: 'POST', path: '/identity/link', body: { sync: 'slack' }, status: 404 }],
  identityCheck: () => [{ method: 'POST', path: '/identity/check', body: { sync: 'slack' }, status: 404 }],
  identityUnlink: () => [{ method: 'POST', path: '/identity/unlink', body: { actor: '@julian' }, status: 403 }],
  // Lists drop what the caller can't read.
  channels: () => [
    { method: 'GET', path: '/channels', status: 200, check: (body) => expect(body.channels.map((c: any) => c.path)).toEqual(['open']) },
  ],
  actors: () => [
    { method: 'GET', path: '/actors', status: 200, check: (body) => expect(body.actors.map((a: any) => a.handle)).not.toContain('keeper') },
  ],
  messages: ({ secret }) =>
    ['', '?channel=secret', '?channel=secret/', `?re=${secret.root}`, '?by=keeper', '?label=private', '?text=hush', '?mentions=keeper'].map(
      (query) => ({ method: 'GET', path: `/messages${query}`, status: 200, check: nothingFrom('messages') }),
    ),
  threads: () =>
    ['', '?channel=secret', '?label=private'].map((query) => ({ method: 'GET', path: `/threads${query}`, status: 200, check: nothingFrom('threads') })),
  events: () => [
    { method: 'GET', path: '/events?after=0', status: 200, check: nothingFrom('events') },
    { method: 'GET', path: '/events?after=0&all=1', status: 200, check: nothingFrom('events') },
    { method: 'GET', path: '/events?after=0&channel=secret', status: 200, check: (body) => expect(body.events).toEqual([]) },
  ],
  schedules: ({ secret }) => [
    { method: 'GET', path: '/schedules?all=1', status: 200, check: nothingFrom('schedules') },
    { method: 'GET', path: `/schedules?re=${secret.root}`, status: 404 },
  ],
  // By ID: what it can't read is 404, what it reads but can't change is 403.
  message: ({ secret }) => [
    { method: 'GET', path: `/messages/${secret.root}`, status: 404 },
    { method: 'GET', path: `/messages/${secret.reply}`, status: 404 },
  ],
  edit: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/edit`, body: { text: 'mine now' }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/edit`, body: { text: 'mine now' }, status: 403 },
  ],
  delete: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/delete`, body: {}, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/delete`, body: {}, status: 403 },
  ],
  react: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/reactions`, body: { emoji: 'eyes' }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/reactions`, body: { emoji: 'eyes' }, status: 403 },
  ],
  label: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/labels`, body: { set: { seen: 'yes' } }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/labels`, body: { set: { seen: 'yes' } }, status: 403 },
  ],
  sync: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.root}/sync`, body: { target: 'slack:#leak' }, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/sync`, body: { target: 'slack:#leak' }, status: 403 },
  ],
  typing: ({ secret, open }) => [
    { method: 'POST', path: `/messages/${secret.reply}/typing`, body: {}, status: 404 },
    { method: 'POST', path: `/messages/${open.root}/typing`, body: {}, status: 403 },
  ],
  cancelSchedule: ({ secret, open }) => [
    { method: 'POST', path: `/schedules/${secret.schedule}/cancel`, status: 404 },
    { method: 'POST', path: `/schedules/s${open.schedule}/cancel`, status: 403 },
  ],
  attachment: ({ secret }) => [{ method: 'GET', path: `/attachments/${secret.file}`, status: 404 }],
  // Writes: a reply's channel is its root's, so an unreadable root is 404; a channel the request names is 403.
  post: ({ secret, open }) => [
    { method: 'POST', path: '/messages', body: { channel: 'secret', text: 'hi' }, status: 403 },
    { method: 'POST', path: '/messages', body: { re: secret.root, text: 'hi' }, status: 404 },
    { method: 'POST', path: '/messages', body: { re: secret.reply, text: 'hi' }, status: 404 },
    { method: 'POST', path: '/messages', body: { re: open.root, text: 'hi' }, status: 403 },
  ],
  schedule: ({ secret, open }) => [
    { method: 'POST', path: '/schedules', body: { channel: 'secret', text: 'hi', in: '1h' }, status: 403 },
    { method: 'POST', path: '/schedules', body: { re: secret.root, text: 'hi', in: '1h' }, status: 404 },
    { method: 'POST', path: '/schedules', body: { re: open.root, text: 'hi', in: '1h' }, status: 403 },
  ],
  upload: () => [{ method: 'POST', path: '/attachments', status: 403 }],
  // The board's own bookkeeping spans every channel.
  inbox: () => [{ method: 'GET', path: '/inbox/slack', status: 403 }],
  stuck: () => [{ method: 'GET', path: '/stuck', status: 403 }],
  redrive: () => [{ method: 'POST', path: '/stuck/redrive', body: { session: 'board', index: 1, action: 'skip' }, status: 403 }],
  sourceRead: () => [{ method: 'GET', path: '/sources/slack/read?target=C0123', status: 403 }],
}

async function setup() {
  const board = testBoard({
    scheduler: fakeQueue().scheduler,
    access: [githubActions({ repository: 'basehub-ai/www', can: { open: ['read'] } })],
  })
  const keeper = caller(board.fetch, await personToken('u_keeper'), { 'x-board-handle': 'keeper' })
  const host = caller(board.fetch, await personToken('u_host'), { 'x-board-handle': 'host' })
  const upload = await board.fetch(
    new Request(`${BOARD_URL}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await personToken('u_keeper')}`, 'content-type': 'text/plain', 'x-board-filename': 'plan.txt' },
      body: 'the plan',
    }),
  )
  const file = ((await upload.json()) as { attachment: { id: string } }).attachment.id
  const root = (await keeper('POST', '/messages', { channel: 'secret', text: 'hush @keeper', labels: { private: 'yes' }, attachments: [file] })).body.message.id
  const reply = (await keeper('POST', '/messages', { re: root, text: 'still hush' })).body.message.id
  await keeper('POST', `/messages/${root}/reactions`, { emoji: 'eyes' })
  const schedule = (await keeper('POST', '/schedules', { channel: 'secret', text: 'hush later', in: '1d' })).body.schedule.id
  const openRoot = (await host('POST', '/messages', { channel: 'open', text: 'hello' })).body.message.id
  const openSchedule = (await host('POST', '/schedules', { re: openRoot, text: 'hello later', in: '1d' })).body.schedule.id
  const fixture: Fixture = { secret: { root, reply, schedule, file }, open: { root: openRoot, schedule: openSchedule } }
  return { board, fixture, outsider: caller(board.fetch, await workflowToken()) }
}

describe('every route', () => {
  it('is classified', () => {
    expect(Object.keys(WALK).sort()).toEqual(Object.keys(routes).sort())
  })

  it('shows nothing of a channel the caller can’t read, and refuses writes where it only reads', async () => {
    const { fixture, outsider } = await setup()
    for (const [name, walk] of Object.entries(WALK) as [RouteName, Walk][]) {
      if (walk === 'public') continue
      for (const call of walk(fixture)) {
        const { status, body } = await outsider(call.method, call.path, call.body)
        expect(status, `${name}: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')}`).toBe(call.status)
        // A 404 says nothing more than that it isn't there.
        if (status === 404) expect(JSON.stringify(body)).not.toMatch(/hush|keeper|plan\.txt/)
        call.check?.(body)
      }
    }
  })
})
