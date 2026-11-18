"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { parseConfig, priced } from "@/lib/config";
import { OPEN, open } from "@/lib/gate";
import { models } from "@/lib/models";
import { begin, launch, stop as stopRun } from "@/lib/run";
import { SLUG } from "@/lib/runs";
import { githubConnector } from "@/lib/project";
import { history } from "@/lib/swarm";

// What the pages do, as this deployment. Every action reads or spends as the project, so each checks
// first that strangers can't reach the deployment.

type Result<T = object> = ({ ok: true } & T) | { ok: false; problem: string };

async function guarded<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  if (await open((await headers()).get("host"))) return { ok: false, problem: OPEN };
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The repos the GitHub app is on right now: a launch takes only one of these. */
async function installedRepos(): Promise<string[]> {
  const { getToken } = await import("@vercel/connect");
  const token = await getToken(githubConnector(), { subject: { type: "app" } });
  const response = await fetch("https://api.github.com/installation/repositories?per_page=100", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} listing the app's repos`);
  return ((await response.json()) as { repositories: { full_name: string }[] }).repositories.map((repo) => repo.full_name.toLowerCase());
}

/** Launches a run from the form. It answers with the run's slug at once, and the checkout, the tasks, and the agents follow. */
export async function start(input: unknown): Promise<Result<{ slug: string }>> {
  const parsed = parseConfig(input);
  if ("problem" in parsed) return { ok: false, problem: parsed.problem };
  return guarded(async () => {
    const { config } = parsed;
    const problem = priced(config, await models());
    if (problem) throw new Error(problem);
    // The form lists the app's repos, and the board takes whatever it's sent: so it's checked again here.
    const repos = await installedRepos().catch(() => null);
    if (repos && !repos.includes(config.repo.toLowerCase())) throw new Error(`The GitHub app isn't on ${config.repo}.`);
    const run = await begin(config);
    // The slow part runs after the response: the page already shows the run.
    after(() => launch(run));
    return { slug: run.slug };
  });
}

/** Stops a run: its agents stop, and its sandboxes go. */
export async function stop(slug: string): Promise<Result> {
  if (!SLUG.test(slug)) return { ok: false, problem: "not a run" };
  return guarded(async () => {
    await stopRun(slug);
    return {};
  });
}

/** A task's thread, for the panel a click opens on the live page. The live page has no action that writes. */
export async function thread(id: string) {
  if (!/^[\w.:-]{1,128}$/.test(id)) throw new Error("not a message id");
  if (await open((await headers()).get("host"))) throw new Error(OPEN);
  return history(id);
}
