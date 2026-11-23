import { FIRST_TASK_PATH } from "./first-task.ts";
import { ONBOARD_PATH } from "./onboard.ts";
import type { Running } from "./running.ts";
import { duration } from "./overview.ts";
import { headline, isDone, progress, type Setup, type Step, type Task } from "./setup.ts";

// The launcher for whatever doesn't ask for a page: an agent told "set up <this URL>". The same
// steps and tasks the page shows, checked on the same request, as a checklist.

/** A task as a checklist item: its help on the line under it, then each command in its own block. */
function item(task: Task): string[] {
  const help = [task.hint, task.link ? `[${task.link.label}](${task.link.href})` : ""].filter(Boolean).join(" ");
  const commands = (task.commands ?? []).flatMap((command) => ["", "  ```", `  ${command}`, "  ```"]);
  // What the page does with a button, said as the request it makes.
  const action = task.action ? [`  ${task.action.label}: POST ${task.action.path}`] : [];
  return [`- [${task.done ? "x" : " "}] ${task.label}`, ...(help ? [`  ${help}`] : []), ...action, ...commands, ...(commands.length ? [""] : [])];
}

/**
 * Whether a task carries `command`: only one still to do does. The command that opens the board is
 * on the launcher once, always: in the task that asks for it, or under the steps.
 */
export const asksFor = (steps: Step[], command: string): boolean => steps.some((step) => step.tasks.some((task) => task.commands?.includes(command)));

/** How long ago `at` was, as people say it: `4m ago`. */
export const ago = (at: string, now: Date): string => `${duration(now.getTime() - Date.parse(at))} ago`;

/** How many repos have the GitHub app and come into no channel, in a line. Nothing when there's none, or it couldn't be told. */
export const waitingLine = ({ waiting }: Pick<Running["ask"], "waiting">): string => (waiting ? `${waiting} more ${waiting === 1 ? "has" : "have"} the GitHub app.` : "");

/** Where a repo shows: its board channel, and the Slack channel that mirrors it, when one does. */
export const shows = ({ channel, slack }: { channel: string; slack: string | null }): string => (slack ? `${channel} · ${slack}` : channel);

/** The first task, in a line: what it is while it's on offer, and where it is once it started. */
export const firstTaskLine = (first: NonNullable<Running["first"]>, { channel, slack }: Running["ask"]): string =>
  first === "offer" ? "Make the README yours: the factory opens a pull request." : `The factory is making the README yours, in ${slack ?? channel}.`;

/** What the factory has been doing, once it runs: its first task while that's open, the week, its pull requests, its repos. */
function activity({ overview: { week, lastReplyAt, pulls }, repos, ask, first }: Running, now: Date): string[] {
  const plus = week.more ? "+" : "";
  return [
    ...(first ? ["", "## First task", "", `- ${firstTaskLine(first, ask)}${first === "offer" ? ` Start: POST ${FIRST_TASK_PATH}` : ""}`] : []),
    "",
    "## This week",
    "",
    `- ${week.threads}${plus} threads, ${week.messages}${plus} messages`,
    `- ${week.answered} answered${week.firstReplyMs === null ? "" : `, the first reply after ${duration(week.firstReplyMs)} (median)`}`,
    ...(lastReplyAt ? [`- Last reply ${ago(lastReplyAt, now)}`] : []),
    // The ones the factory opened: GitHub counts them, and when it didn't answer there's nothing to say.
    ...(pulls ? ["", "## Pull requests", "", `- ${pulls.open} open, ${pulls.merged} merged, ${pulls.closed} closed, opened by the factory`] : []),
    "",
    "## Repos",
    "",
    ...repos.map(({ repo, channel, slack }) => `- ${repo} in \`${channel}\`${slack ? `, ${slack} in Slack` : ""}`),
    // What the page does with a field and a button, said as the request it makes.
    `- ${[waitingLine(ask), `Onboard one: POST ${ONBOARD_PATH} with {"repo": "<owner>/<repo>"}, or ask in ${ask.slack ?? ask.channel}: onboard <owner>/<repo>`].filter(Boolean).join(" ")}`,
    ...(ask.suggest.length ? [`- With the app, not onboarded: ${ask.suggest.join(", ")}`] : []),
    ...(ask.install ? [`- [Add the GitHub app to more repos](${ask.install})`] : []),
  ];
}

/**
 * The launcher as markdown. `inspect` is the command that opens this factory's board, and `running`
 * what it's been doing, once it runs.
 */
export function markdown(setup: Setup, inspect: string, running: Running | null = null, now = new Date()): string {
  const { title, lede } = headline(setup);
  if (setup.open) return [`# ${title}`, "", lede, "", ...item(setup.task)].join("\n").trimEnd() + "\n";
  const { done, of } = progress(setup.steps);
  const lines = [`# ${title}`, "", `${lede} ${done} of ${of} steps done, checked on this request.`, ...(running ? activity(running, now) : [])];
  setup.steps.forEach((step, i) => {
    const state = isDone(step) ? " (done)" : step.optional ? " (optional)" : "";
    const tasks = step.tasks.flatMap(item);
    // A task that ends on a command already left a blank line.
    while (tasks.at(-1) === "") tasks.pop();
    lines.push("", `## ${i + 1}. ${step.title}${state}`, "", ...tasks);
  });
  if (!asksFor(setup.steps, inspect)) lines.push("", "## Watch the board", "", "```", inspect, "```");
  return lines.join("\n") + "\n";
}

/**
 * What to paste to a coding agent on your machine to have it join a factory that runs: its board
 * is the team's, which the Vercel CLI reads and writes as whoever is signed in, and how it works is
 * its own repo's skills and instructions.
 */
export function joinPrompt({ origin, team, board, home, repo }: { origin: string; team: string | undefined; board: string | null; home: string; repo: string | null }): string {
  // Which board: the team's, and by its name when it isn't the team's default one, as a preview's or a dev server's isn't.
  const scope = `${team ? ` --scope ${team}` : ""}${board ? ` --name ${board}` : ""}`;
  return [
    `Join the software factory at ${origin}, as another agent on its board.`,
    "",
    `- Its board is my Vercel team's. Read and write it with the Vercel CLI: vercel board whoami${scope}`,
    `- Its channels are ${home} and the ones under it, read one at a time: vercel board channels ${home}${scope}`,
    ...(repo ? [`- How it works is in its repo, https://github.com/${repo}: read agent/skills/ and agent/lib/instructions.ts, and work the same way, with "vercel board" where they say "vb".`] : []),
    "- Post under your own name: --as <your name>",
  ].join("\n");
}

/**
 * What to paste to an agent to have it set this factory up: the deployment, and how to read it. A
 * deployment is behind Vercel Authentication, which a plain fetch doesn't get through and the Vercel
 * CLI does, as whoever is signed in.
 */
export function agentPrompt(origin: string, local: boolean): string {
  return local
    ? `Set up ${origin}\n\nIt answers its steps as markdown: curl ${origin}`
    : `Set up ${origin}\n\nIt's behind Vercel Authentication. Read it with the Vercel CLI, which gets its steps as markdown: vercel curl ${origin}`;
}
