// Packs `vboard` into dist/ with the install page and its metadata. The page and
// preview.json name the deployment's own URL, so the build can't be cached.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = fileURLToPath(new URL('../dist/', import.meta.url))
const packageDirectory = fileURLToPath(new URL('../../../packages/vboard/', import.meta.url))
if (process.env.VERCEL && !process.env.VERCEL_GIT_COMMIT_SHA) {
  throw new Error('Set VERCEL_GIT_COMMIT_SHA when deploying with the CLI. Git deployments provide it automatically.')
}
const commit = process.env.VERCEL_GIT_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const host = process.env.VERCEL_URL

if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a full Git commit SHA')
if (process.env.VERCEL && !host) throw new Error('VERCEL_URL is required on Vercel')
if (host && !/^[a-z0-9.-]+$/.test(host)) throw new Error('Invalid VERCEL_URL')

const baseUrl = host ? `https://${host}` : 'http://localhost:4173'
const filename = 'vboard.tgz'
const url = `${baseUrl}/${filename}`
const { name, version } = JSON.parse(await readFile(`${packageDirectory}package.json`, 'utf8'))

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
// `prepack` builds the package first.
execFileSync('pnpm', ['pack', '--out', `${output}${filename}`], { cwd: packageDirectory, stdio: 'inherit' })

const tarball = await readFile(`${output}${filename}`)
const manifest = {
  name,
  version,
  commit,
  url,
  integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
}
const template = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

await writeFile(`${output}preview.json`, `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(
  `${output}index.html`,
  template.replace(/\{\{(name|version|commit|url)\}\}/g, (_, key) => escapeHtml(manifest[key])),
)
