import { eveName } from "./agent.ts";

// When `review-pi` starts Eve reviewing a PR. A draft isn't ready for review, so its thread
// waits: Eve reviews a PR when it opens ready, or when it leaves draft. The GitHub sync keeps a
// PR root's `state` label (`draft`, `open`, `merged`, `closed`), and marking a draft ready
// relabels the root `state=open`.

/** Whether a PR root is a draft. A root with no `state` label (synced before it had one) counts as ready. */
export const isDraft = (labels: Record<string, string>) => labels.state === "draft";

/**
 * Whether an event on a PR root is the moment to review it: the root posted ready, or relabeled
 * `state=open` (marked ready, or reopened). The review's tellEve key is `pr`, which Eve takes once
 * per thread, so a PR opened ready and later reopened is still reviewed once.
 */
export function reviewStarts(event: {
  type: string;
  payload: unknown;
  message?: { re: string | null; labels: Record<string, string> };
}) {
  const message = event.message;
  if (!message || message.re !== null) return false;
  if (event.type === "message.posted") return !isDraft(message.labels);
  if (event.type === "labels.changed") return (event.payload as { set?: Record<string, string> }).set?.state === "open";
  return false;
}

/**
 * Whether a reply in a draft PR's thread asks Eve itself: it names Eve (`eve`, `@eve`, or the old `pi`) or this
 * thread's Eve by its own name. Kept to the text, so it can misfire on a reply about Eve; that wakes
 * Eve, which stays quiet when a reply isn't for it.
 */
export const asksEve = (thread: string, text: string) =>
  /(^|[^\w/-])@?(pi|eve)(?![\w/-])/i.test(text) || text.toLowerCase().includes(eveName(thread));
