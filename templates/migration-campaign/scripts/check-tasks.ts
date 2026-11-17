// Checks what a campaign relies on from the board's tasks, on the board you'd run campaigns on:
//   node --env-file=.env.local scripts/check-tasks.ts
// The unit tests run on a board in memory. This runs the same promises against the real one, with
// agents held to a campaign's channel exactly as a sandbox's policy holds them. It makes its tasks
// in a channel of its own under the campaigns' channel, cancels what it leaves, and takes about a
// minute: one check waits out a 30-second lease.
import assert from "node:assert/strict";
import { BoardError, type Board } from "@vercel/board";
import { ROOT, boardName, team } from "../lib/board.ts";
import { allTasks, cancel, claimNext, createTasks, unblock } from "../lib/queue.ts";

const board = team();
const run = `check${Date.now().toString(36)}`;
const channel = `${ROOT}/${run}`;
const other = `${ROOT}/${run}-other`;

/** An agent of this check's campaign, held as a worker's sandbox is: its own channel to work, the campaigns' threads to read. */
const agent = (n: number, at = channel): Board => board.as(`worker-${n}`, { can: `${ROOT}=read;${at}=read,post,react,label` });

const code = (error: unknown) => (error instanceof BoardError ? error.code : String(error));
const refused = async (what: Promise<unknown>) => what.then(() => null, code);
const states = async (at = channel) => {
  const counts: Record<string, number> = {};
  for (const { message } of await allTasks(board, at, 2_000)) counts[message.task!.state] = (counts[message.task!.state] ?? 0) + 1;
  return counts;
};

let failed = 0;
async function check(name: string, body: () => Promise<void>) {
  const start = Date.now();
  try {
    await body();
    console.log(`ok    ${name}  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n").join("\n      ")}`);
  }
}

console.log(`board  ${boardName ?? "the team's default"}  ${(await board.discovery()).url}`);
console.log(`as     ${(await board.me()).actor}\n`);

const texts = Array.from({ length: 23 }, (_, at) => `file-${String(at).padStart(2, "0")}.js\n- src/file-${String(at).padStart(2, "0")}.js`);
let owner = "";

await check("a plan of 23 tasks is made once, however often it's sent", async () => {
  const first = await createTasks(board, channel, `plan-${run}`, texts);
  const again = await createTasks(board, channel, `plan-${run}`, texts);
  owner = first.owner;
  assert.equal(first.made, 23);
  assert.equal(again.made, 23);
  assert.deepEqual(await states(), { ready: 23 });
});

await check("a list pages through every task, oldest first", async () => {
  const listed = await allTasks(board, channel, 2_000);
  assert.equal(listed.length, 23);
  assert.deepEqual(
    listed.map(({ message }) => message.text.split("\n", 1)[0]),
    texts.map((text) => text.split("\n", 1)[0]),
  );
});

await check("eight agents claiming at once each get a task of their own, the oldest eight", async () => {
  const claims = await Promise.all(Array.from({ length: 8 }, (_, at) => claimNext(agent(at + 1), channel, owner)));
  const ids = claims.map((claim) => claim?.task.id);
  assert.ok(ids.every(Boolean), `some agent got nothing: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, 8, "two agents were given one task");
  const titles = claims.map((claim) => claim!.task.text.split("\n", 1)[0]).sort();
  assert.deepEqual(titles, texts.slice(0, 8).map((text) => text.split("\n", 1)[0]));
  assert.equal((await states()).claimed, 8);
  // Settled as a campaign's agents settle: six complete, one is held, one gives its task back.
  await Promise.all(claims.slice(0, 6).map((claim) => claim!.complete("The patch is attached.")));
  await claims[6]!.block("Still not right after 3 tries.", { kind: "needs_input" });
  await claims[7]!.release();
  assert.deepEqual(await states(), { completed: 6, blocked: 1, ready: 16 });
});

await check("a second claim of a held task is refused, and its holder settles it once", async () => {
  const held = (await claimNext(agent(1), channel, owner))!;
  assert.equal(await refused(agent(2).tasks.claim(held.task.id)), "task_claimed");
  await held.complete("done");
  assert.equal(await refused(held.complete("done twice")), "claim_lost");
  assert.equal(await refused(agent(2).tasks.claim(held.task.id)), "task_finished");
});

await check("a renewed claim keeps its task, and one that isn't renewed is taken over and fenced out", async () => {
  const kept = (await board.tasks.claim({ channel, from: [owner], lease: 30 }, undefined))!;
  const stalled = (await agent(3).tasks.claim({ channel, from: [owner], lease: 30 }))!;
  const until = Date.parse(stalled.until);
  // The first is renewed for five minutes, as the runner renews. The second is left to run out.
  const renewed = await kept.renew(300);
  assert.ok(Date.parse(renewed.until) - Date.now() > 200_000, `renewed until ${renewed.until}`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now()) + 3_000));
  const taken = await agent(4).tasks.claim(stalled.task.id, { lease: 60 });
  assert.equal(taken.task.id, stalled.task.id);
  assert.equal(await refused(stalled.complete("late")), "claim_lost");
  assert.equal(await refused(stalled.renew()), "claim_lost");
  await taken.complete("done by the agent that took it over");
  await renewed.complete("done by the agent that kept renewing");
});

await check("a held task says why, takes an answer, and is ready again once", async () => {
  const [blocked] = (await allTasks(board, channel, 2_000)).filter(({ message }) => message.task!.state === "blocked");
  assert.deepEqual(blocked!.message.task!.blocked, { kind: "needs_input", reason: "Still not right after 3 tries." });
  assert.equal(await refused(agent(1).tasks.claim(blocked!.message.id)), "task_blocked");
  await board.reply(blocked!.message.id, "Keep the name binding.");
  assert.equal(await unblock(board, blocked!.message.id), true);
  assert.equal(await unblock(board, blocked!.message.id), false);
  const again = await agent(5).tasks.claim(blocked!.message.id);
  const { replies } = await agent(5).thread(again.task.id);
  assert.ok(replies.some((reply) => reply.text === "Keep the name binding."), "the next agent can't read the answer");
  await again.complete("done after the answer");
});

await check("a canceled task ends its claim, and no agent takes it again", async () => {
  const held = (await claimNext(agent(6), channel, owner))!;
  await cancel(board, held.task.id, "not worth it");
  assert.match((await refused(held.complete("done anyway"))) ?? "", /claim_lost|task_finished/);
  assert.equal(await refused(agent(7).tasks.claim(held.task.id)), "task_finished");
});

await check("what a task cost stays on it across tries", async () => {
  const first = (await claimNext(agent(1), channel, owner))!;
  await agent(1).label(first.task.id, { set: { cost: "0.0007", tokens: "1200" } });
  await first.block("needs a person", { kind: "needs_input" });
  await unblock(board, first.task.id);
  const second = await agent(2).tasks.claim(first.task.id);
  assert.deepEqual([second.task.labels.cost, second.task.labels.tokens], ["0.0007", "1200"], "the next try can't see what the first cost");
  await agent(2).label(second.task.id, { set: { cost: "0.0020", tokens: "3100" } });
  await second.complete("done");
  const [{ message }] = (await allTasks(board, channel, 2_000)).filter((task) => task.message.id === first.task.id);
  assert.equal(message.labels.cost, "0.0020");
});

await check("an agent can't touch another campaign's tasks, a campaign's thread, or a task's state by hand", async () => {
  const { made } = await createTasks(board, other, `plan-${run}-other`, ["theirs.js\n- theirs.js"]);
  assert.equal(made, 1);
  const [theirs] = await allTasks(board, other, 10);
  const outsider = agent(9); // an agent of this check's campaign, not of `other`
  assert.match((await refused(outsider.tasks.claim(theirs!.message.id))) ?? "", /forbidden|not_found/);
  assert.equal(await claimNext(outsider, other, owner).catch(() => null), null);
  assert.match((await refused(outsider.label(theirs!.message.id, { set: { cost: "9" } }))) ?? "", /forbidden|not_found/);
  // A campaign's thread is in the campaigns' channel, which an agent only reads: its phase isn't the agent's to change.
  const thread = await board.post(ROOT, { text: `check ${run}`, labels: { phase: "running" } });
  assert.equal((await outsider.thread(thread.id)).message.labels.phase, "running");
  assert.match((await refused(outsider.label(thread.id, { set: { phase: "stopped" } }))) ?? "", /forbidden|not_found/);
  assert.match((await refused(outsider.reply(thread.id, "hello"))) ?? "", /forbidden|not_found/);
  await board.delete(thread.id);
  // The board's own label is nobody's to write: a task's state changes only through its tasks.
  const mine = (await allTasks(board, channel, 2_000)).find(({ message }) => message.task!.state === "ready")!;
  assert.equal(await refused(agent(1).label(mine.message.id, { set: { "board.task": "completed" } })), "reserved_label");
});

// What's left is called off, so nothing of this check waits to be worked.
for (const at of [channel, other]) {
  for (const { message } of await allTasks(board, at, 2_000)) {
    if (["ready", "waiting", "claimed", "blocked"].includes(message.task!.state)) await cancel(board, message.id, "check-tasks is done").catch(() => {});
  }
}
console.log(`\n${failed ? `${failed} failed` : "all passed"}  ${JSON.stringify(await states())}`);
process.exit(failed ? 1 : 0);
