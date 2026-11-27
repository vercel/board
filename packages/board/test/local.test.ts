import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { local } from '../src/backend-local/index.ts'
import { localFile } from '../src/server/local.ts'
import { bearer, BOARD_URL, localBoard, personToken } from './harness.ts'

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-local-'))
  made.push(dir)
  return dir
}

/** A handle on the board behind `fetch`, as `vb conformance` checks it, with `token`'s credentials. */
const over = (fetch: (request: Request) => Promise<Response>, token: () => Promise<string>) =>
  board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

describe('local()', () => {
  it('passes the whole conformance kit, schedules, tasks, and files included', async () => {
    const team = localBoard()
    try {
      // With headers of its own, as a proxy holding the person's token sends them: x-board-can, a profile.
      const withHeaders = (headers: Record<string, string>) =>
        over((request) => {
          for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
          return team.fetch(request)
        }, () => personToken())
      const report = await conformance(over(team.fetch, () => personToken()), { withHeaders })
      // All but the grants checks a local board skips: a viewer's cap and an app, which it has neither of, a member under a lock, and grants across teams.
      expect(report.checks.filter((check) => check.status !== 'passed').map((check) => [check.status, check.name])).toEqual([
        ['skipped', 'caps a person by their team role, so a viewer reads but neither posts nor manages'],
        ['skipped', 'names an app by its slug or client ID, keeps it by client ID, and every app as a group'],
        ['skipped', 'lets a member grant on a pattern after a lock under it'],
        ['skipped', 'lets a project on another team in, in its environments'],
      ])
      expect([...new Set(report.checks.map((check) => check.group))]).toEqual(['core', 'paging', 'search', 'schedules', 'tasks', 'inbox', 'grants', 'schemas', 'attachments', 'watchers', 'sync'])
    } finally {
      await team.close()
    }
  }, 30_000)

  it("keeps each name's board in its own file, its files beside it, and finds it again after a restart", async () => {
    const dir = await scratch()
    const open = (name?: string) => {
      const backend = local({ dir })
      return { backend, team: board({ backend, ...(name !== undefined ? { name } : {}) }) }
    }
    const first = open('security')
    const shot = await first.team.upload({ data: new TextEncoder().encode('pixels'), name: 'shot.txt' })
    const posted = await first.team.post('dev', { text: 'rotate the keys', attachments: [shot] })
    const general = open()
    await general.team.post('dev', 'on the default board')
    await Promise.all([first.backend.close(), general.backend.close()])
    // A board's files folder is there once it keeps a file.
    expect((await readdir(dir)).filter((name) => !/-(wal|shm)$/.test(name)).sort()).toEqual(['local.db', 'security', 'security.db'])

    // Another process, by the same name in another case: the same board, its file included.
    const again = open('SECURITY')
    expect((await again.team.channel('dev').messages()).messages.map((m) => m.text)).toEqual(['rotate the keys'])
    expect(await (await again.team.download(posted.attachments[0]!.id)).text()).toBe('pixels')
    await again.backend.close()
  })

  it("names a file for any other name so that none is another's or the default board's", async () => {
    const dir = await scratch()
    for (const name of ['Security Team', 'local', 'con']) {
      const backend = local({ dir })
      await board({ backend, name }).post('dev', `on ${name}`)
      await backend.close()
    }
    const files = (await readdir(dir)).filter((name) => name.endsWith('.db')).sort()
    expect(files).toEqual([expect.stringMatching(/^con\.[0-9a-f]{32}\.db$/), expect.stringMatching(/^local\.[0-9a-f]{32}\.db$/), expect.stringMatching(/^security-team\.[0-9a-f]{32}\.db$/)])
  })

  it("keeps a name apart from a plain name that reads like the file another's would be", async () => {
    const dir = await scratch()
    // Before, Security Team's file was security-team-83f2a9a1.db, the plain name's file too. Its
    // file's name now, taken as a name, is no plain name either.
    const names = ['Security Team', 'security-team-83f2a9a1', localFile('Security Team')]
    for (const name of names) {
      const backend = local({ dir })
      await board({ backend, name }).post('dev', `only on ${name}`)
      await backend.close()
    }
    for (const name of names) {
      const backend = local({ dir })
      expect((await board({ backend, name }).channel('dev').messages()).messages.map((m) => m.text)).toEqual([`only on ${name}`])
      await backend.close()
    }
    expect((await readdir(dir)).filter((file) => file.endsWith('.db')).length).toBe(3)
  })

  it("stops its timers when it's closed, so nothing runs against the closed file", async () => {
    const dir = await scratch()
    const failed = vi.spyOn(console, 'error')
    try {
      const backend = local({ dir })
      const team = board({ backend })
      const root = (await team.post('dev', 'deploy')).id
      await team.schedule({ re: root }, { text: 'did it land?', in: '1s' })
      await backend.close()
      // Past its time: nothing ran against the closed file.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(failed.mock.calls.filter(([said]) => String(said).includes('a scheduled task failed'))).toEqual([])
    } finally {
      failed.mockRestore()
    }
  })

  it("keeps one board per name whatever its team: there's one team here", async () => {
    const dir = await scratch()
    const acme = local({ dir })
    await board({ backend: acme, team: 'acme', name: 'security' }).post('dev', 'from acme')
    await acme.close()
    const ours = local({ dir })
    expect((await board({ backend: ours, name: 'security' }).channel('dev').messages()).messages.map((m) => m.text)).toEqual(['from acme'])
    await ours.close()
    const other = local({ dir })
    expect((await board({ backend: other, team: 'acme' }).channel('dev').messages()).messages).toEqual([])
    await other.close()
    expect((await readdir(dir)).filter((name) => name.endsWith('.db')).sort()).toEqual(['local.db', 'security.db'])
  })

  it('keeps nothing on disk in memory, and nothing outlives the backend', async () => {
    const dir = await scratch()
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const team = board({ backend: local({ memory: true }) })
      await team.post('dev', 'only here')
      expect((await team.channel('dev').messages()).messages.map((m) => m.text)).toEqual(['only here'])
      expect((await board({ backend: local({ memory: true }) }).channel('dev').messages()).messages).toEqual([])
      expect(await readdir(dir)).toEqual([])
    } finally {
      process.chdir(cwd)
    }
  })

  it("says where it couldn't keep the board, on the first call", async () => {
    const dir = await scratch()
    // A file where its directory would be.
    await writeFile(join(dir, 'taken'), '')
    const team = board({ backend: local({ dir: join(dir, 'taken') }) })
    await expect(team.post('dev', 'hi')).rejects.toMatchObject({ status: 500, code: 'no_store', message: expect.stringContaining(`can't open the board at ${join(dir, 'taken', 'local.db')}`) })
  })
})
