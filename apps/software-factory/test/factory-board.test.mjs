import assert from "node:assert/strict";
import { test } from "node:test";
import { vercelTrustedSources } from "../app/api/board/[[...path]]/trusted-sources.ts";
import { caller, deploymentToken, personToken, testBoard, TEAM_ID } from "../../../packages/board/test/harness.ts";

const URL = "http://board.test/api/board";
const grants = JSON.stringify([{ projectId: "prj_factory", teamId: TEAM_ID }]);
const options = { url: URL, access: vercelTrustedSources(grants) };
const token = (environment = "production", overrides) => deploymentToken("factory", "prj_factory", environment, { audience: URL, ...overrides });

test("requires explicit immutable project/team grants and defaults to production", () => {
  assert.deepEqual(vercelTrustedSources(undefined), []);
  assert.deepEqual(vercelTrustedSources(""), []);
  for (const grant of [
    { projectId: "factory", teamId: TEAM_ID },
    { projectId: "prj_factory" },
    { projectId: "prj_factory", teamId: TEAM_ID, environments: [] },
    { projectId: "prj_factory", teamId: TEAM_ID, can: ["sync"] },
  ]) assert.throws(() => vercelTrustedSources(JSON.stringify([grant])));
  assert.throws(() => vercelTrustedSources("not JSON"), {
    message: "Invalid BOARD_TRUSTED_SOURCES: expected valid JSON",
  });
});

test("trusted Factory sessions discover, post, review and respond with verified provenance", async () => {
  const board = testBoard(options);
  const author = caller(board.fetch, await token(), { "x-board-profile": "factory", "x-board-session": "author-task-1" });
  const reviewer = caller(board.fetch, await token(), { "x-board-profile": "factory", "x-board-session": "review-task-2" });
  const channel = "factory/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/ci-health";
  const posted = await author("POST", "/messages", {
    channel, text: "Reproduced timeout: artifact://log-a", id: "factory-repro", noSync: true,
    labels: { "factory-task": "task-1", "factory-workflow": "ci" },
  });
  assert.equal(posted.status, 201);
  const root = posted.body.message;
  assert.equal(root.by.principal, "vercel:project:prj_factory:production");
  assert.equal(root.by.session, "author-task-1");
  assert.equal(root.channel, channel);
  const found = await reviewer("GET", `/messages?channel=${encodeURIComponent(channel)}&text=timeout&limit=1`);
  assert.equal(found.status, 200);
  assert.equal(found.body.messages[0].id, root.id);
  const review = await reviewer("POST", "/messages", { re: root.id, text: "Also fails before the patch: artifact://log-b", id: "factory-review", noSync: true });
  assert.equal(review.status, 201);
  const read = await author("GET", `/messages?channel=${encodeURIComponent(channel)}&re=${root.id}&after=${root.id}&limit=1`);
  assert.equal(read.body.messages[0].by.session, "review-task-2");
  const response = await author("POST", "/messages", { re: root.id, text: "Revised diagnosis: missing startup prerequisite.", id: "factory-response", noSync: true });
  assert.equal(response.status, 201);
  const replay = await author("POST", "/messages", { channel, text: root.text, labels: root.labels, id: "factory-repro", noSync: true });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.message.id, root.id);
  assert.equal((await author("GET", "/channels")).body.channels[0].path, channel);
  // Labels only in factory/ channels: on dev they'd drive Eve.
  assert.equal((await author("POST", `/messages/${root.id}/labels`, { set: { "factory-task": "task-2" } })).status, 200);
  const person = caller(board.fetch, await personToken("u_operator", URL));
  const dev = (await person("POST", "/messages", { channel: "dev", text: "Existing dev work", noSync: true })).body.message;
  assert.equal((await author("GET", `/messages/${dev.id}`)).status, 200);
  assert.equal((await author("POST", `/messages/${dev.id}/labels`, { set: { kind: "bug" } })).status, 403);
  assert.equal((await author("POST", "/messages", { channel: "dev", text: "Labeled", labels: { kind: "bug" }, noSync: true })).status, 403);
  assert.equal((await author("POST", `/messages/${root.id}/reactions`, { emoji: "eyes" })).status, 403);
});

test("refuses unconfigured projects, wrong teams, environments, audiences and malformed tokens", async () => {
  const board = testBoard(options);
  assert.equal((await caller(testBoard({ url: URL }).fetch, await token())("GET", "/me")).status, 403);
  for (const candidate of [
    await deploymentToken("other", "prj_other", "production", { audience: URL }),
    await token("production", { teamId: "team_other" }),
    await token("preview"),
    await token("development"),
  ]) assert.equal((await caller(board.fetch, candidate)("GET", "/me")).status, 403);
  assert.equal((await caller(board.fetch, await token("production", { audience: "http://other.test/api/board" }))("GET", "/me")).status, 401);
  assert.equal((await caller(board.fetch, "not-a-jwt")("GET", "/me")).status, 401);
});

test("operators inspect Factory and software-factory discussions in one board", async () => {
  const board = testBoard(options);
  const inspector = caller(board.fetch, await personToken("u_operator", URL));
  assert.equal((await inspector("GET", "/me")).body.kind, "person");
  await inspector("POST", "/messages", { channel: "dev", text: "Existing software factory work" });
  const factory = caller(board.fetch, await token());
  await factory("POST", "/messages", { channel: "factory/project/repo/ci-health", text: "Shared Factory evidence", noSync: true });
  const channels = (await inspector("GET", "/channels")).body.channels.map(c => c.path);
  assert.deepEqual(channels.sort(), ["dev", "factory/project/repo/ci-health"]);
  assert.equal((await inspector("GET", "/messages")).body.messages.length, 2);
});

test("explicit preview grants work on the same endpoint", async () => {
  const board = testBoard({ url: URL, access: vercelTrustedSources(JSON.stringify([
    { projectId: "prj_factory", teamId: TEAM_ID, environments: ["preview"] },
  ])) });
  assert.equal((await caller(board.fetch, await token("preview"))("GET", "/me")).status, 200);
});

test("PR-labeled Factory discussions stay off dev automation and external sync", async () => {
  const { autoland } = await import("../app/api/board/[[...path]]/autoland.ts");
  const { shipit } = await import("../app/api/board/[[...path]]/shipit.ts");
  const { security } = await import("../app/api/board/[[...path]]/security.ts");
  const { owner } = await import("../app/api/board/[[...path]]/owner.ts");
  const { crosspost } = await import("../app/api/board/[[...path]]/crosspost.ts");
  const { fakePlatform } = await import("../../../packages/board/test/sync-fixtures.ts");
  const { channels, slack } = await import("../../../packages/board/src/sync/slack.ts");
  const { github, repos } = await import("../../../packages/board/src/sync/github.ts");
  const { issues, pulls } = await import("../app/api/board/[[...path]]/quiet.ts");
  const slackPlatform = fakePlatform("slack");
  const githubPlatform = fakePlatform("github");
  const watched = [];
  const noEve = async () => { throw new Error("must not start a live agent"); };
  const watchers = { autoland: autoland(), shipit: shipit({ tellEve: noEve }), security: security({ tellEve: noEve }), owner: owner(), crosspost: crosspost() };
  const board = testBoard({
    ...options,
    sync: {
      slack: slack({ adapter: slackPlatform.adapter }, channels({ C1: "dev" })),
      github: github({ adapter: githubPlatform.adapter }, repos({ "vercel-labs/board": { pulls, issues } })),
    },
    watch: Object.fromEntries(Object.entries(watchers).map(([name, watcher]) => [name, {
      ...watcher, run: ({ event }) => { watched.push([name, event.message?.channel]); },
    }])),
  });
  const operator = caller(board.fetch, await personToken());
  const factory = caller(board.fetch, await token());
  const labels = { pr: "vercel-labs/board#123", kind: "bug" };
  const posted = await factory("POST", "/messages", { channel: "factory/project/repo/ci-health", text: "Review evidence", labels, noSync: true });
  assert.equal(posted.status, 201);
  await operator("POST", `/messages/${posted.body.message.id}/reactions`, { emoji: "shipit" });
  // Test channel routing independently of the Factory's noSync safeguard too.
  await operator("POST", "/messages", { channel: "factory/project/repo/ci-health", text: "Internal evidence", labels });
  await operator("POST", "/messages", { channel: "dev", text: "Existing dev behavior", labels });
  const deadline = Date.now() + 5000;
  while ((new Set(watched.map(([name]) => name)).size !== 5 || slackPlatform.channelPosts.length !== 1) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(new Set(watched.map(([name]) => name)).size, 5);
  assert.ok(watched.every(([, channel]) => channel === "dev"));
  assert.equal(slackPlatform.channelPosts.length, 1);
  assert.equal(githubPlatform.channelPosts.length, 0);
  assert.equal(githubPlatform.posts.length, 0);
  assert.match(slackPlatform.channelPosts[0].text, /Existing dev behavior/);
  await board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "existing-dev-pr" },
    body: JSON.stringify({ action: "opened", repository: { full_name: "vercel-labs/board" }, sender: { login: "reviewer", id: 42 },
      pull_request: { number: 123, title: "Existing GitHub work", html_url: "https://github.com/vercel-labs/board/pull/123", draft: false, merged: false } }),
  }));
  let githubRoot;
  const until = Date.now() + 5000;
  while (!githubRoot && Date.now() < until) {
    githubRoot = (await operator("GET", "/messages?channel=dev&text=Existing%20GitHub%20work")).body.messages[0];
    if (!githubRoot) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(githubRoot);
  // A board reply in a PR's thread (an Eve's, say) reaches Slack but not the PR on GitHub.
  const slackBefore = slackPlatform.posts.length;
  await operator("POST", "/messages", { re: githubRoot.re ?? githubRoot.id, text: "Existing dev response" });
  while (slackPlatform.posts.length === slackBefore && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slackPlatform.posts.slice(slackBefore).some((post) => /Existing dev response/.test(post.text)));
  assert.equal(githubPlatform.posts.length, 0);
  // So does one in an issue's thread.
  await board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST", headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "existing-dev-issue" },
    body: JSON.stringify({ action: "opened", repository: { full_name: "vercel-labs/board" }, sender: { login: "reporter", id: 43 },
      issue: { number: 124, title: "Existing GitHub issue", html_url: "https://github.com/vercel-labs/board/issues/124" } }),
  }));
  let issueRoot;
  while (!issueRoot && Date.now() < until) {
    issueRoot = (await operator("GET", "/messages?channel=dev&text=Existing%20GitHub%20issue")).body.messages[0];
    if (!issueRoot) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(issueRoot);
  const slackBeforeIssue = slackPlatform.posts.length;
  await operator("POST", "/messages", { re: issueRoot.re ?? issueRoot.id, text: "Existing issue response" });
  while (slackPlatform.posts.length === slackBeforeIssue && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slackPlatform.posts.slice(slackBeforeIssue).some((post) => /Existing issue response/.test(post.text)));
  assert.equal(githubPlatform.posts.length, 0);
});
