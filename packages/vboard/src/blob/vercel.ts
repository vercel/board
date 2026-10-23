import { BlobNotFoundError, get, head, issueSignedToken, presignUrl, put } from '@vercel/blob'
import type { BlobStore } from '../server/blob.ts'

/**
 * Attachments in a private Vercel Blob store. Connect one to the board's
 * project; the SDK finds it through `BLOB_READ_WRITE_TOKEN`, or the project's
 * OIDC token and `BLOB_STORE_ID`. Files are private: the board serves them to
 * callers it verified, and the store never hands them out. Direct uploads, for
 * files over 4 MB, `PUT` to a URL the store presigns for one pathname, which
 * takes at most the file's size and never overwrites.
 */
/** The Blob API version `@vercel/blob` speaks, which a presigned `PUT` names. */
const BLOB_API_VERSION = '12'

export function vercelBlob(options: { token?: string; storeId?: string; prefix?: string } = {}): BlobStore {
  const auth = { ...(options.token ? { token: options.token } : {}), ...(options.storeId ? { storeId: options.storeId } : {}) }
  // `prefix`: one store for many boards, each under its own path, so no board serves another's files.
  const prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  return {
    async put(key, data, contentType) {
      await put(prefix + key, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
        ...auth,
        access: 'private',
        contentType,
        addRandomSuffix: false,
      })
    },
    async get(key) {
      // A record (`.json`) can be read before it's written (an attachment named before its upload
      // finished): from origin, so the CDN never keeps that miss. Files' bytes, once there, never change.
      const found = await get(prefix + key, { ...auth, access: 'private', ...(key.endsWith('.json') ? { useCache: false } : {}) })
      if (!found || found.statusCode !== 200) return null
      return { data: found.stream, contentType: found.blob.contentType }
    },
    async uploadUrl(key, { contentType, maxBytes, expiresAt }) {
      const pathname = prefix + key
      const validUntil = expiresAt.getTime()
      const signed = await issueSignedToken({ ...auth, pathname, operations: ['put'], validUntil, allowedContentTypes: [contentType], maximumSizeInBytes: maxBytes })
      const { presignedUrl } = await presignUrl(signed, {
        operation: 'put',
        access: 'private',
        pathname,
        validUntil,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
        allowOverwrite: false,
        addRandomSuffix: false,
      })
      // What the SDK's own presigned `PUT` sends beside the URL's signature.
      return { url: presignedUrl, headers: { 'x-api-version': BLOB_API_VERSION, 'x-vercel-blob-access': 'private', 'x-content-type': contentType } }
    },
    async head(key) {
      try {
        return { size: (await head(prefix + key, auth)).size }
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null
        throw error
      }
    },
  }
}
