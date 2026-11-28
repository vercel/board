import { board } from "@vercel/board";
import { postgres } from "@vercel/board/backend-postgres";
import { vercelQueues } from "@vercel/board/backend-postgres/scheduler-vercel";

// The board's log, tables, and files, in DATABASE_URL's database (or POSTGRES_URL's). autoMigrate
// applies the package's schema.sql on the first request when the database doesn't have this
// release's; turn it off to apply it yourself, with `pnpm db:schema` or your migrations.
// On Vercel, its timers go through Vercel Queues; anywhere else, they run in this process.
export const backend = postgres({
  autoMigrate: true,
  ...(process.env.VERCEL ? { scheduler: vercelQueues({ topic: "board" }) } : {}),
});

export const team = board({ backend });
