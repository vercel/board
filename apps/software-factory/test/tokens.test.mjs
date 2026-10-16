import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverSchedulerAppend } from "experimental-a2/server";
import { memory } from "experimental-a2/store-memory";
import { REFRESH_LEAD_MS, expiresAt, refreshAt, tokenRefreshes } from "../app/api/board/[[...path]]/tokens.ts";

const MIN = 60_000;
const SESSION = 45 * MIN;

test("refreshAt: tokens that die before Pi's session does are replaced in their last minutes, and others aren't", () => {
  const now = Date.now();
  // A function's token reused for 90 of its 120 minutes: 30 left, while the session runs 45.
  assert.equal(refreshAt(now + 30 * MIN, now + SESSION, now)?.getTime(), now + 30 * MIN - REFRESH_LEAD_MS);
  // A fresh one outlives the session.
  assert.equal(refreshAt(now + 120 * MIN, now + SESSION, now), null);
  // One about to die (a refresh that got the same token again) tries again in a minute.
  assert.equal(refreshAt(now + 5 * MIN, now + SESSION, now)?.getTime(), now + MIN);
});

test("expiresAt: a JWT's exp, in milliseconds", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_791_394_851 })).toString("base64url");
  assert.equal(expiresAt(`e30.${payload}.sig`), 1_791_394_851_000);
});

/** A queue that runs drains right away and holds timers until `fire` delivers them, due or not. */
function queue() {
  let servers = [];
  const timers = [];
  const scheduler = {
    schedule: async (task) => {
      if (task.kind === "drain") {
        setTimeout(() => void servers.find((s) => s.contract.name === task.contract)?.drain(task.sessionId), 0);
      } else if (task.kind === "append" && !timers.some((t) => t.id === task.id)) timers.push(task);
    },
    handler: (...mounted) => {
      servers = mounted;
      return async () => new Response(null, { status: 204 });
    },
  };
  return {
    scheduler,
    timers,
    async fire() {
      const due = timers.splice(0);
      for (const task of due) await deliverSchedulerAppend(servers[0], task);
      // Let the drain the append arms run its handler.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

test("tokenRefreshes: Pi handed tokens that die mid-session gets new ones before they do, until they outlive it", async () => {
  const { scheduler, timers, fire } = queue();
  const now = Date.now();
  const given = [];
  // The refresh after 90 minutes of reuse gets the function's next token, good for 2 hours.
  const refreshes = tokenRefreshes({
    store: memory(),
    scheduler,
    give: async (thread) => {
      given.push(thread);
      return { tokensEnd: Date.now() + 120 * MIN, sessionEnd: now + SESSION };
    },
  });
  scheduler.handler(refreshes.server);

  // A message hands Pi tokens with 30 minutes left: before, nothing replaced them.
  await refreshes.later(1956, { tokensEnd: now + 30 * MIN, sessionEnd: now + SESSION });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].dueAt, now + 30 * MIN - REFRESH_LEAD_MS);
  // A second message with the same tokens arms the same refresh.
  await refreshes.later(1956, { tokensEnd: now + 30 * MIN, sessionEnd: now + SESSION + MIN });
  assert.equal(timers.length, 1);

  await fire();
  assert.deepEqual(given, [1956]);
  // The new tokens outlive the session: nothing more to do.
  assert.equal(timers.length, 0);
});

test("tokenRefreshes: tokens that outlive the session arm nothing, and a stopped sandbox ends the refreshes", async () => {
  const { scheduler, timers, fire } = queue();
  const now = Date.now();
  let calls = 0;
  const refreshes = tokenRefreshes({
    store: memory(),
    scheduler,
    give: async () => {
      calls++;
      return null;
    },
  });
  scheduler.handler(refreshes.server);

  await refreshes.later(7, { tokensEnd: now + 100 * MIN, sessionEnd: now + SESSION });
  assert.equal(timers.length, 0);

  await refreshes.later(7, { tokensEnd: now + 20 * MIN, sessionEnd: now + SESSION });
  await fire();
  assert.equal(calls, 1);
  assert.equal(timers.length, 0);
});

test("tokenRefreshes: a refresh that fails says so and doesn't throw, so the thread's next refresh still runs", async () => {
  const { scheduler, timers, fire } = queue();
  const now = Date.now();
  const error = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const refreshes = tokenRefreshes({
      store: memory(),
      scheduler,
      give: async () => {
        throw new Error("sandbox unreachable");
      },
    });
    scheduler.handler(refreshes.server);
    await refreshes.later(7, { tokensEnd: now + 20 * MIN, sessionEnd: now + SESSION });
    await fire();
    assert.equal(timers.length, 0);
    assert.match(logged.join("\n"), /couldn't refresh Pi's tokens on board thread #7/);
    assert.deepEqual(await refreshes.server.session("thread-7").deadLetters(), []);
  } finally {
    console.error = error;
  }
});
