import type { Board, MessageView, ThreadSummaryView } from "@vercel/board";
import { SWARM, NAME, team } from "./board.ts";

/** The states the board keeps a task in. */
export const STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;
export type State = (typeof STATES)[number];

/** A message as the page shows it. */
export type Line = { id: string; channel: string; re: string | null; author: string; text: string; at: string };

/** A task: a thread whose state the board keeps, on its root's `task`. */
export type Task = {
  id: string;
  channel: string;
  title: string;
  state: State;
  /** The agent that holds it, by its handle, as it shows on what it writes. */
  holder: string | null;
  /** When the claim runs out. A claimed task past it has stalled, and anyone may take it over. */
  lease: string | null;
  /** The tasks a waiting one waits for, by their IDs. */
  needs: string[];
  /** Why it's held for a person, or how it ended: its result, or why it failed or was canceled. */
  note: string | null;
  author: string;
  replies: number;
  last: Line | null;
  createdAt: string;
};

export type Snapshot = {
  name: string;
  swarm: string;
  /** The board's position this was read at: the live route follows on from it. */
  cursor: string;
  at: string;
  /** Every open task, and the latest few finished ones. */
  tasks: Task[];
  /** True when there are more finished tasks than `tasks` holds, so a count of them is a floor. */
  finishedCapped: boolean;
  /** The latest messages under the swarm, newest first. */
  flow: Line[];
};

const author = (message: MessageView) => message.author?.handle ?? message.by.actor;

const line = (message: MessageView): Line => ({
  id: message.id,
  channel: message.channel,
  re: message.re,
  author: author(message),
  text: message.text,
  at: message.createdAt,
});

/** The states a task is still in play in: the page shows every such task. */
const OPEN = ["waiting", "ready", "claimed", "blocked"] as const;
/** The states a task ends in: the page shows the newest few of each. */
const FINISHED = ["completed", "failed", "canceled"] as const;
const OPEN_LIMIT = 200;
const FINISHED_LIMIT = 25;

/**
 * Who holds a task, as the page shows them: by handle when the snapshot read something they wrote
 * (`known`), so a holder and an author are one agent in the list. An agent logs its plan as it
 * claims, so that's nearly always. Otherwise its profile's name, from its actor's ID: `ada` from
 * `vercel:user:…+ada`, or from a local board's `board:client:ada`.
 */
export const holderOf = (actor: string, known: Map<string, string>) => known.get(actor) ?? (actor.split(/[+:]/).pop() || actor);

/** Each actor's handle, from the messages a snapshot read: a claim names its holder by ID, and the page shows who by handle. */
function handles(messages: (MessageView | null)[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const message of messages) if (message?.author?.handle) known.set(message.by.actor, message.author.handle);
  return known;
}

function toTask({ message, replies, last }: ThreadSummaryView, known: Map<string, string>): Task[] {
  const task = message.task;
  if (!task) return [];
  return [
    {
      id: message.id,
      channel: message.channel,
      title: message.text.split("\n", 1)[0] || "(no title)",
      state: task.state,
      holder: task.claim ? holderOf(task.claim.actor, known) : null,
      lease: task.claim?.until ?? null,
      needs: task.needs,
      note: task.blocked?.reason ?? task.result ?? task.reason ?? null,
      author: author(message),
      replies,
      last: last ? line(last) : null,
      createdAt: message.createdAt,
    },
  ];
}

/**
 * The swarm as it is now: its newest messages, then one read per task state. A task's state is a
 * label too, `board.task` on its root, and a board indexes a label with one value: so
 * `board.task=ready` lists only the ready tasks, newest activity last, while a filter with several
 * values, or the bare key, makes Vercel's board page through every thread in every channel of the
 * swarm. Finished states are read with a small limit, which caps their summaries, the
 * expensive part; Vercel's board still lists every finished task to find the newest few, a request
 * per page of them. Nothing is kept between snapshots: each is the board as it is, whoever asks
 * and whatever they missed.
 */
export async function snapshot(board: Board = team(), swarm: string = SWARM): Promise<Snapshot> {
  // The messages first: their cursor is where the live route listens from, so a change that lands
  // between the reads is in the next snapshot rather than in neither.
  const page = await board.messages({ channel: swarm, limit: 100 });
  const read = async (state: State, limit: number) => (await board.threads({ channel: swarm, label: { "board.task": state }, limit })).threads.reverse();
  const [openRead, finishedRead] = await Promise.all([
    Promise.all(OPEN.map((state) => read(state, OPEN_LIMIT))),
    Promise.all(FINISHED.map((state) => read(state, FINISHED_LIMIT))),
  ]);
  const summaries = [...openRead.flat(), ...finishedRead.flat()];
  const known = handles([...page.messages, ...summaries.flatMap(({ message, last }) => [message, last])]);
  const [open, finished] = [openRead, finishedRead].map((states) => states.map((threads) => threads.flatMap((thread) => toTask(thread, known))));
  return {
    name: NAME,
    swarm,
    cursor: page.cursor,
    at: new Date().toISOString(),
    // The board lists oldest first; the page reads newest first, state by state.
    tasks: [...open!.flat(), ...finished!.flat()],
    finishedCapped: finished!.some((tasks) => tasks.length >= FINISHED_LIMIT),
    flow: page.messages.map(line).reverse(),
  };
}

/** One task's thread: its brief, its labels, and its work log. Only a thread under the swarm. */
export async function history(id: string): Promise<{ root: Line; labels: Record<string, string>; replies: Line[] }> {
  const { message, replies } = await team().thread(id);
  if (!message.channel.startsWith(SWARM)) throw new Error(`${id} isn't in ${SWARM}`);
  return { root: line(message), labels: message.labels, replies: replies.map(line) };
}
