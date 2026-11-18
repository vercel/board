import { getToken } from "@vercel/connect";
import type { SyncFn } from "@vercel/board/sync";
import type { GitHubEvent, GitHubRepo } from "@vercel/board/sync-github";

type Side = { repo?: { full_name?: string } | null } | undefined;
type PR = { user?: { login?: string }; head?: Side; base?: Side };

/** A fork's branch, or a fork that's since gone. */
const fromFork = (pr: PR) => !pr.base?.repo?.full_name || pr.head?.repo?.full_name !== pr.base.repo.full_name;

/**
 * `repos()`'s map, but two kinds of PR start no thread. A fork's, because reviewing it runs its code
 * where the agent's GitHub token is. The factory's own, opened as `factory`'s login (its app's bot,
 * like `factory[bot]`), because the agent follows those itself, from the thread it built them for.
 * Comments, edits, and reactions only join threads that exist, so neither one's land either.
 */
export function withoutForksOrOwn(map: Record<string, string>, factory: () => Promise<string | null>): Record<string, GitHubRepo> {
  return Object.fromEntries(Object.entries(map).map(([repo, channel]) => [repo, intoUnless(channel, factory)]));
}

/** Like `into()` from `@vercel/board/sync`, which imports everything. */
function intoUnless(channel: string, factory: () => Promise<string | null>): SyncFn<GitHubEvent> {
  return async (sync) => {
    if (sync.direction !== "in") return;
    const pr = (sync.event.raw as { pull_request?: PR } | undefined)?.pull_request;
    const starts = /^(pr|issue|review)\./.test(sync.event.type) && !(pr && (fromFork(pr) || pr.user?.login === (await factory())));
    await sync.import(starts ? channel : undefined);
  };
}

/** The login the connector's GitHub App acts as, looked up once. Null when the lookup fails, which leaves nothing out; the next call tries again. */
export function appLogin(connector: string): () => Promise<string | null> {
  let login: Promise<string | null> | undefined;
  return () =>
    (login ??= (async () => {
      const token = await getToken(connector, { subject: { type: "app" } });
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: "query { viewer { login } }" }),
      });
      const body = (await response.json()) as { data?: { viewer?: { login?: string } } };
      return body.data?.viewer?.login ?? Promise.reject(new Error(`no viewer: ${response.status}`));
    })().catch(() => ((login = undefined), null)));
}
