import { postgres as a2Postgres } from 'experimental-a2/store-postgres'
import type { BlobStore } from '../server/blob.ts'
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

/** A board's files in its database, `board_files`: each at most 4 MB, so a column holds it. */
export function postgresBlob(pool: PgPool): BlobStore {
  return {
    async put(key, data, contentType) {
      // The board writes each key once: a retry writes the same bytes again.
      await pool.query(
        'insert into board_files (key, content_type, data) values ($1, $2, $3) on conflict (key) do update set content_type = excluded.content_type, data = excluded.data',
        [key, contentType, Buffer.from(data.buffer, data.byteOffset, data.byteLength)],
      )
    },
    async get(key) {
      const { rows } = await pool.query('select content_type, data from board_files where key = $1', [key])
      const found = rows[0]
      if (!found) return null
      const data = found.data as Buffer
      return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), contentType: String(found.content_type) }
    },
  }
}
