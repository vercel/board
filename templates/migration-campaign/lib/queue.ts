import { BoardError, createTasksInChunks, type Board, type ClaimedTask, type ThreadSummaryView } from "@vercel/board";

// A campaign's work queue, on the board's own tasks. A task is a thread whose state the board
// keeps: who may work it, who holds it and until when, what it's held for, and how it ended. A
// claim is a lease the board fences, so two agents never hold one task, and an agent that stalls
// past its lease can't settle a task another has taken.
//
// The agents in the sandboxes take the same steps with `vb tasks` (sandbox/runner.ts). This is the
// app's side: making a campaign's tasks, reading them, and what a person does to one from the page.

/** How long a claim holds without a renewal, in seconds. Vercel's board gives five minutes at most. */
export const LEASE_S = 300;

/**
 * Makes the campaign's tasks, ready, in as many writes as the board needs. The same `key` again
 * makes none and answers the ones that are there. `owner` is whoever made them, by ID: an agent
 * claims another owner's tasks only when it names them.
 */
export async function createTasks(board: Board, channel: string, key: string, texts: string[]): Promise<{ owner: string; made: number }> {
  const made = await createTasksInChunks(
    board,
    channel,
    texts.map((text) => ({ text })),
    { id: key },
  );
  return { owner: made[0]!.task!.owner, made: made.length };
}

/** Claims the oldest ready task in a channel, as an agent would: `owner` names whose tasks it takes. Null when nothing is ready. */
export const claimNext = (board: Board, channel: string, owner: string): Promise<ClaimedTask | null> => board.tasks.claim({ channel, from: [owner], lease: LEASE_S });

/** Lifts a hold: the task is ready again. False when it wasn't held. */
export async function unblock(board: Board, id: string): Promise<boolean> {
  const held = (await board.thread(id)).message.task?.state === "blocked";
  if (held) await board.tasks.unblock(id);
  return held;
}

/** Calls a task off: an agent that holds it loses its claim, and settles nothing. */
export const cancel = (board: Board, id: string, why: string) => board.tasks.cancel(id, why.slice(0, 900)).then(() => undefined);

const PAGE = 200;

/** Every task of a channel, oldest first, a page at a time, up to `max`. */
export async function allTasks(board: Board, channel: string, max: number): Promise<ThreadSummaryView[]> {
  const found: ThreadSummaryView[] = [];
  let after: string | undefined;
  while (found.length < max) {
    // Before its first task, a campaign's channel isn't there: Vercel's board answers 404 for it, and a local one an empty list.
    const page = await board.tasks.list({ channel, state: "all", limit: PAGE, ...(after ? { after } : {}) }).catch((error: unknown) => {
      if (error instanceof BoardError && error.status === 404) return { tasks: [], cursor: "" };
      throw error;
    });
    found.push(...page.tasks);
    if (page.tasks.length < PAGE || !page.cursor || page.cursor === after) break;
    after = page.cursor;
  }
  return found;
}
