import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { memoryBlob, type BlobStore } from '../src/server/blob.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>()
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) }
})

async function setup(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  const token = await personToken()
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => board.fetch(new Request(input, init))) as typeof globalThis.fetch
  return { board, token, client: createBoardClient({ url: BOARD_URL, token, fetch }), call: caller(board.fetch, token) }
}

describe('attachments', () => {
  it('uploads a file, posts it, and serves it back as the board stored it', async () => {
    const { client } = await setup()
    const shot = await client.upload({ data: PNG, name: 'screens/after fix.png', type: 'image/png' })
    expect(shot).toMatchObject({ name: 'after fix.png', type: 'image/png', size: PNG.byteLength })
    expect(shot.id).toMatch(/^[A-Za-z0-9_-]{22}$/)

    const posted = await client.post('errors-www', { text: 'fixed, see screenshot', attachments: [shot] })
    expect(posted.attachments).toEqual([shot])
    const { messages } = await client.messages({ channel: 'errors-www' })
    expect(messages[0]!.attachments).toEqual([shot])

    const file = await client.download(shot.id)
    expect(file.headers.get('content-type')).toBe('image/png')
    expect(file.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''after%20fix.png`)
    expect(file.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
  })

  it('mints no id that starts with "-", which a command line reads as a flag, and still serves those it did', async () => {
    const blob = memoryBlob()
    const { client } = await setup({ blob })
    // 16 bytes of 0xf8 are `-Pj4…` in base64url: one draw in 64 starts with `-`.
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(16, 0xf8) as never)
    const shot = await client.upload({ data: PNG, name: 'shot.png', type: 'image/png' })
    expect(shot.id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{21}$/)

    const old = { id: '-Pj4-Pj4-Pj4-Pj4-Pj4-A', name: 'old.png', type: 'image/png', size: PNG.byteLength }
    await blob.put(`vboard/attachments/${old.id}`, PNG, old.type)
    await blob.put(`vboard/attachments/${old.id}.json`, new TextEncoder().encode(JSON.stringify(old)), 'application/json')
    expect(new Uint8Array(await (await client.download(old.id)).arrayBuffer())).toEqual(PNG)
    expect((await client.post('ops', { text: 'still here', attachments: [old.id] })).attachments).toEqual([old])
  })

  it('downloads what a browser could run, and needs a token to read', async () => {
    const { board, client } = await setup()
    const page = await client.upload({ data: new TextEncoder().encode('<script>alert(1)</script>'), name: 'x.svg', type: 'image/svg+xml' })
    expect((await client.download(page.id)).headers.get('content-disposition')).toMatch(/^attachment;/)
    const anonymous = await board.fetch(new Request(`${BOARD_URL}/attachments/${page.id}`))
    expect(anonymous.status).toBe(401)
  })

  it('records only files it stored, and lets a message with files have no text', async () => {
    const { client, call } = await setup()
    const missing = await call('POST', '/messages', { channel: 'ops', text: 'here', attachments: ['AAAAAAAAAAAAAAAAAAAAAA'] })
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 'attachment_not_found' } } })
    expect((await call('POST', '/messages', { channel: 'ops', text: ' ' })).status).toBe(400)

    const shot = await client.upload({ data: PNG, name: 'shot.png', type: 'image/png' })
    const posted = await client.post('ops', { text: '', attachments: [shot.id] })
    expect(posted).toMatchObject({ text: '', attachments: [shot] })

    await client.delete(posted.id)
    expect((await client.thread(posted.id)).message.attachments).toEqual([])
  })

  it('refuses files over 4 MB where the store takes no direct uploads, and in one request everywhere', async () => {
    const { board, client, token } = await setup()
    await expect(client.upload({ data: new Uint8Array(4 * 1024 * 1024 + 1), name: 'big.bin' })).rejects.toMatchObject({ status: 501, code: 'no_direct_uploads' })
    const oneRequest = await board.fetch(new Request(`${BOARD_URL}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(4 * 1024 * 1024 + 1) }))
    expect(oneRequest.status).toBe(413)

    // Without a content-length, the board stops reading once it's past the limit.
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const chunked = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: endless,
        duplex: 'half',
      } as RequestInit),
    )
    expect(chunked.status).toBe(413)
    expect(sent).toBeLessThanOrEqual(6 * 1024 * 1024)
  })

  describe('direct uploads', () => {
    /** A store that signs URLs as an S3 or Vercel Blob one does: one key, at most the size, no overwrites, until it expires. */
    function signingBlob() {
      const store = memoryBlob()
      const signed = new Map<string, { key: string; contentType: string; maxBytes: number; expiresAt: Date }>()
      const blob = {
        ...store,
        async uploadUrl(key: string, options: { contentType: string; maxBytes: number; expiresAt: Date }) {
          const token = randomBytes(8).toString('hex')
          signed.set(token, { key, ...options })
          return { url: `https://blob.test/put/${token}`, headers: { 'x-signed': 'yes' } }
        },
        async head(key: string) {
          const found = await store.get(key)
          return found ? { size: (found.data as Uint8Array).byteLength } : null
        },
      }
      /** What the store answers a `PUT` on a URL it signed. */
      async function put(request: Request): Promise<Response> {
        const grant = signed.get(new URL(request.url).pathname.split('/').pop()!)
        if (!grant || request.method !== 'PUT' || request.headers.get('x-signed') !== 'yes' || grant.expiresAt < new Date()) return new Response('forbidden', { status: 403 })
        if (request.headers.get('content-type') !== grant.contentType) return new Response('wrong type', { status: 400 })
        const data = new Uint8Array(await request.arrayBuffer())
        if (data.byteLength > grant.maxBytes) return new Response('too large', { status: 413 })
        if (await store.get(grant.key)) return new Response('exists', { status: 409 })
        await store.put(grant.key, data, grant.contentType)
        return new Response(null, { status: 200 })
      }
      return { blob, put }
    }

    async function directSetup() {
      const { blob, put } = signingBlob()
      const board = testBoard({ blob })
      const token = await personToken()
      const puts: { url: string; authorization: string | null }[] = []
      // The board's fetch brings its credentials to whatever it sends, as `vb`'s does.
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        request.headers.set('authorization', `Bearer ${token}`)
        return board.fetch(request)
      }) as typeof globalThis.fetch
      const storeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        puts.push({ url: request.url, authorization: request.headers.get('authorization') })
        return put(request)
      }) as typeof globalThis.fetch
      return { board, blob, token, puts, client: createBoardClient({ url: BOARD_URL, fetch, storeFetch }), call: caller(board.fetch, token) }
    }

    it('uploads a file over 4 MB straight to the store, then posts and serves it', async () => {
      const { client, puts } = await directSetup()
      // The 10.9 MB recording from board #252.
      const video = new Uint8Array(Math.round(10.9 * 1024 * 1024)).fill(7)
      const demo = await client.upload({ data: video, name: 'demo.mp4' })
      expect(demo).toMatchObject({ name: 'demo.mp4', type: 'video/mp4', size: video.byteLength })
      // One PUT to the store, which never sees the board's token.
      expect(puts).toEqual([{ url: expect.stringMatching(/^https:\/\/blob\.test\/put\//), authorization: null }])

      const posted = await client.post('ops', { text: 'the demo', attachments: [demo] })
      expect(posted.attachments).toEqual([demo])
      const file = await client.download(demo.id)
      expect(file.headers.get('content-type')).toBe('video/mp4')
      expect((await file.arrayBuffer()).byteLength).toBe(video.byteLength)

      // The PUT sends the type the URL was signed for, not the one the caller wrote.
      const typed = await client.upload({ data: video, name: 'demo.mp4', type: 'Video/MP4; codecs=avc1' })
      expect(typed).toMatchObject({ type: 'video/mp4', size: video.byteLength })
      puts.pop()

      // Small files still go in one request.
      await client.upload({ data: PNG, name: 'shot.png', type: 'image/png' })
      expect(puts).toHaveLength(1)
    })

    it('records an upload only once the store has exactly its bytes, and only for its uploader', async () => {
      const { board, blob, call } = await directSetup()
      const size = 5 * 1024 * 1024
      const ticket = (await call('POST', '/attachments/uploads', { name: 'run.mov', type: 'video/quicktime', size })).body
      expect(ticket).toMatchObject({ id: expect.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_-]{21}$/), url: expect.any(String), headers: { 'x-signed': 'yes', 'content-type': 'video/quicktime' }, expiresAt: expect.any(String) })

      // Before the bytes: nothing to record, and nothing to read or post.
      expect((await call('POST', `/attachments/uploads/${ticket.id}`, {})).body.error.code).toBe('not_uploaded')
      expect((await call('GET', `/attachments/${ticket.id}`)).status).toBe(404)
      expect((await call('POST', '/messages', { channel: 'ops', text: 'x', attachments: [ticket.id] })).status).toBe(404)

      // Someone else can't finish it.
      const other = caller(board.fetch, await personToken('u_other'))
      expect((await other('POST', `/attachments/uploads/${ticket.id}`, {})).status).toBe(404)

      // Bytes that aren't the size it said are refused.
      await blob.put(`vboard/attachments/${ticket.id}`, new Uint8Array(size - 1), 'video/quicktime')
      expect((await call('POST', `/attachments/uploads/${ticket.id}`, {})).body.error.code).toBe('size_mismatch')
    })

    it('finishes once, and answers the same attachment when finished again', async () => {
      const { blob, call } = await directSetup()
      const size = 5 * 1024 * 1024
      const ticket = (await call('POST', '/attachments/uploads', { name: 'run.mov', type: 'video/quicktime', size })).body
      await blob.put(`vboard/attachments/${ticket.id}`, new Uint8Array(size), 'video/quicktime')
      const first = await call('POST', `/attachments/uploads/${ticket.id}`, {})
      expect(first).toMatchObject({ status: 201, body: { attachment: { id: ticket.id, name: 'run.mov', type: 'video/quicktime', size } } })
      expect((await call('POST', `/attachments/uploads/${ticket.id}`, {})).body).toEqual(first.body)
    })

    it("posts a direct upload on a store whose reads keep a miss, as Vercel Blob's CDN does", async () => {
      // Board #252: the upload finished, then the post said `no attachment`, since finishing read
      // the attachment's record before writing it, and the store's cache kept that miss.
      const { blob, put } = signingBlob()
      const misses = new Set<string>()
      const cached: BlobStore = {
        ...blob,
        async get(key) {
          if (misses.has(key)) return null
          const found = await blob.get(key)
          if (!found) misses.add(key)
          return found
        },
      }
      const board = testBoard({ blob: cached })
      const token = await personToken()
      const client = createBoardClient({ url: BOARD_URL, token, fetch: ((input: RequestInfo | URL, init?: RequestInit) => board.fetch(new Request(input, init))) as typeof globalThis.fetch, storeFetch: ((input: RequestInfo | URL, init?: RequestInit) => put(new Request(input, init))) as typeof globalThis.fetch })
      const demo = await client.upload({ data: new Uint8Array(5 * 1024 * 1024), name: 'demo.mp4' })
      expect((await client.post('scratch', { text: 'blob test', attachments: [demo] })).attachments).toEqual([demo])
    })

    it('refuses a direct upload over 100 MB before signing anything', async () => {
      const { client, call, puts } = await directSetup()
      expect((await call('POST', '/attachments/uploads', { name: 'huge.mov', size: 100 * 1024 * 1024 + 1 })).status).toBe(400)
      await expect(client.upload({ data: new Uint8Array(100 * 1024 * 1024 + 1), name: 'huge.mov' })).rejects.toMatchObject({ status: 413, code: 'too_large' })
      expect(puts).toHaveLength(0)
    })
  })
})
