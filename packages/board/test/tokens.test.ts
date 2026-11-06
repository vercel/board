import { afterEach, describe, expect, it, vi } from 'vitest'
import { caller, personToken, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

const DAY = 24 * 3600_000

/** A board, Julian on it with the handle his CLI sends, and a way to call it with any token. */
async function setUp(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian', 'x-board-name': 'Julian' })
  const as = (token: string, headers: Record<string, string> = {}) => caller(board.fetch, token, headers)
  const mint = async (body: Record<string, unknown>, by = julian) => {
    const minted = await by('POST', '/tokens', body)
    expect(minted.status).toBe(200)
    return minted.body as { token: { id: string }; secret: string }
  }
  return { board, julian, as, mint }
}

afterEach(() => vi.useRealTimers())

describe('tokens', () => {
  it('acts as whoever minted it, by their handle, narrowed to its can', async () => {
    const { as, mint } = await setUp()
    const { secret } = await mint({ name: 'feedback-widget', can: { 'feedback/': ['post'] } })
    expect(secret).toMatch(/^board_[A-Za-z0-9_-]{43}$/)
    const widget = as(secret)
    const me = (await widget('GET', '/me')).body
    expect(me).toMatchObject({ principal: 'vercel:user:u_julian', actor: 'vercel:user:u_julian', handle: 'julian', name: 'Julian', can: { 'feedback/': ['post'] } })
    expect((await widget('POST', '/messages', { channel: 'feedback/web', text: 'love it' })).status).toBe(201)
    expect((await widget('POST', '/messages', { channel: 'dev', text: 'not here' })).status).toBe(403)
  })

  it("never does more than its minter can now: a workflow's token loses what its grant gave", async () => {
    const { julian, as, mint } = await setUp()
    const { body } = await julian('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['read', 'post'] } })
    const workflow = as(await workflowToken())
    const { secret } = await mint({ name: 'ci-helper', can: 'all' }, workflow)
    const helper = as(secret)
    expect((await helper('GET', '/me')).body.can).toEqual({ 'ci/': ['read', 'post'] })
    expect((await helper('POST', '/messages', { channel: 'dev', text: 'past its minter' })).status).toBe(403)
    await julian('POST', `/grants/${body.grant.id}/revoke`, {})
    expect((await helper('POST', '/messages', { channel: 'ci', text: 'after the revoke' })).status).toBe(403)
  })

  it('writes as the profile and session it pins, whatever a request says', async () => {
    const { as, mint } = await setUp()
    const { secret } = await mint({ name: 'eve-1956', profile: 'clever-lemur', avatar: 'https://example.com/lemur.png', session: 'thread-1956' })
    const eve = as(secret, { 'x-board-profile': 'claude', 'x-board-session': 'other', 'x-board-avatar': 'https://evil.example/x.png', 'x-board-handle': 'someone-else' })
    const me = (await eve('GET', '/me')).body
    expect(me).toMatchObject({ actor: 'vercel:user:u_julian+clever-lemur', handle: 'julian/clever-lemur', profile: 'clever-lemur', session: 'thread-1956', avatar: 'https://example.com/lemur.png' })
  })

  it('gives what a grant does when can is left out: read, post, react, and label everywhere, never manage', async () => {
    const { as, mint } = await setUp()
    const script = as((await mint({ name: 'script' })).secret)
    expect((await script('GET', '/me')).body.can).toEqual({ '*': ['read', 'post', 'react', 'label'] })
    expect((await script('GET', '/grants')).status).toBe(403)
  })

  it('lists what each token may do now, not the most it could', async () => {
    const { julian, as, mint } = await setUp()
    const { body } = await julian('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['read', 'post'] } })
    const minted = await mint({ name: 'ci-helper', can: 'all' }, as(await workflowToken()))
    expect((minted.token as unknown as { can: unknown }).can).toEqual({ 'ci/': ['read', 'post'] })
    const listed = async () => (await julian('GET', '/tokens')).body.tokens.find((token: { name: string }) => token.name === 'ci-helper').can
    expect(await listed()).toEqual({ 'ci/': ['read', 'post'] })
    await julian('POST', `/grants/${body.grant.id}/revoke`, {})
    expect(await listed()).toEqual({})
  })

  it("ends a schedule made with it by the token's expiry, and refuses one that would start after", async () => {
    const queue = fakeQueue()
    const { as, mint } = await setUp({ scheduler: queue.scheduler })
    const { token, secret } = await mint({ name: 'reminders', can: { 'dev/': ['read', 'post'] }, expires: '7d' })
    const expiresAt = (token as unknown as { expiresAt: string }).expiresAt
    const reminders = as(secret)
    expect((await reminders('POST', '/schedules', { channel: 'dev', text: 'standup', every: '1d' })).body.schedule.until).toBe(expiresAt)
    const week = (await reminders('POST', '/schedules', { channel: 'dev', text: 'this week', every: '1d', for: '2d' })).body.schedule
    expect(Date.parse(week.until)).toBeLessThan(Date.parse(expiresAt))
    const late = await reminders('POST', '/schedules', { channel: 'dev', text: 'too late', at: new Date(Date.parse(expiresAt) + 3600_000).toISOString() })
    expect(late).toMatchObject({ status: 400, body: { error: { code: 'token_expires_first' } } })
  })

  it("is never its minter's integration, even with nothing narrowed: no watchers or sync records", async () => {
    const { as, mint } = await setUp()
    const { secret } = await mint({ name: 'everything', can: 'all' })
    const full = as(secret)
    expect((await full('GET', '/me')).body.can).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] })
    expect((await full('POST', '/watchers', { url: null, watch: { tail: { tail: 'dev' } } })).status).toBe(403)
    expect((await full('GET', '/inbox/slack/next')).status).toBe(403)
  })

  it('narrows further, never wider, with x-board-scope', async () => {
    const { as, mint } = await setUp()
    const { secret } = await mint({ name: 'dev-reader', can: { 'dev/': ['read', 'post'] } })
    const scoped = as(secret, { 'x-board-scope': '*=all' })
    expect((await scoped('GET', '/me')).body.can).toEqual({ 'dev/': ['read', 'post'] })
    const narrower = as(secret, { 'x-board-scope': 'dev/=read' })
    expect((await narrower('GET', '/me')).body.can).toEqual({ 'dev/': ['read'] })
  })

  it('stops on its next request once revoked, and so does every token minted with it', async () => {
    const { julian, as, mint } = await setUp()
    const parent = await mint({ name: 'sandbox', can: { 'dev/': ['read', 'post'] } })
    const child = await mint({ name: 'subagent', can: 'all' }, as(parent.secret))
    // A child is its parent's at most.
    expect((await as(child.secret)('GET', '/me')).body.can).toEqual({ 'dev/': ['read', 'post'] })
    expect((await julian('POST', `/tokens/${parent.token.id}/revoke`, {})).body).toEqual({ revoked: true })
    expect((await as(parent.secret)('GET', '/me')).status).toBe(401)
    expect((await as(child.secret)('GET', '/me')).status).toBe(401)
    expect((await julian('POST', `/tokens/${parent.token.id}/revoke`, {})).body).toEqual({ revoked: false })
  })

  it('keeps the profile a parent pins: a child writes as it too', async () => {
    const { as, mint } = await setUp()
    const parent = await mint({ name: 'eve', profile: 'clever-lemur' })
    const child = await mint({ name: 'subagent', profile: 'someone-else' }, as(parent.secret))
    expect((await as(child.secret)('GET', '/me')).body.profile).toBe('clever-lemur')
  })

  it('expires after 30 days by default, a child no later than its parent, and lives 90 at most', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { as, mint, julian } = await setUp()
    const minted = await mint({ name: 'monthly' })
    const short = await mint({ name: 'short', expires: '1d' }, as(minted.secret))
    const long = await mint({ name: 'long', expires: '90d' }, as(minted.secret))
    expect(Date.parse((long.token as unknown as { expiresAt: string }).expiresAt)).toBe(Date.parse((minted.token as unknown as { expiresAt: string }).expiresAt))
    expect((await julian('POST', '/tokens', { name: 'forever', expires: '91d' })).status).toBe(400)
    vi.setSystemTime(Date.now() + 2 * DAY)
    expect((await as(short.secret)('GET', '/me')).status).toBe(401)
    expect((await as(minted.secret)('GET', '/me')).status).toBe(200)
    vi.setSystemTime(Date.now() + 30 * DAY)
    expect((await as(minted.secret)('GET', '/me')).status).toBe(401)
  })

  it("lists its minter's tokens for them, everyone's with manage, and never a secret", async () => {
    const { board, julian, as, mint } = await setUp()
    await julian('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['read', 'post'] } })
    const workflow = as(await workflowToken())
    const theirs = await mint({ name: 'theirs' }, workflow)
    const mine = await mint({ name: 'mine' })
    expect((await workflow('GET', '/tokens')).body.tokens.map((token: { name: string }) => token.name)).toEqual(['theirs'])
    const everyone = (await julian('GET', '/tokens')).body.tokens
    expect(everyone.map((token: { name: string }) => token.name)).toEqual(['theirs', 'mine'])
    expect(JSON.stringify(everyone)).not.toContain(mine.secret)
    // Someone else's token answers as one that isn't there, and stays live.
    expect((await workflow('POST', `/tokens/${mine.token.id}/revoke`, {})).body).toEqual({ revoked: false })
    expect((await workflow('POST', '/tokens/t999999/revoke', {})).body).toEqual({ revoked: false })
    expect((await as(mine.secret)('GET', '/me')).status).toBe(200)
    const pi = caller(board.fetch, await personToken('u_pi'))
    expect((await pi('POST', `/tokens/${theirs.token.id}/revoke`, {})).body).toEqual({ revoked: true })
  })

  it("sees and revokes only itself and the tokens minted with it, never its minter's others", async () => {
    const { julian, as, mint } = await setUp()
    const widget = await mint({ name: 'feedback-widget', can: { 'feedback/': ['post'] } })
    const deploy = await mint({ name: 'deploy-bot', can: { 'deploys/': ['post'] } })
    const child = await mint({ name: 'widget-child' }, as(widget.secret))
    const names = async (secret: string) => (await as(secret)('GET', '/tokens')).body.tokens.map((token: { name: string }) => token.name)
    expect(await names(widget.secret)).toEqual(['feedback-widget', 'widget-child'])
    expect(await names(child.secret)).toEqual(['widget-child'])
    // Its minter's other token, and to a child its parent, answer as tokens that aren't there, and stay live.
    expect((await as(widget.secret)('POST', `/tokens/${deploy.token.id}/revoke`, {})).body).toEqual({ revoked: false })
    expect((await as(child.secret)('POST', `/tokens/${widget.token.id}/revoke`, {})).body).toEqual({ revoked: false })
    expect((await as(deploy.secret)('GET', '/me')).status).toBe(200)
    expect((await as(widget.secret)('GET', '/me')).status).toBe(200)
    expect((await as(widget.secret)('POST', `/tokens/${child.token.id}/revoke`, {})).body).toEqual({ revoked: true })
    expect((await julian('GET', '/tokens')).body.tokens.map((token: { name: string }) => token.name)).toEqual(['feedback-widget', 'deploy-bot'])
  })

  it('edits and deletes only what was written as the profile it pins, not its minter\'s own posts', async () => {
    const { julian, as, mint } = await setUp()
    const dev = { 'dev/': ['read', 'post'] }
    const eve = as((await mint({ name: 'eve-1956', profile: 'clever-lemur', can: dev })).secret)
    const renewed = as((await mint({ name: 'eve-1956-renewed', profile: 'clever-lemur', can: dev })).secret)
    const helper = as((await mint({ name: 'helper', can: dev })).secret)
    const julians = (await julian('POST', '/messages', { channel: 'dev', text: 'mine' })).body.message
    const eves = (await eve('POST', '/messages', { channel: 'dev', text: 'on it' })).body.message
    expect((await eve('POST', `/messages/${julians.id}/edit`, { text: 'not yours' })).status).toBe(403)
    expect((await eve('POST', `/messages/${julians.id}/delete`, {})).status).toBe(403)
    // Another token that pins the same profile is the same author: a renewed one picks up where it left off.
    expect((await renewed('POST', `/messages/${eves.id}/edit`, { text: 'on it, round two' })).status).toBe(200)
    // One that pins no profile writes as its minter, and changes what they wrote.
    expect((await helper('POST', `/messages/${julians.id}/edit`, { text: 'mine, edited' })).status).toBe(200)
    expect((await julian('GET', `/messages/${julians.id}`)).body.message.text).toBe('mine, edited')
  })

  it('cancels only schedules made as the profile it pins', async () => {
    const queue = fakeQueue()
    const { julian, as, mint } = await setUp({ scheduler: queue.scheduler })
    const eve = as((await mint({ name: 'eve-1956', profile: 'clever-lemur', can: { 'dev/': ['read', 'post'] } })).secret)
    const standup = (await julian('POST', '/schedules', { channel: 'dev', text: 'standup', every: '1d' })).body.schedule
    const reminder = (await eve('POST', '/schedules', { channel: 'dev', text: 'check CI', every: '1d' })).body.schedule
    expect((await eve('POST', `/schedules/${standup.id}/cancel`, {})).status).toBe(403)
    expect((await eve('POST', `/schedules/${reminder.id}/cancel`, {})).body).toMatchObject({ canceled: true })
  })

  it("cancels a schedule made with it once it's revoked", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const queue = fakeQueue()
    const { board, julian, as, mint } = await setUp({ scheduler: queue.scheduler })
    const { token, secret } = await mint({ name: 'reminders', can: { 'dev/': ['read', 'post'] } })
    const made = await as(secret)('POST', '/schedules', { channel: 'dev', text: 'standup', every: '1d' })
    expect(made.status).toBe(201)
    await julian('POST', `/tokens/${token.id}/revoke`, {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(Date.now() + DAY + 60_000)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // A day on, Julian's own token has expired too: he looks with a new one.
    const later = caller(board.fetch, await personToken())
    expect((await later('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ id: made.body.schedule.id, sent: 0, state: 'canceled', canceled: { reason: 'revoked' } }])
  })

  it("acts as the board's own code when its handle mints it, narrowed, with the profile it pins", async () => {
    const { board, as } = await setUp()
    const { secret } = await board.createToken({ name: 'eve-1956', can: { 'dev/': ['read', 'post'] }, profile: 'clever-lemur', session: 'thread-1956' })
    const eve = as(secret)
    expect((await eve('GET', '/me')).body).toMatchObject({ principal: 'board:client', actor: 'board:client+clever-lemur', session: 'thread-1956', can: { 'dev/': ['read', 'post'] } })
    const posted = await eve('POST', '/messages', { channel: 'dev', text: 'on it' })
    expect(posted.body.message.by).toMatchObject({ actor: 'board:client+clever-lemur', principal: 'board:client', session: 'thread-1956' })
    expect((await eve('POST', '/messages', { channel: 'ops', text: 'not here' })).status).toBe(403)
  })

  it("is the board's to check: a token for another board, or one it never issued, is a 401", async () => {
    const { as } = await setUp()
    const other = await setUp()
    const theirs = await other.mint({ name: 'elsewhere' })
    expect((await as(theirs.secret)('GET', '/me')).status).toBe(401)
    expect((await as(`board_${'x'.repeat(43)}`)('GET', '/me')).status).toBe(401)
  })
})
