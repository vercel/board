import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { BOARD, eveName, policy } from "../../app/api/board/[[...path]]/harness.ts";
import { CONNECTOR } from "../../app/api/board/[[...path]]/github.ts";
import { expiresAt, stale } from "../../app/api/board/[[...path]]/tokens.ts";
import { environment } from "../sandbox";
import type { Board } from "./board";

// Real credentials go in the sandbox's network policy, never in the sandbox.

const GITHUB_MS = 30 * 60_000;
const GIT_EMAIL = "pi@vboard-factory.playground-vercel.tools";

const given = defineState("factory.credentials", () => ({ until: 0 }));

/** Puts fresh tokens and git's identity in the sandbox: always with `force` (each turn's start, which also covers a sandbox eve recreated), else when they're near their end. */
export async function give(ctx: Pick<ToolContext, "getSandbox">, board: Board, { force = false } = {}) {
  const now = Date.now();
  if (!force && !stale(given.get().until, now)) return;
  const sandbox = await ctx.getSandbox(environment);
  const [{ getToken }, { getVercelOidcToken }] = await Promise.all([import("@vercel/connect"), import("@vercel/oidc")]);
  const [gateway, boardToken, github] = await Promise.all([
    getVercelOidcToken(),
    getVercelOidcToken({ audience: BOARD }),
    getToken(CONNECTOR, { subject: { type: "app" }, validityBufferMs: GITHUB_MS }),
  ]);
  const tokens = { gateway, board: boardToken, github };
  await sandbox.setNetworkPolicy(policy(board.thread, tokens, process.env.VERCEL_AUTOMATION_BYPASS_SECRET) as SandboxNetworkPolicy);
  const git = await sandbox.run({
    command: `git config --global user.name ${JSON.stringify(eveName(board.thread))} && git config --global user.email ${GIT_EMAIL}`,
  });
  if (git.exitCode !== 0) throw new Error(`git config failed: ${git.stderr.slice(-300)}`);
  given.update(() => ({ until: Math.min(expiresAt(gateway), expiresAt(boardToken), now + GITHUB_MS) }));
}
