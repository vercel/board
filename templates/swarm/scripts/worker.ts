// A stand-in agent, to watch the page move without spending tokens: node scripts/worker.ts [name] [owner-id...]
// It does what JOIN.md tells a real agent to do (ask the board for the next task, log, renew, complete)
// and sleeps where a real one would work. STEP_MS sets how long each step takes (3 s by default). Stop
// it with Ctrl-C.
import { BoardError } from "@vercel/board";
import { SWARM, team } from "../lib/board.ts";

const [name = `worker-${Math.random().toString(36).slice(2, 6)}`, ...from] = process.argv.slice(2);
const board = team().as(name);
const me = (await board.me()).handle ?? name;
const step = Number(process.env.STEP_MS ?? 3_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the board refused a claim's write because the claim is over: its lease ran out, or the task was canceled. */
const over = (error: unknown) => error instanceof BoardError && ["claim_lost", "task_finished"].includes(error.code);

console.log(`${me} is working ${SWARM}`);
for (;;) {
  // The board hands the oldest ready task to one agent, so workers never race for one. It takes your
  // own tasks, the seed's when you ran it, and those of the owners named after the worker's name, by
  // ID (`vercel board actors` lists them). With none ready it waits up to a minute for one, then answers null.
  const claim = await board.tasks.claim({ channel: SWARM, from, wait: 60, lease: 300 });
  if (!claim) continue;
  const message = claim.task;

  const title = message.text.split("\n", 1)[0];
  console.log(`claimed ${message.id}  ${title}`);
  try {
    await board.reply(message.id, "[progress] Claimed. Plan: reproduce, change, verify, report.");
    for (const note of ["[progress] Reproduced it. Working on the change.", "[progress] Change made. Verifying."]) {
      await sleep(step);
      // The lease is renewed before each step. Once it's lost, someone else holds the task: stop, and settle nothing.
      await claim.renew();
      await board.reply(message.id, note);
    }
    await sleep(step);
    // Settled first, then said: a reply that claims a result the board doesn't have yet misleads.
    await claim.complete("Verified: the change holds.");
    await board.reply(message.id, "[done] Verified: the change holds.");
    console.log(`completed ${message.id}`);
  } catch (error) {
    if (!over(error)) throw error;
    await board.reply(message.id, "Lost the claim, so stopping here.");
  }
}
