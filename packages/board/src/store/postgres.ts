import { postgres as a2Postgres } from 'experimental-a2/store-postgres'
import { checkout, postgresDb, type PgPool } from './postgres-db.ts'
import { sqlTables } from './sql.ts'
import type { BoardStore } from './types.ts'

/** A board's log and tables in one Postgres database, on `pool`, which closing the store leaves open. */
export function postgresStore(pool: PgPool): BoardStore {
  // A2 ends a client it's given when its store closes: this one has no end(), so the pool stays its owner's.
  // The connections it holds for its own transactions are heard too: see `checkout`.
  const log = a2Postgres({ client: { query: (text, values) => pool.query(text, values), connect: () => checkout(pool) } })
  const tables = sqlTables(postgresDb(pool))
  return {
    log,
    tables,
    async close() {
      await tables.close()
      await log.close()
    },
  }
}

