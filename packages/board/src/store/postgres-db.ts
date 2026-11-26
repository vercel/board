import { createHash } from 'node:crypto'
import { A2_POSTGRES_SCHEMA } from './a2-postgres-schema.ts'
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
    return new TablesNotConfiguredError("board's tables aren't in this database, or are from an older release: apply postgresSchema()", { cause: error })
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

/**
 * Everything a board on Postgres needs, as one file: the tables that keep its log, then those it
 * reads from, and its files. Every statement creates only what's missing and leaves existing
 * data alone, so it's safe to apply again, and it works as a migration as it is: the breakpoint after
 * each statement splits it for tools that send one statement per query.
 */
export function postgresSchema(): string {
  return `-- The tables of a board on Postgres (@vercel/board/backend-postgres): those that keep
-- its log, then those it reads from, and its files. postgres() applies this
-- itself unless it's given schema: false. Every statement creates only what is missing
-- and leaves existing data alone, so it's safe to re-run.

${A2_POSTGRES_SCHEMA.trimEnd()}${BREAKPOINT}
${[...ddl('postgres'), FILES_DDL].join(`;${BREAKPOINT}`)};
`
}

/** The schema's own version: a database that has it skips applying it. */
export const SCHEMA_VERSION = createHash('sha256').update(postgresSchema()).digest('hex').slice(0, 16)

/** `board_meta`'s key for the schema version applied. */
const SCHEMA_KEY = 'postgres_schema'

/** One lock for every instance applying the schema at once, whatever board: two would race on the catalog. */
const SCHEMA_LOCK = 0x626f617264

/**
 * Applies the schema unless the database has this version of it: one read when it does. It runs in
 * one transaction under an advisory lock, so instances starting together apply it once, and a
 * failure leaves the database as it was.
 */
export async function ensureSchema(pool: PgPool): Promise<void> {
  const applied = async (client: PgQueryable) => {
    // Checked before it's read: a failed read would end the transaction it's in.
    const { rows: present } = await client.query("select to_regclass('board_meta') is not null as present")
    if (present[0]?.present !== true) return false
    const { rows } = await client.query('select value from board_meta where key = $1', [SCHEMA_KEY])
    return rows[0]?.value === SCHEMA_VERSION
  }
  if (await applied(pool)) return
  try {
    await transaction(pool, 'begin', async (client) => {
      await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK])
      // Another instance may have applied it while this one waited.
      if (await applied(client)) return true
      await client.query(postgresSchema())
      await client.query('insert into board_meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [SCHEMA_KEY, SCHEMA_VERSION])
      return true
    })
  } catch (error) {
    if ((error as { code?: unknown }).code === '42501')
      throw new TablesNotConfiguredError(
        "this database role can't create board's tables: apply postgresSchema() as a role that can, and pass postgres({ schema: false })",
        { cause: error },
      )
    throw error
  }
}

/** The tables a board's first calls need, each of A2's, board's, and its files': whether they're all there. */
export async function checkSchema(pool: PgPool): Promise<void> {
  const { rows } = await pool.query("select to_regclass('a2_events') is not null and to_regclass('board_messages') is not null and to_regclass('board_files') is not null as present")
  if (rows[0]?.present !== true) throw new TablesNotConfiguredError("board's tables aren't in this database: apply postgresSchema(), or leave out schema: false")
}
