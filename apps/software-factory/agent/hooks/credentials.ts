import { defineHook } from "eve/hooks";
import { boardOf } from "../lib/board";
import { give } from "../lib/credentials";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const board = boardOf(ctx.session);
      if (board) await give(ctx, board, { force: true });
    },
  },
});
