import assert from "node:assert/strict";
import { test } from "node:test";
import { board } from "@vercel/board";
import { oidcTokens } from "@vercel/board/access";
import { a2, memoryBlob } from "@vercel/board/backend-a2";
import { memory } from "@vercel/board/backend-a2/store-memory";
import { vercelTrustedSources } from "../app/api/board/[[...path]]/trusted-sources.ts";
// Only what's the same in every release: the test project, keys, tokens, and a caller.
import { caller, deploymentToken, personToken, PROJECT_ID, TEAM_ID, testAuth } from "../../../packages/board/test/tokens.ts";

const URL = "http://board.test/api/board";

/**
 * A board as the factory runs one: its pinned `@vercel/board`, the same release its rules
 * (`vercelTrustedSources`) and watchers are built with, in memory, in the test project, trusting
 * the test issuers. This checkout's engine never sees the factory's rules.
 */
const testBoard = (given = {}) =>
  board({
    backend: a2({ store: memory(), blob: memoryBlob() }),
    authenticate: oidcTokens(testAuth),
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    url: URL,
    ...given,
  });
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
  // Only the trusted sources decide: g2 would let in every project on the board's team.
  const board = testBoard(options);
  await board.revokeGrant("g2");
  const plain = testBoard({ url: URL });
  await plain.revokeGrant("g2");
  assert.equal((await caller(plain.fetch, await token())("GET", "/me")).status, 403);
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
  const { inThread, devMirror } = await import("../app/api/board/[[...path]]/inthread.ts");
  const { fakePlatform } = await import("../../../packages/board/test/sync-fixtures.ts");
  const { channels, slack } = await import("@vercel/board/sync-slack");
  const { github, repos } = await import("@vercel/board/sync-github");
  const { issues, pulls } = await import("../app/api/board/[[...path]]/quiet.ts");
  const slackPlatform = fakePlatform("slack");
  const githubPlatform = fakePlatform("github");
  const watched = [];
  const noEve = async () => { throw new Error("must not start a live agent"); };
  const watchers = { autoland: autoland(), shipit: shipit({ tellEve: noEve }), security: security({ tellEve: noEve }), owner: owner(), "in-thread": inThread() };
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

test("a factory PR starts its own Slack thread, and the thread it was built for gets its line", async () => {
  const { inThread, devMirror } = await import("../app/api/board/[[...path]]/inthread.ts");
  const { renderForSlack } = await import("../app/api/board/[[...path]]/render.ts");
  const { fakePlatform } = await import("../../../packages/board/test/sync-fixtures.ts");
  const { channels, slack } = await import("@vercel/board/sync-slack");
  const { render } = await import("@vercel/board/sync");
  const { github, repos } = await import("@vercel/board/sync-github");
  const { issues, pulls } = await import("../app/api/board/[[...path]]/quiet.ts");
  const slackPlatform = fakePlatform("slack");
  const githubPlatform = fakePlatform("github");
  const board = testBoard({
    ...options,
    sync: {
      slack: slack({ adapter: slackPlatform.adapter }, render(renderForSlack, channels({ C1: devMirror("dev") }))),
      github: github({ adapter: githubPlatform.adapter }, repos({ "vercel-labs/board": { pulls, issues } })),
    },
    watch: { "in-thread": inThread() },
  });
  const operator = caller(board.fetch, await personToken());
  const until = Date.now() + 5000;
  const waitFor = async (check) => {
    let value;
    while (!(value = await check()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(value);
    return value;
  };
  const source = (await operator("POST", "/messages", { channel: "dev", text: "Post PRs in the thread" })).body.message;
  await waitFor(() => slackPlatform.channelPosts.length === 1);
  const pr = (action, extra = {}) => board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": `in-thread-${action}` },
    body: JSON.stringify({
      action, repository: { full_name: "vercel-labs/board" }, sender: { login: "factory[bot]", id: 9 },
      pull_request: {
        number: 77, title: "Post PRs in their thread", html_url: "https://github.com/vercel-labs/board/pull/77", draft: false, merged: false,
        head: { ref: `board/${source.id}`, repo: { full_name: "vercel-labs/board" } }, ...extra,
      },
    }),
  }));
  await pr("opened");
  const root = await waitFor(async () => {
    const found = (await operator("GET", "/messages?channel=dev&label=pr")).body.messages.find((m) => m.re === null && m.labels.card);
    return found;
  });
  assert.equal(root.labels.source, source.id);
  const card = await waitFor(() => slackPlatform.posts.find((post) => post.text.includes("#77") && post.threadId?.endsWith(slackPlatform.channelPosts[0].id)));
  assert.equal(JSON.parse(card.text).markdown, ":pr: [#77 Post PRs in their thread](https://github.com/vercel-labs/board/pull/77)");
  assert.ok(card.threadId.endsWith(slackPlatform.channelPosts[0].id), "in the source's Slack thread");
  await waitFor(() => slackPlatform.channelPosts.length === 2);
  assert.match(slackPlatform.channelPosts[1].text, /#77 Post PRs in their thread/, "the PR starts its own thread in the channel");

  await pr("closed", { merged: true });
  await waitFor(() => slackPlatform.edits.some((edit) => String(edit.text ?? JSON.stringify(edit)).includes(":pr-merged: [#77")));
  assert.equal(slackPlatform.channelPosts.length, 2);
  assert.deepEqual(slackPlatform.reactions.filter((r) => r.emoji.startsWith("pr")), [], "no PR emoji on the source root");

  // A source thread kept off Slack gets no line, and its PR still starts its own thread.
  const hidden = (await operator("POST", "/messages", { channel: "dev", text: "Board-only thread", noSync: true })).body.message;
  await board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "in-thread-hidden" },
    body: JSON.stringify({
      action: "opened", repository: { full_name: "vercel-labs/board" }, sender: { login: "factory[bot]", id: 9 },
      pull_request: {
        number: 78, title: "From a board-only thread", html_url: "https://github.com/vercel-labs/board/pull/78", draft: false, merged: false,
        head: { ref: `board/${hidden.id}`, repo: { full_name: "vercel-labs/board" } },
      },
    }),
  }));
  await waitFor(() => slackPlatform.channelPosts.length === 3);
  assert.match(slackPlatform.channelPosts[2].text, /#78 From a board-only thread/);
});
