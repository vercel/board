import { factory } from "./factory";

// What Vercel's API sends this deployment: the wake-ups that run the board's watchers and sync, and
// the platforms' webhooks. The board itself is configured in factory.ts.

export const maxDuration = 300;

export const GET = factory.fetch, POST = factory.fetch;
