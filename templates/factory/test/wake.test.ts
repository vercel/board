import assert from "node:assert/strict";
import { test } from "node:test";
import { send, sendToAgent, wakeAgent, type AgentMessage } from "../agent/lib/wake.ts";

// What the board's watcher hands the agent, driven as the board drives it: an event, and a handle
// that says who this deployment writes as. What reaches the agent is what `deliver` gets.

const DEPLOYMENT = "vercel:project:prj_factory:production";

const by = (principal: string, profile: string | null) => ({ principal, profile, actor: profile ? `${principal}+${profile}` : principal });
const ada = by("vercel:user:u_ada", null);
// The agent is the deployment writing as itself: no profile.
const agent = by(DEPLOYMENT, null);

type Fields = { id?: string; re?: string | null; by?: ReturnType<typeof by>; schedule?: string };
const posted = ({ id = "13", re = "12", by: author = ada, schedule }: Fields = {}) =>
  ({ type: "message.posted", cursor: `c-${id}`, message: { id, re, by: author, ...(schedule ? { schedule } : {}) } }) as never;
const reacted = (to: ReturnType<typeof by>, who: ReturnType<typeof by>) =>
  ({ type: "reaction.added", cursor: "c-r", actor: { name: "Ada" }, payload: { emoji: "eyes", by: who }, message: { id: "13", re: "12", by: to } }) as never;

async function woken(event: never) {
  const got: AgentMessage[] = [];
  const replies: string[] = [];
  const board = { me: async () => ({ principal: DEPLOYMENT }), reply: async (_id: string, text: string) => void replies.push(text) } as never;
  await wakeAgent({ event, board } as never, async (message) => void got.push(message));
  return { got, replies };
}

test("a person's reply wakes the agent, for its thread, under the event's cursor", async () => {
  const { got } = await woken(posted());
  assert.deepEqual(got, [{ thread: "12", key: "c-13", text: "New message #13 in board thread #12." }]);
});

test("a new thread wakes the agent for itself", async () => {
  const { got } = await woken(posted({ id: "20", re: null }));
  assert.deepEqual(got.map(({ thread, text }) => [thread, text]), [["20", "New board thread #20."]]);
});

test("the agent's own message doesn't wake it, but a check-in it scheduled does", async () => {
  assert.deepEqual((await woken(posted({ by: agent }))).got, []);
  assert.equal((await woken(posted({ by: agent, schedule: "s1" }))).got.length, 1);
});

test("what the deployment's sync brought in, and its watcher's own word, aren't the agent's: they wake it", async () => {
  assert.equal((await woken(posted({ by: by(DEPLOYMENT, "github:user:583231") }))).got.length, 1);
  assert.equal((await woken(posted({ by: by(DEPLOYMENT, "wake") }))).got.length, 1);
  // And a person who names a profile after the project is still a person.
  assert.equal((await woken(posted({ by: by("vercel:user:u_ada", "factory") }))).got.length, 1);
});

test("what someone asked through the factory's page, under the launcher's profile, wakes the agent as anyone's thread does", async () => {
  const { got } = await woken(posted({ id: "30", re: null, by: by(DEPLOYMENT, "launcher") }));
  assert.deepEqual(got, [{ thread: "30", key: "c-30", text: "New board thread #30." }]);
  // And a reaction the page never makes, on a message that isn't the agent's, wakes nobody.
  assert.deepEqual((await woken(reacted(by(DEPLOYMENT, "launcher"), ada))).got, []);
});

test("the agent under a profile it named is still the agent: as it wrote at first, or as BOARD_PROFILE says", async () => {
  assert.deepEqual((await woken(posted({ by: by(DEPLOYMENT, "factory") }))).got, []);
  assert.deepEqual((await woken(posted({ by: by(DEPLOYMENT, "night-shift") }))).got, []);
  assert.equal((await woken(posted({ by: by(DEPLOYMENT, "factory"), schedule: "s1" }))).got.length, 1);
});

test("a reaction to the agent's message wakes it, but not its own, and not one on someone else's message", async () => {
  const { got } = await woken(reacted(agent, ada));
  assert.deepEqual(got.map(({ thread, text }) => [thread, text]), [["12", "Ada reacted :eyes: to your message #13 in board thread #12."]]);
  assert.deepEqual((await woken(reacted(agent, agent))).got, []);
  assert.deepEqual((await woken(reacted(ada, ada))).got, []);
});

test("a wake-up that never gets there is tried 3 times, then said in the thread", async () => {
  let tries = 0;
  const replies: [string, string][] = [];
  const board = { reply: async (id: string, text: string) => void replies.push([id, text]) } as never;
  const message = { thread: "12", key: "c-13", text: "New message #13 in board thread #12." };
  await sendToAgent(board, message, async () => ((tries += 1), Promise.reject(new Error("the agent's channel answered 500: boom"))), 0);
  assert.equal(tries, 3);
  assert.deepEqual(replies, [["12", "The agent couldn't start: `the agent's channel answered 500: boom`. Reply here to try again."]]);
});

/** eve's own channel, faked: what each request asked, and what it answers, in order. */
function eve(answers: [status: number, body: object][]) {
  const requests: { path: string; body: unknown }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
    const [status, body] = answers[requests.length - 1] ?? [500, { error: "unexpected request" }];
    return new Response(JSON.stringify(body), { status });
  }) as never;
  return { requests, fake };
}

const WAKE = { thread: "12", key: "c-13", text: "hi" };
const DELIVERY = { message: "hi", clientContext: { board: { thread: "12" } }, idempotencyKey: "c-13" };

test("a wake-up finds the thread's session by the thread, then delivers once under the event's cursor", async () => {
  const { requests, fake } = eve([
    [200, { ok: true, sessionId: "wrun_a" }],
    [202, { ok: true, sessionId: "wrun_a" }],
  ]);
  await send(WAKE, fake);
  assert.deepEqual(requests, [
    { path: "/eve/v1/session", body: { operationId: "thread-12" } },
    { path: "/eve/v1/session/wrun_a", body: DELIVERY },
  ]);
});

test("on Vercel, a wake-up carries the deployment's OIDC token twice: for eve, and to get through its own Deployment Protection", async () => {
  const sent: Record<string, string>[] = [];
  const fake = (async (_url: string, init: RequestInit) => (sent.push(init.headers as Record<string, string>), new Response(JSON.stringify({ ok: true, sessionId: "wrun_a" }), { status: 200 }))) as never;
  // Even on a project that has a bypass secret, the wake-up doesn't carry it: a preview holds that secret too.
  const before = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "shared-secret";
  try {
    await send(WAKE, fake, async () => "oidc-token");
  } finally {
    if (before === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = before;
  }
  for (const headers of sent) {
    assert.equal(headers.authorization, "Bearer oidc-token");
    assert.equal(headers["x-vercel-trusted-oidc-idp-token"], "oidc-token");
    assert.equal(headers["x-vercel-protection-bypass"], undefined);
  }
  assert.equal(sent.length, 2);
});

test("a session that ended since it was found is replaced, and the wake-up delivered to the new one", async () => {
  const { requests, fake } = eve([
    [200, { ok: true, sessionId: "wrun_old" }],
    [409, { ok: false, code: "session_not_active", error: "The session is no longer active." }],
    [200, { ok: true, sessionId: "wrun_new" }],
    [202, { ok: true, sessionId: "wrun_new" }],
  ]);
  await send(WAKE, fake);
  assert.deepEqual(requests.map((request) => request.path), ["/eve/v1/session", "/eve/v1/session/wrun_old", "/eve/v1/session", "/eve/v1/session/wrun_new"]);
  assert.deepEqual(requests[3]!.body, DELIVERY);
});

test("a session that just started takes its first message a moment later: the wake-up waits, and starts nothing over", async () => {
  // What eve answers a message sent right after the session was created.
  const notReady: [number, object] = [409, { ok: false, code: "session_not_ready", error: "The session is not ready yet." }];
  const { requests, fake } = eve([[202, { ok: true, sessionId: "wrun_a" }], notReady, notReady, [202, { ok: true, sessionId: "wrun_a" }]]);
  await send(WAKE, fake, async () => null, [0, 0, 0]);
  assert.deepEqual(requests.map((request) => request.path), ["/eve/v1/session", "/eve/v1/session/wrun_a", "/eve/v1/session/wrun_a", "/eve/v1/session/wrun_a"]);
  assert.deepEqual(requests[3]!.body, DELIVERY);
});

test("a session that never gets ready fails the delivery, after waiting as long as it's told to", async () => {
  const notReady: [number, object] = [409, { ok: false, code: "session_not_ready", error: "The session is not ready yet." }];
  const { requests, fake } = eve([[202, { ok: true, sessionId: "wrun_a" }], notReady, notReady, notReady]);
  await assert.rejects(send(WAKE, fake, async () => null, [0, 0]), /eve answered 409 to a wake-up \(session_not_ready\)/);
  assert.equal(requests.length, 4);
});

test("a channel that refuses fails the delivery, with what it answered, and delivers nothing", async () => {
  const refused = eve([[401, { ok: false, error: "unauthorized" }]]);
  await assert.rejects(send(WAKE, refused.fake), /eve answered 401 to opening the thread's session: unauthorized/);
  assert.equal(refused.requests.length, 1);
  const failing = eve([
    [200, { ok: true, sessionId: "wrun_a" }],
    [500, { ok: false, error: "boom" }],
  ]);
  await assert.rejects(send(WAKE, failing.fake), /eve answered 500 to a wake-up: boom/);
});
