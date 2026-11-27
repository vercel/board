import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { ddl, type Db, type Sql } from './sql.ts'

/**
 * `$1` → `?`, with the value each `?` takes in `order`. Plain `?`s, not SQLite's `?1`: before
 * 22.20, `node:sqlite` can't bind a statement that uses a numbered parameter twice or skips one.
 */
const positional = (text: string) => {
  const order: number[] = []
  const sql = text.replace(/\$(\d+)/g, (_, n: string) => (order.push(Number(n) - 1), '?'))
  return { sql, order }
}

/** SQLite has no booleans. */
const bind = (value: unknown) => (typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null))

/**
 * The tables on `node:sqlite`, at `path` (`:memory:` works). Every transaction
 * runs synchronously, from `begin` to `commit`: A2's SQLite store, on another
 * handle to the same file, blocks the thread while it waits for the lock, so
 * a transaction of ours that yielded in between would wait on itself.
 */
export function sqliteDb(path: string): Db {
  // Loaded only when used, so a board that never opens SQLite never loads it.
  const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  if (path !== ':memory:') mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), { recursive: true })
  const db: DatabaseSync = new Database(path)
  db.exec('pragma busy_timeout = 5000')
  for (const statement of ddl()) db.exec(statement)

  const statements = new Map<string, { statement: StatementSync; order: number[] }>()
  const run = (query: Sql) => {
    let prepared = statements.get(query.text)
    if (!prepared) {
      const { sql, order } = positional(query.text)
      statements.set(query.text, (prepared = { statement: db.prepare(sql), order }))
    }
    return prepared.statement.all(...(prepared.order.map((at) => bind(query.values[at])) as never[])) as Record<string, unknown>[]
  }
  const rollback = () => {
    try {
      db.exec('rollback')
    } catch {
      // Nothing was open.
    }
  }

  return {
    all: async (query) => run(query),
    async read(queries) {
      db.exec('begin')
      try {
        const rows = queries.map(run)
        db.exec('commit')
        return rows
      } catch (error) {
        rollback()
        throw error
      }
    },
    async commit(claim, writes) {
      db.exec('begin immediate')
      try {
        if (run(claim).length === 0) {
          db.exec('rollback')
          return false
        }
        for (const write of writes) run(write)
        db.exec('commit')
        return true
      } catch (error) {
        rollback()
        throw error
      }
    },
    async close() {
      db.close()
    },
  }
}
