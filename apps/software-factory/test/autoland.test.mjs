import assert from "node:assert/strict";
import { test } from "node:test";
import { autoland, decide as decideFor } from "../app/api/board/[[...path]]/autoland.ts";

// Eve posts as the factory's production deployment.
process.env.VERCEL_PROJECT_ID = "prj_factory";
const PI = "vercel:project:prj_factory:production";

const decide = (review, pr, files, checks) => decideFor(review, pr, files, checks, "vboard-factory[bot]");
const review = (over = {}) => ({ land: "yes", why: "fixes the bug as asked", sha: "abc123", ...over });
const pr = (over = {}) => ({ state: "open", merged: false, user: { login: "vboard-factory[bot]" }, head: { sha: "abc123" }, ...over });
const file = (filename, status = "modified") => ({ filename, status });
const green = [{ name: "check", status: "completed", conclusion: "success" }];

test("a reviewed factory PR outside core, with CI green, would land", () => {
  assert.deepEqual(decide(review(), pr(), [file("apps/software-factory/app/x.ts")], green), {
    would: true,
    why: "outside board core",
  });
});

test("an internal core change, with no changeset, would land", () => {
  assert.deepEqual(decide(review(), pr(), [file("packages/board/src/a.ts")], green), {
    would: true,
    why: "internal change to board core",
  });
});

test("a user-facing core change, with a changeset, doesn't land", () => {
  const files = [file("packages/board/src/a.ts"), file(".changeset/brave-cats.md", "added")];
  assert.deepEqual(decide(review(), pr(), files, green), { would: false, why: "user-facing change to board core" });
});

test("a changeset outside core lands, and the changeset README or a removed changeset isn't one", () => {
  assert.equal(decide(review(), pr(), [file("apps/a.ts"), file(".changeset/x.md", "added")], green).would, true);
  const core = file("packages/board/src/a.ts");
  assert.equal(decide(review(), pr(), [core, file(".changeset/README.md")], green).would, true);
  assert.equal(decide(review(), pr(), [core, file(".changeset/old.md", "removed")], green).would, true);
});

test("the package's manifest and build config count as core", () => {
  for (const path of ["packages/board/package.json", "packages/board/tsdown.config.ts"]) {
    const files = [file(path), file(".changeset/x.md", "added")];
    assert.deepEqual(decide(review(), pr(), files, green), { would: false, why: "user-facing change to board core" });
  }
});

test("core tests and docs aren't core source", () => {
  const files = [file("packages/board/test/a.test.ts"), file("packages/board/README.md"), file(".changeset/x.md", "added")];
  assert.equal(decide(review(), pr(), files, green).would, true);
});

test("the reviewer's no is final, with its reason", () => {
  assert.deepEqual(decide(review({ land: "no", why: "has a tradeoff" }), pr(), [file("apps/a.ts")], green), {
    would: false,
    why: "review: has a tradeoff",
  });
});

test("a PR people opened, a closed or merged one, and new commits since the review don't land", () => {
  const files = [file("apps/a.ts")];
  assert.equal(decide(review(), pr({ user: { login: "jb" } }), files, green).why, "opened by jb, not the factory");
  const actions = { login: "github-actions[bot]" };
  assert.equal(decide(review(), pr({ user: actions, head: { sha: "abc123", ref: "board/42" } }), files, green).would, true, "pi-pr's PR is the factory's");
  assert.equal(decide(review(), pr({ user: actions, head: { sha: "abc123", ref: "pi/42" } }), files, green).why, "opened by github-actions[bot], not the factory");
  assert.equal(decide(review(), pr({ user: actions, head: { sha: "abc123", ref: "other" } }), files, green).why, "opened by github-actions[bot], not the factory");
  assert.equal(decide(review(), pr({ state: "closed" }), files, green).why, "the PR is closed");
  assert.equal(decide(review(), pr({ merged: true, state: "closed" }), files, green).why, "the PR is merged");
  assert.equal(decide(review({ sha: "old" }), pr(), files, green).why, "new commits since the review");
  assert.equal(decide(review({ sha: undefined }), pr(), files, green).why, "new commits since the review");
});

test("CI must have passed `check` on the head", () => {
  const files = [file("apps/a.ts")];
  assert.equal(decide(review(), pr(), files, []).why, "CI `check` hasn't run");
  assert.equal(decide(review(), pr(), files, [{ name: "check", status: "in_progress", conclusion: null }]).why, "CI `check` in_progress");
  assert.equal(decide(review(), pr(), files, [{ name: "check", status: "completed", conclusion: "failure" }]).why, "CI `check` failure");
});

function event(over = {}) {
  return {
    cursor: "90",
    type: "labels.changed",
    payload: {
      id: "59",
      set: { land: "yes", "land.why": "fixes the bug", "land.sha": "abc123" },
      unset: [],
      by: { actor: `${PI}+pi`, principal: PI, profile: "pi", session: "thread-59" },
    },
    message: {
      id: "59",
      re: null,
      labels: { pr: "vercel-labs/board#53", land: "yes", "land.why": "fixes the bug", "land.sha": "abc123" },
    },
    ...over,
  };
}

function harness(routes) {
  const requests = [];
  const labels = [];
  const watcher = autoland({
    token: async () => "test-token",
    fetch: async (url) => {
      requests.push(url);
      const path = url.replace("https://api.github.com/repos/vercel-labs/board", "");
      const body = routes[path];
      assert.ok(body, `unexpected GitHub request: ${path}`);
      if (body instanceof Error) throw body;
      return Response.json(body.json ?? body, { status: body.status ?? 200 });
    },
  });
  const reactions = [];
  const board = {
    label: async (id, change) => { labels.push({ id, ...change }); },
    react: async (id, emoji, opts = {}) => { reactions.push({ id, emoji, ...opts }); },
  };
  return { requests, labels, reactions, run: (input = event()) => watcher.run({ event: input, board }) };
}

const routes = (files = [file("apps/a.ts")]) => ({
  "/pulls/53": pr(),
  "/pulls/53/files?per_page=100&page=1": files,
  "/commits/abc123/check-runs?check_name=check&filter=latest": { check_runs: green },
  // The factory's bot, as GraphQL names it: without REST's `[bot]`.
  "https://api.github.com/graphql": { data: { viewer: { databaseId: 1, login: "vboard-factory" } } },
});

test("the watcher labels the PR thread with its decision and merges nothing", async () => {
  const h = harness(routes());
  await h.run();
  assert.deepEqual(h.labels, [{ id: "59", set: { autoland: "would", "autoland.why": "outside board core" } }]);
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests.every((url) => !url.includes("/merge")));
});

test("the watcher pages through a PR's files", async () => {
  const many = Array.from({ length: 100 }, (_, i) => file(`apps/${i}.ts`));
  const h = harness({
    ...routes(many),
    "/pulls/53/files?per_page=100&page=2": [file("packages/board/src/a.ts"), file(".changeset/x.md", "added")],
  });
  await h.run();
  assert.deepEqual(h.labels[0].set, { autoland: "no", "autoland.why": "user-facing change to board core" });
});

test("only the PR thread's own Eve can set the verdict", async () => {
  for (const by of [
    { actor: "slack:user:U1", principal: "slack:user:U1", profile: null, session: null },
    { actor: `${PI}+pi`, principal: PI, profile: "pi", session: "thread-12" },
    // Anyone who can write sends a profile and session: a person, or a preview of some branch.
    { actor: "vercel:user:abc+pi", principal: "vercel:user:abc", profile: "pi", session: "thread-59" },
    { actor: "vercel:project:prj_factory:preview+pi", principal: "vercel:project:prj_factory:preview", profile: "pi", session: "thread-59" },
  ]) {
    const h = harness(routes());
    await h.run(event({ payload: { ...event().payload, by } }));
    assert.deepEqual(h.labels, []);
    assert.deepEqual(h.requests, []);
  }
  const own = harness(routes());
  await own.run();
  assert.equal(own.labels[0].set.autoland, "would", "thread-59's own Eve sets it");
});

test("the watcher ignores other labels, replies, and other repos", async () => {
  const h = harness(routes());
  await h.run(event({ payload: { ...event().payload, set: { kind: "bug" } } }));
  await h.run(event({ type: "message.posted" }));
  await h.run(event({ message: { ...event().message, re: "12" } }));
  await h.run(event({ message: { ...event().message, labels: { ...event().message.labels, pr: "vercel/v0#1" } } }));
  assert.deepEqual(h.labels, []);
  assert.deepEqual(h.requests, []);
  await h.run();
  assert.equal(h.labels[0].set.autoland, "would", "the same harness labels a land verdict on a board PR root");
});

test("when GitHub fails, it says no and why", async () => {
  const h = harness({ "/pulls/53": { status: 404, json: { message: "Not Found" } } });
  await h.run();
  assert.deepEqual(h.labels[0].set, { autoland: "no", "autoland.why": "couldn't read the PR: Not Found" });
});

const withVerdict = (autoland) => event({ message: { ...event().message, labels: { ...event().message.labels, autoland } } });

test("a PR that would land gets :stamp-hammer: on its root", async () => {
  const h = harness(routes());
  await h.run();
  assert.deepEqual(h.reactions, [{ id: "59", emoji: "stamp-hammer", remove: false }]);
});

test("the stamp comes off when the verdict flips to no", async () => {
  const h = harness(routes([file("packages/board/src/a.ts"), file(".changeset/x.md", "added")]));
  await h.run(withVerdict("would"));
  assert.deepEqual(h.labels[0].set.autoland, "no");
  assert.deepEqual(h.reactions, [{ id: "59", emoji: "stamp-hammer", remove: true }]);
});

test("the stamp is left alone when the verdict doesn't change", async () => {
  const stays = harness(routes());
  await stays.run(withVerdict("would"));
  assert.equal(stays.labels[0].set.autoland, "would");
  const never = harness({ "/pulls/53": { status: 404, json: { message: "Not Found" } } });
  await never.run();
  await never.run(withVerdict("no"));
  assert.equal(never.labels[1].set.autoland, "no");
  assert.deepEqual([...stays.reactions, ...never.reactions], []);
});
