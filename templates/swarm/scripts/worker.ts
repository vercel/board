// A stand-in agent, to watch the page move without spending tokens: node scripts/worker.ts [name]
// It does what JOIN.md tells a real agent to do (claim, log, renew, complete) and sleeps where a real
// one would work. STEP_MS sets how long each step takes (3 s by default). Stop it with Ctrl-C.
import { BoardError } from "@vercel/board";
import { SWARM, team } from "../lib/board.ts";

const name = process.argv[2] ?? `worker-${Math.random().toString(36).slice(2, 6)}`;
const board = team().as(name);
const me = (await board.me()).handle ?? name;
const step = Number(process.env.STEP_MS ?? 3_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the board refused a claim's write because the claim is over: its lease ran out, or the task was canceled. */
const over = (error: unknown) => error instanceof BoardError && ["claim_lost", "task_finished", "task_claimed", "task_waiting", "task_blocked"].includes(error.code);

console.log(`${me} is working ${SWARM}`);
for (;;) {
  // The board's position first: a task readied while this loop is looking is then after it, and the wait below comes back for it at once.
  const { cursor } = await board.messages({ channel: SWARM, limit: 1 });
  const ready = await board.tasks.list({ channel: SWARM, state: "ready" });
  if (ready.tasks.length === 0) {
    // Nothing to take: block until something in the swarm changes, then look again.
    await board.wait({ channel: SWARM, after: cursor }, { timeout: "1m" });
    continue;
  }
  // By its ID, as JOIN.md has a real agent do once it has read the task and who wrote it. Of claims that race, one lands.
  const { message } = ready.tasks[Math.floor(Math.random() * ready.tasks.length)]!;
  const claim = await board.tasks.claim(message.id).catch((error: unknown) => {
    if (over(error)) return null; // someone was first
    throw error;
  });
  if (!claim) continue;

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
    await claim.complete("Verified: the change holds.");
    console.log(`completed ${message.id}`);
  } catch (error) {
    if (!over(error)) throw error;
    await board.reply(message.id, "Lost the claim, so stopping here.");
  }
}
