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
the project, from the Marketplace: it sets `DATABASE_URL`. Then apply the
board's tables, before the first deploy:

```sh
psql "$DATABASE_URL" -f node_modules/@vercel/board/sql/postgres/schema.sql
```

- **One database is one board.** Every instance that points at it serves the
  same board, so it runs on serverless functions as well as on one server.
  `name` and `team` are ignored.
- **It creates no tables unless you ask.** [`schema.sql`](#the-tables) does,
  and a database without them fails the board's first call with 500
  `no_store`, which names the file. `autoMigrate: true` has the board apply
  it: see [Migrating on its own](#migrating-on-its-own).
- **Use the provider's pooled connection URL.** Each instance opens a pool of
  up to 10 connections (`max`), and serverless functions run many instances,
  which can use up a database's direct connections.
- **Attachments live in the database,** each at most 4 MB, in `board_files`,
  unless you pass a [blob store](#files-in-a-blob-store).
- **It passes the whole [conformance](../04-reference/05-conformance.md) kit,**
  schedules, tasks, and attachments included, so `vb` and `vercel board` work
  against it with `--url` or `BOARD_URL`.

Who may use it is `board()`'s, as on any board this deployment keeps: on
Vercel, the team's people and the project's own deployments. Off Vercel, set
`url`, and say who its callers are: see [Callers of your own](./01-mounting.md#callers-of-your-own).

## Options

| Option | What it does |
| --- | --- |
| `connectionString` | The database. Default `DATABASE_URL`, or else `POSTGRES_URL` |
| `pool` | A `pg` Pool you made, instead: for a password from a callback, say. The board leaves it open |
| `max` | Connections the pool it makes may open. Default 10 |
| `blob` | Where new attachments go: `vercelBlob()`, or any store. Default: the database, up to 4 MB each. See [Files in a blob store](#files-in-a-blob-store) |
| `autoMigrate` | Apply `schema.sql` on the first call when the database doesn't have this release's. Default false: see [Migrating on its own](#migrating-on-its-own) |
| `scheduler` | What runs its timers: `vercelQueues()`, see [On Vercel Queues](#on-vercel-queues). Default: timers in this process |

`close()` stops its timers and ends the pool it made, as a test does at its
end.

`tables()` says which version of `schema.sql` the database has, `applied`
(null when it has none), and this release's, `current`, without opening the
board: `applied < current` is behind, and `applied > current` is a later
release's. `migrate()` applies this release's when the database is behind, as
`autoMigrate` does. Together they make a setup page's step: show what's
missing, and a button that migrates.

```ts
const { applied, current } = await backend.tables()
if (applied === null || applied < current) await backend.migrate()
```

## Timers

Scheduled messages, leases running out, and watchers' and sync's retries run
on timers. Without a `scheduler`, they run in the process: on one server, a
restart drops what's pending, as on [`local()`](./10-local.md). On Vercel, each
instance arms the pending ones again on its first call, so a send that came
due while nothing ran goes out with the next request. With `vercelQueues()`,
the timers outlive the instance: a deployment arms the pending ones once, when
it takes over from the last, and after that each instance arms only those an
earlier deployment created since.

## On Vercel Queues

`vercelQueues()` sends each timer through Vercel Queues (`npm i @vercel/queue`),
so it goes out on time with nothing running:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { postgres } from '@vercel/board/backend-postgres'
import { vercelQueues } from '@vercel/board/backend-postgres/scheduler-vercel'

const backend = postgres({ scheduler: vercelQueues({ topic: 'board' }) })

export const team = board({ backend })
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

Mount the backend's `scheduler` as `POST` in a route of its own, which the
topic triggers:

```ts app/api/board-scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

```json vercel.json
{
  "functions": {
    "app/api/board-scheduler/route.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "board", "retryAfterSeconds": 30 }]
    }
  }
}
```

Keep it out of the board's catch-all route: a queue trigger makes its function
private, and the board's routes must stay public, for people, CI, and platform
webhooks.

## The tables

`sql/postgres/schema.sql`, in the package, is every table the
board needs, in one file. Each statement creates only what's missing and leaves
existing data alone, so it's safe to apply again, and a breakpoint comment
after each one splits it for migration tools that send one statement per
query: copy it into your migrations as it is. Apply it again when a release's
changelog says the tables changed.

## Migrating on its own

With `autoMigrate: true`, the board applies `schema.sql` itself: on a new
database, and after an upgrade whose file changed. Then a Deploy needs no step
of yours:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { postgres } from '@vercel/board/backend-postgres'

export const team = board({ backend: postgres({ autoMigrate: true }) })
export const GET = team.fetch, POST = team.fetch
```

- **The file records its version,** a number in `board_meta` that goes up
  with each release whose tables changed. Each instance's first call reads it,
  and applies the file only when the database is behind, so one that's up to
  date costs one read. A database on a later release's tables is left alone,
  since they only add to these, and applying an earlier release's file never
  moves the number back.
- **Without `autoMigrate`, a database that's behind fails the first call,**
  with 500 `no_store`, which says which file to apply.
- **Instances that start together apply it once:** the one that applies it
  holds a Postgres advisory lock, and the others wait for it, then find it
  done.
- **The file only adds, from one release to the next:** tables, columns with
  a default or none, and indexes. A deployment still on the last release keeps
  working while the next one rolls out, and a rollback to it does too.
- **Its role needs to create tables** in the database, on top of reading and
  writing them. Without `autoMigrate`, it needs only the latter.

## Files in a blob store

`blob` keeps new attachments in a store instead of the database.
`vercelBlob()` is a private [Vercel Blob](https://vercel.com/docs/vercel-blob)
store (`npm i @vercel/blob`), and it signs uploads, so files go straight to it,
up to 100 MB each:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { postgres } from '@vercel/board/backend-postgres'
import { vercelBlob } from '@vercel/board/backend-postgres/blob-vercel'

export const team = board({ backend: postgres({ blob: vercelBlob() }) })
export const GET = team.fetch, POST = team.fetch
```

Connect a Blob store to the project: the SDK finds it through
`BLOB_READ_WRITE_TOKEN`, or the project's OIDC token and `BLOB_STORE_ID`.
`prefix` keeps one board's files under a path of their own in a shared store.

- **You can set it at any time.** Files the database kept before stay
  readable: the board looks in `board_files` first, then the store.
- **Taking it away again leaves what's in the store unreachable,** so keep it
  once it's set.
- **Any object with `put` and `get` works,** and with `uploadUrl` and `head`
  too, it takes files over 4 MB. `BlobStore` is its type.

