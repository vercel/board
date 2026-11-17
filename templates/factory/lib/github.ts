type Env = Record<string, string | undefined>;

/** This factory's own repo, on a deployment from Git: null anywhere else. */
export function ownRepo(env: Env = process.env): string | null {
  return env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
}

/**
 * The repos a thread's GitHub token covers. A thread synced from GitHub covers its own repo alone,
 * read from where the board says its root came from (`origin`, which only the board writes, unlike
 * labels), and only when that's one of `repos`. Any other thread covers all of `repos`. No root, as
 * when reading it failed, covers nothing.
 */
export function threadRepos(root: { origin?: { thread?: string | null } | null } | null, repos: string[]): string[] {
  if (!root) return [];
  // github:<owner>/<repo>:<number>, its sync's key first.
  const from = root.origin?.thread?.match(/^[^:]+:([^/:]+\/[^/:]+):/)?.[1]?.toLowerCase();
  if (!from) return repos;
  return repos.filter((repo) => repo.toLowerCase() === from);
}

/**
 * What Connect needs to mint a GitHub token for `repos` alone, and with `permissions` (like
 * `contents:write`), only those. A token covers one org: the first repo's.
 */
export function githubScope(repos: string[], permissions?: string[]) {
  const org = repos[0]?.split("/")[0];
  if (!org) return null;
  const repositories = repos.filter((repo) => repo.split("/")[0] === org).map((repo) => repo.split("/")[1]!);
  return [{ type: "github_app_installation" as const, org, repositories, ...(permissions ? { permissions } : {}) }];
}
