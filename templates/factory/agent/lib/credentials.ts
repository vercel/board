import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { githubScope, threadRepos } from "../../lib/github";
import { environment } from "../sandbox";
import { connectors, factory, repoChannels, serviceChannels } from "../../app/api/board/[[...path]]/factory.ts";
import { NAME } from "./identity.ts";
import { policy } from "./policy.ts";
import { threadServices } from "./services.ts";
import { agentBoard } from "./vb-tool.ts";
import { stale } from "./tokens";

const GITHUB_MS = 30 * 60_000;
const GIT_EMAIL = `${NAME}@users.noreply.github.com`;

/** A thread's first message, or null when it couldn't be read. */
type Root = Awaited<ReturnType<ReturnType<typeof agentBoard>["thread"]>>["message"] | null;

/**
 * A GitHub token for this thread's repos only (`threadRepos`), among the ones the board brings in:
 * code run from one repo's PR can't reach the others. Null without a repo.
 */
async function githubToken(getToken: typeof import("@vercel/connect").getToken, thread: string, root: Root) {
  if (!root) {
    console.warn(`[factory] couldn't read thread ${thread}, so the agent can't reach GitHub this turn`);
    return null;
  }
  const repos = threadRepos(root, Object.keys(repoChannels));
  const scope = githubScope(repos);
  if (!scope) {
    console.warn(`[factory] no repo to scope a GitHub token to for thread ${thread} (repoChannels in factory.ts), so the agent can't reach GitHub this turn`);
    return null;
  }
  return getToken(connectors.github, { subject: { type: "app" }, validityBufferMs: GITHUB_MS, authorizationDetails: scope }).catch((error: unknown) => {
    console.warn(`[factory] no GitHub token from ${connectors.github} for ${repos.join(", ")}, so the agent can't reach GitHub this turn:`, error);
    return null;
  });
}

const given = defineState("factory.credentials", () => ({ until: 0 }));

/** Puts fresh tokens and git's identity in the sandbox: always with `force` (each turn's start, which also covers a sandbox eve recreated), else when they're near their end. */
export async function give(ctx: Pick<ToolContext, "getSandbox">, thread: string, { force = false } = {}) {
  const now = Date.now();
  if (!force && !stale(given.get().until, now)) return;
  const sandbox = await ctx.getSandbox(environment);
  const { getToken } = await import("@vercel/connect");
  const root: Root = await agentBoard(factory)
    .thread(thread)
    .then((view) => view.message)
    .catch(() => null);
  const github = await githubToken(getToken, thread, root);
  // Other services' keys: only in the channels channels.ts gives them.
  const services = threadServices(root?.channel, serviceChannels);
  await sandbox.setNetworkPolicy(policy({ github, services }) as SandboxNetworkPolicy);
  const git = await sandbox.run({
    command: `git config --global user.name ${JSON.stringify(NAME)} && git config --global user.email ${GIT_EMAIL}`,
  });
  if (git.exitCode !== 0) throw new Error(`git config failed: ${git.stderr.slice(-300)}`);
  // Without GitHub, the next turn's start asks again: the connector may be set up by then.
  given.update(() => ({ until: github ? now + GITHUB_MS : Infinity }));
}
