// What the app and the runner in each sandbox agree on. The app writes a RunnerConfig into every
// worker's sandbox, and reads back what the runner leaves on the board. Nothing here imports
// anything, so the same file runs in both places.

/** Dollars per token. */
export type TokenPrice = { input: number; output: number; cacheRead: number };

/** What a worker's sandbox is told, as /vercel/sandbox/campaign/runner.json. It holds no credential: those are in the sandbox's network policy. */
export type RunnerConfig = {
  slug: string;
  /** The campaign's thread: its root's `phase` label says whether to keep working. */
  campaign: string;
  title: string;
  /** The channel the campaign's tasks are in. */
  channel: string;
  /** This agent's profile on the board: `worker-3`. */
  worker: string;
  /** The actor that owns the tasks, by ID: a claim takes another owner's tasks only when it names them. */
  owner: string;
  /** The checkout, and the commit every task starts from. */
  repo: string;
  base: string;
  instructions: string;
  /** Run after each change, with `{files}` as the task's files. Empty for none. */
  verify: string;
  rounds: number;
  model: string;
  /** The model that reviews each diff, or null for no review. */
  reviewModel: string | null;
  thinking: "low" | "medium" | "high";
  /** Each model's context window and price, by ID: what the gateway said when the campaign started. */
  models: Record<string, { context: number; price: TokenPrice | null }>;
  delivery: "patch" | "prs" | "branch";
  /** `owner/name` on GitHub, for pull requests. Null for a repository elsewhere. */
  github: string | null;
  /** The branch pull requests target, and the one `branch` delivery pushes to. */
  baseBranch: string;
  campaignBranch: string;
  /** Epoch ms after which no task is started. */
  deadline: number;
};

/** The labels an agent leaves on a task's root: what the task has cost so far, across every try. */
export const LABEL = { cost: "cost", tokens: "tokens" } as const;

/** The states the board keeps a task in. */
export const STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;
export type State = (typeof STATES)[number];

/** A result or a reason holds 1,000 characters on a board: one is cut to fit. */
export const brief = (text: string) => text.trim().slice(0, 900);

/** A path as one shell word, whatever is in it: `app/(dashboard)/page.tsx` stays one file. */
export const quoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

/** Where the runner and its config are in a sandbox, and where the checkout is. */
export const SANDBOX = {
  dir: "/vercel/sandbox/campaign",
  config: "/vercel/sandbox/campaign/runner.json",
  /** The runner's process ID, which it writes when it starts: how the app tells an agent that's working from a sandbox its agent has left. */
  pid: "/vercel/sandbox/campaign/runner.pid",
  repo: "/vercel/sandbox/repo",
} as const;

/** The phases a campaign's thread wears as its `phase` label. Agents work only while it's `running`. */
export const PHASES = ["preparing", "running", "paused", "stopped", "done", "failed"] as const;
export type Phase = (typeof PHASES)[number];

/** A task's files, from its text: one per line under its title, each after `- `. */
export const taskFiles = (text: string) =>
  text
    .split("\n")
    .slice(1)
    .flatMap((line) => (line.startsWith("- ") ? [line.slice(2).trim()] : []));

/** What a run of a model cost, from its tokens and its price. */
export const costOf = (usage: { input: number; output: number; cacheRead: number }, price: TokenPrice | null) =>
  price ? usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead : 0;

/** The first line a reviewer's answer must start with, and what each means. */
export function verdict(answer: string): { approved: boolean; notes: string } {
  const text = answer.trim();
  const first = text.split("\n", 1)[0]!.toUpperCase();
  // Anything that isn't a clear approval is a request for changes: a reviewer that rambles hasn't approved.
  return { approved: /^\W*APPROVE/.test(first), notes: text.replace(/^.*\n?/, "").trim() || text };
}

/** Whether an agent's last message says the task can't be done as written, and why. */
export function blocked(answer: string): string | null {
  const match = /^\W*BLOCKED:\s*(.+)/im.exec(answer);
  return match ? match[1]!.trim() : null;
}
