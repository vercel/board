import type { MessageView } from "@vercel/board";
import { byAgent } from "../agent/lib/identity.ts";
import type { Pulls } from "./setup.ts";

// What the page shows once the factory runs: the week in its channels, worked out from what the
// board already has, and the pull requests the factory opened, as GitHub counts them. Nothing here
// is kept: every load reads again.
//
// Numbers only. The page reads the board as the deployment, and whoever can open the deployment sees
// it, whatever they may read on the board themselves: so it counts, and never shows what a message
// or a pull request says. The board shows that, to each person as themselves.

export type Overview = {
  /**
   * The last 7 days in the factory's channels: threads with a message in them, messages, the threads
   * the agent answered, and how long a thread waited for its first answer, as the median. `more`
   * says the board had more than one read brings, so the week may hold more than this counts.
   */
  week: { threads: number; messages: number; answered: number; firstReplyMs: number | null; more: boolean };
  /** When the agent last wrote, in what was read. */
  lastReplyAt: string | null;
  /** The pull requests the factory itself opened in its repos, or null when GitHub didn't say. */
  pulls: Pulls | null;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

/**
 * `recent` is the latest messages in the factory's channels, a read of at most `limit`; `pulls`,
 * the factory's own pull requests as GitHub counts them; `principal`, who this deployment is on
 * the board, which tells the agent's messages from the rest.
 */
export function overview(recent: MessageView[], pulls: Pulls | null, principal: string, now: Date, limit: number): Overview {
  const at = (message: MessageView) => Date.parse(message.createdAt);
  const agent = (message: MessageView) => byAgent(message.by, principal);
  const threads = new Map<string, MessageView[]>();
  for (const message of [...recent].sort((a, b) => at(a) - at(b))) {
    const thread = message.re ?? message.id;
    threads.set(thread, [...(threads.get(thread) ?? []), message]);
  }
  const since = now.getTime() - WEEK_MS;
  const week = [...threads.values()].filter((messages) => messages.some((message) => at(message) >= since));
  // A thread's wait: from the first message that isn't the agent's to the agent's first one after it.
  const waits = week.flatMap((messages) => {
    const asked = messages.find((message) => !agent(message));
    const answered = asked && messages.find((message) => agent(message) && at(message) >= at(asked));
    return asked && answered ? [at(answered) - at(asked)] : [];
  });
  const replies = recent.filter(agent).map(at);

  return {
    week: {
      threads: week.length,
      messages: recent.filter((message) => at(message) >= since).length,
      answered: week.filter((messages) => messages.some(agent)).length,
      firstReplyMs: median(waits),
      more: recent.length >= limit,
    },
    lastReplyAt: replies.length ? new Date(Math.max(...replies)).toISOString() : null,
    pulls,
  };
}

/** A length of time as people say it: `14s`, `3m`, `2h`, `5d`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
