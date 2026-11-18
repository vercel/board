// What the app and the runner in each sandbox agree on. The app writes a RunnerConfig into every
// agent's sandbox, and reads back what the runner leaves on the board. Nothing here imports
// anything, so the same file runs in both places.

/** Dollars per token. */
export type TokenPrice = { input: number; output: number; cacheRead: number };

/** What a run does with its repo: plan and open pull requests, or read it and report what's wrong. */
export const SCENARIOS = ["pipeline", "review"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/**
 * What a task asks of the agent that claims it, as its `role` label says.
 * - pipeline: `plan` splits the goal into `work` tasks, each with a `review` that waits for it.
 * - review: `find` reads one area of the repo, `verify` checks what it found, `report` sums them up.
 */
export const ROLES = ["plan", "work", "review", "find", "verify", "report"] as const;
export type Role = (typeof ROLES)[number];

/** What an agent's sandbox is told, as /vercel/sandbox/swarm/runner.json. It holds no credential: those are in the sandbox's network policy. */
export type RunnerConfig = {
  slug: string;
  /** The run's control thread, in its own channel: its `phase` and `cost` labels say whether to keep working. */
  control: string;
  /** The run's goal, in the words of whoever launched it. Every agent reads it. */
  goal: string;
  scenario: Scenario;
  /** The channel the run's tasks are in. */
  channel: string;
  /** This agent's profile on the board: `agent-3`. */
  worker: string;
  /** The actor that owns the run's tasks, by ID: a claim takes another owner's tasks only when it names them. */
  owner: string;
  /** The checkout, and the commit every task starts from. */
  repo: string;
  base: string;
  /** The branch pull requests target. */
  baseBranch: string;
  /** `owner/name` on GitHub. */
  github: string;
  /** The prefix of every branch the run pushes: `swarm/<slug>`. */
  branches: string;
  model: string;
  /** The model's context window and price: what the gateway said when the run started. A model with no price costs nothing here. */
  context: number;
  price: TokenPrice | null;
  /** The most work tasks a plan makes. */
  maxTasks: number;
  /** How many agents the run has: the planner splits the goal to keep as many busy as it genuinely allows. */
  agents: number;
  /** What the whole run may spend, in dollars, or null for no cap. */
  budgetUsd: number | null;
  /** Epoch ms after which no task is started. */
  deadline: number;
  /** How often at most an agent posts what it's doing in its task's thread: longer in a big run, which shares the board's write limit. */
  progressMs: number;
};

/** What an agent is doing, in a few words, from the tool it just called: what its task's thread shows as it works. */
export function doing(tool: string, args: unknown): string | null {
  const given = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const said = (key: string) => (typeof given[key] === "string" ? (given[key] as string).replace(/\s+/g, " ").trim() : "");
  // A path in the repo, or a command's program, and never more: a command's arguments, or what an
  // agent searches for, can hold what the board's readers shouldn't see.
  const path = (key: string) => {
    const value = said(key);
    return /^[\w./@+-]{1,160}$/.test(value) ? value : "";
  };
  switch (tool) {
    case "bash": {
      const program = said("command").replace(/^(?:cd \S+ && |[A-Z_]+=\S+ )*/, "").split(" ", 1)[0] ?? "";
      return /^[\w./-]{1,40}$/.test(program) ? `running \`${program}\`` : "running a command";
    }
    case "read":
      return `reading ${path("path") || "a file"}`;
    case "edit":
    case "write":
      return `editing ${path("path") || "a file"}`;
    case "grep":
      return "searching the code";
    case "find":
    case "ls":
      return `looking around ${path("path") || "the repo"}`;
    default:
      return null;
  }
}

/** The labels on a task's root: its role, what it has cost so far across every try, and what it left behind. */
export const LABEL = { role: "role", cost: "cost", tokens: "tokens", worker: "worker", pr: "pr", branch: "branch", expanded: "expanded" } as const;

/** The states the board keeps a task in. */
export const STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;
export type State = (typeof STATES)[number];

/** The phases a run's thread wears as its `phase` label. Agents work only while it's `running`. */
export const PHASES = ["preparing", "running", "stopped", "done", "failed"] as const;
export type Phase = (typeof PHASES)[number];

/** Where the runner and its config are in a sandbox, and where the checkout is. */
export const SANDBOX = {
  /** The runner and its dependencies. */
  dir: "/vercel/sandbox/swarm",
  /** What the runner writes: its config, its process ID, and the agent's home. */
  state: "/vercel/sandbox/state",
  config: "/vercel/sandbox/state/runner.json",
  /** The runner's process ID, which it writes when it starts: how the app tells an agent that's working from a sandbox its agent has left. */
  pid: "/vercel/sandbox/state/runner.pid",
  repo: "/vercel/sandbox/repo",
} as const;

/** The first word of each reply that carries an agent's output, so the next agent finds it in a thread. */
export const OUTPUT = { plan: "[plan]", work: "[done]", review: "[review]", find: "[findings]", verify: "[verified]", report: "[report]" } as const satisfies Record<Role, string>;

/** A result or a reason holds 1,000 characters on a board: one is cut to fit. */
export const brief = (text: string) => text.trim().slice(0, 900);

/** What a run of a model cost, from its tokens and its price. */
export const costOf = (usage: { input: number; output: number; cacheRead: number }, price: TokenPrice | null) =>
  price ? usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead : 0;

/** A task's text: its title on the first line, then its brief. */
export const taskText = (title: string, body: string) => `${title.trim().split("\n", 1)[0]!.slice(0, 200)}\n\n${body.trim()}`.trim();

/** A task's title and brief, from its text. */
export function splitTask(text: string): { title: string; body: string } {
  const [title = "", ...rest] = text.split("\n");
  return { title: title.trim(), body: rest.join("\n").trim() };
}

/** One task of a plan: what a person would read in a queue. */
export type Planned = { title: string; brief: string };

/**
 * The tasks a planner's answer lists, from its first ```json block (or the whole answer when it's
 * bare JSON): an array of `{ title, brief }`, `max` at most. Empty when there's none to read.
 */
export function parsePlan(answer: string, max: number): Planned[] {
  const fenced = /```(?:json)?(?:\s+plan)?\n([\s\S]*?)\n```/.exec(answer)?.[1] ?? answer.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { tasks?: unknown })?.tasks) ? (parsed as { tasks: unknown[] }).tasks : [];
  return items
    .flatMap((item) => {
      const { title, brief: body } = (item ?? {}) as { title?: unknown; brief?: unknown };
      return typeof title === "string" && title.trim() && typeof body === "string" ? [{ title: title.trim().slice(0, 200), brief: body.trim().slice(0, 4_000) }] : [];
    })
    .slice(0, max);
}

/** The most a reply the runner posts holds: the board takes 10,000 characters a message. */
export const REPLY_MAX = 9_500;

/**
 * The plan as the planner's replies carry it: one that lists the titles for a person, then one per
 * task with its JSON, which the app reads back. One reply per task, since a plan of a few detailed
 * briefs runs past what one message holds, and a plan cut off there reads as no plan at all.
 */
export function planReplies(tasks: Planned[]): string[] {
  const head = `${OUTPUT.plan} ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}:`;
  const lines: string[] = [];
  let size = head.length;
  for (const task of tasks) {
    const line = `\n- ${task.title}`;
    if (size + line.length > REPLY_MAX - 40) {
      lines.push(`\n- and ${tasks.length - lines.length} more`);
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return [
    head + lines.join(""),
    ...tasks.map((task, i) => `[plan] task ${i + 1} of ${tasks.length}: ${task.title}\n\n\`\`\`json plan-task\n${JSON.stringify({ n: i + 1, of: tasks.length, ...task })}\n\`\`\``),
  ];
}

/** The plan in a planner's replies, in order: one task per `plan-task` block. Empty until every task of it is there. */
export function planFrom(replies: string[], max: number): Planned[] {
  const found = new Map<number, Planned>();
  let of = 0;
  for (const text of replies) {
    const block = /\`\`\`json plan-task\n([\s\S]*?)\n\`\`\`/.exec(text)?.[1];
    if (!block) continue;
    try {
      const item = JSON.parse(block) as { n?: unknown; of?: unknown; title?: unknown; brief?: unknown };
      if (typeof item.n !== "number" || typeof item.of !== "number" || typeof item.title !== "string" || typeof item.brief !== "string") continue;
      found.set(item.n, { title: item.title, brief: item.brief });
      of = item.of;
    } catch {
      continue;
    }
  }
  if (of > 0) return found.size < of ? [] : Array.from({ length: of }, (_, i) => found.get(i + 1)!).slice(0, max);
  // A runner from before one reply per task posts its plan whole, in one `json plan` block: read when it isn't cut off.
  for (const text of [...replies].reverse()) {
    const whole = /\`\`\`json plan\n[\s\S]*?\n\`\`\`/.exec(text)?.[0];
    const plan = whole ? parsePlan(whole, max) : [];
    if (plan.length) return plan;
  }
  return [];
}

/** The first line a reviewer's answer must start with, and what each means. Anything that isn't a clear approval asks for changes. */
export function verdict(answer: string): { approved: boolean; notes: string } {
  const text = answer.trim();
  const first = text.split("\n", 1)[0]!.toUpperCase();
  return { approved: /^\W*APPROVE/.test(first), notes: text.replace(/^.*\n?/, "").trim() || text };
}

/** Whether an agent's answer says the task can't be done as written, and why. */
export function blocked(answer: string): string | null {
  const match = /^\W*BLOCKED:\s*(.+)/im.exec(answer);
  return match ? match[1]!.trim() : null;
}

/** The paths a find task covers, from its text: one per line under its title, each after `- `. */
export const taskPaths = (text: string) =>
  text
    .split("\n")
    .slice(1)
    .flatMap((line) => (line.startsWith("- ") ? [line.slice(2).trim()] : []));

/**
 * Which of `self`'s profiles wrote something: null for `self` itself, undefined for someone else.
 * Vercel's board says a profile beside its principal (`profile: "agent-3"`); a local board names it
 * in the principal (`board:client:agent-3`).
 */
export function profileOfSelf(by: { principal?: string; profile?: string | null } | undefined, self: string): string | null | undefined {
  if (!by?.principal) return undefined;
  if (by.principal === self) return by.profile ?? null;
  if (by.principal.startsWith(`${self}:`) && !by.profile) return by.principal.slice(self.length + 1);
  return undefined;
}
