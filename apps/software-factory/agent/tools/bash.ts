import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";
import { boardOf } from "../lib/board";
import { give } from "../lib/credentials";

// eve's bash, renewing the sandbox's credentials first when they're near their end.
export default defineTool({
  ...bash,
  async *execute(input, ctx) {
    const board = boardOf(ctx.session);
    if (board) await give(ctx, board);
    const output = await bash.execute(input, ctx);
    if (Symbol.asyncIterator in Object(output)) yield* output as AsyncIterable<never>;
    else yield output as never;
  },
});
