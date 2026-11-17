import type { FirstTask } from "./first-task.ts";
import { joinPrompt } from "./markdown.ts";
import { overview, type Overview } from "./overview.ts";
import { mirrorOf, progress, READ, reposOf, type Listed, type Setup, type Synced } from "./setup.ts";

// What the launcher shows once the factory runs, put together from one check of the deployment.

/** What the launcher shows once the factory runs. */
export type Running = {
  overview: Overview;
  /** The repos it works on, each with where it shows. */
  repos: Listed[];
  /**
   * How to onboard another: where the factory is asked, on the board and in Slack, how many repos
   * have the GitHub app and no channel (null when that couldn't be told), which ones, to suggest,
   * and where on GitHub the app is added to more (null when that couldn't be told).
   */
  ask: { channel: string; slack: string | null; waiting: number | null; suggest: string[]; install: string | null };
  /** What to paste to a coding agent on your machine to have it join. */
  join: string;
  /** Where its first task stands, while the README is still the template's. */
  first: FirstTask;
};

/**
 * What the launcher shows once the factory runs, from one check's result: nothing while a required
 * step is left, the deployment is open, or it can't use its board. `where` is what the join prompt
 * names: the deployment, its team and board, and its own repo.
 */
export function runningOf(
  result: Setup,
  { repoChannels, slackChannels, home }: Pick<Synced, "repoChannels" | "slackChannels" | "home">,
  where: { origin: string; team: string | undefined; board: string | null; repo: string | null },
  now: Date,
): Running | null {
  if (result.open || !result.found.me || !progress(result.steps).running) return null;
  const { found } = result;
  const rsi = `${home}/rsi`;
  return {
    overview: overview(found.recent, found.pulls, result.found.me.principal, now, READ),
    repos: reposOf({ repoChannels, slackChannels }),
    ask: { channel: rsi, slack: mirrorOf(slackChannels, rsi), waiting: found.waiting, suggest: found.unmapped, install: found.install },
    join: joinPrompt({ ...where, home }),
    first: found.first,
  };
}
