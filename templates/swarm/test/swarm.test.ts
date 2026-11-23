// What the page is told, and what the swarm relies on from the board's tasks, on a board in memory:
// node --test test/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { board as makeBoard, BoardError, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { holderOf, snapshot } from "../lib/swarm.ts";

const fresh = (): Board => makeBoard({ backend: local({ memory: true }) });
const look = (board: Board) => snapshot(board, "swarm/");
const states = (tasks: { title: string; state: string }[]) => Object.fromEntries(tasks.map((task) => [task.title, task.state]));
const create = async (board: Board, channel: string, text: string, needs: string[] = []) => (await board.tasks.create(channel, { text, needs })).task.id;
const code = (error: unknown) => (error instanceof BoardError ? error.code : String(error));

async function done(board: Board, title: string): Promise<string> {
  const id = await create(board, "swarm/fixes", title);
  await (await board.as("ada").tasks.claim(id)).complete("verified");
  return id;
}

test("a snapshot has the swarm's tasks with their state and holder, and nothing from other channels", async () => {
  const board = fresh();
  await create(board, "swarm/fixes", "ready one\n\nthe brief");
  const held = await create(board, "swarm/perf", "held one");
  await board.as("grace").tasks.claim(held);
  await board.as("grace").reply(held, "[progress] Claimed.");
  await done(board, "done one");
  await create(board, "other/fixes", "another queue's");
  await board.post("swarm/general", "not a task");

  const snap = await look(board);
  assert.deepEqual(states(snap.tasks), { "ready one": "ready", "held one": "claimed", "done one": "completed" });
  const task = snap.tasks.find((task) => task.title === "held one")!;
  // Its holder shows as it does on what it wrote, so the page counts one agent, not two.
  assert.equal(task.holder, snap.flow.find((line) => line.text === "[progress] Claimed.")!.author);
  assert.equal(task.channel, "swarm/perf");
  assert.ok(Date.parse(task.lease!) > Date.now());
  assert.equal(snap.tasks.find((task) => task.title === "done one")!.note, "verified");
  assert.ok(snap.flow.some((line) => line.text === "not a task"));
  assert.ok(!snap.flow.some((line) => line.channel.startsWith("other/")));
});

test("a holder shows by the handle it writes under when a message of its was read, and by its profile's name otherwise", () => {
  const known = new Map([["vercel:user:u1+ada", "julian/ada"]]);
  assert.equal(holderOf("vercel:user:u1+ada", known), "julian/ada");
  assert.equal(holderOf("vercel:user:u1+grace", known), "grace");
  assert.equal(holderOf("board:client:linus", known), "linus");
});

test("a task that waits shows what it needs, and is ready once that completes", async () => {
  const board = fresh();
  const fix = await create(board, "swarm/fixes", "fix it");
  const review = await create(board, "swarm/fixes", "review the fix", [fix]);
  let snap = await look(board);
  assert.deepEqual(states(snap.tasks), { "fix it": "ready", "review the fix": "waiting" });
  assert.deepEqual(snap.tasks.find((task) => task.id === review)!.needs, [fix]);
  assert.equal(await board.as("grace").tasks.claim(review).then(() => null, code), "task_waiting");

  await (await board.as("ada").tasks.claim(fix)).complete("fixed");
  snap = await look(board);
  assert.deepEqual(states(snap.tasks), { "fix it": "completed", "review the fix": "ready" });
});

test("of many agents claiming one task at once, one gets it, and the rest settle nothing", async () => {
  const board = fresh();
  const id = await create(board, "swarm/fixes", "one task");
  const agents = ["ada", "grace", "linus", "ken", "barbara", "edsger", "margaret", "dennis"];
  const claims = await Promise.all(agents.map((agent) => board.as(agent).tasks.claim(id).then((claim) => claim, code)));
  const won = claims.filter((claim) => typeof claim !== "string");
  assert.equal(won.length, 1);
  assert.ok(claims.filter((claim) => typeof claim === "string").every((refusal) => refusal === "task_claimed"));
  const [task] = (await look(board)).tasks;
  assert.equal(task!.holder, agents[claims.findIndex((claim) => typeof claim !== "string")]);
});

test("a task held for a person shows why, and one given up on or called off shows how it ended", async () => {
  const board = fresh();
  const asked = await create(board, "swarm/fixes", "needs a ruling");
  await (await board.as("ada").tasks.claim(asked)).block("Which of the two redirects is the bug?", { kind: "needs_input" });
  const failed = await create(board, "swarm/fixes", "can't be done");
  await (await board.as("ada").tasks.claim(failed)).fail("The endpoint is gone.");
  const dropped = await create(board, "swarm/fixes", "dropped");
  await board.tasks.cancel(dropped, "Superseded.");
  await board.post("swarm/fixes", { text: "a thread, not a task", labels: { "task.state": "ready" } });

  const snap = await look(board);
  assert.deepEqual(states(snap.tasks), { "needs a ruling": "blocked", "can't be done": "failed", dropped: "canceled" });
  const notes = Object.fromEntries(snap.tasks.map((task) => [task.title, task.note]));
  assert.deepEqual(notes, { "needs a ruling": "Which of the two redirects is the bug?", "can't be done": "The endpoint is gone.", dropped: "Superseded." });
});

test("a task made and finished between two snapshots shows in the next, though it was never seen open", async () => {
  const board = fresh();
  await create(board, "swarm/fixes", "still ready");
  await look(board);
  await done(board, "quick one");
  assert.deepEqual(states((await look(board)).tasks), { "still ready": "ready", "quick one": "completed" });
});

test("a snapshot holds the newest 25 finished tasks and says there are more", async () => {
  const board = fresh();
  for (let i = 1; i <= 27; i++) await done(board, `done ${i}`);
  await create(board, "swarm/fixes", "open");
  const snap = await look(board);
  const finished = snap.tasks.filter((task) => task.state === "completed").map((task) => task.title);
  assert.equal(snap.finishedCapped, true);
  assert.deepEqual(finished, Array.from({ length: 25 }, (_, i) => `done ${27 - i}`));
  assert.equal(snap.tasks.filter((task) => task.state === "ready").length, 1);

  const few = fresh();
  await done(few, "only one");
  assert.equal((await look(few)).finishedCapped, false);
});

test("the newest finished tasks are found past the first page of the list, which goes oldest first", async () => {
  const board = fresh();
  for (let i = 1; i <= 520; i++) await done(board, `done ${i}`);
  const finished = (await look(board)).tasks.filter((task) => task.state === "completed").map((task) => task.title);
  assert.deepEqual(finished, Array.from({ length: 25 }, (_, i) => `done ${520 - i}`));
});
