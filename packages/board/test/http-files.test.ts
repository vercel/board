import { afterAll, describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http as httpBackend } from '../src/backend-http/index.ts'
import { memoryBlob, type BlobStore } from '../src/server/blob.ts'
import { bearer, deploymentToken, testBoard } from './harness.ts'
import { serve } from './http.ts'

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

/** A project's board on http(), using a team's board on a2() behind Vercel Functions' request limit. */
async function setup(blob: BlobStore) {
  const team = testBoard({ url: TEAM_URL, blob })
  // The support project's production deployments may do everything there.
  await team.createGrant({ principals: [{ kind: 'project', project: 'prj_support', environments: ['production'] }], can: { '*': 'all' } })
  const limited = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = request.method === 'GET' ? null : await request.clone().arrayBuffer()
    if (body && body.byteLength > FUNCTION_LIMIT) return new Response('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE', { status: 413 })
    return team.fetch(request)
  }) as typeof globalThis.fetch
  const backend = httpBackend(TEAM_URL, { fetch: bearer(limited, () => deploymentToken('support', 'prj_support', 'production', { audience: TEAM_URL })) })
  closers.push(async () => backend.close())
  const project = board({ backend, url: PROJECT_URL })
  const video = new Uint8Array(Math.round(10.9 * 1024 * 1024)).fill(7)
  const upload = () => project.upload({ data: video, name: 'demo.mp4', type: 'video/mp4' })
  return { video, upload }
}

describe('a board on http() uploads a file over 4.5 MB', () => {
  it("straight to the store, where the board it uses' store signs uploads", async () => {
    const { video, upload } = await setup(await signingBlob())
    // The board it uses records it only once its store has exactly these bytes.
    expect(await upload()).toMatchObject({ name: 'demo.mp4', type: 'video/mp4', size: video.byteLength })
  })

  it("never as one request, which the board it uses can't take, where its store signs nothing", async () => {
    const { upload } = await setup(memoryBlob())
    await expect(upload()).rejects.toMatchObject({ code: 'no_direct_uploads' })
  })
})
