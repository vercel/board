import { board } from "@vercel/board";
import { postgres } from "@vercel/board/backend-postgres";
import { vercelQueues } from "@vercel/board/backend-postgres/scheduler-vercel";

// The board's log, tables, and files, in DATABASE_URL's database (or POSTGRES_URL's), with
// node_modules/@vercel/board/sql/postgres/schema.sql applied: `pnpm db:schema`.
// On Vercel, its timers go through Vercel Queues; anywhere else, they run in this process.
export const backend = postgres(process.env.VERCEL ? { scheduler: vercelQueues({ topic: "board" }) } : {});

export const team = board({ backend });
