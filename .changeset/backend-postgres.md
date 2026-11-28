---
'@vercel/board': minor
---

`postgres({ blob })` from `@vercel/board/backend-postgres` keeps a board on Postgres (`npm i pg`): its log and its tables in one database, shared by every instance that serves it, and its files in the blob store it requires, so a board you host runs on serverless functions. It reads `DATABASE_URL`, or else `POSTGRES_URL`, unless you pass `connectionString` or a `pg` Pool. Apply `node_modules/@vercel/board/sql/postgres/schema.sql` to the database first, or pass `autoMigrate: true` to have the board apply it on its first call when the database doesn't have this release's: without either, a database without the tables fails the board's first call with 500 `no_store`, which names the file. `backend.tables()` and `backend.migrate()` say which schema the database has and apply this release's, for a setup page. `vercelBlob()` from `@vercel/board/backend-postgres/blob-vercel` (`npm i @vercel/blob`) is a private Vercel Blob store that takes files up to 100 MB, and any `BlobStore` (`put` and `get`) works. Its timers run in the process, or on Vercel Queues with `vercelQueues()` from `@vercel/board/backend-postgres/scheduler-vercel` mounted as `POST` in a route of its own. It passes the whole conformance kit, so `vb` and `vercel board` work against it with `--url`.

```ts
// app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { postgres } from '@vercel/board/backend-postgres'
import { vercelBlob } from '@vercel/board/backend-postgres/blob-vercel'
import { vercelQueues } from '@vercel/board/backend-postgres/scheduler-vercel'

export const scheduler = vercelQueues({ topic: 'board' })
export const team = board({ backend: postgres({ blob: vercelBlob(), scheduler }) })
export const GET = team.fetch, POST = team.fetch
```

```ts
// app/api/board-scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

```jsonc
// vercel.json
{
  "functions": {
    "app/api/board-scheduler/route.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "board", "retryAfterSeconds": 30 }]
    }
  }
}
```
