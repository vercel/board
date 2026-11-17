import { createHmac } from 'node:crypto'
import { createLinearAdapter } from '@chat-adapter/linear'
import type { Adapter } from 'chat'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { linear, teams } from '../src/sync/linear.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'
import { NewLabels } from '../src/contract/schemas.ts'

const secret = 'test-secret'
const BOT = 'bot-user'
const ISSUE = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const OPENED = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ada = { id: 'user-ada', name: 'Ada Lovelace', url: 'https://linear.app/acme/profiles/ada', avatarUrl: 'https://avatars.test/ada.png', type: 'user' }
const board = { id: BOT, name: 'board', url: 'https://linear.app/acme/profiles/board', type: 'OauthClient' }
const issue = { id: ISSUE, identifier: 'ENG-12', title: 'Sync Linear to the board', url: 'https://linear.app/acme/issue/ENG-12/sync-linear-to-the-board' }
const thread = `linear:ENG:${ISSUE}`

const readIssue = {
  ...issue, description: 'Line numbers are not read out.', createdAt: '2026-10-29T10:00:00Z', priority: 2, priorityLabel: 'High',
  state: { name: 'In Review' }, assignee: ada, creator: ada, project: { name: 'v0 Accessibility' }, labels: { nodes: [{ name: 'Screen reader' }] },
}
const readComment = (id: string, body: string, createdAt: string) => ({ id, body, createdAt, user: ada })
const readIssues = (variables: Record<string, unknown>) => ({
  nodes: [{ ...readIssue, comments: { nodes: [{ id: 'c1', createdAt: '2026-10-30T10:00:00Z' }] } }, { ...readIssue, id: 'other', identifier: 'ENG-13', title: 'Unassigned one', description: null, priority: 0, priorityLabel: 'No priority', assignee: null, labels: { nodes: [] }, comments: { nodes: [] } }],
  pageInfo: variables.after ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'cursor-2' },
})

// Linear's GraphQL API, answering by operation: who the app is, its teams, its issues, and what it creates.
const calls: { query: string; variables: Record<string, unknown> }[] = []
beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    calls.push({ query, variables })
    const answer = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
    if (query.includes('LinearAdapterViewerOrganization')) return answer({ viewer: { id: BOT, displayName: 'board', organization: { id: 'org-1' } } })
    if (/query teams/i.test(query)) return answer({ teams: { nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }], pageInfo: { hasNextPage: false } } })
    if (/^\s*query issue\(/i.test(query)) {
      return answer({ issue: { ...issue, description: 'Comments and states, both ways.', priority: 2, priorityLabel: 'High', team: { id: 'team-eng' }, state: { id: 'state-todo' }, reactions: [], sharedAccess: { isShared: false, sharedWithCount: 0, viewerHasOnlySharedAccess: false, sharedWithUsers: [], disallowedIssueFields: [] } } })
    }
    if (/^\s*query workflowState\(/i.test(query)) return answer({ workflowState: { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#ccc', position: 1, team: { id: 'team-eng' } } })
    if (/issueCreate\(/.test(query)) return answer({ issueCreate: { success: true, lastSyncId: 1, issue: { id: OPENED } } })
    if (/issueUpdate\(/.test(query)) return answer({ issueUpdate: { success: true, lastSyncId: 2, issue: { id: OPENED } } })
    if (/^\s*query issue_labels\(/i.test(query)) return answer({ issue: { labels: { nodes: [{ id: 'label-1', name: 'Bug', color: '#f00' }], pageInfo: { hasNextPage: false } } } })
    if (/query BoardReadProject/.test(query)) return answer({ projects: { nodes: variables.slugId === 'aa87a7750b04' ? [{ id: 'project-1', name: 'v0 Accessibility', url: 'https://linear.app/acme/project/v0-accessibility-aa87a7750b04' }] : [] } })
    if (/query BoardReadIssues/.test(query)) return answer({ issues: readIssues(variables) })
    if (/query BoardReadIssue\(/.test(query)) {
      if (variables.id !== 'ENG-12') return answer({ issue: null })
      // Linear's pages come newest first: the board puts them in order.
      const comments = variables.after
        ? { nodes: [readComment('c1', 'first', '2026-10-30T10:00:00Z')], pageInfo: { hasNextPage: false, endCursor: null } }
        : { nodes: [readComment('c3', 'third', '2026-10-30T12:00:00Z'), readComment('c2', 'second', '2026-10-30T11:00:00Z')], pageInfo: { hasNextPage: true, endCursor: 'cursor-c' } }
      return answer({ issue: { ...readIssue, comments } })
    }
    throw new Error(`unexpected Linear call: ${query.slice(0, 80)}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

const apiCalls = () => calls.filter((call) => !call.query.includes('LinearAdapterViewerOrganization'))

function setup(adapter: Adapter = createLinearAdapter({ apiKey: 'lin_api_test', webhookSecret: secret, userName: 'board' }) as unknown as Adapter) {
  const provider = linear({ adapter }, teams({ ENG: 'dev' }))
  const send = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ organizationId: 'org-1', webhookId: 'hook-1', webhookTimestamp: Date.now(), ...payload })
    const request = new Request('https://board.test/webhooks/linear', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'linear-delivery': `delivery-${Math.random()}`, 'linear-signature': createHmac('sha256', secret).update(body).digest('hex') },
    })
    const received: ReceivedEvent[] = []
    const response = await provider.receive('linear', request, async (event) => void received.push(event))
    return { status: response.status, received }
  }
  return { provider, send }
}

const comment = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, body, issueId: ISSUE, createdAt: '2026-10-26T22:00:00Z', updatedAt: '2026-10-26T22:00:00Z', user: ada,
  issue: { id: ISSUE, title: issue.title }, ...extra,
})

it('imports a comment into its issue thread, in its team channel', async () => {
  const { send } = setup()
  const { status, received } = await send({ type: 'Comment', action: 'create', url: `${issue.url}#comment-1`, data: comment('comment-1', 'Looks **good**') })
  expect(status).toBe(200)
  expect(received).toHaveLength(1)
  expect(received[0]!.event).toMatchObject({
    kind: 'message', channel: 'linear:ENG', thread, subthread: `${thread}:c:comment-1`,
    message: 'comment-1', text: 'Looks **good**',
    author: { id: 'linear:user:user-ada', handle: 'ada', name: 'Ada Lovelace', avatar: 'https://avatars.test/ada.png', isBot: false },
  })
})

it('keeps a reply in the comment thread it answers', async () => {
  const { send } = setup()
  const { received } = await send({ type: 'Comment', action: 'create', url: `${issue.url}#comment-2`, data: comment('comment-2', 'agreed', { parentId: 'comment-1' }) })
  expect(received[0]!.event).toMatchObject({ thread, subthread: `${thread}:c:comment-1`, message: 'comment-2' })
})

it("puts a comment in its issue's current team, from the comment's URL", async () => {
  const { send } = setup()
  const { received } = await send({ type: 'Comment', action: 'create', url: 'https://linear.app/acme/issue/OPS-3/sync-linear-to-the-board#comment-3', data: comment('comment-3', 'moved') })
  expect(received[0]!.event).toMatchObject({ channel: 'linear:OPS', thread: `linear:OPS:${ISSUE}` })
})

it('types a comment event as a comment, for sync functions', async () => {
  const { provider, send } = setup()
  const { received } = await send({ type: 'Comment', action: 'create', url: `${issue.url}#comment-1`, data: comment('comment-1', 'hi') })
  const event = provider.event({ id: '812', key: 'linear', event: received[0]!.event, raw: received[0]!.raw })
  expect(event).toMatchObject({ type: 'comment', platform: 'linear', channel: 'linear:ENG', thread, text: 'hi' })
})

it('syncs edited and deleted comments, which the adapter does not emit', async () => {
  const { send } = setup()
  const edited = await send({ type: 'Comment', action: 'update', url: `${issue.url}#comment-1`, data: comment('comment-1', 'Looks great') })
  expect(edited.received.map((r) => r.event)).toMatchObject([{ kind: 'edited', thread, message: 'comment-1', text: 'Looks great' }])
  const deleted = await send({ type: 'Comment', action: 'remove', url: `${issue.url}#comment-1`, data: comment('comment-1', 'Looks great') })
  expect(deleted.received.map((r) => r.event)).toMatchObject([{ kind: 'deleted', channel: 'linear:ENG', thread, message: 'comment-1' }])
})

it("ignores edits to the board's own comments, which it already has", async () => {
  const { send } = setup()
  const { received } = await send({ type: 'Comment', action: 'update', url: `${issue.url}#comment-9`, data: comment('comment-9', 'on it', { user: board }) })
  expect(received).toEqual([])
})

it('opens a thread for a new issue and labels its state', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, state: { name: 'Todo', type: 'unstarted' } }
  const { received } = await send({ type: 'Issue', action: 'create', url: issue.url, data, actor: ada })
  expect(received.map((r) => r.event)).toMatchObject([{
    kind: 'lifecycle', type: 'issue.created', channel: 'linear:ENG', thread,
    title: 'ENG-12: Sync Linear to the board', url: issue.url, labels: { issue: 'ENG-12', state: 'unstarted' }, createRoot: true,
    author: { isBot: false },
  }])
  const moved = await send({ type: 'Issue', action: 'update', url: issue.url, data: { ...data, state: { name: 'Done', type: 'completed' } }, updatedFrom: { stateId: 'state-todo' }, actor: ada })
  expect(moved.received.map((r) => r.event)).toMatchObject([{ type: 'issue.updated', labels: { issue: 'ENG-12', state: 'completed' }, createRoot: true }])
})

it('opens a thread on any edit to an issue the board has not seen, like a bulk edit of older issues', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, state: { name: 'Backlog', type: 'backlog' } }
  const { received } = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { priority: 2 }, actor: ada })
  expect(received.map((r) => r.event)).toMatchObject([{
    kind: 'lifecycle', type: 'issue.updated', channel: 'linear:ENG', thread,
    title: 'ENG-12: Sync Linear to the board', labels: { issue: 'ENG-12', state: 'backlog' }, createRoot: true,
  }])
  const removed = await send({ type: 'Issue', action: 'remove', url: issue.url, data, actor: ada })
  expect(removed.received).toEqual([])
})

it('brings a label whose name has a control character in as one a write can set', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, state: { name: 'Todo', type: 'unstarted' }, labels: [{ id: 'label-1', name: 'Bug\n#999  Admin' }] }
  const { received } = await send({ type: 'Issue', action: 'create', url: issue.url, data, actor: ada })
  const [event] = received.map((r) => r.event) as { labels: Record<string, string> }[]
  expect(event!.labels['tag.bug-999-admin']).toBe('Bug#999  Admin')
  expect(NewLabels.safeParse(event!.labels).success).toBe(true)
})

it("carries an issue's description, and its priority, project, labels, and assignee as labels", async () => {
  const { send } = setup()
  const data = {
    ...issue, team: { key: 'ENG' }, state: { name: 'In Review', type: 'started' },
    description: '  Line numbers are not read out.\n\nSteps: open the editor.  ',
    priority: 2, priorityLabel: 'High', projectId: 'project-1', project: { id: 'project-1', name: 'v0 Accessibility' },
    labels: [{ id: 'label-1', name: 'Screen reader' }], assigneeId: 'user-ada', assignee: ada,
  }
  const { received } = await send({ type: 'Issue', action: 'create', url: issue.url, data, actor: ada })
  expect(received.map((r) => r.event)).toMatchObject([{
    body: 'Line numbers are not read out.\n\nSteps: open the editor.',
    labels: { issue: 'ENG-12', state: 'started', priority: 'high', project: 'v0-accessibility', 'tag.screen-reader': 'Screen reader', 'assignee.ada': 'ada' },
    unset: [],
    owns: ['tag.', 'assignee.'],
  }])
  // Unassigned, with no priority or project: their labels go, by name for the single keys. Linear
  // leaves an empty assignee and project out of the payload rather than sending null.
  const { assigneeId: _assigneeId, assignee: _assignee, projectId: _projectId, project: _project, ...rest } = data
  const cleared = await send({
    type: 'Issue', action: 'update', url: issue.url, actor: ada, updatedFrom: { assigneeId: 'user-ada', projectId: 'project-1' },
    data: { ...rest, description: null, priority: 0, priorityLabel: 'No priority', labels: [] },
  })
  const [event] = cleared.received.map((r) => r.event) as { labels: Record<string, string>; unset: string[]; owns: string[]; body: string | null }[]
  expect(event!.labels).toEqual({ issue: 'ENG-12', state: 'started' })
  expect(event!.unset).toEqual(['priority', 'project'])
  expect(event!.owns).toEqual(['tag.', 'assignee.'])
  expect(event!.body).toBeNull()
})

it('leaves a property as it was when the payload names it without its details', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, state: { name: 'Todo', type: 'unstarted' }, priority: 2, projectId: 'project-1', assigneeId: 'user-ada' }
  const { received } = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { priority: 1 }, actor: ada })
  expect(received.map((r) => r.event)).toMatchObject([{ labels: { issue: 'ENG-12', state: 'unstarted' }, unset: [], owns: [] }])
})

it('names an assignee without a profile link by their name, as Linear sends one', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, assigneeId: 'user-ada', assignee: { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@acme.test' } }
  const { received } = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { assigneeId: null }, actor: ada })
  expect(received.map((r) => r.event)).toMatchObject([{ labels: { 'assignee.ada-lovelace': 'Ada Lovelace' }, owns: ['assignee.'] }])
})

it('marks a description change as a redraw of the root', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, state: { name: 'Todo', type: 'unstarted' }, description: 'New steps' }
  const { received } = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { description: 'Old steps' }, actor: ada })
  expect(received.map((r) => r.event)).toMatchObject([{ retitled: true, body: 'New steps' }])
})

it('never opens a second root for an issue the board opened', async () => {
  const { send } = setup()
  const data = { ...issue, id: OPENED, team: { key: 'ENG' }, state: { name: 'Todo', type: 'unstarted' }, creatorId: BOT }
  const { received } = await send({ type: 'Issue', action: 'create', url: issue.url, data, actor: board })
  expect(received.map((r) => r.event)).toMatchObject([{ type: 'issue.created', thread: `linear:ENG:${OPENED}`, labels: { issue: 'ENG-12' }, createRoot: false, author: { isBot: true } }])
  // Someone edits it before the board has recorded its root: still the board's issue.
  const edited = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { priority: 2 }, actor: ada })
  expect(edited.received.map((r) => r.event)).toMatchObject([{ type: 'issue.updated', thread: `linear:ENG:${OPENED}`, createRoot: false, author: { isBot: false } }])
})

it('leaves an unseen issue off the board when Linear itself or an archive edits it', async () => {
  const { send } = setup()
  const data = { ...issue, team: { key: 'ENG' }, state: { name: 'Canceled', type: 'canceled' } }
  const automation = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { stateId: 'state-todo' } })
  expect(automation.received.map((r) => r.event)).toMatchObject([{ type: 'issue.updated', labels: { state: 'canceled' }, createRoot: false }])
  const app = await send({ type: 'Issue', action: 'update', url: issue.url, data, updatedFrom: { stateId: 'state-todo' }, actor: { id: 'github', name: 'GitHub', type: 'Integration' } })
  expect(app.received.map((r) => r.event)).toMatchObject([{ createRoot: false }])
  const archived = await send({ type: 'Issue', action: 'update', url: issue.url, data: { ...data, archivedAt: '2026-10-30T00:00:00.000Z' }, updatedFrom: { archivedAt: null }, actor: ada })
  expect(archived.received.map((r) => r.event)).toMatchObject([{ createRoot: false }])
})

it('refuses a webhook that Linear did not sign', async () => {
  const { provider } = setup()
  const body = JSON.stringify({ type: 'Comment', action: 'create', organizationId: 'org-1', webhookTimestamp: Date.now(), data: comment('comment-1', 'hi') })
  const request = new Request('https://board.test/webhooks/linear', { method: 'POST', body, headers: { 'linear-signature': 'nope' } })
  const received: ReceivedEvent[] = []
  const response = await provider.receive('linear', request, async (event) => void received.push(event))
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(received).toEqual([])
})

it('resolves teams by key and issues by UUID or identifier', async () => {
  const { provider } = setup()
  await expect(provider.resolveChannel('eng')).resolves.toBe('ENG')
  await expect(provider.resolveTarget('eng')).resolves.toEqual({ target: 'ENG', channel: 'ENG', kind: 'channel' })
  const target = { target: `ENG:${ISSUE}`, channel: 'ENG', kind: 'thread' }
  await expect(provider.resolveTarget(`eng:${ISSUE}`)).resolves.toEqual(target)
  await expect(provider.resolveTarget(ISSUE)).resolves.toEqual(target)
  await expect(provider.resolveTarget('ENG-12')).resolves.toEqual(target)
  await expect(provider.resolveTarget(`ENG:${ISSUE}:c:comment-1`)).rejects.toThrow(`sync its issue, ENG:${ISSUE}`)
  await expect(provider.resolveTarget('not a target')).rejects.toThrow('invalid Linear target')
  // The team in a thread's ID is the channel its outbound events route by, so `into` sends nothing back.
  expect(provider.inboxChannel('linear', `linear:ENG:${ISSUE}:c:comment-1`)).toBe('linear:ENG')
})

it("opens an issue for a board root, titled with its first line without the author's label", async () => {
  const { provider } = setup()
  const sent = await provider.post('ENG', 'channel', { markdown: '**ada**: Flaky snake_case_name test\n\nIt fails one run in ten.' })
  expect(sent).toEqual({ thread: `ENG:${OPENED}`, message: 'issue' })
  const created = calls.find((call) => /issueCreate\(/.test(call.query))!
  expect(created.variables.input).toEqual({ teamId: 'team-eng', title: 'Flaky snake_case_name test', description: '**ada**: Flaky snake_case_name test\n\nIt fails one run in ten.' })
})

it("titles an issue with a root's first line when that opens a block, under the author's label", async () => {
  const { provider } = setup()
  await provider.post('ENG', 'channel', { markdown: '**ada**:\n\n# Checkout is down\n\nSince 10:00.' })
  const created = calls.find((call) => /issueCreate\(/.test(call.query))!
  expect(created.variables.input).toMatchObject({ title: 'Checkout is down', description: '**ada**:\n\n# Checkout is down\n\nSince 10:00.' })
})

it("edits only the description of an issue the board opened, and leaves the issue alone for its root's reactions and deletes", async () => {
  const { provider } = setup()
  await provider.edit(`ENG:${OPENED}`, 'issue', { markdown: 'Flaky checkout test, now with logs' })
  const updated = apiCalls().filter((call) => /issueUpdate\(/.test(call.query))
  expect(updated.map((call) => call.variables)).toEqual([{ id: OPENED, input: { description: 'Flaky checkout test, now with logs' } }])
  calls.length = 0
  for (const root of ['issue', 'lifecycle:812', 'root:812']) {
    await provider.react(`ENG:${ISSUE}`, root, 'eyes', true)
    await provider.delete(`ENG:${ISSUE}`, root)
  }
  for (const root of ['lifecycle:812', 'root:812']) await provider.edit(`ENG:${ISSUE}`, root, { markdown: 'ENG-12: Sync Linear to the board' })
  expect(apiCalls()).toEqual([])
})

it('reaches Linear outside a webhook with a Connect token', async () => {
  const connect = createLinearAdapter({ accessToken: async () => 'connect-token', webhookVerifier: async () => true, userName: 'board', mode: 'comments' }) as unknown as Adapter
  const { provider } = setup(connect)
  await expect(provider.resolveChannel('ENG')).resolves.toBe('ENG')
  await expect(provider.resolveTarget('ENG-12')).resolves.toEqual({ target: `ENG:${ISSUE}`, channel: 'ENG', kind: 'thread' })
  await expect(provider.post('ENG', 'channel', { markdown: 'From Connect' })).resolves.toEqual({ thread: `ENG:${OPENED}`, message: 'issue' })
  await expect(provider.fetchRoot(`ENG:${ISSUE}`)).resolves.toMatchObject({
    text: `ENG-12: Sync Linear to the board\n${issue.url}\n\nComments and states, both ways.`,
    labels: { issue: 'ENG-12', state: 'unstarted', priority: 'high', 'tag.bug': 'Bug' },
  })
})

it("puts an issue's description on its root, redraws it when the description changes, and keeps its labels in step", async () => {
  const adapter = createLinearAdapter({ apiKey: 'lin_api_test', webhookSecret: secret, userName: 'board' }) as unknown as Adapter
  const board = testBoard({ sync: { linear: linear({ adapter }, teams({ ENG: 'dev' })) } })
  const julian = caller(board.fetch, await personToken())
  const send = (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ organizationId: 'org-1', webhookId: 'hook-1', webhookTimestamp: Date.now(), ...payload })
    return board.fetch(new Request(`${BOARD_URL}/webhooks/linear`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'linear-delivery': `delivery-${Math.random()}`, 'linear-signature': createHmac('sha256', secret).update(body).digest('hex') },
    }))
  }
  const root = async () => ((await julian('GET', '/messages?channel=dev')).body.messages as { id: string; text: string; labels: Record<string, string> }[])[0]
  const data = {
    ...issue, team: { key: 'ENG' }, state: { name: 'Todo', type: 'unstarted' }, description: 'Old steps',
    priority: 2, priorityLabel: 'High', projectId: 'project-1', project: { id: 'project-1', name: 'v0 Accessibility' },
  }
  await send({ type: 'Issue', action: 'create', url: issue.url, data, actor: ada })
  await vi.waitFor(async () => expect((await root())?.text).toBe(`ENG-12: Sync Linear to the board\n${issue.url}\n\nOld steps`))
  const { id } = (await root())!
  // A label someone set that only starts like a property's stays.
  await julian('POST', `/messages/${id}/labels`, { set: { 'project-lead': 'ada' } })

  await send({ type: 'Issue', action: 'update', url: issue.url, data: { ...data, description: 'New steps', priority: 0, priorityLabel: 'No priority' }, updatedFrom: { description: 'Old steps', priority: 2 }, actor: ada })
  await vi.waitFor(async () => expect((await root())?.text).toBe(`ENG-12: Sync Linear to the board\n${issue.url}\n\nNew steps`))
  await vi.waitFor(async () => expect((await root())?.labels).toEqual({ issue: 'ENG-12', state: 'unstarted', project: 'v0-accessibility', 'project-lead': 'ada' }))
})

it("drops a root's assignee and project labels once they're removed, which Linear says by leaving them out", async () => {
  const adapter = createLinearAdapter({ apiKey: 'lin_api_test', webhookSecret: secret, userName: 'board' }) as unknown as Adapter
  const board = testBoard({ sync: { linear: linear({ adapter }, teams({ ENG: 'dev' })) } })
  const julian = caller(board.fetch, await personToken())
  const send = (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ organizationId: 'org-1', webhookId: 'hook-1', webhookTimestamp: Date.now(), ...payload })
    return board.fetch(new Request(`${BOARD_URL}/webhooks/linear`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'linear-delivery': `delivery-${Math.random()}`, 'linear-signature': createHmac('sha256', secret).update(body).digest('hex') },
    }))
  }
  const root = async () => ((await julian('GET', '/messages?channel=dev')).body.messages as { labels: Record<string, string> }[])[0]
  const unassigned = { ...issue, team: { key: 'ENG' }, state: { name: 'Backlog', type: 'backlog' }, priority: 0, priorityLabel: 'No priority', labels: [] }
  const assigned = { ...unassigned, assigneeId: 'user-ada', assignee: ada, projectId: 'project-1', project: { id: 'project-1', name: 'v0 Accessibility' } }
  await send({ type: 'Issue', action: 'create', url: issue.url, data: assigned, actor: ada })
  await vi.waitFor(async () => expect((await root())?.labels).toEqual({ issue: 'ENG-12', state: 'backlog', project: 'v0-accessibility', 'assignee.ada': 'ada' }))

  const { assigneeId: _assigneeId, assignee: _assignee, ...unassignedInProject } = assigned
  await send({ type: 'Issue', action: 'update', url: issue.url, data: unassignedInProject, updatedFrom: { assigneeId: 'user-ada' }, actor: ada })
  await vi.waitFor(async () => expect((await root())?.labels).toEqual({ issue: 'ENG-12', state: 'backlog', project: 'v0-accessibility' }))

  await send({ type: 'Issue', action: 'update', url: issue.url, data: unassigned, updatedFrom: { projectId: 'project-1' }, actor: ada })
  await vi.waitFor(async () => expect((await root())?.labels).toEqual({ issue: 'ENG-12', state: 'backlog' }))
})

it("reads a project's issues on demand, with their properties and descriptions, a page at a time", async () => {
  const { provider } = setup()
  const read = await provider.read('https://linear.app/acme/project/v0-accessibility-aa87a7750b04/issues?layout=list', { limit: 50, after: null })
  expect(read).toMatchObject({ channel: 'https://linear.app/acme/project/v0-accessibility-aa87a7750b04', name: 'v0 Accessibility', thread: null, more: true, next: 'cursor-2' })
  expect(read.messages.map((message) => message.text)).toEqual([
    `ENG-12: Sync Linear to the board\nIn Review · High · assigned to ada · v0 Accessibility · Screen reader\n${issue.url}\n\nLine numbers are not read out.`,
    `ENG-13: Unassigned one\nIn Review · unassigned · v0 Accessibility\n${issue.url}`,
  ])
  expect(read.messages[0]).toMatchObject({ id: 'ENG-12', thread: 'ENG-12', author: 'ada', replies: 1 })
  const filters = apiCalls().filter((call) => /BoardReadIssues/.test(call.query)).map((call) => call.variables)
  expect(filters).toEqual([{ filter: { project: { id: { eq: 'project-1' } } }, first: 50, after: null }])
  const second = await provider.read('https://linear.app/acme/project/v0-accessibility-aa87a7750b04', { limit: 50, after: 'cursor-2' })
  expect(second).toMatchObject({ more: false, next: null })
})

it("reads a team's issues by its key, and one issue with its comments, oldest first", async () => {
  const { provider } = setup()
  const team = await provider.read('eng', { limit: 200, after: null })
  expect(team).toMatchObject({ channel: 'ENG', thread: null })
  expect(apiCalls().find((call) => /BoardReadIssues/.test(call.query))!.variables).toMatchObject({ filter: { team: { key: { eq: 'ENG' } } }, first: 100 })
  const one = await provider.read('https://linear.app/acme/issue/ENG-12/sync-linear-to-the-board', { limit: 2, after: null })
  expect(one).toMatchObject({ channel: 'ENG', thread: 'ENG-12', more: true, next: '2' })
  expect(one.messages.map((message) => [message.id, message.text.split('\n')[0]])).toEqual([['ENG-12', 'ENG-12: Sync Linear to the board'], ['c1', 'first'], ['c2', 'second']])
  expect(one.messages[0]!.replies).toBe(3)
  const rest = await provider.read('ENG-12', { limit: 2, after: '2' })
  expect(rest).toMatchObject({ more: false, next: null })
  expect(rest.messages.map((message) => message.id)).toEqual(['c3'])
  await expect(provider.read('ENG-99', { limit: 50, after: null })).rejects.toMatchObject({ code: 'channel_not_found' })
  await expect(provider.read('https://linear.app/acme/project/missing-0123456789ab', { limit: 50, after: null })).rejects.toMatchObject({ code: 'channel_not_found' })
  await expect(provider.read('#general', { limit: 50, after: null })).rejects.toMatchObject({ code: 'invalid_target' })
})
