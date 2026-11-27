import { createHash } from 'node:crypto'
import { ddl, type Db, type Sql } from './sql.ts'

/** What the tables need of a `pg` Pool, or of anything shaped like one. */
export type PgQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>
}
export type PgPool = PgQueryable & {
  connect(): Promise<PgQueryable & { release(): void }>
  end(): Promise<void>
}

/** The board's own error for tables that aren't there, or that its role can't use. */
export class TablesNotConfiguredError extends Error {
  readonly code = 'STORE_NOT_CONFIGURED'
}

/** Missing tables or columns (42P01, 42703) say to apply the schema; missing grants (42501), what to grant. */
function explain(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code
  if (code === '42P01' || code === '42703')
    return new TablesNotConfiguredError(`board's tables aren't in this database, or are from an older release: apply ${SCHEMA_FILE}`, { cause: error })
  if (code === '42501')
    return new TablesNotConfiguredError("this database role can't use board's tables: grant it select, insert, update, and delete on them", { cause: error })
  return error
}

/** Runs `body` on one connection in a transaction, which commits when it returns true and rolls back otherwise. */
async function transaction(pool: PgPool, begin: string, body: (client: PgQueryable) => Promise<boolean>): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query(begin)
    const keep = await body(client)
    await client.query(keep ? 'commit' : 'rollback')
    return keep
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** The tables on Postgres, through `pool`. Closing them leaves the pool to its owner. */
export function postgresDb(pool: PgPool): Db {
  const run = async (queryable: PgQueryable, query: Sql) => {
    try {
      return (await queryable.query(query.text, query.values)).rows
    } catch (error) {
      throw explain(error)
    }
  }
  return {
    all: (query) => run(pool, query),
    async read(queries) {
      const rows: Record<string, unknown>[][] = []
      await transaction(pool, 'begin isolation level repeatable read read only', async (client) => {
        for (const query of queries) rows.push(await run(client, query))
        return true
      })
      return rows
    },
    commit: (claim, writes) =>
      transaction(pool, 'begin', async (client) => {
        if ((await run(client, claim)).length === 0) return false
        for (const write of writes) await run(client, write)
        return true
      }),
    close: async () => {},
  }
}

const BREAKPOINT = '\n--> statement-breakpoint\n'

/** Where a board keeps its files' bytes on Postgres: up to 4 MB each, so a column holds them. */
const FILES_DDL = `create table if not exists board_files (
  key text primary key,
  content_type text not null,
  data bytea not null
)`

/** Where the package ships the schema, as an app that installs it finds it. */
export const SCHEMA_FILE = 'node_modules/@vercel/board/sql/postgres/schema.sql'

/** `board_meta`'s key for the version of `schema.sql` last applied to the database. */
export const SCHEMA_VERSION_KEY = 'postgres_schema'

/**
 * `sql/postgres/schema.sql`: `a2`, the bundled A2 release's schema.sql, whose tables keep the log,
 * then board's tables and its files, so a database needs one file. Its last statement records
 * `version`, a hash of the rest, so `postgres({ autoMigrate: true })` applies it only when it changed.
 */
export function postgresSchema(a2: string): { sql: string; version: string } {
  const body = `-- The tables of a board on Postgres (@vercel/board/backend-postgres): those that keep
-- its log, then those it reads from, and its files. Apply this file before the first
-- deploy, and again when a board release says the tables changed, or pass
-- postgres({ autoMigrate: true }) to have the board apply it. Every statement creates
-- only what is missing and leaves existing data alone, so it's safe to re-run.
-- The breakpoint after each statement splits it for migration tools that send one
-- statement per query; to every other tool it's only a comment.

${a2.trimEnd()}${BREAKPOINT}
${[...ddl('postgres'), FILES_DDL].join(`;${BREAKPOINT}`)};
`
  const version = createHash('sha256').update(body).digest('hex').slice(0, 16)
  const stamp = `insert into board_meta (key, value) values ('${SCHEMA_VERSION_KEY}', '${version}') on conflict (key) do update set value = excluded.value;\n`
  return { sql: `${body}${BREAKPOINT.slice(1)}${stamp}`, version }
}

/** The version of `schema.sql` the database last had applied, or null when it has none. */
export async function appliedVersion(client: PgQueryable): Promise<string | null> {
  // Asked first, so a new database answers null without a failed query.
  const { rows: present } = await client.query("select to_regclass('board_meta') is not null as present")
  if (present[0]?.present !== true) return null
  const { rows } = await client.query('select value from board_meta where key = $1', [SCHEMA_VERSION_KEY])
  return rows.length > 0 ? String(rows[0]!.value) : null
}

/** The advisory lock key instances take while one applies the schema: "board" in ASCII. */
const MIGRATION_LOCK = 0x626f617264

/**
 * Applies `schema.sql` when the database's recorded version isn't `version`, in one transaction under
 * a transaction-scoped advisory lock, so instances that start together apply it once, and a
 * transaction pooler (which may run each statement outside a transaction on another connection)
 * can't leave the lock held. A database already on it costs one read.
 */
export async function migrateSchema(pool: PgPool, schema: { sql: string; version: string }): Promise<void> {
  if ((await appliedVersion(pool)) === schema.version) return
  await transaction(pool, 'begin', async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
    // Another instance may have applied it while this one waited for the lock.
    if ((await appliedVersion(client)) !== schema.version) await client.query(schema.sql)
    return true
  })
}

/** Whether the tables a board's first calls need are there: the log's, board's, and its files'. */
export async function checkSchema(pool: PgPool): Promise<void> {
  const { rows } = await pool.query("select to_regclass('a2_events') is not null and to_regclass('board_messages') is not null and to_regclass('board_files') is not null as present")
  if (rows[0]?.present !== true) throw new TablesNotConfiguredError(`board's tables aren't in this database: apply ${SCHEMA_FILE}`)
}
