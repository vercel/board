import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "experimental-a2/store-memory";
import { deliverSchedulerAppend } from "experimental-a2/server";
import { CLOSE_H, FACTORY_BOT, PINGS_H, followups } from "../app/api/board/[[...path]]/followup.ts";

const HOUR = 60 * 60_000;
const DRI = "slack:user:U0AP7QRUM7E";
const PR_THREAD = 1240;
const SOURCE = 1163;

/** The follow-up server and watcher over a memory store, with a scheduler that holds timers until the test fires them. */
function harness({ pr = { state: "open", merged: false, head: { ref: `pi/${SOURCE}` } }, source } = {}) {
  const timers = [];
  const replies = [];
  const requests = [];
  const scheduler = {
    schedule: async (task) => { if (task.kind === "append") timers.push(task); },
    handler: () => async () => new Response(null),
  };
  const roots = {
    [SOURCE]: source ?? { id: SOURCE, re: null, by: { actor: DRI, profile: null } },
  };
  const board = {
    thread: async (id) => {
      if (!roots[id]) throw new Error("not found");
      return { message: roots[id], replies: [] };
    },
  };
  const f = followups({
    store: memory(),
    scheduler,
    client: (key) => ({ reply: async (id, text) => { replies.push({ id, text, key }); } }),
    token: async () => "test-token",
    fetch: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json(pr);
    },
  });
  /** Waits out the handlers an append started in the background. */
  const settle = async () => {
    while (!(await f.server.drain(`pr:${PR_THREAD}`)).settled) await new Promise((r) => setTimeout(r, 5));
  };
  let index = 0;
  const run = (event) => f.watcher.run({ event: { index: ++index, ...event }, board });
  return {
    f, timers, replies, requests, pr,
    opened: () => run({
      type: "message.posted",
      message: { id: PR_THREAD, re: null, labels: { pr: "basehub-ai/vboard#81", state: "open" }, by: { actor: FACTORY_BOT, profile: null } },
    }),
    said: (actor, thread, id = 2000 + index) => run({
      type: "message.posted",
      message: { id, re: thread, labels: {}, by: { actor, profile: null } },
    }),
    labeled: (state) => run({
      type: "labels.changed",
      payload: { set: { state }, unset: [] },
      message: { id: PR_THREAD, re: null, labels: { pr: "basehub-ai/vboard#81", state }, by: { actor: FACTORY_BOT, profile: null } },
    }),
    /** Fires the next pending timer, as the queue would at its due time. */
    fire: async () => {
      const task = timers.shift();
      assert.ok(task, "no timer pending");
      await deliverSchedulerAppend(f.server, task);
      await settle();
      return task;
    },
    settle,
  };
}

const offset = (task, from) => (task.dueAt - from) / HOUR;
const armedAt = async (h) => (await h.f.server.session(`pr:${PR_THREAD}`).history())[0].createdAt.getTime();

test("a factory PR pings the source thread's author at 1h, then doubling gaps, and closes it a week after it opened", async () => {
  const h = harness();
  await h.opened();
  await h.settle();
  const start = await armedAt(h);
  assert.equal(h.requests[0].url, "https://api.github.com/repos/basehub-ai/vboard/pulls/81");

  const due = [];
  for (let round = 1; round <= PINGS_H.length; round++) {
    due.push(offset(h.timers[0], start));
    await h.fire();
  }
  assert.deepEqual(due, [1, 3, 7, 15, 31, 63, 127], "the gap doubles: 1h, 2h, 4h, ... 64h");
  assert.equal(h.replies.length, 7);
  for (const [i, reply] of h.replies.entries()) {
    assert.equal(reply.id, PR_THREAD);
    assert.ok(reply.text.startsWith(`@[${DRI}] reminder ${i + 1}/7: PR #81 (from #${SOURCE})`));
  }
  assert.equal(new Set(h.replies.map((r) => r.key)).size, 7, "each ping posts under its own idempotency key");

  assert.equal(offset(h.timers[0], start), CLOSE_H, "closes a week after the PR opened");
  // Each timer is armed when the one before it fires, so what has to fit Vercel Queues' 6-day cap is the gap.
  const hops = [...due, CLOSE_H].map((at, i, all) => at - (all[i - 1] ?? 0));
  assert.ok(Math.max(...hops) < 6 * 24, `every hop fits the 6-day cap: ${hops}`);
  await h.fire();
  assert.deepEqual(h.requests.at(-1), { url: "https://api.github.com/repos/basehub-ai/vboard/pulls/81", method: "PATCH", body: { state: "closed" } });
  assert.equal(h.replies.length, 8);
  assert.ok(h.replies[7].text.startsWith(`@[${DRI}] closed PR #81 after a week`));
  assert.deepEqual(h.timers, [], "nothing fires after the close");
});

test("the DRI replying in the source thread or the PR thread starts the cycle over; old timers do nothing", async () => {
  const h = harness();
  await h.opened();
  await h.settle();
  await h.fire(); // ping 1
  const stale = h.timers.shift(); // ping 2, from the first cycle

  await h.said(DRI, SOURCE);
  await h.settle();
  const history = await h.f.server.session(`pr:${PR_THREAD}`).history();
  const reset = history.find((e) => e.type === "followup.reset");
  assert.ok(reset, "the DRI's reply in the source thread resets");
  assert.equal(offset(h.timers[0], reset.createdAt.getTime()), 1, "back to 1h after the reply");

  await deliverSchedulerAppend(h.f.server, stale);
  await h.settle();
  assert.equal(h.replies.length, 1, "a timer from the old cycle doesn't ping");
  assert.equal(h.timers.length, 1, "nor does it arm another");

  await h.fire();
  assert.ok(h.replies[1].text.includes("reminder 1/7"), "the new cycle counts from 1 again");

  h.timers.length = 0;
  await h.said(DRI, PR_THREAD);
  await h.settle();
  assert.equal(h.timers.length, 1, "a reply in the PR thread resets too");
});

test("someone other than the DRI talking doesn't reset", async () => {
  const h = harness();
  await h.opened();
  await h.settle();
  await h.said("slack:user:U09R3BTUDE3", SOURCE);
  await h.said("slack:user:U09R3BTUDE3", PR_THREAD);
  await h.settle();
  const types = (await h.f.server.session(`pr:${PR_THREAD}`).history()).map((e) => e.type);
  assert.deepEqual(types, ["followup.armed"]);
});

for (const state of ["merged", "closed"]) {
  test(`a ${state} PR stops its follow-up`, async () => {
    const h = harness();
    await h.opened();
    await h.settle();
    await h.labeled(state);
    await h.settle();
    await h.fire();
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.timers, []);
    await h.said(DRI, SOURCE);
    await h.settle();
    assert.deepEqual(h.timers, [], "a stopped follow-up doesn't restart");
  });
}

test("at the close, a PR GitHub says is no longer open is left alone", async () => {
  const h = harness();
  await h.opened();
  await h.settle();
  for (let i = 0; i < PINGS_H.length; i++) await h.fire();
  h.pr.state = "closed";
  h.pr.merged = true;
  await h.fire();
  assert.equal(h.requests.filter((r) => r.method === "PATCH").length, 0);
  assert.equal(h.replies.length, 7);
});

test("retries converge: arming twice schedules one cycle", async () => {
  const h = harness();
  await h.opened();
  await h.opened();
  await h.settle();
  const types = (await h.f.server.session(`pr:${PR_THREAD}`).history()).map((e) => e.type);
  assert.deepEqual(types, ["followup.armed"]);
  assert.deepEqual(new Set(h.timers.map((t) => t.id)).size, 1);
});

test("only factory PRs from a pi/<thread> branch, built for a person's thread, are followed up", async () => {
  const notPi = harness({ pr: { state: "open", head: { ref: "changeset-release/main" } } });
  await notPi.opened();
  const byPi = harness({ source: { id: SOURCE, re: null, by: { actor: "vercel:project:p:production+pi", profile: "pi" } } });
  await byPi.opened();
  const missing = harness({ pr: { state: "open", head: { ref: "pi/9999" } } });
  await missing.opened();
  for (const h of [notPi, byPi, missing]) {
    await h.settle();
    assert.deepEqual(h.timers, []);
    assert.deepEqual(await h.f.server.session(`pr:${PR_THREAD}`).history(), []);
  }

  const someone = harness();
  await someone.f.watcher.run({
    event: { index: 1, type: "message.posted", message: { id: PR_THREAD, re: null, labels: { pr: "basehub-ai/vboard#81" }, by: { actor: "github:user:1", profile: null } } },
    board: {},
  });
  assert.deepEqual(someone.requests, [], "a person's PR isn't looked up at all");
});
