// Answers a held task from the terminal: node --env-file=.env.local scripts/answer.ts <slug> <task-id> "<note>"
// The note goes in the task's thread, where the next agent reads it, and the task is ready again.
import { team } from "../lib/board.ts";
import { history } from "../lib/campaign.ts";
import { unblock } from "../lib/queue.ts";
import { reconcile } from "../lib/run.ts";

const [slug, id, note] = process.argv.slice(2);
if (!slug || !id) {
  console.error('usage: scripts/answer.ts <slug> <task-id> "<note>"');
  process.exit(2);
}
await history(slug, id); // only a task of this campaign
if (note?.trim()) await team().reply(id, note.trim());
console.log((await unblock(team(), id)) ? `ready ${id}` : `${id} wasn't held`);
await reconcile(slug, team(), undefined, { force: true });
