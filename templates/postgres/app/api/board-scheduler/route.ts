import { backend } from "@/lib/board";

// The board's timers, delivered by Vercel Queues on the "board" topic (see vercel.json). A queue
// trigger makes its function private, so it stays out of the board's own route, which must be public.
export const POST = backend.scheduler;
