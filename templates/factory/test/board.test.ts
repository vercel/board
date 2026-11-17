import assert from "node:assert/strict";
import { test } from "node:test";
import { threadFrom, threadOf } from "../agent/lib/board.ts";

// The thread a wake-up names reaches the turn as the channel keeps it on the session, where the
// agent's tools and its GitHub credentials read it.

const session = (context: unknown) => {
  const thread = threadFrom(context);
  return { auth: { current: thread ? { attributes: { boardThread: thread } } : null, initiator: null } };
};

test("the thread a wake-up names is the session's", () => {
  assert.equal(threadOf(session({ board: { thread: "msg_1f0e_12" } })), "msg_1f0e_12");
});

test("a wake-up that names no thread leaves the session without one", () => {
  assert.equal(threadOf(session({ board: {} })), null);
  assert.equal(threadOf(session({ board: { thread: 12 } })), null);
  assert.equal(threadOf(session(null)), null);
});

test("a session keeps the thread of whoever started it, when a later message carries none", () => {
  assert.equal(threadOf({ auth: { current: null, initiator: { attributes: { boardThread: "12" } } } }), "12");
});
