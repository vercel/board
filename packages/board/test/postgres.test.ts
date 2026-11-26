import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { oidcTokens } from '../src/access/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { postgres, postgresSchema } from '../src/backend-postgres/index.ts'
import { A2_POSTGRES_SCHEMA } from '../src/store/a2-postgres-schema.ts'
import { bearer, board, BOARD_URL, personToken } from './harness.ts'
import { testAuth, testLocal } from './tokens.ts'
import { freshPool, POSTGRES, TEST_DATABASE_URL } from './postgres-harness.ts'
import type { PgPool } from '../src/store/postgres-db.ts'

/** A board on `backend`, whose tokens come from the local test issuer, as `localBoard()`'s do. */
const on = (backend: ReturnType<typeof postgres>) => board({ backend, authenticate: oidcTokens({ ...testAuth, local: testLocal }), url: BOARD_URL })

/** A handle on the board behind `fetch`, as `vb conformance` checks it, with `token`'s credentials. */
const over = (fetch: (request: Request) => Promise<Response>, token: () => Promise<string>) =>
  board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

/** How many of board's and A2's tables the database has. */
async function tables(pool: PgPool) {
  const { rows } = await pool.query("select count(*)::int as n from pg_tables where schemaname = 'public' and (tablename like 'board_%' or tablename like 'a2_%')")
  return Number(rows[0]!.n)
}

describe("postgres()'s schema", () => {
  it("is the bundled A2 release's schema.sql, then board's tables: run scripts/a2-postgres-schema.ts after bumping experimental-a2", () => {
    const a2 = readFileSync(join(import.meta.dirname, '..', 'node_modules', 'experimental-a2', 'sql', 'postgres', 'schema.sql'), 'utf8')
    expect(A2_POSTGRES_SCHEMA).toBe(a2)
    expect(postgresSchema()).toContain(a2.trimEnd())
    expect(postgresSchema()).toContain('create table if not exists board_messages')
  })
})

describe(`postgres(), on ${POSTGRES}`, () => {
  it('passes the whole conformance kit, schedules, tasks, and files included', async () => {
    const backend = postgres({ pool: await freshPool() })
    const team = on(backend)
    try {
      const withHeaders = (headers: Record<string, string>) =>
        over((request) => {
          for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
          return team.fetch(request)
        }, () => personToken())
      const report = await conformance(over(team.fetch, () => personToken()), { withHeaders })
      // What local() skips too: a viewer's cap and an app, which it has neither of, a member under a lock, and grants across teams.
      expect(report.checks.filter((check) => check.status !== 'passed').map((check) => [check.status, check.name])).toEqual([
        ['skipped', 'caps a person by their team role, so a viewer reads but neither posts nor manages'],
        ['skipped', 'names an app by its slug or client ID, keeps it by client ID, and every app as a group'],
        ['skipped', 'lets a member grant on a pattern after a lock under it'],
        ['skipped', 'lets a project on another team in, in its environments'],
      ])
      expect([...new Set(report.checks.map((check) => check.group))]).toEqual(['core', 'paging', 'search', 'schedules', 'tasks', 'grants', 'schemas', 'attachments', 'watchers', 'sync'])
    } finally {
      await backend.close()
    }
  }, 120_000)

  it('makes its tables on its first call, and shares one board, files included, between instances and across restarts', async () => {
    const pool = await freshPool()
    expect(await tables(pool)).toBe(0)
    // Two instances starting together, as two serverless functions would: the tables are made once.
    const [one, two] = [postgres({ pool }), postgres({ pool })]
    const [first, second] = [on(one), on(two)]
    const [shot, posted] = await Promise.all([first.upload({ data: new TextEncoder().encode('pixels'), name: 'shot.txt' }), second.post('dev', 'from the second')])
    const reply = await first.reply(posted.id, { text: 'from the first', attachments: [shot] })
    expect(await tables(pool)).toBeGreaterThan(10)
    expect((await second.thread(posted.id)).replies.map((m) => m.text)).toEqual(['from the first'])
    await Promise.all([one.close(), two.close()])

    const again = postgres({ pool })
    const restarted = on(again)
    try {
      expect((await restarted.channel('dev').messages()).messages.map((m) => m.text)).toEqual(['from the second', 'from the first'])
      expect(await (await restarted.download(reply.attachments[0]!.id)).text()).toBe('pixels')
    } finally {
      await again.close()
    }
  })

  it("on Vercel, sends a scheduled message that came due while no instance ran, once the next one starts", async () => {
    // Each instance of a deployment arms its pending sends again on its first call.
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_postgres_test')
    const pool = await freshPool()
    const before = postgres({ pool })
    const first = on(before)
    const root = (await first.post('dev', 'deploy')).id
    await first.schedule({ re: root }, { text: 'did it land?', in: '1s' })
    await before.close()
    // Past its time, with nothing running.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const after = postgres({ pool })
    const next = on(after)
    try {
      await vi.waitFor(async () => expect((await next.thread(root)).replies.map((m) => m.text)).toEqual(['did it land?']), { timeout: 10_000 })
    } finally {
      await after.close()
      vi.unstubAllEnvs()
    }
  }, 20_000)

  it('takes a pool of yours and leaves it open, and with schema: false says what to apply to a database without its tables', async () => {
    const pool = await freshPool()
    {
      const bare = postgres({ pool, schema: false })
      await expect(on(bare).post('dev', 'hello')).rejects.toThrow(/board's tables aren't in this database/)
      await bare.close()

      await pool.query(postgresSchema())
      const applied = postgres({ pool, schema: false })
      expect((await on(applied).post('dev', 'hello')).text).toBe('hello')
      await applied.close()
      expect((await pool.query('select 1 as one')).rows).toEqual([{ one: 1 }])
    }
  })

  it.skipIf(!TEST_DATABASE_URL)('makes a pool from its connection string, and ends it when it closes', async () => {
    const pool = await freshPool()
    const { rows } = await pool.query('select current_database() as name')
    const url = new URL(TEST_DATABASE_URL!)
    url.pathname = `/${String(rows[0]!.name)}`
    const backend = postgres({ connectionString: url.toString() })
    expect((await on(backend).post('dev', 'hello')).text).toBe('hello')
    await backend.close()
    expect(await tables(pool)).toBeGreaterThan(10)
  })

  it('says it has no database when it has no connection string', async () => {
    const backend = postgres({ connectionString: '' })
    await expect(on(backend).post('dev', 'hello')).rejects.toThrow(/no database: pass connectionString, or set DATABASE_URL/)
    await backend.close()
  })
})
