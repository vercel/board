import { REPO } from "./github.ts";

// What the factory imports from GitHub but keeps on the board, out of Slack, or off the board altogether.

type GitHubEvent = { kind: string; thread: string; subthread: string | null; type: string; labels?: Record<string, string> };
type Board = { messages(query: { channel: string; label: Record<string, string>; limit: number }): Promise<{ messages: unknown[] }> };

/**
 * Whether a GitHub event's board reply stays off Slack: inline review threads (comments on
 * lines of code), and the "closed by …" reply when a PR is closed without merging. Closing
 * a batch of stale PRs posted one Slack reply each; the PR root's emoji turning
 * :pr-closed: still says it. Merges still post "merged by …".
 */
export function boardOnly(event: Pick<GitHubEvent, "subthread" | "type" | "labels">): boolean {
  if (event.subthread !== null) return true;
  return event.type === "pr.closed" && event.labels?.state === "closed";
}

/**
 * Whether a GitHub comment is on a PR the board has no thread for: one opened before the
 * board was, or while it wasn't listening. Syncing it would open a new Slack thread for an
 * old PR (a "closing as stale" comment did, for each PR it closed), so it stays on GitHub.
 * A PR's thread starts when it's opened or marked ready, so new PRs always have one.
 */
export async function unseenPr(event: GitHubEvent, board: Board, channel: string): Promise<boolean> {
  if (event.kind !== "message") return false;
  const number = /:(\d+)$/.exec(event.thread)?.[1];
  if (!number) return false;
  const { messages } = await board.messages({ channel, label: { pr: `${REPO}#${number}` }, limit: 1 });
  return messages.length === 0;
}

// Going out, a function gets a delivery it never calls: nothing written on the board or in Slack reaches GitHub.
type Outbound = { direction: "out"; deliver(): Promise<void> };
type PullsSync =
  | { direction: "in"; event: GitHubEvent; board: Board; import(channel: string, overrides: { noSync: boolean }): Promise<unknown> }
  | Outbound;
type IssuesSync = { direction: "in"; import(channel: string): Promise<unknown> } | Outbound;

/**
 * PR threads come in from GitHub and go nowhere back: a reply on the board, a Pi's included, stays
 * in Slack and on the board, so a conversation about a PR doesn't end up as comments on it.
 * Inline review threads and "closed by …" replies stay out of Slack; comments on a PR the board
 * has no thread for stay on GitHub.
 */
export async function pulls(sync: PullsSync): Promise<void> {
  if (sync.direction === "out") return;
  if (await unseenPr(sync.event, sync.board, "dev")) return;
  await sync.import("dev", { noSync: boardOnly(sync.event) });
}

/**
 * Issue threads come in from GitHub and go nowhere back, like PR threads: a public repo would show
 * what's said on the board. Pi answers on GitHub only on purpose, with gh.
 */
export async function issues(sync: IssuesSync): Promise<void> {
  if (sync.direction === "in") await sync.import("dev");
}
