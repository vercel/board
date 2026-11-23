import type { Board, MessageView, ThreadSummaryView } from "@vercel/board";
import { SWARM, NAME, RUNS, team } from "./board.ts";
import { ownWrite, runs, selfOf } from "./runs.ts";

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
  /** What it is in a launched run (`plan`, `work`, `review`, `find`, `verify`, `report`), from its `role` label: null for a task people made. */
  role: string | null;
  /** The pull request it opened, from its `pr` label, when it opened one. */
  pr: string | null;
  /** Whether this deployment made it: only such a task is one of a launched run's, whatever its channel or labels say. */
  own: boolean;
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
  /** The channel the deployment's runs are announced in, and its newest runs, newest first: the page shows a run by its goal, not its channel. */
  runsChannel: string;
  runs: RunView[];
};

/** A run as the live page shows it: what it was asked, how far it got, and what it spent. */
export type RunView = {
  slug: string;
  /** Its tasks' channel. */
  channel: string;
  /** Its thread in the runs channel, where the deployment logs what it does for the run. */
  thread: string;
  title: string;
  goal: string;
  repo: string;
  scenario: string;
  model: string;
  agents: number;
  /** How many of them are up: one per task that's ready or being worked, so the plan decides it. */
  up: number;
  phase: string;
  note: string | null;
  cost: number;
  budgetUsd: number | null;
  settled: number;
  total: number;
  /** When it stops starting tasks, once it's prepared. */
  deadline: string | null;
  createdAt: string;
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

function toTask({ message, replies, last }: ThreadSummaryView, known: Map<string, string>, self: string | null): Task[] {
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
      role: message.labels.role ?? null,
      pr: message.labels.pr ?? null,
      own: self !== null && task.owner === self && ownWrite(message.by, self),
      author: author(message),
      replies,
      last: last ? line(last) : null,
      createdAt: message.createdAt,
    },
  ];
}

/** When a task's thread was last active: its latest reply, or its root. */
const activeAt = ({ message, last }: ThreadSummaryView) => (last ?? message).createdAt;

/** The latest active last. A sort keeps ties as they came, so in the order the board lists them. */
const byActivity = (tasks: ThreadSummaryView[]) => [...tasks].sort((a, b) => activeAt(a).localeCompare(activeAt(b)));

/**
 * A state's tasks under the swarm, the latest active first. The board lists them by when each was
 * made, oldest first: an open state is its oldest `limit`, the ones next in line. A finished one is
 * the `limit` last active, which can be anywhere in that order (a task made first can finish last),
 * so it asks the board for those with `latest`, which reads to the end itself, latest active last.
 */
async function tasksIn(board: Board, swarm: string, state: State, limit: number): Promise<ThreadSummaryView[]> {
  if (!(FINISHED as readonly State[]).includes(state)) return byActivity((await board.tasks.list({ channel: swarm, state, limit })).tasks).reverse();
  return (await board.tasks.list({ channel: swarm, state, limit, latest: true })).tasks.reverse();
}

/**
 * The swarm as it is now: its newest events, then one task list per state, each a read of the whole
 * subtree. Vercel's board answers both in one request for a caller that reads every channel, as
 * this deployment does: the feed's newest events, and the tasks its index keeps for that state. A
 * caller held to some channels lists tasks in 50 of them at most (400 `channel_tree_too_large`), and
 * the swarm makes a channel per run, so this reads as the deployment. Nothing is kept between
 * snapshots: each is the board as it is, whoever asks and whatever they missed.
 */
export async function snapshot(board: Board = team(), swarm: string = SWARM): Promise<Snapshot> {
  // The feed first: its end is where the live route listens from, so a change that lands between the
  // reads is in the next snapshot rather than in neither.
  const feed = await board.poll({ channel: swarm, last: 100 });
  // What was posted among them, each as it is now. A claim's renewals are events too, so it's fewer than 100.
  const posted = feed.events.flatMap((event) => (event.type === "message.posted" && event.message && !event.message.deleted ? [event.message] : []));
  const [openRead, finishedRead] = await Promise.all([
    Promise.all(OPEN.map((state) => tasksIn(board, swarm, state, OPEN_LIMIT))),
    Promise.all(FINISHED.map((state) => tasksIn(board, swarm, state, FINISHED_LIMIT))),
  ]);
  const self = await selfOf(board).catch(() => null);
  const summaries = [...openRead.flat(), ...finishedRead.flat()];
  // A swarm with no launched runs (agents joining from JOIN.md alone) has no runs channel: that's no runs.
  const launched = await runs(board, 20).catch(() => []);

  const known = handles([...posted, ...summaries.flatMap(({ message, last }) => [message, last])]);
  const [open, finished] = [openRead, finishedRead].map((states) => states.map((threads) => threads.flatMap((thread) => toTask(thread, known, self))));
  return {
    name: NAME,
    swarm,
    cursor: feed.cursor,
    at: new Date().toISOString(),
    // The board lists oldest first; the page reads newest first, state by state.
    tasks: [...open!.flat(), ...finished!.flat()],
    finishedCapped: finished!.some((tasks) => tasks.length >= FINISHED_LIMIT),
    flow: posted.map(line).reverse(),
    runsChannel: RUNS,
    runs: launched.map((run) => ({
      slug: run.slug,
      channel: `${swarm}${run.slug}`,
      thread: run.id,
      title: run.title,
      goal: run.config.goal,
      repo: run.config.repo,
      scenario: run.config.scenario,
      model: run.config.model,
      agents: run.config.agents,
      up: run.up,
      phase: run.phase,
      note: run.note,
      cost: run.cost,
      budgetUsd: run.config.budgetUsd,
      settled: run.settled,
      total: run.total,
      deadline: run.prepared ? new Date(run.prepared.deadline).toISOString() : null,
      createdAt: run.createdAt,
    })),
  };
}

/** How old a snapshot every viewer shares may be: a snapshot is about nine board reads, and the board takes 600 a minute from this project, agents included. */
export const SHARED_MS = 5_000;

let shared: { at: number; value: Promise<Snapshot> } | undefined;

/**
 * The swarm's snapshot, shared by everyone looking at it from this instance: one is read at most
 * every `SHARED_MS`, however many tabs are open, so watching a busy run doesn't spend the board's
 * rate limit that its agents need. A read that failed isn't kept.
 */
export function sharedSnapshot(maxAgeMs = SHARED_MS): Promise<Snapshot> {
  if (shared && Date.now() - shared.at < maxAgeMs) return shared.value;
  const value = snapshot();
  const entry = { at: Date.now(), value };
  shared = entry;
  value.catch(() => {
    if (shared === entry) shared = undefined;
  });
  return value;
}

/** One task's thread: its brief, its labels, and its work log. Only a thread under the swarm. */
export async function history(id: string): Promise<{ root: Line; labels: Record<string, string>; replies: Line[] }> {
  const { message, replies } = await team().thread(id);
  if (!message.channel.startsWith(SWARM)) throw new Error(`${id} isn't in ${SWARM}`);
  return { root: line(message), labels: message.labels, replies: replies.map(line) };
}
