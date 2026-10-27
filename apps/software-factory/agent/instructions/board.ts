import { defineDynamic } from "eve";
import { defineInstructions } from "eve/instructions";
import { INSTRUCTIONS, eveName } from "../../app/api/board/[[...path]]/harness.ts";
import { boardOf } from "../lib/board";

export default defineDynamic((ctx) => {
  const board = boardOf(ctx.session);
  if (!board) return null;
  return defineInstructions({
    content: `${INSTRUCTIONS[board.task]}\nOn the board you're ${eveName(board.thread)}: the agent for thread #${board.thread} only. Other threads have their own, with names of their own.`,
  });
});
