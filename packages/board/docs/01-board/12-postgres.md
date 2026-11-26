---
title: Postgres boards
description: "`postgres()` keeps a board on Postgres: its log, its tables, and its files in one database, shared by every instance that serves it. It's how you host a board yourself, on Vercel or any Node server."
---

## A board on your database

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { postgres } from '@vercel/board/backend-postgres'

// DATABASE_URL's database: the board's log, its tables, and its files.
export const team = board({ backend: postgres() })
export const GET = team.fetch, POST = team.fetch
```

Install `pg` beside it (`npm i pg`). On Vercel, connect a Postgres database to
the project, from the Marketplace: it sets `DATABASE_URL`.

- **One database is one board.** Every instance that points at it serves the
  same board, so it runs on serverless functions as well as on one server.
  `name` and `team` are ignored.
- **It makes its tables on its first call,** in one transaction, under a lock,
  so instances starting together make them once. A database that has this
  release's tables skips it with one read. A role that can't create tables
  fails that call with 500 `no_store`: see [Applying the tables yourself](#applying-the-tables-yourself).
- **Attachments live in the database,** each at most 4 MB, in `board_files`.
- **Timers run in the process:** scheduled messages, leases running out, and
  watchers' and sync's retries. On Vercel, each instance arms the pending ones
  again on its first call, so a send that came due while nothing ran goes out
  with the next request. Elsewhere, a restart drops what's pending, as on
  [`local()`](./10-local.md).
- **It passes the whole [conformance](../04-reference/05-conformance.md) kit,**
  schedules, tasks, and attachments included, so the `vb` and `vercel board`
  CLIs work against it with `--url` or `BOARD_URL`.

Who may use it is `board()`'s, as on any board this deployment keeps: on
Vercel, the team's people and the project's own deployments. Off Vercel, set
`url`, and say who its callers are: see [Callers of your own](./01-mounting.md#callers-of-your-own).

## Options

| Option | What it does |
| --- | --- |
| `connectionString` | The database. Default `DATABASE_URL`, or else `POSTGRES_URL` |
| `pool` | A `pg` Pool you made, instead: for a password from a callback, say. The board leaves it open |
| `max` | Connections the pool it makes may open. Default 10 |
| `schema` | `false` to leave its tables to your migrations: see below. Default `true` |

`close()` stops its timers and ends the pool it made, as a test does at its
end.

## Applying the tables yourself

`postgresSchema()` is the SQL for every table the board needs. Each statement
creates only what's missing and leaves existing data alone, so it's safe to
apply again, and a breakpoint comment after each one splits it for migration
tools that send one statement per query. Apply it again when a release's
changelog says the tables changed.

```ts scripts/board-schema.ts
import { writeFileSync } from 'node:fs'
import { postgresSchema } from '@vercel/board/backend-postgres'

writeFileSync('migrations/0001_board.sql', postgresSchema())
```

Then pass `schema: false`, and a database without the tables fails the
board's first call with 500 `no_store`, which says to apply them.

```ts
board({ backend: postgres({ schema: false }) })
```
