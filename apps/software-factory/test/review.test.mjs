import assert from "node:assert/strict";
import { test } from "node:test";
import { eveName } from "../app/api/board/[[...path]]/agent.ts";
import { asksEve, isDraft, reviewStarts } from "../app/api/board/[[...path]]/review.ts";

const root = (state) => ({ re: null, labels: { pr: "vercel-labs/board#170", ...(state ? { state } : {}) } });

test("reviewStarts: a PR opened ready is reviewed when its thread opens", () => {
  assert.equal(reviewStarts({ type: "message.posted", payload: {}, message: root("open") }), true);
  // Synced before roots had a state: still a PR to review.
  assert.equal(reviewStarts({ type: "message.posted", payload: {}, message: root() }), true);
});

test("reviewStarts: a draft waits, and is reviewed when it's marked ready", () => {
  assert.equal(reviewStarts({ type: "message.posted", payload: {}, message: root("draft") }), false);
  const ready = { type: "labels.changed", payload: { set: { state: "open" }, unset: [] }, message: root("open") };
  assert.equal(reviewStarts(ready), true);
});

test("reviewStarts: no other event starts a review", () => {
  const relabel = (set) => ({ type: "labels.changed", payload: { set, unset: [] }, message: root("open") });
  // Converted back to draft, merged, closed, or labeled by a watcher.
  assert.equal(reviewStarts(relabel({ state: "draft" })), false);
  assert.equal(reviewStarts(relabel({ state: "merged" })), false);
  assert.equal(reviewStarts(relabel({ land: "yes" })), false);
  // A reply, even one relabeled state=open, isn't the PR.
  const reply = { re: "170", labels: {} };
  assert.equal(reviewStarts({ type: "message.posted", payload: {}, message: reply }), false);
  assert.equal(reviewStarts({ type: "labels.changed", payload: { set: { state: "open" }, unset: [] }, message: reply }), false);
  assert.equal(reviewStarts({ type: "reaction.added", payload: {}, message: root("open") }), false);
  assert.equal(reviewStarts({ type: "message.posted", payload: {} }), false);
});

test("isDraft: only state=draft", () => {
  assert.equal(isDraft({ state: "draft" }), true);
  assert.equal(isDraft({ state: "open" }), false);
  assert.equal(isDraft({}), false);
});

test("asksEve: a reply in a draft wakes Eve only when it asks Eve", () => {
  assert.equal(asksEve("170", "@pi can you look at the failing test?"), true);
  assert.equal(asksEve("170", "Eve, review this before I mark it ready"), true);
  assert.equal(asksEve("170", "thoughts, pi?"), true);
  assert.equal(asksEve("170", "@eve can you rebase?"), true);
  assert.equal(asksEve("170", `${eveName("170")} please rebase`), true);
  assert.equal(asksEve("170", "still working on this, will mark ready soon"), false);
  // Words and names that contain "pi" aren't Eve.
  assert.equal(asksEve("170", "the api route picks the wrong pipeline"), false);
  assert.equal(asksEve("170", "see pi-pr.yml and the pi/170 branch"), false);
  assert.equal(asksEve("170", "Steve says every evening build breaks"), false);
});
