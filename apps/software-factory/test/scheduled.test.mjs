import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduled, scheduledThread } from "../app/api/board/[[...path]]/kinds.ts";

const schedule = { id: "12", n: 0 };

test("a scheduled new thread with an Eve kind goes straight to Eve, like the twice-daily sitrep", () => {
  // Board #1095: a sitrep schedule posts a new dev thread as Eve, labeled kind=task.
  // Triage skips Eve's posts and nothing changes the label later, so Eve never heard of it.
  assert.equal(scheduledThread({ re: null, labels: { kind: "task" }, schedule }), "task");
});

test("only scheduled roots that carry an Eve kind count", () => {
  assert.equal(scheduledThread({ re: null, labels: { kind: "task" } }), null, "not scheduled");
  assert.equal(scheduledThread({ re: "5", labels: { kind: "task" }, schedule }), null, "a reply");
  assert.equal(scheduledThread({ re: null, labels: {}, schedule }), null, "no kind: triage decides");
  assert.equal(scheduledThread({ re: null, labels: { kind: "noise" }, schedule }), null);
  assert.equal(scheduledThread({ re: null, labels: { kind: "toString" }, schedule }), null);
});

test("scheduled tells a vb schedule's posts apart", () => {
  assert.equal(scheduled({ schedule }), true);
  assert.equal(scheduled({}), false);
});
