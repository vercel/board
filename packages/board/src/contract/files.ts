// The sizes a file can be, here so a client reads them without zod.
/** Under Vercel Functions' 4.5 MB request body limit, so an upload fits in one request. */
export const ATTACHMENT_BYTES_MAX = 4 * 1024 * 1024
/**
 * The most a file sync brings over from a platform can be. Sync fetches it on the server and
 * stores it in-process, so no request carries it and the request limit doesn't apply: this bounds
 * what one import holds in memory.
 */
export const IMPORT_BYTES_MAX = 25 * 1024 * 1024
/**
 * The most a direct upload can be: the client sends the bytes straight to the blob store, on a URL
 * the board signs, so no request to the board carries them. Needs a store with `uploadUrl`.
 */
export const DIRECT_UPLOAD_BYTES_MAX = 100 * 1024 * 1024

/** `120 KB`, `3.4 MB`: a file's size the way people read it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
}

/** A file's type from its name, for when nothing better says: browsers leave `.log` untyped. */
export function typeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream'
}

/** `shot.png`, as the board stores a name: no paths, no control or invisible formatting characters, and no leading dot, so a download can't land as a dotfile or show a disguised extension. */
export function fileName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim().replace(/^[.\s]+/, '')
  return base.slice(0, 255) || 'file'
}

/** `image/png`, or `application/octet-stream` when the type isn't one. */
export function mediaType(type: string | null): string {
  const value = (type ?? '').split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) && value.length <= 255 ? value : 'application/octet-stream'
}
