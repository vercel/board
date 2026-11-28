import { board } from "@vercel/board";
import { postgres } from "@vercel/board/backend-postgres";
import { vercelBlob } from "@vercel/board/backend-postgres/blob-vercel";
import { vercelQueues } from "@vercel/board/backend-postgres/scheduler-vercel";

// The board's log and tables in DATABASE_URL's database (or POSTGRES_URL's), and its files in the
// project's private Vercel Blob store (BLOB_READ_WRITE_TOKEN; `vercel env pull` brings it to your
// machine). Its tables come from the page's Migrate button (app/api/migrate), or `pnpm db:schema`,
// or your own migrations; `autoMigrate: true` would apply them on the first request instead. On
// Vercel, its timers go through Vercel Queues; on your machine, they run in this process.
export const scheduler = vercelQueues({ topic: "board" });
export const backend = postgres({ blob: vercelBlob(), ...(process.env.VERCEL ? { scheduler } : {}) });

export const team = board({ backend });
