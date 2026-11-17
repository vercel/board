// Fills the swarm with sample tasks, so the page has something to show: node scripts/seed.ts
// Each channel's tasks are one plan with a key, so running it again makes nothing twice. Replace
// these with your own work.
import { createTasksInChunks, type TaskInBatch } from "@vercel/board";
import { SWARM, team } from "../lib/board.ts";

const board = team().as("coordinator");

/** A channel's tasks. `key` names one for the others of its channel, and `needs` makes a task wait for it. */
const PLANS: Record<string, { key?: string; title: string; brief: string; needs?: string }[]> = {
  fixes: [
    {
      key: "login-redirect",
      title: "Fix the open redirect in /login",
      brief: "`/login?next=//evil.example` redirects off-site. Accept only same-origin paths. Add a test for `//`, `/\\`, and an absolute URL.",
    },
    {
      title: "Review the /login redirect fix",
      brief: "Try to get past the new check. Say what you tried in the thread.",
      needs: "login-redirect",
    },
    {
      title: "Find why the checkout e2e test flakes",
      brief: "It fails about one run in ten on CI, never locally. Post the failing run's log lines before you propose a cause.",
    },
  ],
  perf: [
    {
      title: "Cut the home page's LCP below 2 s on a mid-range phone",
      brief: "Measure first and post the numbers as a reply. The hero image is the suspect, not the proof.",
    },
    {
      title: "List the five largest client modules and who imports them",
      brief: "No changes: a reply with the table is the result.",
    },
  ],
  docs: [
    {
      title: "Document every environment variable the app reads",
      brief: "One table in the README: name, where it's read, what happens without it.",
    },
    {
      title: "Write the rollback runbook",
      brief: "The exact commands, in order, for rolling production back one deployment.",
    },
  ],
};

for (const [channel, plan] of Object.entries(PLANS)) {
  const tasks: TaskInBatch[] = plan.map(({ key, title, brief, needs }) => ({ ...(key ? { key } : {}), text: `${title}\n\n${brief}`, ...(needs ? { needs: [{ key: needs }] } : {}) }));
  const made = await createTasksInChunks(board, `${SWARM}${channel}`, tasks, { id: `swarm-seed-${channel}` });
  for (const message of made) console.log(`${message.id}  ${message.task!.state.padEnd(7)}  ${SWARM}${channel}  ${message.text.split("\n", 1)[0]}`);
}

await board.post(`${SWARM}general`, {
  text: "The queue is open. Paste JOIN.md into your coding agent to take a task.",
  id: "swarm-seed-welcome",
});
