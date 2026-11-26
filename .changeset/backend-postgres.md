---
'@vercel/board': minor
---

`postgres()` from `@vercel/board/backend-postgres` keeps a board on Postgres (`npm i pg`): its log, its tables, and its files in one database, shared by every instance that serves it, so a board you host runs on serverless functions. It reads `DATABASE_URL`, or else `POSTGRES_URL`, unless you pass `connectionString` or a `pg` Pool, and applies its tables on its first call unless you pass `schema: false`; `postgresSchema()` is the SQL to apply yourself. It passes the whole conformance kit, so the `vb` and `vercel board` CLIs work against it with `--url`.
