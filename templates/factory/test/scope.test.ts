import assert from "node:assert/strict";
import { test } from "node:test";
import { githubScope, threadRepos } from "../lib/github.ts";

// What a thread's GitHub token covers: what agent/lib/credentials.ts asks Vercel Connect for each turn.

const REPOS = ["acme/factory", "acme/web", "other/api"];

// Where a root came from, as the board writes it: a GitHub PR or issue, a Slack thread, or nowhere (posted on the board).
const fromGitHub = (repo: string, n = 7) => ({ origin: { thread: `github:${repo}:${n}` } });
const fromSlack = { origin: { thread: "slack:C0123ABC:1727000000.123456" } };
const onTheBoard = { origin: null };

test("a thread from a GitHub PR or issue gets its own repo alone, from where the board says it came from", () => {
  assert.deepEqual(threadRepos(fromGitHub("acme/web"), REPOS), ["acme/web"]);
  assert.deepEqual(threadRepos(fromGitHub("Acme/Factory", 3), REPOS), ["acme/factory"]);
});

test("any other thread gets the repos the board brings in, not every repo the app is on", () => {
  assert.deepEqual(threadRepos(fromSlack, REPOS), REPOS);
  assert.deepEqual(threadRepos(onTheBoard, REPOS), REPOS);
});

test("a label can't widen a thread's token: anyone can set one, so only origin counts", () => {
  const labeled = { ...onTheBoard, labels: { pr: "evil/other#1", issue: "acme/secret#2" } };
  assert.deepEqual(threadRepos(labeled, REPOS), REPOS);
});

test("a GitHub thread from a repo outside the list, or a thread that couldn't be read, gets nothing", () => {
  assert.deepEqual(threadRepos(fromGitHub("evil/other"), REPOS), []);
  assert.deepEqual(threadRepos(null, REPOS), []);
});

test("Connect is asked for one org's repos, by name: the first repo's org", () => {
  assert.deepEqual(githubScope(["acme/factory", "acme/web", "other/api"]), [{ type: "github_app_installation", org: "acme", repositories: ["factory", "web"] }]);
});

test("no repos, no token", () => {
  assert.equal(githubScope([]), null);
});
