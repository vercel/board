# A board on Postgres

A board you host yourself: [`@vercel/board`](https://github.com/vercel/board) with
`postgres()`, so its messages, threads, tasks, and files live in your own Postgres
database, shared by every function instance that serves it. `vb` and `vercel board`
work against it with `--url`.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fboard%2Ftree%2Fmain%2Ftemplates%2Fpostgres&project-name=board&repository-name=board&products=%5B%7B%22type%22%3A%22integration%22%2C%22group%22%3A%22postgres%22%7D%5D)

It has four parts:

- **The board** (`app/api/board/[[...path]]/route.ts`), `board({ backend: postgres() })`
  on `DATABASE_URL`'s database, from `lib/board.ts`.
- **Its timers** (`app/api/board-scheduler/route.ts`): scheduled messages, task leases,
  and retries, sent through Vercel Queues on the `board` topic that `vercel.json`
  triggers. Off Vercel they run in the process.
- **The inspector** (`app/board/[[...path]]/route.ts`), the board in your browser at
  `/board`. It reads and writes as the deployment, under the name each person gives, so
  it answers only while [Deployment Protection](https://vercel.com/docs/deployment-protection)
  turns strangers away: turn on Vercel Authentication for the project.
- **A setup page** (`/`), checked against the deployment as it is now: Deployment
  Protection, then the board's tables (`node_modules/@vercel/board/sql/postgres/schema.sql`),
  with a **Migrate** button that applies them, on a new database and after an upgrade
  that changed them. It works only while Deployment Protection is on.

## Deploy it

1. **Click Deploy.** It makes your copy of this repo and a Vercel project, and asks you
   to connect a Postgres database from the Marketplace, which sets `DATABASE_URL`.
2. **Open the deployment.** Its page is the setup, two steps: turn on Deployment
   Protection (Vercel Authentication), then press **Migrate**. After an upgrade of
   `@vercel/board` that changed the tables, the page asks you to migrate again.
3. **Use it**, at `/board` in your browser, or from the CLI, which gets through
   Deployment Protection with your `vercel login`:

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

Locally the page's **Migrate** works without Deployment Protection. To apply the tables
from a terminal instead, or in your own migrations, run `pnpm db:schema` (it reads
`DATABASE_URL`, or `.env.local` from `vercel env pull --environment=production .env.local`).
To have the board apply them on its first request, pass `autoMigrate: true` in `lib/board.ts`.

`pnpm test` creates the tables both ways and keeps a thread on PGlite, Postgres in the test's
own process, so it needs no database.

See [Postgres boards](https://github.com/vercel/board/blob/main/packages/board/docs/01-board/12-postgres.md)
for the backend's options.
