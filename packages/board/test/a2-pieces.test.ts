import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { slack } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { BOARD_URL, caller, personToken, PROJECT_ID, TEAM_ID, testAuth, testBoard } from './harness.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

/** A board on the local board's engine with only a store, a watcher, and Slack synced to `firehose`, in the environment `env`. */
function bare(env: string) {
  vi.stubEnv('NODE_ENV', env)
  const s = fakePlatform('slack')
  const seen: string[] = []
  const board = testBoard({
    blob: undefined,
    sync: { slack: slack({ adapter: s.adapter }, channels({ C1: 'firehose' })) },
    watch: {
      ack: {
        tail: 'firehose',
        run: async ({ event, board }) => {
          if (event.type !== 'message.posted' || event.message?.re !== null) return
          seen.push(event.message.text)
          await board.reply(event.message.id, 'on it')
        },
      },
    },
  })
  const webhook = (body: unknown) =>
    board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { board, s, seen, webhook }
}

afterEach(() => vi.unstubAllEnvs())

describe("the local board's engine takes a scheduler and a blob store only if it's given them", () => {
  it.each(['development', 'production'])('in %s, runs watchers and sync in the request that wrote, and refuses to schedule', async (env) => {
    const { board, s, seen, webhook } = bare(env)
    const julian = caller(board.fetch, await personToken())
    // Nothing arms a timer: the consumers run in the request that appended, here and in production alike.
    const { body } = await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })
    await vi.waitFor(() => expect(seen).toEqual(['deploy failed']))
    // The watcher's reply, and the root before it, go out to Slack: sync delivers in the request too.
    await vi.waitFor(() => expect(s.channelPosts.map((post) => post.text)).toEqual([expect.stringContaining('deploy failed')]))
    await vi.waitFor(() => expect(s.posts.map((post) => post.text)).toEqual([expect.stringContaining('on it')]))
    // And a Slack message, through the inbox.
    expect((await webhook({ type: 'message', threadId: 'slack:C1:200', id: '200', text: 'export is broken', user: 'U_ADA' })).status).toBe(200)
    await vi.waitFor(() => expect(seen).toEqual(['deploy failed', 'export is broken']))

    const scheduled = await julian('POST', '/schedules', { re: body.message.id, text: 'still broken?', in: '1d' })
    expect(scheduled).toEqual({
      status: 501,
      body: { error: { code: 'no_scheduler', message: "this board has no scheduler, so it can't send later" } },
    })
    expect((await julian('GET', '/schedules')).body).toEqual({ schedules: [] })
    // Its scheduler route has nothing to run.
    expect((await board.scheduler(new Request(`${BOARD_URL}/a2/scheduler`, { method: 'POST' }))).status).toBe(404)
  })

  it.each(['development', 'production'])('in %s, keeps no files without a blob store, and links the ones sync brings', async (env) => {
    const { board, s, webhook } = bare(env)
    const julian = caller(board.fetch, await personToken())
    const noFiles = { code: 'no_files', message: 'this board keeps no files' }

    const upload = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${await personToken()}`, 'content-type': 'image/png' }, body: PNG }),
    )
    expect(upload.status).toBe(501)
    expect(await upload.json()).toEqual({ error: noFiles })
    expect(await julian('POST', '/messages', { channel: 'dev', text: 'see attached', attachments: ['AAAAAAAAAAAAAAAAAAAAAA'] })).toEqual({ status: 501, body: { error: noFiles } })
    expect(await julian('GET', '/attachments/AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ status: 501, body: { error: noFiles } })
    await expect(board.upload({ data: PNG, name: 'shot.png' })).rejects.toMatchObject({ status: 501, code: 'no_files' })

    // A file posted in Slack comes over as a link to where it lives, with nothing fetched past the first.
    s.served.set('https://files.slack.test/shot.png', PNG)
    await webhook({
      type: 'message', threadId: 'slack:C1:300', id: '300', text: 'the export page', user: 'U_ADA',
      files: [
        { name: 'shot.png', mimeType: 'image/png', url: 'https://files.slack.test/shot.png', size: PNG.byteLength },
        { name: 'run (2).mov', mimeType: 'video/quicktime', url: 'https://files.slack.test/run (2).mov', size: 2048 },
      ],
    })
    await vi.waitFor(async () => {
      const { body } = await julian('GET', '/messages?channel=firehose')
      expect(body.messages.find((message: { from: string | null }) => message.from === 'slack')).toMatchObject({
        text:
          'the export page\n\n' +
          "📎 [shot.png](https://files.slack.test/shot.png) (7 B) didn't come over: this board keeps no files\n" +
          "📎 [run (2).mov](https://files.slack.test/run%20%282%29.mov) (2 KB) didn't come over: this board keeps no files",
        attachments: [],
      })
    })
    expect(s.fetches).toEqual(['https://files.slack.test/shot.png'])
  })
})

describe('local() from the build', () => {
  it('sends a scheduled message, on the engine it inlines', async () => {
    // Resolved as an app resolves it, through the package's exports, to what the build put there.
    const require = createRequire(import.meta.url)
    const built = async <T,>(spec: string) => (await import(pathToFileURL(require.resolve(spec)).href)) as T
    expect(require.resolve('@vercel/board/backend-local')).toMatch(/dist\/backend-local\.mjs$/)
    const { local } = await built<typeof import('../src/backend-local/index.ts')>('@vercel/board/backend-local')
    const { board: mounted } = await built<typeof import('../src/server/index.ts')>('@vercel/board')
    const { oidcTokens } = await built<typeof import('../src/access/index.ts')>('@vercel/board/access')
    // In the test project, as a deployment of it finds itself.
    vi.stubEnv('VERCEL_PROJECT_ID', PROJECT_ID)
    vi.stubEnv('VERCEL_ORG_ID', TEAM_ID)
    const board = mounted({ backend: local({ memory: true }), authenticate: oidcTokens(testAuth), url: BOARD_URL })
    const julian = caller(board.fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'dev', text: 'PR #12 is open' })
    expect((await julian('POST', '/schedules', { re: body.message.id, text: 'friendly ping: review?', in: '1s' })).status).toBe(201)
    await vi.waitFor(
      async () => expect((await julian('GET', `/messages/${body.message.id}`)).body.replies).toEqual([expect.objectContaining({ text: 'friendly ping: review?', schedule: { id: expect.anything(), n: 0 } })]),
      { timeout: 5000 },
    )
  })
})
