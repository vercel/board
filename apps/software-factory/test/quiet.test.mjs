import assert from "node:assert/strict";
import { test } from "node:test";
import { boardOnly, issues, pulls, unseenPr } from "../app/api/board/[[...path]]/quiet.ts";

const lifecycle = (type, labels = {}) => ({ subthread: null, type, labels });

test("a PR closed without merging stays off Slack", () => {
  assert.equal(boardOnly(lifecycle("pr.closed", { state: "closed" })), true);
});

test("merges, reopens and other PR events still reach Slack", () => {
  assert.equal(boardOnly(lifecycle("pr.closed", { state: "merged" })), false);
  assert.equal(boardOnly(lifecycle("pr.reopened", { state: "open" })), false);
  assert.equal(boardOnly(lifecycle("review.submitted", { review: "approved" })), false);
  assert.equal(boardOnly({ subthread: null, type: "comment" }), false);
});

test("inline review comments stay off Slack", () => {
  assert.equal(boardOnly({ subthread: "github:vercel-labs/board:40:rc:9", type: "comment" }), true);
});

const comment = (thread, subthread = null) => ({ kind: "message", type: "comment", thread, subthread });
const boardWith = (prs) => {
  const queries = [];
  return {
    queries,
    messages: async (query) => {
      queries.push(query);
      return { messages: prs.includes(query.label.pr) ? [{ id: "1" }] : [] };
    },
  };
};

test("a comment on a PR the board has no thread for stays on GitHub", async () => {
  const board = boardWith(["vercel-labs/board#180"]);
  assert.equal(await unseenPr(comment("github:vercel-labs/board:114"), board, "dev"), true);
  assert.equal(await unseenPr(comment("github:vercel-labs/board:114", "github:vercel-labs/board:114:rc:9"), board, "dev"), true);
  assert.deepEqual(board.queries[0], { channel: "dev", label: { pr: "vercel-labs/board#114" }, limit: 1 });
});

test("comments on known PRs, and PR events, still sync", async () => {
  const board = boardWith(["vercel-labs/board#180"]);
  assert.equal(await unseenPr(comment("github:vercel-labs/board:180"), board, "dev"), false);
  assert.equal(await unseenPr({ kind: "lifecycle", type: "pr.opened", thread: "github:vercel-labs/board:181", subthread: null }, board, "dev"), false);
  assert.equal(board.queries.length, 1);
});

test("board replies stay off GitHub, in PR and issue threads alike", async () => {
  const delivered = [];
  const out = (where) => ({ direction: "out", deliver: async () => void delivered.push(where) });
  await pulls(out("pulls"));
  await issues(out("issues"));
  assert.deepEqual(delivered, []);
});
