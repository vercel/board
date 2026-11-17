import { BoardError, type Board, type MessageView, type ThreadSummaryView } from "@vercel/board";
import { LABEL, PHASES, STATES, taskFiles, type Phase, type State } from "../sandbox/shared.ts";
import { ROOT, tasksChannel, team } from "./board.ts";
import { campaignText, readConfig, taskText, type Config } from "./config.ts";
import { allTasks as listTasks, createTasks } from "./queue.ts";

export { STATES, type State };

// A campaign on the board. Its thread, in ROOT, carries its config as text and its phase as a
// label. Its tasks are threads in a channel of its own under ROOT, each a task the board keeps the
// state of (lib/queue.ts): who holds it, how it ended, what it's held for. Nothing about a
// campaign is kept anywhere else, so the page, the agents, and `vb` all read the same thing.

/** What the launch learned about the checkout, kept as a reply in the campaign's thread for the app to read back. */
export type Prepared = {
  /** The commit every task starts from. */
  base: string;
  /** The branch it was on: what pull requests target. */
  baseBranch: string;
  /** The actor that owns the tasks, by ID. */
  owner: string;
  /** Epoch ms the campaign runs until. */
  deadline: number;
  files: number;
  tasks: number;
};

export type Campaign = {
  /** Its thread's ID. */
  id: string;
  slug: string;
  title: string;
  config: Config;
  phase: Phase;
  /** How many agents it should have: the form's number, until someone changes it on the page. */
  agents: number;
  /** Why it stopped or failed, in a line. */
  note: string | null;
  /** Whether its sandboxes are gone: an ended campaign is reconciled until they are. */
  torn: boolean;
  prepared: Prepared | null;
  createdAt: string;
  by: string;
};

/** A message as the page shows it. */
export type Line = { id: string; author: string; text: string; at: string; files: { id: string; name: string }[] };

export type Task = {
  id: string;
  title: string;
  files: number;
  state: State;
  /** The agent that holds it, by its profile's name, and when its lease runs out. */
  holder: string | null;
  until: string | null;
  /** What it's held for, when blocked: the kind (`needs_input`, `error`) and the reason. */
  held: { kind: string | null; reason: string } | null;
  /** How it ended, in a line: a completed task's result, or why it was canceled. */
  result: string | null;
  cost: number;
  tokens: number;
  replies: number;
  last: Line | null;
  updatedAt: string;
};

export type Snapshot = {
  campaign: Campaign;
  tasks: Task[];
  counts: Record<State, number>;
  cost: number;
  tokens: number;
  /** The campaign thread's own log: what the launch and the app said, oldest first. */
  log: Line[];
  /** The board's position this was read at: the live route follows on from it. */
  cursor: string;
  at: string;
};

const author = (message: MessageView) => message.author?.handle ?? message.by.actor;

const line = (message: MessageView): Line => ({
  id: message.id,
  author: author(message),
  text: message.text,
  at: message.createdAt,
  files: (message.attachments ?? []).map(({ id, name }) => ({ id, name })),
});

const STATE = /```json state\n([\s\S]*?)\n```/;

function toCampaign(message: MessageView, replies: MessageView[] = []): Campaign | null {
  const slug = message.labels.campaign;
  const config = readConfig(message.text);
  if (!slug || !config) return null;
  const phase = message.labels.phase as Phase;
  let prepared: Prepared | null = null;
  for (const reply of replies) {
    const match = STATE.exec(reply.text);
    if (!match) continue;
    try {
      prepared = JSON.parse(match[1]!) as Prepared;
    } catch {}
  }
  return {
    id: message.id,
    slug,
    title: config.title,
    config,
    phase: PHASES.includes(phase) ? phase : "failed",
    agents: Number(message.labels.agents) || config.agents,
    note: message.labels.note ?? null,
    torn: message.labels.torn === "yes",
    prepared,
    createdAt: message.createdAt,
    by: author(message),
  };
}

/** A profile's name from an actor's ID: `worker-3` from `vercel:project:…+worker-3`, or from a local board's `board:client:worker-3`. */
const profile = (actor: string) => actor.split(/[+:]/).pop() || actor;

function toTask({ message, replies, last }: ThreadSummaryView): Task[] {
  const task = message.task;
  if (!task) return [];
  // A claim past its lease is over, whatever the state still says: the task is anyone's to take.
  const held = task.claim && Date.parse(task.claim.until) > Date.now() ? task.claim : null;
  return [
    {
      id: message.id,
      title: message.text.split("\n", 1)[0] || "(no title)",
      files: taskFiles(message.text).length,
      state: task.state === "claimed" && !held ? "ready" : task.state,
      holder: held ? profile(held.actor) : null,
      until: held?.until ?? null,
      held: task.state === "blocked" ? { kind: task.blocked?.kind ?? null, reason: task.blocked?.reason ?? "Held." } : null,
      result: task.result ?? task.reason ?? null,
      cost: Number(message.labels[LABEL.cost]) || 0,
      tokens: Number(message.labels[LABEL.tokens]) || 0,
      replies,
      last: last ? line(last) : null,
      updatedAt: last?.createdAt ?? message.createdAt,
    },
  ];
}

/** A slug for a new campaign: short, sortable by when it was made, and a channel name the board takes. */
export const newSlug = (now = Date.now()) => `c${now.toString(36)}`;

/** Starts a campaign's thread, in `preparing`. The same `slug` again answers the thread that's there. */
export async function create(board: Board, config: Config, slug: string): Promise<Campaign> {
  const message = await board.post(ROOT, {
    text: campaignText(config),
    labels: { campaign: slug, phase: "preparing", agents: String(config.agents) },
    id: `campaign-${slug}`,
  });
  return toCampaign(message)!;
}

/** Moves a campaign to `phase`, from `from` when given: a phase someone else already changed stays as they left it. False then. */
export async function setPhase(board: Board, id: string, phase: Phase, opts: { from?: Phase; note?: string } = {}): Promise<boolean> {
  try {
    await board.label(id, {
      set: { phase, ...(opts.note ? { note: opts.note.slice(0, 200) } : {}) },
      ...(opts.note ? {} : { unset: ["note"] }),
      ...(opts.from ? { if: { phase: opts.from } } : {}),
    });
    return true;
  } catch (error) {
    if (error instanceof BoardError && error.code === "label_conflict") return false;
    throw error;
  }
}

/** A line in the campaign's thread: what the launch or the app did, for whoever reads the board. */
export const say = (board: Board, id: string, text: string) => board.reply(id, text.slice(0, 9_000)).then(() => undefined);

/** Records what the launch learned, as the reply `toCampaign` reads back. */
export const savePrepared = (board: Board, id: string, prepared: Prepared, text: string) =>
  board.reply(id, `${text}\n\n\`\`\`json state\n${JSON.stringify(prepared)}\n\`\`\``).then(() => undefined);

/** Makes the campaign's tasks, one per group of files, ready to claim. The same slug again makes none twice. */
export const addTasks = (board: Board, slug: string, groups: string[][]): Promise<{ owner: string; made: number }> =>
  createTasks(board, tasksChannel(slug), `plan-${slug}`, groups.map(taskText));

/** Every campaign on the board, newest first. */
export async function campaigns(board: Board = team()): Promise<Campaign[]> {
  const { threads } = await board.threads({ channel: ROOT, limit: 100 });
  return threads
    .flatMap(({ message }) => toCampaign(message) ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One campaign with what its launch recorded, by its slug. Null when the board has none. */
export async function campaign(slug: string, board: Board = team()): Promise<Campaign | null> {
  const { threads } = await board.threads({ channel: ROOT, label: { campaign: slug }, limit: 5 });
  const root = threads.find(({ message }) => message.labels.campaign === slug)?.message;
  if (!root) return null;
  const { message, replies } = await board.thread(root.id);
  return toCampaign(message, replies);
}

/** The most tasks a snapshot reads: a campaign makes 2,000 at most. */
const READ_MAX = 2_000;

/** Every task of a campaign, oldest first: one list, a page at a time, so a task that changes state mid-read is still in it once. */
const allTasks = async (board: Board, slug: string): Promise<Task[]> => (await listTasks(board, tasksChannel(slug), READ_MAX)).flatMap(toTask);

/**
 * A campaign as it is now: its thread, every task, and what they've spent. Nothing is kept between
 * snapshots: each is the board as it is, whoever asks. Null when the board has no such campaign.
 */
export async function snapshot(slug: string, board: Board = team()): Promise<Snapshot | null> {
  // The position first: a change that lands between the reads is in the next snapshot rather than in neither.
  // One channel's read, whatever the number of campaigns: its cursor is the board's position all the same.
  const { cursor } = await board.messages({ channel: ROOT, limit: 1 });
  const { threads } = await board.threads({ channel: ROOT, label: { campaign: slug }, limit: 5 });
  const root = threads.find(({ message }) => message.labels.campaign === slug)?.message;
  if (!root) return null;
  const [{ message, replies }, tasks] = await Promise.all([board.thread(root.id), allTasks(board, slug)]);
  const found = toCampaign(message, replies);
  if (!found) return null;
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  for (const task of tasks) counts[task.state]++;
  return {
    campaign: found,
    tasks,
    counts,
    cost: tasks.reduce((sum, task) => sum + task.cost, 0),
    tokens: tasks.reduce((sum, task) => sum + task.tokens, 0),
    log: replies.map(line).map((entry) => ({ ...entry, text: entry.text.replace(STATE, "").trim() })),
    cursor,
    at: new Date().toISOString(),
  };
}

/** One task's thread: its files, and its work log. Only a thread of this campaign. */
export async function history(slug: string, id: string, board: Board = team()): Promise<{ root: Line; replies: Line[] }> {
  const { message, replies } = await board.thread(id);
  if (message.channel !== tasksChannel(slug)) throw new Error(`${id} isn't a task of ${slug}`);
  return { root: line(message), replies: replies.map(line) };
}
