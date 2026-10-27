import assert from "node:assert/strict";
import { test } from "node:test";
import { security } from "../app/api/board/[[...path]]/security.ts";

function event() {
  return {
    cursor: "88",
    type: "reaction.added",
    actor: { id: "slack:user:U123", handle: "sam" },
    payload: {
      emoji: "security",
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

function harness() {
  const notifications = [];
  const replies = [];
  const reactions = [];
  const watcher = security({ tellEve: async input => { notifications.push(input); } });
  const board = {
    reply: async (id, text) => { replies.push({ id, text }); },
    react: async (id, emoji) => { reactions.push({ id, emoji }); },
  };
  return { notifications, replies, reactions, watcher, run: (input = event()) => watcher.run({ event: input, board }) };
}

test(":security: on a PR root asks Eve for a deepsec review of the diff, for any Slack reactor", async () => {
  for (const user of ["U123", "U456"]) {
    const input = event();
    input.payload.by = { actor: `slack:user:${user}`, principal: `slack:user:${user}` };
    const h = harness();
    await h.run(input);
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.reactions, [], "only Eve reacts :secure:, after deepsec exits 0");
    assert.equal(h.notifications.length, 1);
    const n = h.notifications[0];
    assert.equal(n.task, "review");
    assert.equal(n.thread, "59");
    assert.equal(n.key, "security-88");
    assert.ok(n.message.includes(`(slack:user:${user}) reacted with :security:`));
    assert.ok(n.message.includes("vercel-labs/board#53"));
    assert.ok(n.message.includes("gh pr checkout 53"));
    assert.ok(n.message.includes("vb react 59 secure"));
  }
});

test("names the requester by handle, or by verified identity without one", async () => {
  const h = harness();
  await h.run();
  assert.ok(h.notifications[0].message.startsWith("sam (slack:user:U123)"));
  const input = event();
  delete input.actor;
  const g = harness();
  await g.run(input);
  assert.ok(g.notifications[0].message.startsWith("slack:user:U123 (slack:user:U123)"));
});

for (const [name, change] of [
  ["an unlabeled thread", e => { e.message.labels = { kind: "bug" }; }],
  ["a PR from another repository", e => { e.message.labels.pr = "other/repo#53"; }],
  ["a malformed PR label", e => { e.message.labels.pr = "vercel-labs/board#53/merge"; }],
]) {
  test(`on ${name}, replies that :security: works on PR threads without waking Eve`, async () => {
    const input = event();
    change(input);
    const h = harness();
    await h.run(input);
    assert.deepEqual(h.notifications, []);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].id, "59");
    assert.ok(h.replies[0].text.includes("works on PR threads"));
  });
}

for (const [name, change] of [
  ["a reaction on a reply", e => { e.message.re = 12; }],
  ["a removed reaction", e => { e.type = "reaction.removed"; }],
  ["a different emoji", e => { e.payload.emoji = "shipit"; }],
  ["its own :secure: reaction", e => { e.payload.emoji = "secure"; }],
  ["a board reaction", e => { e.payload.from = null; }],
  ["a GitHub reaction", e => { e.payload.from = "github"; }],
  ["Eve or a deployment acting as a Slack reactor", e => { e.payload.by.principal = "vercel:project:pi:production"; }],
  ["a posted message", e => { e.type = "message.posted"; }],
  ["an event without a message", e => { delete e.message; }],
]) {
  test(`ignores ${name}`, async () => {
    const input = event();
    change(input);
    const h = harness();
    await h.run(input);
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.reactions, []);
    await h.run();
    assert.equal(h.notifications.length, 1, "the unchanged event reaches Eve");
  });
}

test("a retried callback sends Eve the same deduplication key", async () => {
  const h = harness();
  await h.run();
  await h.run();
  assert.deepEqual(h.notifications.map(n => n.key), ["security-88", "security-88"]);
});

test("runs deepsec in a worktree named for the event, and attaches its files by full path", async () => {
  // A shell variable doesn't outlive one of Eve's commands, and its commands don't keep their cwd.
  const input = event();
  input.cursor = "91";
  const g = harness();
  await g.run(input);
  const m = g.notifications[0].message;
  // rm -rf alone leaves a worktree an earlier run left behind registered, and git worktree add refuses the path.
  assert.ok(m.includes("git worktree remove --force /tmp/deepsec-91 2>/dev/null; rm -rf /tmp/deepsec-91; git worktree prune && git worktree add --detach /tmp/deepsec-91 HEAD"));
  // Its data/, deepsec.md and deepsec.log never land in the clone, so a later git add -A can't commit them.
  assert.ok(m.indexOf("git worktree add") < m.indexOf("npx -y deepsec process"));
  // Three dots: only the PR's own changes, not commits that landed on its base since it branched.
  assert.ok(m.includes("deepsec process --diff origin/<base>...HEAD "));
  assert.ok(m.includes("attach /tmp/deepsec-91/deepsec.log"));
  assert.ok(m.includes("attach /tmp/deepsec-91/deepsec.md"));
});
