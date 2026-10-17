// Installs a deployment's tarball the way an application would, from its URL
// with no credentials, and checks that what arrives is the package it built.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseUrl = process.env.DEPLOYMENT_URL
if (!baseUrl) throw new Error('Set DEPLOYMENT_URL to the preview deployment URL')

const get = async (url) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, `${url} must be accessible without authentication`)
  return response
}

const manifest = await (await get(new URL('/preview.json', baseUrl))).json()
assert.equal(manifest.name, 'vboard')
assert.match(manifest.commit, /^[a-f0-9]{40}$/)
if (process.env.EXPECTED_COMMIT) assert.equal(manifest.commit, process.env.EXPECTED_COMMIT)
assert.equal(new URL(manifest.url).pathname, '/vboard.tgz')
const tarball = Buffer.from(await (await get(manifest.url)).arrayBuffer())
assert.equal(tarball[0], 0x1f)
assert.equal(tarball[1], 0x8b)
assert.equal(`sha512-${createHash('sha512').update(tarball).digest('base64')}`, manifest.integrity)

const directory = await mkdtemp(join(tmpdir(), 'vboard-preview-smoke-'))
try {
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n')
  // npm installs the required peer, experimental-a2, as an application would have it.
  execFileSync('npm', ['install', manifest.url, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: directory,
    stdio: 'inherit',
    timeout: 120_000,
  })
  const installed = JSON.parse(await readFile(join(directory, 'node_modules/vboard/package.json'), 'utf8'))
  assert.equal(installed.name, manifest.name)
  assert.equal(installed.version, manifest.version)
  const lockfile = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'))
  assert.equal(lockfile.packages['node_modules/vboard'].integrity, manifest.integrity)
  execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import assert from 'node:assert/strict'; import { board } from 'vboard'; import { createClient } from 'vboard/client'; assert.equal(typeof board, 'function'); assert.equal(typeof createClient, 'function')",
    ],
    { cwd: directory, stdio: 'inherit' },
  )
  const cli = execFileSync(join(directory, 'node_modules/.bin/vb'), ['--version'], { cwd: directory, encoding: 'utf8' })
  assert.equal(cli.trim(), manifest.version)
  await readFile(join(directory, 'node_modules/vboard/docs/index.md'))
  await readFile(join(directory, 'node_modules/vboard/dist/inspect/app.js'))
} finally {
  await rm(directory, { recursive: true, force: true })
}

process.stdout.write(`installed ${manifest.name}@${manifest.version} from ${manifest.url}\n`)
