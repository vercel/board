import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, slackFileName, type SlackClient } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'

/**
 * The real Slack adapter, single-workspace like the software factory (an async
 * bot token, as Vercel Connect gives it), downloading through a fake transport.
 */
function slackWith(served: Uint8Array, extra: Record<string, unknown> = {}) {
  const requests: { url: string; authorization: string | undefined }[] = []
  const adapter = createSlackAdapter({
    signingSecret: 'secret',
    botToken: async () => 'xoxb-test',
    ...extra,
    fileTransport: async (url: URL, _signal: AbortSignal, headers: Record<string, string>) => {
      requests.push({ url: url.href, authorization: headers.authorization })
      return Object.assign(Readable.from([Buffer.from(served)]), {
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(served.byteLength) },
      })
    },
  } as Parameters<typeof createSlackAdapter>[0])
  const provider = slack({ adapter, client: async () => ({ conversations: { list: async () => ({}), info: async () => ({}), join: async () => ({}) } }) }, channels({}))
  return { provider, requests }
}

describe('files from Slack', () => {
  it('downloads a file with the bot token in a single-workspace app, though Slack says which team it came from', async () => {
    const png = new Uint8Array([137, 80, 78, 71])
    const { provider, requests } = slackWith(png)
    // What a Slack message event carries: the file's private URL and the event's team.
    const url = 'https://files.slack.com/files-pri/T1-F1/shot.png'
    const data = await provider.fetchFile({ type: 'image', name: 'shot.png', mimeType: 'image/png', size: 4, url, fetchMetadata: { url, teamId: 'T1' } })
    expect(data && [...data]).toEqual([...png])
    expect(requests).toEqual([{ url, authorization: 'Bearer xoxb-test' }])
  })

  it('keeps the team on a file in an app that also installs through OAuth, so each team uses its own token', async () => {
    const { provider, requests } = slackWith(new Uint8Array([1]), { clientId: 'client', clientSecret: 'shh' })
    const url = 'https://files.slack.com/files-pri/T2-F2/other.png'
    await expect(provider.fetchFile({ type: 'image', name: 'other.png', url, fetchMetadata: { url, teamId: 'T2' } })).rejects.toThrow(/Installation not found for team T2/)
    expect(requests).toEqual([]) // never sent with the default bot token
  })
})

describe('files to Slack', () => {
  it('names a text file so Slack previews it instead of offering a binary download', () => {
    expect(slackFileName('deepsec.log', 'text/plain')).toBe('deepsec.log.txt')
    expect(slackFileName('events.ndjson', 'application/x-ndjson')).toBe('events.ndjson.txt')
    expect(slackFileName('Makefile', 'text/plain')).toBe('Makefile.txt')
    expect(slackFileName('test-run.txt', 'text/plain')).toBe('test-run.txt')
    expect(slackFileName('README.MD', 'text/markdown')).toBe('README.MD')
    expect(slackFileName('data.json', 'application/json')).toBe('data.json')
    expect(slackFileName('shot.png', 'image/png')).toBe('shot.png')
    expect(slackFileName('blob.bin', 'application/octet-stream')).toBe('blob.bin')
    expect(slackFileName('unknown.log')).toBe('unknown.log')
  })
})

describe('a new thread with files, to Slack', () => {
  function slackUploading(sharedAfter: number, scopes = ['files:write', 'files:read'], info?: () => Promise<unknown>) {
    const adapter = createSlackAdapter({ signingSecret: 'secret', botToken: 'xoxb-test' })
    const internals = adapter as unknown as { initialize(chat: unknown): Promise<void>; chat: unknown }
    internals.initialize = async function (chat) {
      internals.chat = chat
    }
    const viaAdapter: unknown[] = []
    adapter.postMessage = async (threadId, message) => {
      viaAdapter.push(message)
      return { id: '1700000000.000300', threadId, raw: {} }
    }
    const uploads: { channel_id: string; initial_comment: string; file_uploads: { file: Buffer; filename: string }[] }[] = []
    let looks = 0
    const client = {
      conversations: { list: async () => ({}), info: async () => ({}) },
      files: {
        delete: async () => ({}),
        uploadV2: async (args: (typeof uploads)[number]) => {
          uploads.push(args)
          return { files: [{ files: args.file_uploads.map((f) => ({ id: `F_${f.filename}` })) }] }
        },
        // Slack shares the upload a moment after it answers.
        info: info ?? (async () => (++looks > sharedAfter ? { file: { shares: { public: { C1: [{ ts: '1700000000.000400' }] } } } } : { file: {} })),
      },
      auth: { test: async () => ({ response_metadata: { scopes } }) },
    }
    const provider = slack({ adapter, client: async () => client as SlackClient }, channels({}))
    return { provider, uploads, viaAdapter, looks: () => looks }
  }

  it('posts its text and files as one message, the thread root', async () => {
    const { provider, uploads, viaAdapter, looks } = slackUploading(1)
    const sent = await provider.post('C1', 'channel', {
      markdown: '**factory**: :merge: [Color picker stays put](https://github.com/acme/web/pull/1)',
      files: [{ data: new Uint8Array([1, 2, 3]), filename: 'after.mp4', mimeType: 'video/mp4' }],
    })
    expect(uploads).toEqual([
      {
        channel_id: 'C1',
        initial_comment: '*factory*: :merge: <https://github.com/acme/web/pull/1|Color picker stays put>',
        file_uploads: [{ file: Buffer.from([1, 2, 3]), filename: 'after.mp4' }],
      },
    ])
    expect(uploads[0]).not.toHaveProperty('thread_ts')
    expect(viaAdapter).toEqual([])
    expect(looks()).toBe(2)
    expect(sent).toEqual({ thread: 'C1:1700000000.000400', message: '1700000000.000400', files: ['F_after.mp4'] })
  })

  it('keeps replies and file-only roots on the adapter', async () => {
    const { provider, uploads, viaAdapter } = slackUploading(0)
    const files = [{ data: new Uint8Array([1]), filename: 'a.png', mimeType: 'image/png' }]
    await provider.post('C1:1700000000.000100', 'thread', { markdown: 'see after', files })
    await provider.post('C1', 'channel', { markdown: '', files })
    expect(uploads).toEqual([])
    expect(viaAdapter).toHaveLength(2)
  })

  it("posts the text alone, its files left to follow, where the app can't read files to find the upload", async () => {
    const { provider, uploads, viaAdapter } = slackUploading(0, ['files:write'])
    const sent = await provider.post('C1', 'channel', { markdown: 'shipped', files: [{ data: new Uint8Array([1]), filename: 'a.png', mimeType: 'image/png' }] })
    expect(uploads).toEqual([])
    expect(viaAdapter).toEqual([{ markdown: 'shipped' }])
    expect(sent).not.toHaveProperty('files')
  })

  it('never reads a failure after the upload as Slack refusing files, which would post the text twice', async () => {
    const refused = Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } })
    const { provider, uploads } = slackUploading(0, ['files:write', 'files:read'], async () => {
      throw refused
    })
    const error = await provider.post('C1', 'channel', { markdown: 'shipped', files: [{ data: new Uint8Array([1]), filename: 'a.png', mimeType: 'image/png' }] }).catch((e: unknown) => e)
    expect(uploads).toHaveLength(1)
    expect(String(error)).toMatch(/couldn't find the message uploading F_a.png made in C1/)
    expect(provider.refusesFiles(error)).toBe(false)
    expect(provider.refusesFiles(refused)).toBe(true)
  })
})
