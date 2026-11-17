import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

const connect = vi.hoisted(() => {
  class UserAuthorizationRequiredError extends Error {}
  class NoValidTokenError extends Error {}
  return {
    UserAuthorizationRequiredError,
    NoValidTokenError,
    startAuthorization: vi.fn(async (connector: string, params: { subject: { id: string } }) => ({ url: `https://connect.test/${connector}?subject=${params.subject.id}`, request: 'r', verifier: 'v' })),
    getToken: vi.fn(async (_connector: string, _params: unknown): Promise<string> => {
      throw new UserAuthorizationRequiredError('user_authorization_required')
    }),
  }
})
vi.mock('@vercel/connect', () => connect)

const { slack } = await import('../src/sync/slack.ts')
const { github, repos } = await import('../src/sync/github.ts')
const { channels } = await import('../src/sync/fn.ts')

describe('a Vercel Connect connector as the adapter', () => {
  it("builds Slack's adapter and its client", async () => {
    const provider = slack({ adapter: 'slack/acme' }, channels({ C1: 'firehose' }))
    const adapter = (provider as unknown as { transport: { adapter: { name: string; withBotToken?: unknown } } }).transport.adapter
    expect(adapter.name).toBe('slack')
    expect(typeof adapter.withBotToken).toBe('function')
  })

  it('gives up on a Slack call that stays rate-limited after a few tries, within a function', async () => {
    let calls = 0
    const api = createServer((_request, response) => {
      calls++
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }).end('{"ok":false,"error":"ratelimited"}')
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('SLACK_API_URL', `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/`)
    try {
      const provider = slack({ adapter: 'slack/acme' }, channels({}))
      type Web = { conversations: { info(args: { channel: string }): Promise<unknown> } }
      const adapter = (provider as unknown as { transport: { adapter: { withBotToken<T>(token: string, fn: () => T): T; webClient: Web } } }).transport.adapter
      const started = Date.now()
      await expect(adapter.withBotToken('xoxb-test', () => adapter.webClient).conversations.info({ channel: 'C1' })).rejects.toThrow(/rate limit/)
      expect(calls).toBe(4)
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      vi.unstubAllEnvs()
      api.close()
    }
  }, 30_000)

  it("builds GitHub's adapter with the bot's user ID", async () => {
    const provider = github({ adapter: 'github/acme', botUserId: 338721338 }, repos({ 'vercel/board': 'prs' }))
    const adapter = (provider as unknown as { transport: { adapter: { name: string; botUserId?: string | number } } }).transport.adapter
    expect(adapter.name).toBe('github')
    expect(String(adapter.botUserId)).toBe('338721338')
  })

  it("finds the app's bot user ID itself, from GraphQL's viewer, when botUserId isn't set", async () => {
    type Detecting = { botUserId?: string; logger: unknown; initialize(chat: unknown): Promise<void>; defaultOctokit: unknown }
    const provider = github('github/acme', repos({ 'vercel/board': 'prs' }))
    const adapter = (provider as unknown as { transport: { adapter: Detecting } }).transport.adapter
    expect(adapter.botUserId).toBeUndefined()
    // An installation token can't call REST's /user, but GraphQL's viewer answers with the bot.
    const graphql = vi.fn(async () => ({ viewer: { databaseId: 338721338, login: 'acme[bot]' } }))
    adapter.defaultOctokit = { graphql }
    await adapter.initialize({ getLogger: () => adapter.logger })
    expect(graphql).toHaveBeenCalledWith('query { viewer { databaseId login } }')
    expect(adapter.botUserId).toBe('338721338')
    // Once known, it isn't asked again.
    await adapter.initialize({ getLogger: () => adapter.logger })
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('keeps a given botUserId without asking GitHub', async () => {
    type Detecting = { botUserId?: string; initialize(chat: unknown): Promise<void>; defaultOctokit: unknown }
    const provider = github({ adapter: 'github/acme', botUserId: 42 }, repos({}))
    const adapter = (provider as unknown as { transport: { adapter: Detecting } }).transport.adapter
    const graphql = vi.fn()
    adapter.defaultOctokit = { graphql }
    await adapter.initialize({})
    expect(graphql).not.toHaveBeenCalled()
    expect(adapter.botUserId).toBe('42')
  })
})
