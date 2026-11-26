// A board on Postgres, which `@vercel/board/backend-postgres` exports: on the board's log and its
// engine, as `local()` is, with its log, tables, and files in one database.
import pg from 'pg'
import { a2 } from './a2.ts'
import type { Backend, BoardBinding, Caller, ProtocolMethods, Trust } from './backend.ts'
import { HttpError } from './errors.ts'
import { METHODS } from './routing.ts'
import { localScheduler } from '../scheduler/local.ts'
import { checkSchema, ensureSchema, type PgPool } from '../store/postgres-db.ts'
import { postgresBlob, postgresStore } from '../store/postgres.ts'

export type PostgresOptions = {
  /**
   * The database, as a connection string: `DATABASE_URL`, or else `POSTGRES_URL`, by default, which
   * a Postgres database connected to a Vercel project sets. Leave it out when you pass `pool`.
   */
  connectionString?: string
  /** A `pg` Pool you made, for a password from a callback, say. The board uses it and leaves it open. */
  pool?: PgPool
  /** Connections the pool it makes may open. Default 10. */
  max?: number
  /**
   * Whether it applies its tables, `postgresSchema()`, on its first call, when the database doesn't
   * have this release's: true by default. False when a migration of yours applies them.
   */
  schema?: boolean
}

/** A board on Postgres. `close()` stops its timers and ends the pool it made. */
export type PostgresBackend = Backend & {
  /** Stops its timers, and ends the pool if it made it. What's still to send stays in the database. */
  close(): Promise<void>
}

/** Why the database couldn't be reached or set up, in a few words. */
const unreachable = (error: unknown) => String((error as { message?: unknown }).message ?? error).split('\n')[0]!

/**
 * A board on Postgres (`npm i pg`): its log, its tables, and its files in one database, which any
 * number of instances share. It applies its tables on its first call, and keeps one board, whatever
 * `board({ name })` says.
 */
export function postgres(options: PostgresOptions = {}): PostgresBackend {
  let binding: BoardBinding | null = null
  let made: pg.Pool | null = null
  let opening: Promise<{ backend: ReturnType<typeof a2>; close(): Promise<void> }> | null = null

  function poolOf(): PgPool {
    if (options.pool) return options.pool
    const connectionString = options.connectionString ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL
    if (!connectionString) throw new HttpError(500, 'no_store', 'postgres: no database: pass connectionString, or set DATABASE_URL')
    made = new pg.Pool({ connectionString, max: options.max ?? 10 })
    // A connection the server closes (a restart, a database that scales to zero) is reported here;
    // unheard, it ends the process. The query it cut off fails on its own.
    made.on('error', () => {})
    return made as unknown as PgPool
  }

  /** The board, opened on its first use: binding does no I/O. One that didn't open is tried again on the next call. */
  function open() {
    if (!binding) throw new Error("postgres: this backend isn't serving a board yet: pass it to board({ backend })")
    const bound = binding
    opening ??= (async () => {
      const pool = poolOf()
      try {
        // A database without this release's tables gets them, or, with schema: false, says so.
        await (options.schema === false ? checkSchema(pool) : ensureSchema(pool))
      } catch (error) {
        throw new HttpError(500, 'no_store', `postgres: ${unreachable(error)}`)
      }
      const store = postgresStore(pool)
      // Timers in this process: scheduled messages, leases running out, and retries of watchers and
      // sync. What was due while no instance ran, the next one to start catches up on.
      const scheduler = localScheduler()
      const backend = a2({ store, scheduler, blob: postgresBlob(pool) })
      backend.bind(bound)
      return {
        backend,
        async close() {
          // Its timers first: one that fired after would run against a closed pool.
          scheduler.stop()
          await store.close()
        },
      }
    })()
    opening.catch(async () => {
      opening = null
      const failed = made
      made = null
      await failed?.end().catch(() => {})
    })
    return opening
  }

  const methods = Object.fromEntries(
    METHODS.map((name) => [name, async (caller: Caller, input: never, signal: AbortSignal) => ((await open()).backend[name] as (...args: unknown[]) => unknown)(caller, input, signal)]),
  ) as unknown as ProtocolMethods

  return {
    ...methods,
    routes: [],
    // The board lives here: board() lets its people and own deployments in by default.
    keeps: true,
    trust: {
      grants: async () => (await open()).backend.trust.grants(),
    } satisfies Trust,
    bind(given: BoardBinding) {
      if (binding) throw new Error('postgres: this backend already serves a board: create one postgres() per board()')
      binding = given
    },
    async close() {
      const opened = opening
      opening = null
      const board = opened && (await opened.catch(() => null))
      await board?.close()
      const ending = made
      made = null
      await ending?.end()
    },
  }
}
