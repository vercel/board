import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { oidcTokens } from '../src/access/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { postgres, type Scheduler } from '../src/backend-postgres/index.ts'
import { poolConfig } from '../src/server/postgres.ts'
import { parseSchema, schemaBody, SCHEMA_VERSION_KEY, stampedSchema } from '../src/store/postgres-db.ts'
import { POSTGRES_SCHEMA } from '../src/store/postgres-schema.generated.ts'
import { vercelQueues } from '../src/backend-postgres/scheduler-vercel.ts'
import { fakeQueue } from './queue.ts'
import { bearer, board, BOARD_URL, personToken } from './harness.ts'
import { testAuth, testLocal } from './tokens.ts'
import { freshPool, freshPoolWithTables, POSTGRES, SCHEMA, TEST_DATABASE_URL } from './postgres-harness.ts'
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

describe("postgres()'s schema.sql", () => {
  it("is the bundled A2 release's schema.sql, then board's tables: run scripts/postgres-schema.ts after changing either", () => {
    const a2 = readFileSync(join(import.meta.dirname, '..', 'node_modules', 'experimental-a2', 'sql', 'postgres', 'schema.sql'), 'utf8')
    expect(SCHEMA).toBe(stampedSchema(schemaBody(a2), POSTGRES_SCHEMA.version).sql)
    expect(POSTGRES_SCHEMA).toEqual(stampedSchema(schemaBody(a2), POSTGRES_SCHEMA.version))
    expect(SCHEMA).toContain(a2.trimEnd())
    expect(SCHEMA).toContain('create table if not exists board_messages')
  })
})

/** The schema the last release shipped: what a database that upgrades to this one has. */
const RELEASED = readFileSync(join(import.meta.dirname, 'postgres-schema-released.sql'), 'utf8')

describe("postgres()'s schema.sql over releases", () => {
  it('only adds to the last release\'s: a drop or rename goes over two releases, so a deployment still on the last one keeps working', () => {
    const released = new Set(RELEASED.split('\n').map((line) => line.trim()))
    const added = SCHEMA.split('\n').map((line) => line.trim()).filter((line) => !released.has(line))
    expect(added.filter((line) => /\b(drop\s+(table|column)|rename)\b/i.test(line))).toEqual([])
  })

  it("is the last release's version when its statements match, and one more when they don't", () => {
    const released = parseSchema(RELEASED)
    const current = parseSchema(SCHEMA)
    expect(current.version).toBe(current.body === released.body ? released.version : released.version + 1)
  })

  it("keeps a board's threads when autoMigrate applies it over the last release's", async () => {
    const pool = await freshPool()
    await pool.query(RELEASED)
    const before = postgres({ pool })
    const root = await on(before).post('dev', 'before the upgrade')
    await before.close()

    const after = postgres({ pool, autoMigrate: true })
    const team = on(after)
    try {
      await team.reply(root.id, 'after the upgrade')
      expect((await team.thread(root.id)).replies.map((m) => m.text)).toEqual(['after the upgrade'])
      expect((await pool.query('select value from board_meta where key = $1', [SCHEMA_VERSION_KEY])).rows).toEqual([{ value: String(POSTGRES_SCHEMA.version) }])
    } finally {
      await after.close()
    }
  }, 20_000)
})

describe(`postgres(), on ${POSTGRES}`, () => {
  it('passes the whole conformance kit, schedules, tasks, and files included', async () => {
    const backend = postgres({ pool: await freshPoolWithTables() })
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

  it('shares one board, files included, between instances and across restarts', async () => {
    const pool = await freshPoolWithTables()
    // Two instances at once, as two serverless functions would be.
    const [one, two] = [postgres({ pool }), postgres({ pool })]
    const [first, second] = [on(one), on(two)]
    const [shot, posted] = await Promise.all([first.upload({ data: new TextEncoder().encode('pixels'), name: 'shot.txt' }), second.post('dev', 'from the second')])
    const reply = await first.reply(posted.id, { text: 'from the first', attachments: [shot] })
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
    const pool = await freshPoolWithTables()
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

  it('says which file to apply to a database without its tables, and leaves a pool of yours open', async () => {
    const pool = await freshPool()
    const bare = postgres({ pool })
    await expect(on(bare).post('dev', 'hello')).rejects.toThrow("postgres: board's tables aren't in this database: apply node_modules/@vercel/board/sql/postgres/schema.sql")
    await bare.close()
    expect(await tables(pool)).toBe(0)

    await pool.query(SCHEMA)
    const applied = postgres({ pool })
    expect((await on(applied).post('dev', 'hello')).text).toBe('hello')
    await applied.close()
    expect((await pool.query('select 1 as one')).rows).toEqual([{ one: 1 }])
  })

  it('with autoMigrate, applies schema.sql to a database without it, once for instances that start together', async () => {
    const pool = await freshPool()
    const [one, two] = [postgres({ pool, autoMigrate: true }), postgres({ pool, autoMigrate: true })]
    try {
      const [a, b] = await Promise.all([on(one).post('dev', 'one'), on(two).post('dev', 'two')])
      expect([a.text, b.text]).toEqual(['one', 'two'])
      expect(await tables(pool)).toBeGreaterThan(0)
      expect((await pool.query('select value from board_meta where key = $1', [SCHEMA_VERSION_KEY])).rows).toEqual([{ value: String(POSTGRES_SCHEMA.version) }])
    } finally {
      await Promise.all([one.close(), two.close()])
    }
  }, 20_000)

  it('with autoMigrate, applies schema.sql again when the database has another release\'s, and keeps its data', async () => {
    const pool = await freshPoolWithTables()
    const first = postgres({ pool })
    const root = await on(first).post('dev', 'kept')
    await first.close()
    await pool.query("update board_meta set value = '0' where key = $1", [SCHEMA_VERSION_KEY])

    const migrating = postgres({ pool, autoMigrate: true })
    try {
      expect((await on(migrating).thread(root.id)).message.text).toBe('kept')
      expect((await pool.query('select value from board_meta where key = $1', [SCHEMA_VERSION_KEY])).rows).toEqual([{ value: String(POSTGRES_SCHEMA.version) }])
    } finally {
      await migrating.close()
    }
  }, 20_000)

  it("leaves a later release's tables alone, and an earlier release's file never moves the version back", async () => {
    const pool = await freshPoolWithTables()
    const later = String(POSTGRES_SCHEMA.version + 1)
    await pool.query('update board_meta set value = $2 where key = $1', [SCHEMA_VERSION_KEY, later])
    await pool.query(SCHEMA)
    const version = async () => (await pool.query('select value from board_meta where key = $1', [SCHEMA_VERSION_KEY])).rows
    expect(await version()).toEqual([{ value: later }])
    const backend = postgres({ pool, autoMigrate: true })
    try {
      expect(await backend.tables()).toEqual({ applied: POSTGRES_SCHEMA.version + 1, current: POSTGRES_SCHEMA.version })
      expect((await on(backend).post('dev', 'on a later schema')).text).toBe('on a later schema')
      expect(await version()).toEqual([{ value: later }])
    } finally {
      await backend.close()
    }
  }, 20_000)

  it("without autoMigrate, refuses an earlier release's tables up front, naming board's file", async () => {
    const pool = await freshPoolWithTables()
    await pool.query("update board_meta set value = '0' where key = $1", [SCHEMA_VERSION_KEY])
    const backend = postgres({ pool })
    try {
      await expect(on(backend).post('dev', 'hello')).rejects.toThrow(`postgres: board's tables in this database are from an earlier release (version 0, this one needs ${POSTGRES_SCHEMA.version}): apply node_modules/@vercel/board/sql/postgres/schema.sql`)
    } finally {
      await backend.close()
    }
  })

  it('says which schema a database has, and migrates it when asked, without opening the board', async () => {
    const pool = await freshPool()
    const backend = postgres({ pool })
    try {
      expect(await backend.tables()).toEqual({ applied: null, current: POSTGRES_SCHEMA.version })
      await expect(on(backend).post('dev', 'too soon')).rejects.toThrow("board's tables aren't in this database")
      await backend.migrate()
      expect(await backend.tables()).toEqual({ applied: POSTGRES_SCHEMA.version, current: POSTGRES_SCHEMA.version })
      const after = postgres({ pool })
      expect((await on(after).post('dev', 'after')).text).toBe('after')
      await after.close()
    } finally {
      await backend.close()
    }
  }, 20_000)

  it("sends what's scheduled through the scheduler it's given, delivered to its scheduler route", async () => {
    const queue = fakeQueue()
    const backend = postgres({ pool: await freshPoolWithTables(), scheduler: queue.scheduler as unknown as Scheduler })
    const team = on(backend)
    try {
      const root = (await team.post('dev', 'deploy')).id
      await team.schedule({ re: root }, { text: 'did it land?', in: '1s' })
      // Nothing runs it in this process: the queue holds it until it's due.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect((await team.thread(root)).replies).toEqual([])
      await vi.waitFor(async () => {
        await queue.fire(backend.scheduler)
        expect((await team.thread(root)).replies.map((m) => m.text)).toEqual(['did it land?'])
      }, { timeout: 10_000 })
    } finally {
      await backend.close()
    }
  }, 20_000)

  it("takes vercelQueues() on a topic the scheduler route's trigger can name", () => {
    expect(() => postgres({ scheduler: vercelQueues({ topic: 'board' }) })).not.toThrow()
    expect(() => vercelQueues({ topic: 'board scheduler' })).toThrow('vercelQueues() topic must match [A-Za-z0-9_-]+')
  })

  it.skipIf(!TEST_DATABASE_URL)('makes a pool from its connection string, and ends it when it closes', async () => {
    const pool = await freshPoolWithTables()
    const { rows } = await pool.query('select current_database() as name')
    const url = new URL(TEST_DATABASE_URL!)
    url.pathname = `/${String(rows[0]!.name)}`
    const backend = postgres({ connectionString: url.toString() })
    expect((await on(backend).post('dev', 'hello')).text).toBe('hello')
    await backend.close()
  })

  it("takes pg's PG* variables without a URL, with the deployment's OIDC token as the password unless PGPASSWORD is set", async () => {
    expect(poolConfig({}, { DATABASE_URL: 'postgres://a@h/d', PGHOST: 'other' })).toEqual({ connectionString: 'postgres://a@h/d', max: 10 })
    expect(poolConfig({}, { PGHOST: 'db.example', PGPASSWORD: 'secret' })).toEqual({ max: 10, password: 'secret' })
    expect(poolConfig({}, {})).toBeNull()
    const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`
    vi.stubEnv('VERCEL_OIDC_TOKEN', token)
    try {
      const { password } = poolConfig({ max: 2 }, { PGHOST: 'db.example' })!
      expect(typeof password).toBe('function')
      expect(await (password as () => Promise<string>)()).toBe(token)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('says it has no database when it has no connection string', async () => {
    const backend = postgres({ connectionString: '' })
    await expect(on(backend).post('dev', 'hello')).rejects.toThrow(/no database: pass connectionString, or set DATABASE_URL or PGHOST/)
    await backend.close()
  })
})
