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

/**
 * `sql/postgres/schema.sql`: `a2`, the bundled A2 release's schema.sql, whose tables keep the log,
 * then board's tables and its files, so a database needs one file.
 */
export function postgresSchemaSql(a2: string): string {
  return `-- The tables of a board on Postgres (@vercel/board/backend-postgres): those that keep
-- its log, then those it reads from, and its files. Apply this file before the first
-- deploy, and again when a board release says the tables changed. Every statement
-- creates only what is missing and leaves existing data alone, so it's safe to re-run.
-- The breakpoint after each statement splits it for migration tools that send one
-- statement per query; to every other tool it's only a comment.

${a2.trimEnd()}${BREAKPOINT}
${[...ddl('postgres'), FILES_DDL].join(`;${BREAKPOINT}`)};
`
}

/** Whether the tables a board's first calls need are there: the log's, board's, and its files'. */
export async function checkSchema(pool: PgPool): Promise<void> {
  const { rows } = await pool.query("select to_regclass('a2_events') is not null and to_regclass('board_messages') is not null and to_regclass('board_files') is not null as present")
  if (rows[0]?.present !== true) throw new TablesNotConfiguredError(`board's tables aren't in this database: apply ${SCHEMA_FILE}`)
}
