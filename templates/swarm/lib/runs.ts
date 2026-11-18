import { BoardError, createTasksInChunks, type Board, type MessageView, type TaskInBatch, type ThreadSummaryView } from "@vercel/board";
import { LABEL, PHASES, STATES, type Phase, type Role, type State } from "../sandbox/shared.ts";
import { RUNS, runChannel, team } from "./board.ts";
import { readConfig, readSlug, runText, type Config } from "./config.ts";

// A run on the board. Its thread, in RUNS, carries its config as text and where it stands as
// labels: its phase, what it has spent, and how far its tasks are. Its tasks are threads in a
// channel of its own (runChannel), each a task the board keeps the state of. Nothing about a run is
// kept anywhere else, so the page, the agents, and `vb` all read the same thing.

/** What the launch learned about the checkout, kept as a reply in the run's thread for the app to read back. */
export type Prepared = {
  /** The commit every task starts from, and the branch it was on: what pull requests target. */
  base: string;
  baseBranch: string;
  /** The actor that owns the run's tasks, by ID. */
  owner: string;
  /** Epoch ms the run goes until. */
  deadline: number;
  /**
   * The run's control thread, in its own channel: its phase and spend, mirrored there, are what its
   * agents read. They never read the runs channel, which holds every run's goal and repo.
   */
  control?: string;
};

export type Run = {
  /** Its thread's ID. */
  id: string;
  slug: string;
  title: string;
  config: Config;
  phase: Phase;
  /** Why it stopped or failed, in a line. */
  note: string | null;
  /** What its agents have spent so far, as its last reconcile summed it. */
  cost: number;
  /** Its tasks that are settled, and all of them, as its last reconcile counted them. */
  settled: number;
  total: number;
  /** How many of its agents are up, as its last reconcile counted them. */
  up: number;
  /** Whether its sandboxes are gone: an ended run is reconciled until they are. */
  torn: boolean;
  prepared: Prepared | null;
  createdAt: string;
};

/** One of a run's tasks, as reconcile and the page read it. */
export type Task = {
  id: string;
  title: string;
  role: Role | null;
  state: State;
  cost: number;
  labels: Record<string, string>;
};

/** A run as it is now: its thread, every task, and what they've spent. */
export type Snapshot = { run: Run; tasks: Task[]; counts: Record<State, number>; cost: number };

const STATE = /```json state\n([\s\S]*?)\n```/;

/** A number a label holds, or 0: a label anyone can write may hold anything. */
export const amount = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

type By = { principal: string; profile: string | null };

/** Whether this deployment itself wrote something: its own principal, under no profile. Nothing else on the board is the app's word. */
export const ownWrite = (by: By, self: string) => by.principal === self && by.profile === null;

const selves = new WeakMap<Board, Promise<string>>();

/** This deployment's principal on `board`, read once per handle. */
export function selfOf(board: Board): Promise<string> {
  let known = selves.get(board);
  if (!known) {
    known = board.me().then((me) => me.principal);
    known.catch(() => selves.delete(board));
    selves.set(board, known);
  }
  return known;
}

/**
 * A run from its thread, when this deployment wrote it: a thread anyone else posted in the runs
 * channel isn't a run, whatever it says. What the launch recorded is read only from the
 * deployment's own replies, the last one standing, so nothing a repo's install printed, and nothing
 * someone replied, can change a run's deadline, base, or owner.
 */
function toRun(message: MessageView, replies: MessageView[], self: string): Run | null {
  if (!ownWrite(message.by, self)) return null;
  // Which run it is comes from its text, which only the deployment wrote; the label only finds it.
  const slug = readSlug(message.text);
  const config = readConfig(message.text);
  if (!slug || !config) return null;
  let prepared: Prepared | null = null;
  for (const reply of replies) {
    if (!ownWrite(reply.by, self)) continue;
    const match = STATE.exec(reply.text);
    if (!match) continue;
    try {
      prepared = JSON.parse(match[1]!) as Prepared;
    } catch {}
  }
  const phase = message.labels.phase as Phase;
  return {
    id: message.id,
    slug,
    title: config.title,
    config,
    phase: PHASES.includes(phase) ? phase : "failed",
    note: message.labels.note ?? null,
    cost: amount(message.labels.cost),
    settled: amount(message.labels.settled),
    total: amount(message.labels.total),
    up: amount(message.labels.up),
    torn: message.labels.torn === "yes",
    prepared,
    createdAt: message.createdAt,
  };
}

/** A slug for a new run: short, sortable by when it was made, and a channel name the board takes. */
export const newSlug = (now = Date.now()) => `r${now.toString(36)}`;

/** A run's slug, as the page and its actions take one. */
export const SLUG = /^r[a-z0-9]{4,16}$/;

/** Starts a run's thread, in `preparing`. The same `slug` again answers the thread that's there. */
export async function create(board: Board, config: Config, slug: string): Promise<Run> {
  // `torn=no` until its sandboxes are gone: reconcile finds the runs that may have sandboxes by that one label.
  const message = await board.post(RUNS, { text: runText(config, slug), labels: { run: slug, phase: "preparing", torn: "no" }, id: `run-${slug}` });
  return toRun(message, [], await selfOf(board))!;
}

/** Whether a failed label write lost a compare-and-set to someone else's write. */
export const lostRace = (error: unknown) => error instanceof BoardError && error.code === "label_conflict";

/** Moves a run to `phase`, from `from` when given: a phase someone else already changed stays as they left it. False then. */
export async function setPhase(board: Board, id: string, phase: Phase, opts: { from?: Phase; note?: string } = {}): Promise<boolean> {
  try {
    await board.label(id, {
      set: { phase, ...(opts.note ? { note: opts.note.slice(0, 200) } : {}) },
      ...(opts.note ? {} : { unset: ["note"] }),
      ...(opts.from ? { if: { phase: opts.from } } : {}),
    });
    return true;
  } catch (error) {
    if (lostRace(error)) return false;
    throw error;
  }
}

/** A line in the run's thread: what the launch or the app did, for whoever reads the board. */
export const say = (board: Board, id: string, text: string) => board.reply(id, text.slice(0, 9_000)).then(() => undefined);

/** Records what the launch learned, as the reply `toRun` reads back: the state alone, so nothing else in the reply can pass for it. */
export const savePrepared = (board: Board, id: string, prepared: Prepared) =>
  board.reply(id, `What the launch recorded.\n\n\`\`\`json state\n${JSON.stringify(prepared)}\n\`\`\``).then(() => undefined);

/** Opens a run's control thread in its channel: its agents read the run's phase and spend there. */
export const openControl = async (board: Board, slug: string) =>
  (await board.post(runChannel(slug), { text: "This run's phase and spend, for its agents.", labels: { phase: "running", cost: "0" }, id: `control-${slug}` })).id;

/** Mirrors a run's phase or spend onto its control thread. Best effort: an agent that can't read it stops at its deadline. */
export async function mirror(board: Board, run: Pick<Run, "prepared">, labels: Record<string, string>): Promise<void> {
  if (run.prepared?.control) await board.label(run.prepared.control, { set: labels }).catch(() => {});
}

/** An actor's ID without its profile: `--from` takes the person, and that covers every profile of theirs. */
export const personOf = (actor: string) => actor.split("+", 1)[0]!;

/**
 * Adds tasks to a run's queue, ready or waiting as their `needs` say, in as many writes as the board
 * needs. The same `key` again makes none and answers the ones that are there. The owner it answers
 * is who made them, by ID: an agent claims another owner's tasks only when it names them.
 */
export async function addTasks(board: Board, slug: string, key: string, tasks: TaskInBatch[]): Promise<{ owner: string; made: number }> {
  const made = await createTasksInChunks(board, runChannel(slug), tasks, { id: key });
  return { owner: personOf(made[0]?.task?.owner ?? (await board.me()).principal), made: made.length };
}

/** Every run on the board this deployment started, newest first. */
export async function runs(board: Board = team(), limit = 50, label?: Record<string, string>): Promise<Run[]> {
  const { threads } = await board.threads({ channel: RUNS, limit, ...(label ? { label } : {}) }).catch((error: unknown) => {
    // Before its first run, the channel isn't there: Vercel's board answers 404 for it.
    if (error instanceof BoardError && error.status === 404) return { threads: [] };
    throw error;
  });
  const self = await selfOf(board);
  return threads.flatMap(({ message }) => toRun(message, [], self) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One run with what its launch recorded, by its slug. Null when the board has none. */
export async function run(slug: string, board: Board = team()): Promise<Run | null> {
  const { threads } = await board.threads({ channel: RUNS, label: { run: slug }, limit: 5 }).catch(() => ({ threads: [] as ThreadSummaryView[] }));
  const self = await selfOf(board);
  const root = threads.find(({ message }) => readSlug(message.text) === slug && ownWrite(message.by, self))?.message;
  if (!root) return null;
  const { message, replies } = await board.thread(root.id);
  return toRun(message, replies, self);
}

const PAGE = 200;

/** Every task of a run, oldest first, a page at a time: one list, so a task that changes state mid-read is in it once. */
export async function tasks(board: Board, slug: string, max = 1_000): Promise<Task[]> {
  const found: ThreadSummaryView[] = [];
  let after: string | undefined;
  while (found.length < max) {
    const page = await board.tasks.list({ channel: runChannel(slug), state: "all", limit: PAGE, ...(after ? { after } : {}) }).catch((error: unknown) => {
      if (error instanceof BoardError && error.status === 404) return { tasks: [], cursor: "" };
      throw error;
    });
    found.push(...page.tasks);
    if (page.tasks.length < PAGE || !page.cursor || page.cursor === after) break;
    after = page.cursor;
  }
  // Only the tasks this deployment made are the run's: anyone who may post in the channel can make
  // a task there, which no agent would take, and which mustn't start sandboxes or count as spend.
  const self = await selfOf(board);
  return found.flatMap(({ message }) => {
    const task = message.task;
    if (!task || task.owner !== self || !ownWrite(message.by, self)) return [];
    // A claim past its lease is over, whatever the state still says: the task is anyone's to take.
    const held = task.claim && Date.parse(task.claim.until) > Date.now();
    const role = message.labels[LABEL.role] as Role | undefined;
    return [
      {
        id: message.id,
        title: message.text.split("\n", 1)[0] || "(no title)",
        role: role ?? null,
        state: task.state === "claimed" && !held ? "ready" : task.state,
        cost: amount(message.labels[LABEL.cost]),
        labels: message.labels,
      },
    ];
  });
}

/** A run as it is now, or null when the board has no such run. */
export async function snapshot(slug: string, board: Board = team()): Promise<Snapshot | null> {
  const found = await run(slug, board);
  if (!found) return null;
  const all = await tasks(board, slug);
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  for (const task of all) counts[task.state]++;
  return { run: found, tasks: all, counts, cost: all.reduce((sum, task) => sum + task.cost, 0) };
}
