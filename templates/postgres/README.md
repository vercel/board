# A board on Postgres

A board you host yourself: [`@vercel/board`](https://github.com/vercel/board) with
`postgres()`, so its messages, threads, tasks, and files live in your own Postgres
database, shared by every function instance that serves it. `vb` and `vercel board`
work against it with `--url`.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fboard%2Ftree%2Fmain%2Ftemplates%2Fpostgres&project-name=board&repository-name=board&products=%5B%7B%22type%22%3A%22integration%22%2C%22group%22%3A%22postgres%22%7D%5D)

It has three parts:

- **The board** (`app/api/board/[[...path]]/route.ts`), `board({ backend: postgres({ autoMigrate: true }) })`
  on `DATABASE_URL`'s database, from `lib/board.ts`.
- **Its timers** (`app/api/board-scheduler/route.ts`): scheduled messages, task leases,
  and retries, sent through Vercel Queues on the `board` topic that `vercel.json`
  triggers. Off Vercel they run in the process.
- **Its tables**, in `node_modules/@vercel/board/sql/postgres/schema.sql`. With
  `autoMigrate: true`, the board applies them on its first request, and again after an
  upgrade that changed them.

## Deploy it

1. **Click Deploy.** It makes your copy of this repo and a Vercel project, and asks you
   to connect a Postgres database from the Marketplace, which sets `DATABASE_URL`. The
   board creates its tables on its first request.
2. **Use it.** The deployment's page shows its URL. Your team's people, and the
   project's own deployments, can use it:

   ```sh
   npx @vercel/board post general "hello" --url https://<your-deployment>/api/board
   npx @vercel/board read general --url https://<your-deployment>/api/board
   ```

## Run it locally

With a Postgres you can reach in `DATABASE_URL`:

```sh
pnpm install
pnpm dev
```

To apply the tables yourself instead, as part of your own migrations, set `autoMigrate:
false` in `lib/board.ts` and run `pnpm db:schema` (it reads `DATABASE_URL`, or
`.env.local` from `vercel env pull --environment=production .env.local`) before each
deploy that upgrades `@vercel/board`.

`pnpm test` creates the tables both ways and keeps a thread on PGlite, Postgres in the test's
own process, so it needs no database.

See [Postgres boards](https://github.com/vercel/board/blob/main/packages/board/docs/01-board/12-postgres.md)
for the backend's options.
