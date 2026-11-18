import type { Board } from "@vercel/board";
import { LABEL, parsePlan, type RunnerConfig, type State } from "../sandbox/shared.ts";
import { agentName, runChannel, team } from "./board.ts";
import { deadlineOf, taskCap, type Config } from "./config.ts";
import { models } from "./models.ts";
import { addTasks, create, lostRace, newSlug, run as readRun, runs, savePrepared, say, setPhase, snapshot, type Run, type Snapshot, type Task } from "./runs.ts";
import * as sandboxes from "./sandboxes.ts";
import { expand, seed } from "./scenarios.ts";

// Running a run: the launch, once, and then `reconcile`, again and again. Reconcile reads what the
// board says the run should be (its phase, what's left to do, what it has spent) and makes the
// sandboxes match. Nothing remembers a run but the board, so any request can reconcile it: the cron,
// the page someone has open, or the launch itself.

/** What reconcile uses of the sandboxes: the real ones, or a test's. */
export type Sandboxes = Pick<typeof sandboxes, "baseSandbox" | "prepare" | "startAgent" | "agents" | "refresh" | "stop" | "teardown">;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Starts a run's thread and answers it at once: `launch` does the slow part. */
export async function begin(config: Config, board: Board = team(), now = Date.now()): Promise<Run> {
  return create(board, config, newSlug(now));
}

/**
 * The slow part of starting a run: the checkout, its first tasks, and its first agents. It says
 * what it's doing in the run's thread as it goes, so the page and the board show it. A failure ends
 * the run as `failed`, with why.
 */
export async function launch(started: Run, board: Board = team(), boxes: Sandboxes = sandboxes): Promise<void> {
  const { id, slug, config } = started;
  const tell = (text: string) => say(board, id, text).catch(() => {});
  try {
    const base = await boxes.baseSandbox(tell);
    await tell(`Cloning ${config.repo}.`);
    const checkout = await boxes.prepare(slug, config.repo, base, tell);
    const first = seed(config, checkout.files);
    if (first.length === 0) throw new Error(`${config.repo} has no files to review.`);
    const { owner, made } = await addTasks(board, slug, `seed-${slug}`, first);
    const deadline = deadlineOf(config, Date.now());
    const what = config.scenario === "pipeline" ? "A planner splits the goal into tasks first." : `${(made - 1) / 2} areas to review, each checked, then one report.`;
    await savePrepared(board, id, { base: checkout.base, baseBranch: checkout.baseBranch, owner, deadline }, `From ${checkout.baseBranch}@${checkout.base.slice(0, 7)}. ${what}${checkout.setup ? ` ${checkout.setup}` : ""}`);
    // Someone may have stopped it while it was preparing: then it stays stopped.
    if (!(await setPhase(board, id, "running", { from: "preparing" }))) return;
    await reconcile(slug, board, boxes, { force: true });
  } catch (error) {
    await setPhase(board, id, "failed", { note: message(error).split("\n", 1)[0] }).catch(() => {});
    await tell(`Couldn't start: ${message(error)}`);
    await boxes.teardown(slug).catch(() => {});
  }
}

/** What an agent's sandbox is told, from the run as the board has it. */
export async function runnerConfig(found: Run, n: number, listed = models()): Promise<RunnerConfig> {
  const { config, slug, prepared } = found;
  const model = (await listed).find((entry) => entry.id === config.model);
  return {
    slug,
    run: found.id,
    goal: config.goal,
    scenario: config.scenario,
    channel: runChannel(slug),
    worker: agentName(n),
    owner: prepared!.owner,
    repo: "/vercel/sandbox/repo",
    base: prepared!.base,
    baseBranch: prepared!.baseBranch,
    github: config.repo,
    branches: `swarm/${slug}`,
    model: config.model,
    context: model?.context ?? 128_000,
    price: model?.price ?? null,
    maxTasks: taskCap(config.agents),
    budgetUsd: config.budgetUsd,
    deadline: prepared!.deadline,
  };
}

/** A reconcile runs at most this often per run, whoever asks. */
const EVERY_MS = 30_000;

/**
 * Takes this turn at reconciling a run, or doesn't: the `tick` label on its thread is when the last
 * one ran, and it changes only from the value this caller read. Of two requests at once, one gets
 * the turn.
 */
async function turn(board: Board, id: string, last: string | undefined, force: boolean): Promise<boolean> {
  if (!force && last && Date.now() - Date.parse(last) < EVERY_MS) return false;
  try {
    await board.label(id, { set: { tick: new Date().toISOString() }, if: { tick: last ?? null } });
    return true;
  } catch (error) {
    if (lostRace(error)) return false;
    throw error;
  }
}

/** Plans that are done and whose tasks aren't in the queue yet: the run isn't over while one is. */
export const unexpanded = (tasks: Task[]) => tasks.filter((task) => task.role === "plan" && task.state === "completed" && task.labels[LABEL.expanded] !== "yes");

/** Tasks an agent could be working on: ready, or held by one. */
export const live = (counts: Record<State, number>) => counts.ready + counts.claimed;

/**
 * Why a running run is over, or null while it isn't. It's done once nothing is ready or held and no
 * plan waits to be added: what's still waiting then waits on a task that failed, which nothing will
 * complete. Spend counts against the budget as soon as an agent labels it, mid-task included.
 */
export function ending(now: Pick<Snapshot, "counts" | "cost" | "tasks"> & { run: Pick<Run, "config" | "prepared"> }, at = Date.now()): { phase: "done" | "stopped"; why: string } | null {
  const { run, counts, cost, tasks } = now;
  const spent = `$${cost.toFixed(2)}`;
  if (run.config.budgetUsd !== null && cost >= run.config.budgetUsd) return { phase: "stopped", why: `Stopped at its budget: ${spent} of $${run.config.budgetUsd}.` };
  if (run.prepared && at >= run.prepared.deadline) return { phase: "stopped", why: `Stopped at its time limit, ${run.config.minutes ?? "its most"} minutes, for ${spent}.` };
  if (tasks.length > 0 && live(counts) === 0 && unexpanded(tasks).length === 0) {
    const gaveUp = counts.failed + counts.canceled + counts.blocked + counts.waiting;
    return { phase: "done", why: `Done: ${counts.completed} completed${gaveUp ? `, ${gaveUp} not` : ""}, for ${spent}.` };
  }
  return null;
}

/** The plan a completed plan task's thread carries, as the planner posted it. */
async function planOf(board: Board, task: Task, max: number) {
  const { replies } = await board.thread(task.id);
  for (const reply of [...replies].reverse()) {
    const plan = parsePlan(/```json plan\n[\s\S]*?\n```/.exec(reply.text)?.[0] ?? "", max);
    if (plan.length) return plan;
  }
  return [];
}

/** Adds each finished plan's tasks to the queue, once: the batch's key makes a second try add none. */
async function expandPlans(board: Board, found: Run, tasks: Task[]): Promise<boolean> {
  const pending = unexpanded(tasks);
  for (const task of pending) {
    const plan = await planOf(board, task, taskCap(found.config.agents));
    if (plan.length) {
      const { made } = await addTasks(board, found.slug, `plan-${task.id}`, expand(plan));
      await say(board, found.id, `The plan has ${made / 2} ${made === 2 ? "task" : "tasks"}, each with a review.`);
    } else await say(board, found.id, "The plan listed no tasks, so there's nothing to work on.");
    await board.label(task.id, { set: { [LABEL.expanded]: "yes" } });
  }
  return pending.length > 0;
}

/**
 * Makes a run's sandboxes match what the board says. While it runs: adds a finished plan's tasks,
 * keeps its labels current, ends it when it's done, over budget, or out of time; otherwise starts
 * the agents it's short of and hands the rest fresh credentials. Once it isn't running, its
 * sandboxes go. `force` skips the wait between turns, for a change someone just made on the page.
 */
export async function reconcile(slug: string, board: Board = team(), boxes: Sandboxes = sandboxes, opts: { force?: boolean } = {}): Promise<void> {
  let now = await snapshot(slug, board);
  if (!now) return;
  const found = now.run;
  if (found.phase === "preparing") return;
  const root = (await board.thread(found.id)).message;
  if (!(await turn(board, found.id, root.labels.tick, opts.force ?? false))) return;

  if (found.phase !== "running") {
    if (!found.torn) {
      await boxes.teardown(slug);
      await board.label(found.id, { set: { torn: "yes" } });
    }
    return;
  }

  if (await expandPlans(board, found, now.tasks)) now = (await snapshot(slug, board))!;
  const settled = now.counts.completed + now.counts.failed + now.counts.canceled;
  await board.label(found.id, { set: { cost: now.cost.toFixed(4), settled: String(settled), total: String(now.tasks.length) } });

  const end = ending(now);
  if (end) {
    if (await setPhase(board, found.id, end.phase, { from: "running", note: end.why })) {
      await say(board, found.id, end.why);
      await boxes.teardown(slug);
      await board.label(found.id, { set: { torn: "yes" } });
    }
    return;
  }

  const up = await boxes.agents(slug);
  const agents = found.config.agents;
  const write = found.config.scenario === "pipeline";
  await boxes.refresh(up, { slug, repo: found.config.repo, write });
  // An agent per task that's ready or held, up to the run's number: what waits needs nobody yet.
  const want = Math.min(agents, live(now.counts));
  const taken = new Set(up.map(({ n }) => n));
  const missing: number[] = [];
  for (let n = 1; n <= agents && taken.size + missing.length < want; n++) if (!taken.has(n)) missing.push(n);
  if (missing.length === 0) return;
  const timeoutMs = Math.max(10 * 60_000, found.prepared!.deadline - Date.now() + 5 * 60_000);
  const listed = models();
  const started = await Promise.allSettled(missing.map(async (n) => boxes.startAgent(slug, n, await runnerConfig(found, n, listed), { timeoutMs, write })));
  const failed = started.flatMap((result) => (result.status === "rejected" ? [message(result.reason)] : []));
  const ok = started.length - failed.length;
  if (ok) await say(board, found.id, `Started ${ok} ${ok === 1 ? "agent" : "agents"}: ${up.length + ok} of ${agents} up.`);
  if (failed.length) await say(board, found.id, `Couldn't start ${failed.length} ${failed.length === 1 ? "agent" : "agents"}: ${failed[0]}`);
}

/** Reconciles every run that could have sandboxes: what the cron runs, and the page while it's open. */
export async function reconcileAll(board: Board = team(), boxes: Sandboxes = sandboxes): Promise<{ slug: string; error?: string }[]> {
  const all = await runs(board);
  // The ones that could have sandboxes: running, or ended with its sandboxes not yet seen gone.
  const active = all.filter((found) => found.phase === "running" || (found.phase !== "preparing" && !found.torn));
  return Promise.all(
    active.map((found) =>
      reconcile(found.slug, board, boxes).then(
        () => ({ slug: found.slug }),
        (error: unknown) => ({ slug: found.slug, error: message(error) }),
      ),
    ),
  );
}

/** Stops a run, as the page asks: its agents stop at their next check, and its sandboxes go now. */
export async function stop(slug: string, board: Board = team(), boxes: Sandboxes = sandboxes): Promise<void> {
  const found = await readRun(slug, board);
  if (!found) throw new Error(`no run ${slug}`);
  if (found.phase !== "preparing" && found.phase !== "running") throw new Error(`a ${found.phase} run can't be stopped`);
  if (!(await setPhase(board, found.id, "stopped", { from: found.phase, note: "Stopped by hand." }))) return;
  await say(board, found.id, "Stopped.");
  await reconcile(slug, board, boxes, { force: true });
}
