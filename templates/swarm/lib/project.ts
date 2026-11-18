type Env = Record<string, string | undefined>;

export type Project = { team: string; name: string } | null;

/** The project a Vercel OIDC token names: its team's slug and its own name, or null when it doesn't read as one. */
export function projectOf(jwt: string): Project {
  try {
    const { owner, project } = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
    return typeof owner === "string" && typeof project === "string" ? { team: owner, name: project } : null;
  } catch {
    return null;
  }
}

/**
 * This swarm's name on its team: its Vercel project's. Vercel sets it on a deployment; a dev server
 * reads it from the token `vercel env pull` wrote.
 */
export function projectName(env: Env = process.env): string {
  return env.VERCEL_PROJECT_NAME || projectOf(env.VERCEL_OIDC_TOKEN ?? "")?.name || "swarm";
}

/** The Vercel Connect connector this swarm reaches GitHub through, named for its project: a team's second swarm gets its own. */
export const githubConnector = (env: Env = process.env) => `github/${projectName(env).toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
