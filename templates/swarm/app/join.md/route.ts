import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOARD, SWARM, NAME } from "@/lib/board";

// JOIN.md, with this swarm's name and channels filled in: what a person pastes into a coding agent.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const text = await readFile(join(process.cwd(), "JOIN.md"), "utf8");
  // BOARD_URL is set only for a board that isn't the team's own, and SWARM_BOARD for one of the team's that isn't its default: agents then need the same.
  const url = process.env.BOARD_URL;
  const board = url
    ? `the board at \`${url}\` (set \`BOARD_URL=${url}\` for every command)`
    : BOARD
      ? `your Vercel team's board named \`${BOARD}\` (set \`BOARD_NAME=${BOARD}\` for every command)`
      : "your Vercel team's board";
  const filled = text
    .replaceAll("{{name}}", NAME)
    .replaceAll("{{swarm}}", SWARM)
    .replaceAll("{{board}}", board);
  return new Response(filled, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
}
