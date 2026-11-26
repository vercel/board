import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { afterAll } from 'vitest'
import type { PgPool, PgQueryable } from '../src/store/postgres-db.ts'

/**
 * A real Postgres server, which may create databases: `TEST_DATABASE_URL`. Without it, each
 * database is PGlite's, Postgres in this process.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/** Where a test's databases are: a server, or PGlite. */
export const POSTGRES = TEST_DATABASE_URL ? 'Postgres' : 'PGlite'

/** The schema the package ships, `sql/postgres/schema.sql`. */
export const SCHEMA = readFileSync(join(import.meta.dirname, '..', 'sql', 'postgres', 'schema.sql'), 'utf8')

const made: string[] = []
const opened: { end(): Promise<void> }[] = []
let counter = 0

/** Runs `sql` on the server's own database, as the test's admin. */
async function admin(sql: string) {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/**
 * PGlite as a pool: it has one connection, so a query or a checked-out connection holds it, and
 * the next waits its turn, as a pool of one would.
 */
function pglitePool(db: PGlite): PgPool {
  let turn: Promise<void> = Promise.resolve()
  const take = async () => {
    let free!: () => void
    const held = new Promise<void>((resolve) => (free = resolve))
    const before = turn
    turn = before.then(() => held)
    await before
    return free
  }
  const run: PgQueryable['query'] = async (text, values) => {
    if (values && values.length > 0) return { rows: (await db.query<Record<string, unknown>>(text, values)).rows }
    // Several statements, as a schema is, go as one simple query.
    const results = await db.exec(text)
    return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] }
  }
  return {
    async query(text, values) {
      const free = await take()
      try {
        return await run(text, values)
      } finally {
        free()
      }
    },
    async connect() {
      const free = await take()
      let released = false
      return {
        query: run,
        release: () => {
          if (released) return
          released = true
          free()
        },
      }
    },
    end: () => db.close(),
  }
}

/** A pool on an empty database of its own, closed and dropped once the file's tests end. */
export async function freshPool(): Promise<PgPool> {
  if (!TEST_DATABASE_URL) {
    const pool = pglitePool(new PGlite())
    opened.push(pool)
    return pool
  }
  const name = `board_test_${process.pid}_${Date.now()}_${++counter}`
  await admin(`create database ${name}`)
  made.push(name)
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: url.toString() })
  pool.on('error', () => {})
  opened.push(pool)
  return pool as unknown as PgPool
}

afterAll(async () => {
  for (const pool of opened.splice(0)) await pool.end().catch(() => {})
  for (const name of made.splice(0)) await admin(`drop database if exists ${name} with (force)`)
})

/** A pool on an empty database of its own with the package's schema applied, as a deploy would. */
export async function freshPoolWithTables(): Promise<PgPool> {
  const pool = await freshPool()
  await pool.query(SCHEMA)
  return pool
}
