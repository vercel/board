import { BoardError, type Board } from "@vercel/board";
import type { RunnerConfig } from "../sandbox/shared.ts";
import { tasksChannel, team, workerName } from "./board.ts";
import { addTasks, campaign as readCampaign, campaigns, create, newSlug, savePrepared, say, setPhase, snapshot, type Campaign, type Snapshot } from "./campaign.ts";
import { githubRepo, plan, type Config } from "./config.ts";
import { models } from "./models.ts";
import * as sandboxes from "./sandboxes.ts";

// Running a campaign: the launch, once, and then `reconcile`, again and again. Reconcile reads what
// the board says the campaign should be (its phase, how many agents, what's left to do) and makes
// the sandboxes match. Nothing remembers a campaign but the board, so any request can run it: the
// cron, the page someone has open, or the launch itself.

/** What reconcile uses of the sandboxes: the real ones, or a test's. */
export type Sandboxes = Pick<typeof sandboxes, "baseSandbox" | "prepare" | "startWorker" | "workers" | "refresh" | "stop" | "teardown" | "canPush">;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Starts a campaign's thread and answers it at once: `launch` does the slow part. */
export async function begin(config: Config, board: Board = team()): Promise<Campaign> {
  return create(board, config, newSlug());
}

/**
 * The slow part of starting a campaign: the checkout, its tasks, and its first agents. It says what
 * it's doing in the campaign's thread as it goes, so the page shows it. A failure ends the campaign
 * as `failed`, with why.
 */
export async function launch(campaign: Campaign, board: Board = team(), boxes: Sandboxes = sandboxes): Promise<void> {
  const { id, slug, config } = campaign;
  const tell = (text: string) => say(board, id, text).catch(() => {});
  try {
    if (config.delivery !== "patch" && !boxes.canPush()) throw new Error("Pull requests and a branch need GITHUB_TOKEN on this deployment. Without it, deliver patches.");
    const base = await boxes.baseSandbox(tell);
    await tell(`Cloning ${config.repo} and listing its files.`);
    const checkout = await boxes.prepare(slug, config, base, tell);
    const { tasks, left } = plan(checkout.discovered, config.batch, config.maxTasks);
    if (tasks.length === 0) throw new Error(`\`${config.discover}\` listed no files in ${config.repo}.`);
    const { owner, made } = await addTasks(board, slug, tasks);
    const files = tasks.reduce((sum, group) => sum + group.length, 0);
    await savePrepared(
      board,
      id,
      { base: checkout.base, baseBranch: checkout.baseBranch, owner, deadline: Date.now() + config.minutes * 60_000, files, tasks: made },
      `${made} ${made === 1 ? "task" : "tasks"} for ${files} ${files === 1 ? "file" : "files"}, from ${checkout.baseBranch}@${checkout.base.slice(0, 7)}.${left ? ` ${left} more files didn't fit in ${config.maxTasks} tasks, and were left out.` : ""}`,
    );
    // Someone may have stopped it while it was preparing: then it stays stopped.
    if (!(await setPhase(board, id, "running", { from: "preparing" }))) return;
    await reconcile(slug, board, boxes);
  } catch (error) {
    await setPhase(board, id, "failed", { note: message(error).split("\n", 1)[0] }).catch(() => {});
    await tell(`Couldn't start: ${message(error)}`);
    await boxes.teardown(slug).catch(() => {});
  }
}

/** What a worker's sandbox is told, from the campaign as the board has it. */
async function runnerConfig(campaign: Campaign, n: number): Promise<RunnerConfig> {
  const { config, slug, prepared } = campaign;
  const listed = await models();
  const known = (id: string) => {
    const model = listed.find((entry) => entry.id === id);
    return [id, { context: model?.context ?? 128_000, price: model?.price ?? null }] as const;
  };
  return {
    slug,
    campaign: campaign.id,
    title: config.title,
    channel: tasksChannel(slug),
    worker: workerName(n),
    owner: prepared!.owner,
    repo: "/vercel/sandbox/repo",
    base: prepared!.base,
    instructions: config.instructions,
    verify: config.verify,
    rounds: config.rounds,
    model: config.model,
    reviewModel: config.review ? config.reviewModel : null,
    thinking: config.thinking,
    models: Object.fromEntries([known(config.model), ...(config.review ? [known(config.reviewModel)] : [])]),
    delivery: config.delivery,
    github: githubRepo(config.repo),
    baseBranch: prepared!.baseBranch,
    campaignBranch: sandboxes.campaignBranch(slug),
    deadline: prepared!.deadline,
  };
}

/** A reconcile runs at most this often per campaign, whoever asks. */
const EVERY_MS = 45_000;

/**
 * Takes this turn at reconciling a campaign, or doesn't: the `tick` label on its thread is when the
 * last one ran, and it changes only from the value this caller read. Of two requests at once, one
 * gets the turn.
 */
async function turn(board: Board, id: string, last: string | undefined, force: boolean): Promise<boolean> {
  if (!force && last && Date.now() - Date.parse(last) < EVERY_MS) return false;
  try {
    await board.label(id, { set: { tick: new Date().toISOString() }, if: { tick: last ?? null } });
    return true;
  } catch (error) {
    if (error instanceof BoardError && error.code === "label_conflict") return false;
    throw error;
  }
}

/** Why a running campaign is over, or null while it isn't. */
function ending(now: Snapshot): { phase: "done" | "stopped"; why: string } | null {
  const { campaign, counts, cost } = now;
  const open = counts.waiting + counts.ready + counts.claimed;
  if (open === 0 && counts.blocked === 0) return { phase: "done", why: `Done: ${counts.completed} completed, ${counts.failed + counts.canceled} given up on, for $${cost.toFixed(2)}.` };
  if (cost >= campaign.config.budgetUsd) return { phase: "stopped", why: `Stopped at its budget: $${cost.toFixed(2)} of $${campaign.config.budgetUsd}.` };
  if (campaign.prepared && Date.now() >= campaign.prepared.deadline) return { phase: "stopped", why: `Stopped at its time limit of ${campaign.config.minutes} minutes.` };
  return null;
}

/**
 * Makes a campaign's sandboxes match what the board says. While it runs: ends it when it's done,
 * over budget, or out of time; otherwise starts the agents it's short of, stops the ones it has too
 * many of, and hands the rest fresh credentials. Once it isn't running, its sandboxes go.
 * `force` skips the wait between turns, for a change someone just made on the page.
 */
export async function reconcile(slug: string, board: Board = team(), boxes: Sandboxes = sandboxes, opts: { force?: boolean } = {}): Promise<void> {
  const now = await snapshot(slug, board);
  if (!now) return;
  const { campaign, counts } = now;
  if (campaign.phase === "preparing") return;
  const root = (await board.thread(campaign.id)).message;
  if (!(await turn(board, campaign.id, root.labels.tick, opts.force ?? false))) return;

  if (campaign.phase !== "running") {
    // Paused keeps the checkout, to start again from. Any other end deletes it.
    if (campaign.phase === "paused") await boxes.stop((await boxes.workers(slug)).map(({ name }) => name));
    else if (!campaign.torn) {
      await boxes.teardown(slug);
      await board.label(campaign.id, { set: { torn: "yes" } });
    }
    return;
  }

  const end = ending(now);
  if (end) {
    if (await setPhase(board, campaign.id, end.phase, { from: "running", note: end.why })) {
      await say(board, campaign.id, end.why);
      await boxes.teardown(slug);
      await board.label(campaign.id, { set: { torn: "yes" } });
    }
    return;
  }

  const up = await boxes.workers(slug);
  // With nothing to claim and nothing held by an agent, what's left waits for a person: no agent is needed until they answer.
  const want = Math.min(campaign.agents, counts.ready + counts.claimed);
  const extra = up.filter(({ n }) => n > campaign.agents).map(({ name }) => name);
  if (extra.length) await boxes.stop(extra);
  const kept = up.filter(({ n }) => n <= campaign.agents);
  await boxes.refresh(kept, { slug, repo: githubRepo(campaign.config.repo), push: campaign.config.delivery !== "patch" });
  const taken = new Set(kept.map(({ n }) => n));
  const missing: number[] = [];
  for (let n = 1; n <= campaign.agents && taken.size + missing.length < want; n++) if (!taken.has(n)) missing.push(n);
  if (missing.length === 0) return;
  const timeoutMs = Math.max(10 * 60_000, campaign.prepared!.deadline - Date.now() + 5 * 60_000);
  const started = await Promise.allSettled(
    missing.map(async (n) => boxes.startWorker(slug, n, await runnerConfig(campaign, n), { vcpus: campaign.config.vcpus, timeoutMs })),
  );
  const failed = started.flatMap((result) => (result.status === "rejected" ? [message(result.reason)] : []));
  const ok = started.length - failed.length;
  if (ok) await say(board, campaign.id, `Started ${ok} ${ok === 1 ? "agent" : "agents"}: ${kept.length + ok} of ${campaign.agents} up.`);
  if (failed.length) await say(board, campaign.id, `Couldn't start ${failed.length} ${failed.length === 1 ? "agent" : "agents"}: ${failed[0]}`);
}

/** Reconciles every campaign that could have sandboxes: what the cron runs. */
export async function reconcileAll(board: Board = team(), boxes: Sandboxes = sandboxes): Promise<{ slug: string; error?: string }[]> {
  const all = await campaigns(board);
  // The ones that could have sandboxes: running or paused, or ended with its sandboxes not yet seen gone.
  const live = all.filter((campaign) => campaign.phase === "running" || campaign.phase === "paused" || (campaign.phase !== "preparing" && !campaign.torn));
  return Promise.all(
    live.map((campaign) =>
      reconcile(campaign.slug, board, boxes).then(
        () => ({ slug: campaign.slug }),
        (error: unknown) => ({ slug: campaign.slug, error: message(error) }),
      ),
    ),
  );
}

/** Stops, pauses, or resumes a campaign, as the page asks, and reconciles at once. */
export async function change(slug: string, to: "stopped" | "paused" | "running", board: Board = team(), boxes: Sandboxes = sandboxes): Promise<void> {
  const found = await readCampaign(slug, board);
  if (!found) throw new Error(`no campaign ${slug}`);
  const allowed: Record<typeof to, Campaign["phase"][]> = { stopped: ["preparing", "running", "paused"], paused: ["running"], running: ["paused"] };
  if (!allowed[to].includes(found.phase)) throw new Error(`a ${found.phase} campaign can't be ${to}`);
  if (!(await setPhase(board, found.id, to, { from: found.phase, ...(to === "stopped" ? { note: "Stopped by hand." } : {}) }))) return;
  await say(board, found.id, to === "stopped" ? "Stopped." : to === "paused" ? "Paused: its agents stop, and its tasks keep their state." : "Resumed.");
  await reconcile(slug, board, boxes, { force: true });
}

/** Sets how many agents a campaign should have. Reconcile starts or stops the difference. */
export async function scale(slug: string, agents: number, board: Board = team(), boxes: Sandboxes = sandboxes): Promise<void> {
  const found = await readCampaign(slug, board);
  if (!found) throw new Error(`no campaign ${slug}`);
  await board.label(found.id, { set: { agents: String(agents) } });
  await reconcile(slug, board, boxes, { force: true });
}
