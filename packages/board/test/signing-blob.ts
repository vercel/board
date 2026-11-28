import { memoryBlob, type BlobStore } from '../src/server/blob.ts'
import { serve } from './http.ts'

/** A memory store that signs `PUT` URLs on a real local server, as Vercel Blob does on its own host. */
export async function signingBlob(closers: (() => Promise<void>)[]): Promise<BlobStore> {
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
