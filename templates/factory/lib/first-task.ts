import type { Board, MessageView } from "@vercel/board";

// The factory's first task: making this copy of the template the team's own, starting with its
// README. It's something to see work, end to end, that someone would have to do anyway.

/** Where the page, or an agent setting the factory up, starts it: a POST. */
export const FIRST_TASK_PATH = "/api/launcher/first-task";

/** The label its thread carries, which is how the page knows it started. */
export const FIRST_TASK_LABEL = "first-task";

/** What the factory is asked to do, as the thread's first message. */
export const FIRST_TASK_TEXT =
  "First task: make this repo's README ours. It's still the template's. Cut what's about making a copy of it (the Deploy button, the steps to set one up) and what would be true of any factory, and keep what's true of this one: what it's for, its repos and channels, and how to change it.";

/** Whether a README is still the template's: it carries the button that deploys a copy of it. Nothing to read is no. */
export const templateReadme = (readme: string | undefined): boolean => readme?.includes("https://vercel.com/new/clone") ?? false;

/**
 * Where the first task stands: on `offer` while the README is still the template's and it hasn't
 * started, `started` once its thread is there, and nothing once the README is the team's own.
 */
export type FirstTask = "offer" | "started" | null;

export function firstTask(readme: string | undefined, threads: MessageView[]): FirstTask {
  if (!templateReadme(readme)) return null;
  return threads.some((message) => message.labels[FIRST_TASK_LABEL]) ? "started" : "offer";
}

/**
 * Starts it: the page opens the thread where the factory changes itself, and the agent hears it as
 * it hears anyone, through its watcher. Asked twice, it starts once: the post carries an ID the
 * board keeps one message for. The ID names the channel, since a board keeps one message per ID and
 * a team's factories share a board.
 */
export const startFirstTask = (page: Pick<Board, "post">, channel: string): Promise<MessageView> =>
  page.post(channel, { text: FIRST_TASK_TEXT, labels: { [FIRST_TASK_LABEL]: "readme" }, id: `${FIRST_TASK_LABEL}:${channel.replaceAll("/", ".")}` });

/** Whether a request comes from this deployment's own page, or from something that isn't a browser: another site can't start anything with a visitor's session. */
export const ownRequest = (origin: string | null, host: string): boolean => {
  if (origin === null) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};
