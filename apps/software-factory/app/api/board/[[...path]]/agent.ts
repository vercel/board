import type { WatcherContext } from "@vercel/board";
import { eveName, eveSession, type Task } from "./harness.ts";
import { sendToEve, type EveMessage } from "./eve.ts";

export { INSTRUCTIONS, eveAvatar, eveName, evePreview, policy, type Task } from "./harness.ts";


/**
 * Whether a message was written by the Eve working on `thread` (named `pi` before it had a name of its own). Every Eve
 * posts as the factory's production deployment, whose OIDC token its network policy adds; its profile and session
 * are headers anyone who can write may send, so they only say which thread's Eve it is.
 */
export const byEve = (thread: string, by: { principal: string; profile: string | null; session: string | null }) =>
  !!process.env.VERCEL_PROJECT_ID &&
  by.principal === `vercel:project:${process.env.VERCEL_PROJECT_ID}:production` &&
  (by.profile === eveName(thread) || by.profile === "pi") &&
  by.session === eveSession(thread);

/**
 * Whether a message is one of the board's watchers' own notes (a crosspost, `:security:`'s answer, or saying Eve
 * couldn't start), not a person's: it doesn't wake Eve or triage.
 */
export const byWatcher = (by: { actor: string }) => by.actor.startsWith("board:watch:");

/**
 * Whether a message was written by an agent profile (someone's coding agent, like `julian/claude`, or an Eve), not
 * a person: a coding agent sharing its progress in `dev` shouldn't get a kind, and with it, Eve.
 */
export const byAgent = (by: { profile: string | null }) => by.profile !== null;

/** The Slack workspace the factory syncs with. */
const SLACK = "https://vercel.slack.com";

/**
 * Where a thread came from, as a link Eve can put in its PR: a Slack thread's permalink or a GitHub issue or PR.
 * `origin.thread` is the sync target: `slack:C0123:1727000000.123456`, `github:owner/repo:issue:12`, `github:owner/repo:12`.
 */
export function sourceLink(origin: { thread: string } | null | undefined) {
  const thread = origin?.thread ?? "";
  const slack = /^slack:([A-Z0-9]+):(\d+)\.(\d+)$/.exec(thread);
  if (slack) return { platform: "Slack", url: `${SLACK}/archives/${slack[1]}/p${slack[2]}${slack[3]}` };
  const gh = /^github:([^/:]+\/[^/:]+):(issue:)?(\d+)$/.exec(thread);
  if (gh) return { platform: "GitHub", url: `https://github.com/${gh[1]}/${gh[2] ? "issues" : "pull"}/${gh[3]}` };
  return null;
}

/** The task message that starts Eve on a thread, with where it came from when it's synced. */
export function taskMessage(
  task: string,
  thread: { id: string; origin: { thread: string } | null; author?: { name: string } | null },
) {
  const source = sourceLink(thread.origin);
  const by = thread.author?.name ? ` by ${thread.author.name}` : "";
  return `There's ${task} in board thread #${thread.id}${source ? `, posted${by} on ${source.platform}: ${source.url}` : ""}.`;
}


/** How many times a message to Eve is tried before the thread hears Eve couldn't start, and the wait after a first failure. */
const TRIES = 3;
const RETRY_MS = 5_000;

/**
 * Runs `start` until it works, up to TRIES times, and if it never does, says so in the thread instead of throwing.
 * A watcher that throws gets 5 tries in about 15 seconds, then board drops that event without a word in the thread:
 * one bad start (setup hitting GitHub's rate limit) would leave a reply unanswered, with no reason given. Saying so
 * tells the thread, and the next reply tries again.
 */
export async function startOrSay(
  board: Pick<WatcherContext["board"], "reply">,
  thread: string,
  start: () => Promise<void>,
  retryMs = RETRY_MS,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (attempt < TRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
        continue;
      }
      console.error(`[factory] Eve couldn't start on board thread #${thread}:`, error);
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
      await board.reply(thread, `Eve couldn't start: \`${reason}\`. Reply here to try again.`);
      return;
    }
  }
}

export async function tellEve({ board, ...input }: EveMessage & { board: Pick<WatcherContext["board"], "reply"> }) {
  await startOrSay(board, input.thread, () => sendToEve(input));
}
