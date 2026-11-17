import { defineHook } from "eve/hooks";
import { threadOf } from "../lib/board";
import { give } from "../lib/credentials";

// Fresh tokens in the sandbox's network policy at every turn's start.
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const thread = threadOf(ctx.session);
      if (thread) await give(ctx, thread, { force: true });
    },
  },
});
