---
title: Mounting
description: One `board()` call in one route gives you the log, the HTTP API, and everything the CLI and SDK talk to.
---

## One route

```package-install
npm i vboard experimental-a2
```

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'

export const { GET, POST } = board()
```

That's a board. It answers at `/api/board`, and the CLI points at it with
`VBOARD_URL` or `vb link`. Call `board()` once, at module scope.

A board is one log in one route of one Vercel project. The mount path is yours:
the board infers it from requests. To get a second board (one the project's
own people can't all read, say), mount a second route.

## Options

| Option | What it does |
| --- | --- |
| `store` | Any A2 store: `postgres()`, `redis()`, `redisHttp()`, SQLite. See [defaults](#defaults-by-environment) |
| `blob` | Where [attachments](./03-messages.md#attachments) live: `vercelBlob()` from `vboard/adapter-vercel-blob` |
| `scheduler` | An A2 scheduler, for sync, watchers, and scheduled messages: `vercelQueues()` or `qstash()` |
| `sync` | Two-way sync, keyed by a name you choose: `{ slack: slack({…}) }`. See [Sync](../02-sync/01-overview.md) |
| `watch` | Tails the board runs for you, keyed by id: `{ triage: { tail, run } }`. See [Watchers](./05-watchers.md) |
| `access` | Who besides the board's people and its production may call it, and what each may do in each channel: `vercelProject()`, `githubActions()`, `oidc()`. See [Access](./08-access.md) |
| `project` | `{ id, teamId? }`: the board's Vercel project. Defaults to `VERCEL_PROJECT_ID`, then `.vercel/project.json`. The team scopes `vercelProject()` rules named without one |
| `url` | The board's public URL, which every token's audience must equal. Inferred from requests otherwise |
| `basePath` | The mount path, e.g. `/api/board`. Inferred from requests otherwise |
| `streamMaxMs` | How long an SSE stream stays open before the board closes it and the client reconnects. Default `280000` |
| `auth` | Test issuers, for tests only. Production verifies against Vercel's and GitHub's |

Set `url` when the board sits behind a proxy or rewrite that changes the
origin it sees, so the audience it checks matches the one clients mint for.
Clients then use that URL: the Node client mints for the URL it talks to, and
refuses one whose discovery names another.

## A production board

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { vercelBlob } from 'vboard/adapter-vercel-blob'
import { redisHttp } from 'experimental-a2/store-redis-http'
import { vercelQueues } from 'experimental-a2/scheduler-vercel'

// SSE streams close just before this, and clients reconnect where they left off.
export const maxDuration = 300

export const { GET, POST, scheduler, client } = board({
  store: redisHttp({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! }),
  blob: vercelBlob(),
  scheduler: vercelQueues({ topic: 'vboard' }),
})
```

`vercelBlob()` needs `@vercel/blob` installed and a private Blob store
connected to the project. It finds the store through `BLOB_READ_WRITE_TOKEN`,
or the project's OIDC token and `BLOB_STORE_ID`.

## The scheduler route

Mount the `scheduler` that `board()` returns as `POST` in a route of its own:

```ts app/api/a2/scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

```json vercel.json
{
  "functions": {
    "app/api/a2/scheduler/route.ts": {
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "vboard", "retryAfterSeconds": 30 }
      ]
    }
  }
}
```

Keep it out of the board's catch-all route. A Vercel Queues trigger makes its
function private, and the board's routes must stay public: people, CI, and
platform webhooks all call them.

The scheduler serves every A2 server behind the board: the log, the sync inbox,
watchers, and schedules. To share one scheduler with A2 servers of your own,
pass the same scheduler to `board()` and to them, and hand the board's
`servers` to its handler yourself:

```ts lib/queue.ts
import { vercelQueues } from 'experimental-a2/scheduler-vercel'

// One scheduler for the board (`board({ store, scheduler: queue })`) and your own A2 servers.
export const queue = vercelQueues({ topic: 'vboard' })
```

```ts
// app/api/a2/scheduler/route.ts, with the queue shared:
import { queue } from '@/lib/queue'
import { servers } from '@/app/api/board/[[...path]]/route'
// import { ordersServer } from '@/server/orders'   // yours, created with the same queue

export const POST = queue.handler(...servers /*, ordersServer */)
```

## What `board()` returns

| Name | What it is |
| --- | --- |
| `GET`, `POST` | The board's fetch handlers. Export both from the route |
| `fetch` | The same handler, for runtimes that take one function |
| `scheduler` | The scheduler's callback, for its own route. A board without a scheduler answers 404 there |
| `servers` | The A2 servers behind the board, to pass to a shared scheduler |
| `client(name, { key })` | An in-process client for your own server code |

## The in-process client

Your own routes can write to the board without a URL or a token:

```ts app/api/deploys/route.ts
import { client } from '@/app/api/board/[[...path]]/route'

export async function POST(request: Request) {
  const delivery = (await request.json()) as { id: string; sha: string }
  // here's where you'd verify the sender, or any other checks
  await client('deploys', { key: delivery.id }).post('deploys', `${delivery.sha} is live`)
  return Response.json({ ok: true })
}
```

- **It writes as `vboard:client:<name>`,** with the name as its handle. Names
  use lowercase letters, numbers, `-`, and `_`.
- **A `key` makes its posts idempotent.** The same key and the same order of
  posts never post twice, so a redelivered webhook does nothing. Use the
  delivery's own ID.
- **Its writes are ordinary writes.** They wake [watchers](./05-watchers.md)
  and [sync](../02-sync/01-overview.md) like anyone's.
- It's the same client `createClient` returns; see the
  [client reference](../04-reference/02-client.md).

## Discovery

`GET` on the mount is unauthenticated. Clients read it to learn which Vercel
project to mint a token for:

```bash
curl https://www.example.com/api/board
```

```json
{
  "version": "0.5.2",
  "url": "https://www.example.com/api/board",
  "audience": "https://www.example.com/api/board",
  "team_id": "team_a1b2c3",
  "project_id": "prj_d4e5f6",
  "sync": [{ "key": "slack", "platform": "slack" }]
}
```

The board knows its project from the `project` option, `VERCEL_PROJECT_ID` on
Vercel, or `.vercel/project.json` locally. Run `vercel link` in the app once,
so a local board can verify the development tokens people send it.

## Defaults by environment

What the board uses when you leave an option out:

| Option | Development | Tests | Production |
| --- | --- | --- | --- |
| `store` | SQLite at `.a2/dev.db` | memory | an error at startup |
| `blob` | files in `.a2/attachments` | memory | none: uploads answer `no_blob_store`, and the rest of the board works |
| `scheduler` | none | none | none |

Development state survives restarts. Sync and watchers need a scheduler in
production. [Scheduled messages](./06-schedules.md) need one everywhere: without
it, scheduling answers 501.

## Production checklist

- **A store.** Postgres or Redis. A board without one doesn't start.
- **A blob store,** if anyone attaches files: `blob: vercelBlob()`.
- **A scheduler,** if you use sync, watchers, or scheduled messages, mounted in
  [its own route](#the-scheduler-route) with its queue trigger.
- **A long enough function.** Live tails hold an SSE stream open for
  `streamMaxMs` (280 seconds by default). Set `maxDuration` to 300 on the
  board's route, or lower `streamMaxMs` below your limit.
- **Deployment Protection.** If Vercel Authentication protects the
  deployment, the CLI says so:
  `error: <url> is behind Vercel Deployment Protection; set VERCEL_AUTOMATION_BYPASS_SECRET (…)`.
  Set `VERCEL_AUTOMATION_BYPASS_SECRET` to the project's Protection Bypass for
  Automation secret; the CLI and Node SDK send it as `x-vercel-protection-bypass`.
  Webhooks need a way through too; Vercel Connect forwards them through
  protection.
- **Access.** Access to the board is access to its Vercel project: everyone
  who should post needs it. See [Identity](./02-identity.md).
