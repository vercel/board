import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { memoryBlob } from '../src/server/blob.ts'
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

  it('refuses files over 4 MB, and uploads when the board has nowhere to keep them', async () => {
    const { board, client, token } = await setup()
    await expect(client.upload({ data: new Uint8Array(4 * 1024 * 1024 + 1), name: 'big.bin' })).rejects.toMatchObject({ status: 413, code: 'too_large' })

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

    vi.stubEnv('NODE_ENV', 'production')
    try {
      const { client: production } = await setup()
      await expect(production.upload({ data: PNG, name: 'shot.png' })).rejects.toMatchObject({ code: 'no_blob_store' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
