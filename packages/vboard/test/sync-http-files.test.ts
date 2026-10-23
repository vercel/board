import { afterAll, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { http as httpBackend } from '../src/backend-http/index.ts'
import { memoryBlob, type BlobStore } from '../src/server/blob.ts'
import { slack } from '../src/sync/slack.ts'
import { bearer, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { serve } from './http.ts'
import { fakePlatform } from './sync-fixtures.ts'

const TEAM_URL = 'http://team.test/api/board'
const PROJECT_URL = 'http://project.test/api/board'
/** Vercel Functions' request limit, which the platform answers itself, in plain text, before the board sees it. */
const FUNCTION_LIMIT = 4.5 * 1024 * 1024

const closers: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(closers.map((close) => close()))
})

/** A memory store that signs `PUT` URLs on a real local server, as Vercel Blob does on its own host. */
async function signingBlob(): Promise<BlobStore> {
  const store = memoryBlob()
  const grants = new Map<string, { key: string; maxBytes: number }>()
  const server = await serve(async (request) => {
    const grant = grants.get(new URL(request.url).pathname.slice(1))
    if (!grant || request.method !== 'PUT' || request.headers.has('authorization')) return new Response('forbidden', { status: 403 })
    const data = new Uint8Array(await request.arrayBuffer())
    if (data.byteLength > grant.maxBytes) return new Response('too large', { status: 413 })
    await store.put(grant.key, data, request.headers.get('content-type') ?? 'application/octet-stream')
    return new Response(null, { status: 200 })
  })
  closers.push(server.close)
  return {
    ...store,
    async uploadUrl(key, { maxBytes }) {
      const token = Math.random().toString(36).slice(2)
      grants.set(token, { key, maxBytes })
      return { url: `${server.origin}/${token}`, headers: {} }
    },
    async head(key) {
      const found = await store.get(key)
      return found ? { size: (found.data as Uint8Array).byteLength } : null
    },
  }
}

/** A project's board on http(), syncing Slack, using a team's board on a2() behind Vercel Functions' request limit. */
async function setup(blob: BlobStore) {
  const team = testBoard({ url: TEAM_URL, blob, access: [vercelProject({ project: 'prj_support', can: 'all' })] })
  const limited = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = request.method === 'GET' ? null : await request.clone().arrayBuffer()
    if (body && body.byteLength > FUNCTION_LIMIT) return new Response('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE', { status: 413 })
    return team.fetch(request)
  }) as typeof globalThis.fetch
  const backend = httpBackend(TEAM_URL, { fetch: bearer(limited, () => deploymentToken('support', 'prj_support', 'production', { audience: TEAM_URL })) })
  closers.push(async () => backend.close())
  const s = fakePlatform('slack')
  const project = board({ backend, url: PROJECT_URL, sync: { slack: slack({ adapter: s.adapter, channels: { C1: 'firehose' } }) } })
  await backend.registerWatchers()
  const julian = caller(team.fetch, await personToken('u_julian', TEAM_URL))
  const video = new Uint8Array(Math.round(10.9 * 1024 * 1024)).fill(7)
  s.served.set('https://files.slack.test/demo.mp4', video)
  await project.fetch(
    new Request(`${PROJECT_URL}/webhooks/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'message', threadId: 'slack:C1:700.1', id: '700.1', text: 'the demo', user: 'U1',
        files: [{ name: 'demo.mp4', mimeType: 'video/mp4', url: 'https://files.slack.test/demo.mp4', size: video.byteLength }],
      }),
    }),
  )
  const root = async () => {
    const { body } = await julian('GET', '/messages?channel=firehose')
    return body.messages[0] as { text: string; attachments: { id: string; size: number }[] } | undefined
  }
  return { video, root }
}

describe('sync on http() brings a Slack file over 4.5 MB', () => {
  it('as a note, where the board it uses takes nothing bigger than a request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { root } = await setup(memoryBlob())
    await vi.waitFor(async () => expect(await root()).toMatchObject({ text: "the demo\n\n📎 demo.mp4 (10.9 MB) didn't come over: over 4 MB", attachments: [] }))
    warn.mockRestore()
  })

  it("as a file, straight to the store, where the board it uses' store signs uploads", async () => {
    const { video, root } = await setup(await signingBlob())
    await vi.waitFor(async () => expect(await root()).toMatchObject({ text: 'the demo', attachments: [{ name: 'demo.mp4', type: 'video/mp4', size: video.byteLength }] }))
  })
})
