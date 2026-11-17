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

/** Where a project's environment variables are kept in Vercel's dashboard: null when the project isn't known. */
export const envVarsPage = (project: Project): string | null =>
  project ? `https://vercel.com/${project.team}/${project.name}/settings/environment-variables` : null;

/**
 * This factory's name on its team: its Vercel project's. What a team keeps one of per name is named
 * for it (the Connect connectors, the Slack channel), so a team's second factory gets its own.
 * Vercel sets the name on a deployment; a dev server reads it from the token `vercel env pull` wrote.
 */
export function projectName(env: Env = process.env): string {
  return env.VERCEL_PROJECT_NAME || projectOf(env.VERCEL_OIDC_TOKEN ?? "")?.name || "factory";
}

/**
 * This factory's channels on its team's board, all under one named for the project: `project-factory`
 * for what's about no one repo, and with a `name`, `project-factory/rsi` for the factory itself or
 * `project-factory/web` for a repo. A team's second factory has its own, so neither hears the other.
 * A channel takes lowercase letters, digits, `-` and `_`, and 80 characters with what's under it:
 * a `.` in the project's name is a `-`, and a long name is cut to leave a repo's room.
 */
export function channel(name?: string, env: Env = process.env): string {
  const home = `project-${projectName(env).toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 48);
  return name ? `${home}/${name}` : home;
}

/**
 * A Slack channel named for the project, with `suffix` after its name. Slack takes less than Vercel
 * does: lowercase letters, digits, `-` and `_`, 80 characters at most. So a `.` becomes a `-`, and a
 * long name is cut to fit.
 */
export function slackChannel(suffix: string, env: Env = process.env): string {
  const name = projectName(env).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `#${name.slice(0, 80 - suffix.length)}${suffix}`;
}
