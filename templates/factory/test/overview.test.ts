import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, overview } from "../lib/overview.ts";

// What the page shows once the factory runs, worked out from messages as the board gives them.

const DEPLOYMENT = "vercel:project:prj_factory:production";
const NOW = new Date("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;

let next = 0;
type By = "ada" | "agent" | "sync" | "watcher" | "page";
const BY: Record<By, { principal: string; profile: string | null }> = {
  ada: { principal: "vercel:user:u_ada", profile: null },
  agent: { principal: DEPLOYMENT, profile: null },
  sync: { principal: DEPLOYMENT, profile: "github:user:583231" },
  watcher: { principal: DEPLOYMENT, profile: "wake" },
  page: { principal: DEPLOYMENT, profile: "launcher" },
};
const message = (re: string | null, by: By, at: number, more: { id?: string; text?: string; labels?: Record<string, string> } = {}) =>
  ({ id: more.id ?? `m${++next}`, re, text: more.text ?? "", labels: more.labels ?? {}, createdAt: ago(at), by: { ...BY[by], actor: "a" } }) as never;

const week = (recent: never[], limit = 200) => overview(recent, null, DEPLOYMENT, NOW, limit).week;

test("the week is the threads with a message in the last 7 days, their messages in it, and the ones the agent answered", () => {
  const recent = [
    // Started before the week, answered in it.
    message(null, "ada", 10 * DAY, { id: "a" }),
    message("a", "agent", 2 * DAY),
    // In the week, and nobody answered.
    message(null, "sync", DAY, { id: "b" }),
    // All of it before the week.
    message(null, "ada", 20 * DAY, { id: "c" }),
    message("c", "agent", 19 * DAY),
  ];
  const { threads, messages, answered } = week(recent);
  assert.deepEqual({ threads, messages, answered }, { threads: 2, messages: 2, answered: 1 });
});

test("the wait for a first reply is from a thread's first message that isn't the agent's to the agent's next, as the median", () => {
  const thread = (id: string, start: number, wait: number) => [message(null, "ada", start, { id }), message(id, "agent", start - wait), message(id, "agent", start - wait - HOUR)];
  const recent = [
    ...thread("a", DAY, 10 * SECOND),
    ...thread("b", 2 * DAY, 20 * SECOND),
    ...thread("c", 3 * DAY, 60 * SECOND),
    // A thread the agent started, which someone then answered: nobody waited on the agent.
    message(null, "agent", 4 * DAY, { id: "d" }),
    message("d", "ada", 4 * DAY - HOUR),
    // The watcher's own word isn't an answer.
    message(null, "ada", 5 * DAY, { id: "e" }),
    message("e", "watcher", 5 * DAY - SECOND),
  ];
  assert.equal(week(recent).firstReplyMs, 20 * SECOND);
  // With an even count, halfway between the middle two.
  assert.equal(week([...thread("a", DAY, 10 * SECOND), ...thread("b", 2 * DAY, 20 * SECOND)]).firstReplyMs, 15 * SECOND);
  assert.equal(week([message(null, "ada", DAY)]).firstReplyMs, null);
});

test("a thread someone asked for through the page waits on the agent like any other, and isn't answered until the agent replies", () => {
  const asked = [message(null, "page", DAY, { id: "a" })];
  assert.deepEqual([week(asked).answered, week(asked).firstReplyMs], [0, null]);
  const answered = [...asked, message("a", "agent", DAY - 30 * SECOND)];
  assert.deepEqual([week(answered).answered, week(answered).firstReplyMs], [1, 30 * SECOND]);
});

test("a read that came back full says the week may hold more", () => {
  const recent = [message(null, "ada", DAY), message(null, "ada", 2 * DAY)];
  assert.equal(week(recent, 2).more, true);
  assert.equal(week(recent, 3).more, false);
});

test("the last reply is the agent's latest message, whenever it was", () => {
  const recent = [message(null, "ada", HOUR, { id: "a" }), message("a", "agent", 30 * DAY), message("a", "agent", 9 * DAY), message("a", "sync", HOUR)];
  assert.equal(overview(recent, null, DEPLOYMENT, NOW, 200).lastReplyAt, ago(9 * DAY));
  assert.equal(overview([message(null, "ada", HOUR)], null, DEPLOYMENT, NOW, 200).lastReplyAt, null);
});

test("a pull request someone else opened is a thread in the week, and what the board holds is shown as numbers only", () => {
  const recent = [
    message(null, "sync", DAY, { id: "pr12", text: "PR #12: Fix the build\nhttps://github.com/acme/web/pull/12", labels: { pr: "acme/web#12", state: "open" } }),
    message(null, "ada", DAY, { text: "the launch date is the 3rd" }),
  ];
  const seen = overview(recent, { open: 2, merged: 1, closed: 0 }, DEPLOYMENT, NOW, 200);
  assert.equal(seen.week.threads, 2);
  // Whoever can open the deployment sees this, whatever they may read on the board: numbers and times only.
  const shown = JSON.stringify(seen);
  for (const said of ["Fix the build", "acme/web", "launch date", "github.com"]) assert.ok(!shown.includes(said), said);
});

test("a length of time reads as people say it", () => {
  assert.deepEqual([14 * SECOND, 59.6 * SECOND, 3 * 60 * SECOND, 2 * HOUR, 5 * DAY, -SECOND].map(duration), ["14s", "1m", "3m", "2h", "5d", "0s"]);
});
