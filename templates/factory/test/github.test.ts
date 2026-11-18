import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutForksOrOwn } from "../app/api/board/[[...path]]/github.ts";

// What each GitHub event does on the board, called as the board calls a repo's sync function: the
// channel it's imported into starts a thread there; none lands it only in a thread the board has.

type Fn = (sync: unknown) => Promise<void>;

const pr = (head: string | null, base = "acme/web", user = "someone") => ({
  pull_request: { number: 7, title: "Fix login", html_url: "https://github.com/acme/web/pull/7", user: { login: user }, head: { ref: "fix", repo: head === null ? null : { full_name: head } }, base: { ref: "main", repo: { full_name: base } } },
});
const issue = { issue: { number: 3, title: "Login is broken", html_url: "https://github.com/acme/web/issues/3" } };

async function imported(event: { type: string; raw: unknown }, direction: "in" | "out" = "in", factory: string | null = "factory[bot]") {
  const into: (string | undefined)[] = [];
  const fn = withoutForksOrOwn({ "acme/web": "dev" }, async () => factory)["acme/web"] as Fn;
  await fn({ direction, channel: "acme/web:pulls", event, import: async (channel?: string) => void into.push(channel) });
  return into;
}

test("a PR from a branch of its own repo starts a thread in the repo's channel", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web") }), ["dev"]);
});

test("a fork's PR, and its reviews, start no thread", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("someone/web") }), [undefined]);
  assert.deepEqual(await imported({ type: "review.submitted", raw: pr("someone/web") }), [undefined]);
});

test("the factory's own PR, and its reviews, start no thread: the agent follows them from the thread it built them for", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web", "acme/web", "factory[bot]") }), [undefined]);
  assert.deepEqual(await imported({ type: "review.submitted", raw: pr("acme/web", "acme/web", "factory[bot]") }), [undefined]);
});

test("another bot's PR starts a thread", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web", "acme/web", "dependabot[bot]") }), ["dev"]);
});

test("when the factory's login can't be looked up, its PRs start threads like anyone's", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web", "acme/web", "factory[bot]") }, "in", null), ["dev"]);
});

test("a PR whose fork is gone starts no thread", async () => {
  assert.deepEqual(await imported({ type: "pr.reopened", raw: pr(null) }), [undefined]);
});

test("an issue starts a thread in the repo's channel", async () => {
  assert.deepEqual(await imported({ type: "issue.opened", raw: issue }), ["dev"]);
});

test("a comment only lands in a thread the board already has", async () => {
  assert.deepEqual(await imported({ type: "comment", raw: issue }), [undefined]);
});

test("nothing goes back to GitHub", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web") }, "out"), []);
});
