import assert from "node:assert/strict";
import { test } from "node:test";
import { shipit } from "../app/api/board/[[...path]]/shipit.ts";

function event() {
  return {
    cursor: "71",
    type: "reaction.added",
    actor: { id: "slack:user:U123", handle: "sam" },
    payload: {
      emoji: "shipit",
      from: "slack",
      by: { actor: "slack:user:U123", principal: "slack:user:U123" },
    },
    message: {
      id: "59",
      re: null,
      labels: { pr: "vercel-labs/board#53", state: "open" },
      by: { actor: "github:user:40034115", principal: "github:user:40034115" },
    },
  };
}

function harness(responses) {
  const requests = [];
  const notifications = [];
  let tokens = 0;
  const watcher = shipit({
    tellEve: async input => { notifications.push(input); },
    token: async () => { tokens++; return "test-token"; },
    fetch: async (url, init) => {
      requests.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
      const response = responses.shift();
      assert.ok(response, "unexpected GitHub request");
      if (response instanceof Error) throw response;
      return Response.json(response.body, { status: response.status ?? 200 });
    },
  });
  return {
    requests,
    notifications,
    tokens: () => tokens,
    run: (input = event()) => watcher.run({ event: input }),
  };
}

const open = () => ({ body: { merged: false, state: "open", draft: false, head: { sha: "abc123" } } });
const draft = () => ({ body: { ...open().body, draft: true, node_id: "PR_test" } });
const ready = () => ({ body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } });
const merged = () => ({ body: { merged: true } });

test("shipit marks a draft ready before merging the same head", async () => {
  const h = harness([draft(), ready(), merged()]);
  await h.run();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[1].url, "https://api.github.com/graphql");
  assert.equal(h.requests[1].method, "POST");
  assert.ok(h.requests[1].body.query.includes("markPullRequestReadyForReview"));
  assert.deepEqual(h.requests[1].body.variables, { id: "PR_test" });
  assert.equal(h.requests[2].method, "PUT");
  assert.deepEqual(h.requests[2].body, { sha: "abc123", merge_method: "merge" });
  assert.deepEqual(h.notifications, []);
});

test("a failed ready mutation tells Eve the merge intent without attempting to merge", async () => {
  const h = harness([draft(), { body: { errors: [{ message: "Not allowed to mark this PR ready." }] } }]);
  await h.run();
  assert.equal(h.requests.length, 2);
  assertIntent(h, "Not allowed to mark this PR ready.");
});

test("a retry reads the current draft status and does not mark it ready again", async () => {
  const h = harness([draft(), ready(), { status: 405, body: { message: "Checks are pending." } }, open(), merged()]);
  await h.run();
  await h.run();
  assert.equal(h.requests.filter(r => r.url === "https://api.github.com/graphql").length, 1);
  assert.equal(h.requests.filter(r => r.method === "PUT").length, 2);
  assertIntent(h, "Checks are pending.");
});

test("shipit, its Slack squirrel alias, and :approved: merge a PR root for any reactor", async () => {
  for (const [emoji, user] of [["shipit", "U123"], ["squirrel", "U123"], ["squirrel", "U456"], ["approved", "U456"]]) {
    const input = event();
    input.payload.emoji = emoji;
    input.payload.by = { actor: `slack:user:${user}`, principal: `slack:user:${user}` };
    const h = harness([open(), merged()]);
    await h.run(input);
    assert.equal(h.tokens(), 1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].url, "https://api.github.com/repos/vercel-labs/board/pulls/53");
    assert.equal(h.requests[0].method, "GET");
    assert.equal(h.requests[1].url, "https://api.github.com/repos/vercel-labs/board/pulls/53/merge");
    assert.equal(h.requests[1].method, "PUT");
    assert.deepEqual(h.requests[1].body, { sha: "abc123", merge_method: "merge" });
    for (const request of h.requests) {
      assert.equal(request.headers.authorization, "Bearer test-token");
      assert.equal(request.headers["x-github-api-version"], "2026-03-10");
      // Every GitHub call has a timeout, so a hung request can't stall the watcher.
      // AbortSignal.timeout ignores mocked timers, so a hung fetch would take the full 15s here.
      assert.ok(request.signal instanceof AbortSignal);
    }
    assert.deepEqual(h.notifications, []);
  }
});

for (const [name, change] of [
  ["a reaction on a reply", e => { e.message.re = 12; }],
  ["a removed reaction", e => { e.type = "reaction.removed"; }],
  ["a different emoji", e => { e.payload.emoji = "merged"; }],
  ["a board reaction", e => { e.payload.from = null; }],
  ["a GitHub reaction", e => { e.payload.from = "github"; }],
  ["a deployment acting as a Slack reactor", e => { e.payload.by.principal = "vercel:project:pi:production"; }],
  ["a PR from another repository", e => { e.message.labels.pr = "other/repo#53"; }],
  ["a malformed PR label", e => { e.message.labels.pr = "vercel-labs/board#53/merge"; }],
  ["an unlabeled thread", e => { e.message.labels = {}; }],
  ["an event without a message", e => { delete e.message; }],
]) {
  test(`ignores ${name} without obtaining credentials or calling GitHub`, async () => {
    const input = event();
    change(input);
    const h = harness([open(), merged()]);
    await h.run(input);
    assert.equal(h.tokens(), 0);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.notifications, []);
    await h.run();
    assert.equal(h.requests.at(-1).url, "https://api.github.com/repos/vercel-labs/board/pulls/53/merge", "the unchanged event merges");
  });
}

test("a failed :approved: merge names the reaction it came from", async () => {
  const input = event();
  input.payload.emoji = "approved";
  const h = harness([open(), { status: 405, body: { message: "Checks are pending." } }]);
  await h.run(input);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].message, /reacted with :approved: to request a merge/);
});

test("a retried callback sees the merged PR and does not merge it again", async () => {
  const h = harness([open(), merged(), merged()]);
  await h.run();
  await h.run();
  assert.equal(h.requests.filter(r => r.method === "PUT").length, 1);
  assert.deepEqual(h.notifications, []);
});

for (const [name, body, reason] of [
  ["draft without a node ID", { ...draft().body, node_id: undefined }, "GitHub did not return the PR's node ID."],
  ["closed", { state: "closed", draft: false }, "The PR is closed."],
  ["missing head", { state: "open", draft: false }, "GitHub did not return the PR's head SHA."],
]) {
  test(`tells Eve the merge intent for a ${name} PR without attempting to merge it`, async () => {
    const h = harness([{ body }]);
    await h.run();
    assert.equal(h.requests.length, 1);
    assertIntent(h, reason);
  });
}

for (const [status, message] of [
  [403, "Required approvals are missing."],
  [405, "Required status checks have not passed."],
  [409, "Head branch was modified."],
]) {
  test(`reports GitHub's ${status} rejection without bypassing rules or retrying another SHA`, async () => {
    const h = harness([open(), { status, body: { message } }]);
    await h.run();
    assert.equal(h.requests.length, 2);
    assertIntent(h, message);
  });
}

test("reports an unsuccessful merge response", async () => {
  const h = harness([open(), { body: { merged: false, message: "Merge conflict." } }]);
  await h.run();
  assertIntent(h, "Merge conflict.");
});

test("tells Eve the merge intent after a connection failure", async () => {
  const h = harness([new Error("fetch failed")]);
  await h.run();
  assertIntent(h, "fetch failed");
});

function assertIntent(h, reason, requester = "sam") {
  assert.equal(h.notifications.length, 1);
  const notification = h.notifications[0];
  assert.equal(notification.task, "review");
  assert.equal(notification.thread, "59");
  assert.equal(notification.key, "shipit-71");
  assert.ok(notification.message.includes(`${requester} (slack:user:U123)`));
  assert.ok(notification.message.includes("request a merge of vercel-labs/board#53"));
  assert.ok(notification.message.includes(reason));
}

test("uses the reactor's verified identity when its display name is unavailable", async () => {
  const h = harness([{ body: { state: "closed", draft: false } }]);
  const input = event();
  delete input.actor;
  await h.run(input);
  assertIntent(h, "The PR is closed.", "slack:user:U123");
});

test("a failed Eve handoff can retry with the same deduplication key", async () => {
  const notifications = [];
  let delivered = false;
  const watcher = shipit({
    token: async () => "test-token",
    fetch: async () => Response.json({ state: "closed", draft: false }),
    tellEve: async input => {
      notifications.push(input);
      if (!delivered) {
        delivered = true;
        throw new Error("sandbox unavailable");
      }
    },
  });
  await assert.rejects(watcher.run({ event: event() }), /sandbox unavailable/);
  await watcher.run({ event: event() });
  assert.deepEqual(notifications.map(n => n.key), ["shipit-71", "shipit-71"]);
});
