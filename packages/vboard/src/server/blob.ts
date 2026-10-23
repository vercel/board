import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Attachment, ATTACHMENT_BYTES_MAX, type Attachment as AttachmentType } from '../contract/schemas.ts'
import { badRequest, HttpError, notFound } from './errors.ts'

/**
 * Where attachments' bytes live. The board writes each file once, under a key
 * it chose, and never overwrites it; `vercelBlob()` from `vboard/backend-a2/blob-vercel` is the
 * production one.
 */
export type BlobStore = {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>
  /** Null when there's nothing under the key. */
  get(key: string): Promise<{ data: ReadableStream<Uint8Array> | Uint8Array; contentType: string } | null>
}

/** Files in memory, for tests: forgets everything when the process ends. */
export function memoryBlob(): BlobStore {
  const files = new Map<string, { data: Uint8Array; contentType: string }>()
  return {
    put: async (key, data, contentType) => void files.set(key, { data: data.slice(), contentType }),
    get: async (key) => files.get(key) ?? null,
  }
}

/** Files on disk, for development and `vb serve`: under `dir`, `.a2/attachments` by default. */
export function fsBlob(dir = '.a2/attachments'): BlobStore {
  const path = (key: string) => join(dir, ...key.split('/'))
  return {
    async put(key, data, contentType) {
      await mkdir(dirname(path(key)), { recursive: true })
      await writeFile(path(key), data)
      await writeFile(`${path(key)}.type`, contentType)
    },
    async get(key) {
      try {
        const [data, contentType] = await Promise.all([readFile(path(key)), readFile(`${path(key)}.type`, 'utf8')])
        return { data: new Uint8Array(data), contentType }
      } catch {
        return null
      }
    },
  }
}

const dataKey = (id: string) => `vboard/attachments/${id}`
const metaKey = (id: string) => `vboard/attachments/${id}.json`

/** `shot.png`, as the board stores a name: no paths, no control characters. */
function fileName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base.slice(0, 255) || 'file'
}

/** `image/png`, or `application/octet-stream` when the type isn't one. */
function mediaType(type: string | null): string {
  const value = (type ?? '').split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) && value.length <= 255 ? value : 'application/octet-stream'
}

/** A board without a blob store keeps no files: every file route says so. */
const noBlob = () => new HttpError(501, 'no_files', 'this board keeps no files: pass `blob` to `a2()`')

/** 128 random bits, base64url, drawn again when they'd start with `-`, which a command line reads as a flag. */
function attachmentId(): string {
  for (;;) {
    const id = randomBytes(16).toString('base64url')
    if (!id.startsWith('-')) return id
  }
}

/**
 * Stores an upload under a fresh ID, with its metadata beside it. `uploadedBy`
 * is the principal that sent it, who can read it before any message carries it.
 * `max` is the most it can be: `ATTACHMENT_BYTES_MAX` unless the board's own sync imports it.
 */
export async function writeUpload(
  blob: BlobStore | null,
  input: { data: Uint8Array; name: string | null; type: string | null; uploadedBy?: string },
  max = ATTACHMENT_BYTES_MAX,
): Promise<AttachmentType> {
  if (!blob) throw noBlob()
  if (input.data.byteLength === 0) throw badRequest('the file is empty')
  if (input.data.byteLength > max) throw new HttpError(413, 'too_large', `attachments are at most ${max / 1024 / 1024} MB`)
  const attachment: AttachmentType = {
    id: attachmentId(),
    name: fileName(input.name),
    type: mediaType(input.type),
    size: input.data.byteLength,
  }
  await blob.put(dataKey(attachment.id), input.data, attachment.type)
  const meta = input.uploadedBy === undefined ? attachment : { ...attachment, uploadedBy: input.uploadedBy }
  await blob.put(metaKey(attachment.id), new TextEncoder().encode(JSON.stringify(meta)), 'application/json')
  return attachment
}

async function bytes(data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  return data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer())
}

export const attachmentNotFound = (id: string) => notFound(`no attachment: ${id}`, 'attachment_not_found')

/**
 * An upload's metadata, as the board recorded it, never what a request says,
 * and who uploaded it: null for files the board imported itself, or stored
 * before it recorded that.
 */
export async function readUpload(blob: BlobStore | null, id: string): Promise<{ attachment: AttachmentType; uploadedBy: string | null }> {
  if (!blob) throw noBlob()
  const found = Attachment.shape.id.safeParse(id).success ? await blob.get(metaKey(id)) : null
  if (!found) throw attachmentNotFound(id)
  const meta = JSON.parse(new TextDecoder().decode(await bytes(found.data))) as { uploadedBy?: unknown }
  return { attachment: Attachment.parse(meta), uploadedBy: typeof meta.uploadedBy === 'string' ? meta.uploadedBy : null }
}

/** An attachment's bytes. */
export async function readAttachmentData(blob: BlobStore | null, id: string): Promise<Uint8Array> {
  if (!blob) throw noBlob()
  const found = await blob.get(dataKey(id))
  if (!found) throw attachmentNotFound(id)
  return bytes(found.data)
}

/** An attachment's bytes as the store keeps them, a stream or the bytes, for board() to serve. */
export async function attachmentBody(blob: BlobStore | null, id: string): Promise<ReadableStream<Uint8Array> | Uint8Array> {
  if (!blob) throw noBlob()
  const found = await blob.get(dataKey(id))
  if (!found) throw attachmentNotFound(id)
  return found.data
}
