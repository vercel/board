import type { Board, MessageView } from "@vercel/board";
import type { Listed } from "./setup.ts";

// Onboarding a repo from the page: the factory is asked as anyone would ask it, in a thread the
// page opens, and its agent does the rest (the onboard-repo skill): a pull request to this
// factory's own repo.

/** Where the page, or an agent, asks for a repo: a POST with `{ "repo": "<owner>/<repo>" }`. */
export const ONBOARD_PATH = "/api/launcher/onboard";

/**
 * A repo as GitHub writes it, from what someone typed or pasted: `acme/web`, its URL with or
 * without the scheme, or what `git clone` takes. Nothing when it isn't one: what's kept goes into a
 * message the agent reads, so it's a repo's name and no more.
 */
export function repoName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input
    .trim()
    .replace(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)/i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/i, "");
  // An owner is letters, digits and single hyphens, 39 at most; a repo adds `.` and `_`, 100 at most.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(name)) return null;
  return /\/\.{1,2}$/.test(name) ? null : name;
}

/** The repo among the ones that already come into the board, as its map writes it and with where it shows, whatever the case it was asked in. */
export const onboarded = (repo: string, repos: Listed[]): Listed | null => repos.find((listed) => listed.repo.toLowerCase() === repo.toLowerCase()) ?? null;

/** What the factory is asked, as the thread's first message. */
export const onboardText = (repo: string) => `Onboard ${repo}. Asked from this factory's page.`;

/**
 * Asks: the page opens a thread where the factory changes itself, and the agent hears it as it
 * hears anyone, through its watcher. Asked twice, there are two threads, as when two people ask:
 * the agent looks for earlier work first.
 */
export const startOnboarding = (page: Pick<Board, "post">, channel: string, repo: string): Promise<MessageView> => page.post(channel, { text: onboardText(repo) });
