import { githubConnector } from "./project.ts";

// GitHub, through Vercel Connect: a token minted for one repo at a time, with only what the run
// needs. It goes into a sandbox's network policy, never into the sandbox.

/** What Connect needs to mint a GitHub token for one repo alone, and with `permissions`, only those. */
export function githubScope(repo: string, permissions: string[]) {
  const [org, name] = repo.split("/");
  if (!org || !name) return null;
  return [{ type: "github_app_installation" as const, org, repositories: [name], permissions }];
}

/** What a run's agents may do on GitHub: a review reads, a pipeline also pushes branches and opens pull requests. */
export const permissionsFor = (write: boolean) => (write ? ["contents:write", "pull_requests:write"] : ["contents:read"]);

/** A GitHub token for `repo` alone, from this project's connector. */
export async function githubToken(repo: string, write: boolean): Promise<string> {
  const scope = githubScope(repo, permissionsFor(write));
  if (!scope) throw new Error(`${repo} isn't owner/name`);
  const { getToken } = await import("@vercel/connect");
  return getToken(githubConnector(), { subject: { type: "app" }, authorizationDetails: scope });
}
