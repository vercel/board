import { contract } from "experimental-a2";
import { createServer, type A2Scheduler, type A2Store } from "experimental-a2/server";
import { z } from "zod";

// Pi's OIDC tokens (AI Gateway's, and the board's, exchanged from it) die when the function's own does. Vercel
// reuses a function's token for up to 90 minutes of its 2 hours, so a message can hand Pi tokens with 30 minutes
// left, while its session runs at least 45 more: a long turn would lose its model and its board partway through.
// In production @vercel/oidc can't ask for a newer token, so when Pi's die before its session does, a timer puts
// new ones in its sandbox's policy first.

/** How long before Pi's tokens die they're replaced: in their last 30 minutes, when functions get a new one. */
export const REFRESH_LEAD_MS = 15 * 60_000;
/** The soonest a refresh runs again, should it get the same tokens. */
const RETRY_MS = 60_000;

/** When to give Pi new tokens, if the ones it has die at `tokensEnd`, before its session ends at `sessionEnd`. */
export function refreshAt(tokensEnd: number, sessionEnd: number, now: number): Date | null {
  if (tokensEnd >= sessionEnd) return null;
  return new Date(Math.max(tokensEnd - REFRESH_LEAD_MS, now + RETRY_MS));
}

/** When a JWT expires, in epoch milliseconds. */
export function expiresAt(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).exp * 1000;
}

/** When the tokens Pi was just given die, and when its session ends; null when its sandbox isn't running. */
export type Given = { tokensEnd: number; sessionEnd: number } | null;

const tokens = contract({
  name: "factory-pi-tokens",
  events: { "tokens.expiring": z.object({ thread: z.number().int().positive() }) },
});

/** Refreshes of Pi's tokens: `later` arms one after Pi gets tokens, and `give` hands it new ones when it fires. */
export function tokenRefreshes(options: {
  store?: A2Store | undefined;
  scheduler: A2Scheduler;
  give: (thread: number) => Promise<Given>;
}) {
  const server = createServer({
    contract: tokens,
    ...(options.store ? { store: options.store } : {}),
    scheduler: options.scheduler,
    handlers: {
      "tokens.expiring": async ({ event }) => {
        const { thread } = event.payload;
        let given: Given;
        try {
          given = await options.give(thread);
        } catch (error) {
          // The next message brings new tokens anyway. A throw would retry, then dead-letter the thread's timers.
          console.error(`[factory] couldn't refresh Pi's tokens on board thread #${thread}:`, error);
          return;
        }
        if (given) await later(thread, given);
      },
    },
  });

  async function later(thread: number, given: NonNullable<Given>) {
    const at = refreshAt(given.tokensEnd, given.sessionEnd, Date.now());
    if (!at) return;
    // Named for when it fires: messages that hand Pi the same tokens arm one refresh.
    await server
      .session(`thread-${thread}`)
      .schedule(`refresh-${at.getTime()}`, { at }, { type: "tokens.expiring", payload: { thread } });
  }

  return { server, later };
}
