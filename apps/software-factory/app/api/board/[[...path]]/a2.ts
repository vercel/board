import { redisHttp } from "@vercel/board/backend-a2/store-redis-http";
import { vercelQueues } from "@vercel/board/backend-a2/scheduler-vercel";

// The factory's store and queue: A2's log and the board's tables on the project's Upstash, under one
// prefix. Locally there's no VERCEL_ENV, so it's SQLite at .a2/dev.db, loaded only there.
const env = process.env.VERCEL_ENV;

export const store = env
  ? redisHttp({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
      // One Redis serves every environment: a preview never touches production's log.
      keyPrefix: env === "production" ? "board-factory" : `board-factory:${env}`,
    })
  : (await import("@vercel/board/backend-a2/store-sqlite")).sqlite();

export const queues = vercelQueues({ topic: "vboard-factory" });
