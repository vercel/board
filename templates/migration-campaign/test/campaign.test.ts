// What a campaign promises, on a board in memory and with sandboxes that are only names:
// node --test test/*.test.ts
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import { board as makeBoard, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { ROOT, tasksChannel, workerName } from "../lib/board.ts";
import { campaign, snapshot } from "../lib/campaign.ts";
import { cancel, claimNext, unblock } from "../lib/queue.ts";
import { DEFAULTS, parseConfig, plan, type Config } from "../lib/config.ts";
import { begin, change, launch, reconcile, scale, type Sandboxes } from "../lib/run.ts";
import { RUNTIME } from "../lib/sandboxes.ts";
import { blocked, verdict, verifyCommand } from "../sandbox/shared.ts";

const fresh = (): Board => makeBoard({ backend: local({ memory: true }) });

const config = (over: Partial<Config> = {}): Config => {
  const parsed = parseConfig({ ...DEFAULTS, repo: "acme/web", instructions: "Replace every var with const or let.", agents: 3, ...over });
  assert.ok("config" in parsed, "problem" in parsed ? parsed.problem : "");
  return parsed.config;
};

/** Sandboxes that are only names: what was started, stopped, and torn down. */
function fake(files: string[]) {
  const up = new Map<number, string>();
  const calls = { started: [] as number[], stopped: [] as string[], refreshed: 0, torn: 0 };
  const boxes: Sandboxes = {
    canPush: () => false,
    baseSandbox: async () => "base",
    prepare: async () => ({ base: "0123456789abcdef", baseBranch: "main", discovered: files.join("\n") }),
    startWorker: async (_slug, n) => {
      calls.started.push(n);
      up.set(n, `w${n}`);
      return `w${n}`;
    },
    workers: async () => [...up].map(([n, name]) => ({ n, name })),
    refresh: async () => {
      calls.refreshed++;
    },
    stop: async (names) => {
      calls.stopped.push(...names);
      for (const [n, name] of up) if (names.includes(name)) up.delete(n);
    },
    teardown: async () => {
      calls.torn++;
      up.clear();
    },
  };
  return { boxes, calls, up };
}

const files = (count: number) => Array.from({ length: count }, (_, at) => `src/file-${at}.js`);

/** A campaign launched on a fresh board, with `count` files to migrate. */
async function started(count: number, over: Partial<Config> = {}, board: Board = fresh()) {
  const { boxes, calls, up } = fake(files(count));
  const made = await begin(config(over), board);
  await launch(made, board, boxes);
  return { board, boxes, calls, up, slug: made.slug };
}

/** Claims the next task as an agent would: as its profile, naming the tasks' owner. */
async function claimAs(board: Board, slug: string, n: number) {
  const { prepared } = (await campaign(slug, board))!;
  return claimNext(board.as(workerName(n)), tasksChannel(slug), prepared!.owner);
}

test("a config keeps its numbers in range and says what's missing", () => {
  assert.deepEqual(parseConfig({}), { problem: "Name the repository to migrate." });
  assert.ok("problem" in parseConfig({ repo: "acme/web", instructions: "short" }));
  assert.ok("problem" in parseConfig({ ...config(), delivery: "prs", repo: "https://git.example.com/acme/web.git" }));
  const { agents, budgetUsd, title } = config({ agents: 500, budgetUsd: -4, title: "" });
  assert.equal(agents, 16);
  assert.equal(budgetUsd, 1);
  assert.equal(title, "Migrate acme/web");
});

test("a plan groups paths, once each, and counts what didn't fit", () => {
  const { tasks, left } = plan("a.js\nb.js\n\na.js\nc.js\nd.js\ne.js\n-rf\nwith space.js\n", 2, 2);
  assert.deepEqual(tasks, [
    ["a.js", "b.js"],
    ["c.js", "d.js"],
  ]);
  assert.equal(left, 1);
});

test("a reviewer approves only by saying so, and an agent holds a task by saying BLOCKED", () => {
  assert.equal(verdict("APPROVE\nlooks right").approved, true);
  assert.equal(verdict("**APPROVE**").approved, true);
  assert.equal(verdict("I think this is fine overall.").approved, false);
  assert.deepEqual(verdict("CHANGES\n- line 3 still uses var"), { approved: false, notes: "- line 3 still uses var" });
  assert.equal(blocked("Done: replaced 4 declarations."), null);
  assert.equal(blocked("BLOCKED: the file is generated"), "the file is generated");
});

test("a launch makes one task per group of files and starts as many agents as there's work for", async () => {
  const { board, calls, slug } = await started(5, { batch: 2, agents: 4 });
  const now = (await snapshot(slug, board))!;
  assert.equal(now.campaign.phase, "running");
  assert.equal(now.tasks.length, 3);
  assert.equal(now.counts.ready, 3);
  assert.deepEqual(now.campaign.prepared && { files: now.campaign.prepared.files, tasks: now.campaign.prepared.tasks, baseBranch: now.campaign.prepared.baseBranch }, {
    files: 5,
    tasks: 3,
    baseBranch: "main",
  });
  // Four agents were asked for, and three tasks are ready: a fourth would have nothing to claim.
  assert.deepEqual(calls.started.sort(), [1, 2, 3]);
});

// Vercel's board, as vercel/board's tests fake it: in a copy of this template outside that repo, there's no fake, and this is skipped.
const FAKE = new URL("../../../packages/board/test/messageboard.ts", import.meta.url);
const hasFake = await access(FAKE).then(
  () => true,
  () => false,
);

/** What app/api/live does with a snapshot: polls everything under the campaigns' channel since its cursor, and gets only that. */
async function followsOn(board: Board) {
  const { slug } = await started(3, {}, board);
  const { cursor } = (await snapshot(slug, board))!;
  assert.equal((await board.poll({ channel: `${ROOT}/`, after: cursor, wait: 0 })).events.length, 0);
  await board.post(tasksChannel(slug), "a change after the snapshot");
  const page = await board.poll({ channel: `${ROOT}/`, after: cursor, wait: 0 });
  assert.deepEqual(page.events.map((event) => event.message?.text), ["a change after the snapshot"]);
}

test("the live feed follows on from a snapshot's cursor", () => followsOn(fresh()));

test("on Vercel's board, the live feed follows on from a snapshot's cursor", { skip: !hasFake && "no fake of Vercel's API here" }, async () => {
  const { fakeMessageboard, as } = await import(FAKE.href);
  await followsOn(makeBoard({ team: "team_test", fetch: as(fakeMessageboard(), "user:u_jb") }));
});

test("a launch that lists no files fails, says why, and leaves no sandbox", async () => {
  const { board, calls, slug } = await started(0);
  const now = (await snapshot(slug, board))!;
  assert.equal(now.campaign.phase, "failed");
  assert.match(now.campaign.note ?? "", /listed no files/);
  assert.equal(calls.torn, 1);
  assert.deepEqual(calls.started, []);
});

test("of many agents claiming at once, each task goes to one, oldest first", async () => {
  const { board, slug } = await started(2);
  const claims = await Promise.all([1, 2, 3, 4, 5].map((n) => claimAs(board, slug, n)));
  const won = claims.filter((claim) => claim !== null);
  assert.equal(won.length, 2);
  assert.notEqual(won[0]!.task.id, won[1]!.task.id);
  assert.equal(await claimAs(board, slug, 6), null);
  const now = (await snapshot(slug, board))!;
  assert.equal(now.counts.claimed, 2);
  assert.deepEqual(now.tasks.map((task) => task.holder).sort(), [...new Set(now.tasks.map((task) => task.holder))].sort(), "each task has a holder of its own");
  assert.ok(now.tasks.every((task) => /^worker-\d$/.test(task.holder ?? "")));
});

test("a canceled task is nobody's: the agent that held it can't settle it", async () => {
  const { board, slug } = await started(2);
  const first = (await claimAs(board, slug, 1))!;
  const second = (await claimAs(board, slug, 2))!;
  await first.complete("done");
  await cancel(board, second.task.id, "not worth it");
  await assert.rejects(second.complete("done anyway"), (error: { code?: string }) => error.code === "claim_lost" || error.code === "task_finished");
  const now = (await snapshot(slug, board))!;
  assert.deepEqual([now.counts.completed, now.counts.canceled, now.counts.claimed], [1, 1, 0]);
  assert.equal(now.tasks.find((task) => task.state === "canceled")?.result, "not worth it");
});

test("a path is one shell word in the verify command, whatever is in it", () => {
  assert.equal(verifyCommand("npx tsc --noEmit {files}", ["app/(dashboard)/page.tsx", "it's.js"]), `npx tsc --noEmit 'app/(dashboard)/page.tsx' 'it'\\''s.js'`);
  assert.equal(verifyCommand("pnpm test", ["a.js"]), "pnpm test");
});

test("what agents spend is the campaign's cost, and a campaign over its budget stops and tears down", async () => {
  const { board, boxes, calls, slug } = await started(3, { budgetUsd: 1 });
  const claim = (await claimAs(board, slug, 1))!;
  await board.as(workerName(1)).label(claim.task.id, { set: { cost: "1.2500", tokens: "90000" } });
  await claim.complete("The patch is attached.");
  await reconcile(slug, board, boxes, { force: true });
  const now = (await snapshot(slug, board))!;
  assert.equal(now.cost, 1.25);
  assert.equal(now.campaign.phase, "stopped");
  assert.match(now.campaign.note ?? "", /budget/);
  assert.equal(calls.torn, 1);
});

test("a campaign is done when every task has ended, and held tasks keep it open with no agents", async () => {
  const { board, boxes, calls, up, slug } = await started(2, { agents: 2 });
  const first = (await claimAs(board, slug, 1))!;
  const second = (await claimAs(board, slug, 2))!;
  await first.complete("done");
  await second.block("Still not right after 3 tries.", { kind: "needs_input" });
  up.clear(); // its agents found nothing to claim, and exited
  calls.started.length = 0;
  await reconcile(slug, board, boxes, { force: true });
  let now = (await snapshot(slug, board))!;
  assert.equal(now.campaign.phase, "running");
  assert.equal(now.counts.blocked, 1);
  assert.equal(now.tasks.find((task) => task.state === "blocked")?.held?.reason, "Still not right after 3 tries.");
  assert.deepEqual(calls.started, [], "nothing to claim, so no agent is started");

  // A person answers: the task is ready again, and one agent comes back for it.
  assert.equal(await unblock(board, second.task.id), true);
  assert.equal(await unblock(board, second.task.id), false, "a task that isn't held stays as it is");
  await reconcile(slug, board, boxes, { force: true });
  assert.deepEqual(calls.started, [1]);
  await (await claimAs(board, slug, 1))!.complete("done");
  await reconcile(slug, board, boxes, { force: true });
  now = (await snapshot(slug, board))!;
  assert.equal(now.campaign.phase, "done");
  assert.equal(now.counts.completed, 2);
  assert.equal(calls.torn, 1);
});

test("scaling down stops the agents past the new number, and pausing stops them all without ending the campaign", async () => {
  const { board, boxes, calls, slug } = await started(6, { agents: 4 });
  assert.deepEqual(calls.started.sort(), [1, 2, 3, 4]);
  await scale(slug, 2, board, boxes);
  assert.deepEqual(calls.stopped.sort(), ["w3", "w4"]);
  await change(slug, "paused", board, boxes);
  assert.equal((await campaign(slug, board))!.phase, "paused");
  assert.equal((await boxes.workers(slug)).length, 0);
  assert.equal(calls.torn, 0, "a paused campaign keeps its checkout");
  await change(slug, "running", board, boxes);
  assert.equal((await boxes.workers(slug)).length, 2);
  await change(slug, "stopped", board, boxes);
  assert.equal((await campaign(slug, board))!.phase, "stopped");
  assert.equal(calls.torn, 1);
  await assert.rejects(change(slug, "running", board, boxes), /stopped campaign can't be running/);
});

test("two reconciles at once take one turn between them", async () => {
  const { board, boxes, calls, up, slug } = await started(4, { agents: 2 });
  up.clear();
  calls.started.length = 0;
  await Promise.all([reconcile(slug, board, boxes, { force: true }), reconcile(slug, board, boxes, { force: true })]);
  assert.deepEqual(calls.started.sort(), [1, 2]);
});

test("the sandbox installs the versions this package is written against", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const pinned = { ...manifest.devDependencies, ...manifest.dependencies };
  for (const [name, version] of Object.entries(RUNTIME)) assert.equal(pinned[name], version, name);
});
