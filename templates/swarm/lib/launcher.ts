import { after } from "next/server";
import { SWARM, team } from "./board.ts";
import { models, type Model } from "./models.ts";
import { githubConnector, projectOf } from "./project.ts";
import { reconcileAll } from "./run.ts";
import { runs, type Run } from "./runs.ts";
import { inspectCommand, isLocal, liveDeps, progress, setup, type Setup } from "./setup.ts";

// The launcher, checked now: the setup's steps, and once they're done, the form and the runs.

export type Launcher = {
  result: Setup;
  /** The command that opens the team's board in a browser. */
  inspect: string;
  /** A dev server, not a deployment. */
  local: boolean;
  /** The models the form offers, with their prices. Empty when the gateway's list couldn't be read. */
  models: Model[];
  /** The latest runs, newest first. */
  runs: Run[];
};

/** Checks this deployment as `host` sees it: a preview can be open while production is closed. */
export async function check(host: string | null): Promise<Launcher> {
  const board = team();
  const deps = await liveDeps(
    async () => {
      const { principal, can } = await board.me();
      return { principal, can };
    },
    { swarm: SWARM, connector: githubConnector(), host },
  );
  const result = await setup(deps);
  const teamSlug = await deps.oidc().then((token) => projectOf(token)?.team, () => undefined);
  const base = { result, inspect: inspectCommand(teamSlug), local: isLocal(deps.env) };
  if (result.open) return { ...base, models: [], runs: [] };
  const [listed, recent] = await Promise.all([models(), runs(board, 20).catch(() => [])]);
  // Whoever has the page open keeps the runs going too, after the page is sent: a reconcile is a turn
  // each run takes at most every half minute, whoever asks.
  if (progress(result.steps).ready && recent.some((run) => run.phase === "running" || (run.phase !== "preparing" && !run.torn))) after(() => reconcileAll().catch((error: unknown) => console.error("[swarm] reconcile failed:", error)));
  return { ...base, models: listed, runs: recent };
}
