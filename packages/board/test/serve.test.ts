import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { localHandle } from '../src/cli/serve.ts'
import { localTokenFile } from '../src/client/node.ts'
import { BOARD_URL, caller, personToken, testAuth, testBoard } from './harness.ts'
import { CLI, tmp } from './cli-harness.ts'

async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' }] })
  const sign = (sub: string, audience = BOARD_URL, iss = 'board:local') =>
    new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer(iss).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey)
  return { jwks, sign }
}

describe('local auth', () => {
  it("makes a local issuer's subject a person with full access", async () => {
    const { jwks, sign } = await issuer()
    const board = testBoard({ auth: { ...testAuth, local: { issuer: 'board:local', jwks } } })
    const me = await caller(board.fetch, await sign('julian'))('GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ actor: 'local:user:julian', principal: 'local:user:julian', kind: 'person', handle: 'julian' })
    const posted = await caller(board.fetch, await sign('julian'), { 'x-board-profile': 'claude' })('POST', '/messages', { channel: 'local', text: 'hi' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by).toMatchObject({ actor: 'local:user:julian+claude', principal: 'local:user:julian' })
  })

  it("refuses another key, another board's audience, a bad sub, and boards without the issuer", async () => {
    const { jwks, sign } = await issuer()
    const other = await issuer()
    const board = testBoard({ auth: { ...testAuth, local: { issuer: 'board:local', jwks } } })
    for (const token of [await other.sign('julian'), await sign('julian', 'http://elsewhere/api/board'), await sign('../root')])
      expect((await caller(board.fetch, token)('GET', '/me')).status).toBe(401)
    expect((await caller(testBoard().fetch, await sign('julian'))('GET', '/me')).status).toBe(401)
    // The board's own Vercel people still get in alongside.
    expect((await caller(board.fetch, await personToken())('GET', '/me')).status).toBe(200)
  })

  it('turns OS usernames into handles', () => {
    expect(localHandle('Julian Benegas')).toBe('julian-benegas')
    expect(localHandle('DOMAIN\\jb')).toBe('domain-jb')
    expect(localHandle('_')).toBe('me')
  })
})

const running: ChildProcess[] = []
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL')
})

async function setup() {
  const project = await tmp('serve-project-')
  await mkdir(join(project, '.git'))
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|CURSOR_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)),
  )
  const env = { ...clean, HOME: await tmp('serve-home-'), XDG_CONFIG_HOME: await tmp('serve-config-') }
  return { project, env }
}

/** `vb serve` on a free port, resolved once it says where it's serving. */
function serveIn(cwd: string, env: NodeJS.ProcessEnv, flags = ['--no-inspect']) {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--handle', 'julian', ...flags], { cwd, env })
  running.push(child)
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  const url = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      stdout += d
      const found = /serving a local board at (\S+)/.exec(stdout)
      if (found && stdout.includes('\n', found.index)) resolve(found[1]!)
    })
    void exited.then((code) => reject(new Error(`vb serve exited ${code}: ${stderr}`)))
  })
  return { child, url, exited, output: () => stdout }
}

function withConfig<T>(dir: string, run: () => T): T {
  const saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
  }
}

function vb(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}

describe('vb serve', () => {
  it('runs a board here, says how to reach it, and keeps its log across runs', async () => {
    const { project, env } = await setup()
    const first = serveIn(project, env)
    const url = await first.url
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/board$/)
    // It links nothing: other commands reach it by its URL, and its log stays out of Git.
    await expect.poll(first.output).toContain(`reach it with --url ${url}, or BOARD_URL=${url}`)
    expect(existsSync(join(project, '.board', 'config.json'))).toBe(false)
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe('.board/\n')
    const at = { ...env, BOARD_URL: url }

    const whoami = await vb(project, at, ['whoami', '--json'])
    expect(whoami.stderr).toBe('')
    expect(JSON.parse(whoami.stdout)).toMatchObject({ actor: 'local:user:julian', handle: 'julian', board: url })

    // An agent in the same checkout is "claude via julian".
    const posted = await vb(project, { ...at, CLAUDECODE: '1' }, ['post', 'local', 'from claude', '--json'])
    expect(posted.code).toBe(0)
    expect(JSON.parse(posted.stdout).message.by).toMatchObject({ actor: 'local:user:julian+claude' })
    const reply = await vb(join(project), at, ['reply', String(JSON.parse(posted.stdout).message.id), 'from julian'])
    expect(reply.code).toBe(0)

    const tokenFile = withConfig(env.XDG_CONFIG_HOME, () => localTokenFile(url))
    expect(existsSync(tokenFile)).toBe(true)
    first.child.kill('SIGINT')
    expect(await first.exited).toBe(0)
    expect(existsSync(tokenFile)).toBe(false)
    expect(existsSync(join(project, '.board', 'local.db'))).toBe(true)

    // A new run, on another port, still has the thread.
    const second = serveIn(project, env)
    const again = await second.url
    const read = await vb(project, { ...env, BOARD_URL: again }, ['read', 'local', '--json'])
    expect(read.stderr).toBe('')
    expect(read.stdout).toContain('from claude')
    expect(read.stdout).toContain('from julian')
    second.child.kill('SIGINT')
    expect(await second.exited).toBe(0)
  })

  it('carries over the log and files an earlier vb serve kept in .board/board.db', async () => {
    const { project, env } = await setup()
    await writeFile(join(project, 'shot.txt'), 'pixels')
    const first = serveIn(project, env)
    const at = { ...env, BOARD_URL: await first.url }
    const posted = await vb(project, at, ['post', 'local', 'before the upgrade', '--attach', 'shot.txt', '--json'])
    const [file] = JSON.parse(posted.stdout).message.attachments
    first.child.kill('SIGINT')
    expect(await first.exited).toBe(0)
    // As an earlier vb serve left it: the log in board.db, the files in attachments/.
    const board = join(project, '.board')
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(board, `local.db${suffix}`))) await rename(join(board, `local.db${suffix}`), join(board, `board.db${suffix}`))
    await rename(join(board, 'local'), join(board, 'attachments'))

    const second = serveIn(project, env)
    const again = { ...env, BOARD_URL: await second.url }
    expect((await vb(project, again, ['read', 'local'])).stdout).toContain('before the upgrade')
    expect(await vb(project, again, ['download', file.id, '-'])).toMatchObject({ code: 0, stdout: 'pixels' })
    expect(existsSync(join(board, 'board.db'))).toBe(false)
    second.child.kill('SIGINT')
    expect(await second.exited).toBe(0)
  })

  it("opens the inspector as you on this board, whatever BOARD_TOKEN holds", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, { ...env, BOARD_TOKEN: 'not-a-token-for-this-board' }, ['--no-open'])
    await serving.url
    await expect.poll(serving.output, { timeout: 10_000 }).toMatch(/inspector at http:\/\/127\.0\.0\.1:\d+\n/)
    const inspector = /inspector at (\S+)/.exec(serving.output())![1]!
    const page = await (await fetch(`${inspector}/`)).text()
    const token = /<meta name="inspect-token" content="([^"]+)">/.exec(page)![1]!
    const me = await (await fetch(`${inspector}/board/me`, { headers: { 'x-inspect-token': token } })).json()
    expect(me).toMatchObject({ actor: 'local:user:julian' })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it('says so when the port is taken', async () => {
    const { project, env } = await setup()
    const first = serveIn(project, env)
    const port = new URL(await first.url).port
    const second = await vb(project, env, ['serve', '--port', port, '--no-inspect'])
    expect(second.code).toBe(1)
    expect(second.stderr).toBe(`error: Port ${port} is taken. Is a board already running there?\n\n  Pick another port:\n    vb serve --port <PORT>\n`)
  })
})
