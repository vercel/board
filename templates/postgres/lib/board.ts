import { board } from "@vercel/board";
import { fsBlob, postgres } from "@vercel/board/backend-postgres";
import { vercelBlob } from "@vercel/board/backend-postgres/blob-vercel";
import { vercelQueues } from "@vercel/board/backend-postgres/scheduler-vercel";

// The board's log and tables in DATABASE_URL's database (or POSTGRES_URL's), and its files in the
// project's Vercel Blob store. Its tables come from the page's Migrate button (app/api/migrate), or
// `pnpm db:schema`, or your own migrations; `autoMigrate: true` would apply them on the first
// request instead. On Vercel, its timers go through Vercel Queues; on your machine, they run in
// this process and files stay under .board/files.
export const backend = process.env.VERCEL
  ? postgres({ blob: vercelBlob(), scheduler: vercelQueues({ topic: "board" }) })
  : postgres({ blob: fsBlob(".board/files") });

export const team = board({ backend });
