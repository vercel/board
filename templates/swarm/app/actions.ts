"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { parseConfig, priced } from "@/lib/config";
import { githubToken } from "@/lib/credentials";
import { OPEN, open } from "@/lib/gate";
import { models } from "@/lib/models";
import { ask as askRun, begin, launch, PROMPT_MAX, stop as stopRun } from "@/lib/run";
import { LAUNCHER, RUNS, SWARM, team } from "@/lib/board";
import { runs, SLUG } from "@/lib/runs";
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

/**
 * Whether the GitHub app is on `repo` right now, with what the run needs there: a launch takes only
 * such a repo. Connect mints a token for that repo alone, the one the run clones with, and refuses
 * one for a repo the app isn't on. Reading the repo isn't enough (any token reads a public one), and
 * listing the app's repos takes a page per hundred.
 */
async function appIsOn(repo: string, write: boolean): Promise<void> {
  await githubToken(repo, write).catch((error: unknown) => {
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(`The GitHub app can't ${write ? "push to" : "read"} ${repo}: ${said}. Add the repo to the app, then try again.`);
  });
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
    await appIsOn(config.repo, config.scenario === "pipeline");
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

/** The newest runs with their config, phase, spend and progress: what the live page's WebMCP tools answer about runs. Reads only. */
export async function swarmRuns(limit = 20) {
  if (await open((await headers()).get("host"))) throw new Error(OPEN);
  return (await runs(undefined, Math.min(Math.max(1, Math.trunc(limit) || 20), 50))).map((run) => ({
    slug: run.slug,
    thread: run.id,
    title: run.title,
    phase: run.phase,
    note: run.note,
    repo: run.config.repo,
    scenario: run.config.scenario,
    model: run.config.model,
    agents: run.config.agents,
    budgetUsd: run.config.budgetUsd,
    minutes: run.config.minutes,
    spentUsd: run.cost,
    settled: run.settled,
    total: run.total,
    createdAt: run.createdAt,
  }));
}

/** Adds what someone typed on the live page to a running run, as its tasks: the swarm takes them like any other. */
export async function ask(slug: string, prompt: string): Promise<Result<{ made: number }>> {
  if (!SLUG.test(slug)) return { ok: false, problem: "not a run" };
  if (typeof prompt !== "string") return { ok: false, problem: "nothing to ask" };
  return guarded(() => askRun(slug, prompt));
}

/**
 * Replies in a task's thread from the live page, under the launcher's profile. An agent reads people's
 * replies when it takes the task (and a reviewer, the work's), so this steers a task that isn't
 * started or will be tried again.
 */
export async function say(id: string, text: string): Promise<Result> {
  if (!/^[\w.:-]{1,128}$/.test(id)) return { ok: false, problem: "not a message id" };
  const said = typeof text === "string" ? text.trim().slice(0, PROMPT_MAX) : "";
  if (!said) return { ok: false, problem: "nothing to say" };
  return guarded(async () => {
    const board = team();
    const { message } = await board.thread(id);
    // Only a task's thread in the swarm: never the runs channel, where the launch records what the
    // run's agents start from, and never a thread that isn't a task.
    if (!message.channel.startsWith(SWARM) || message.channel === RUNS || !message.task) throw new Error(`${id} isn't a task in ${SWARM}`);
    await board.as(LAUNCHER).reply(message.id, said);
    return {};
  });
}
