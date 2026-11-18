import { ownRepo } from "../../lib/github.ts";
import { projectName } from "../../lib/project.ts";

// Who the agent is on the board: this deployment, writing as itself. It has no profile of its own,
// so the board, and Slack, show it by its Vercel project's name and not as a name "via" that project.

/** Its name on the board, and what people @mention: the Vercel project's. */
export const NAME = projectName();

/** This factory's own repo, which it changes when it's asked to improve itself. */
export const OWN_REPO = ownRepo();

/** This deployment's own origin: its URL on Vercel, the dev server's locally. Not `PORT` under eve, whose dev process has its own. */
export const ORIGIN = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT ?? 3000}`;

/**
 * This deployment's OIDC token on Vercel, and none on your machine. It's what the deployment calls
 * itself with: Deployment Protection's Trusted Sources let a project reach its own environment with
 * it, in `x-vercel-trusted-oidc-idp-token`, and no other.
 */
export const ownToken = async (): Promise<string | null> => (process.env.VERCEL_URL ? (await import("@vercel/oidc")).getVercelOidcToken() : null);

type Author = { principal: string; profile: string | null };

/** The watcher's ID (`factory.ts` names its watcher by it), which the board has it write under. */
export const WATCHER = "wake";

/**
 * The profile this factory's own page writes under, when someone asks the factory something through
 * it: wherever a message shows who wrote it, it reads `launcher via <project>`, and not as the agent
 * asking itself.
 */
export const LAUNCHER = "launcher";

/**
 * The profiles the agent writes under: none, as it writes now, `factory`, as it wrote at first, and
 * what this project's BOARD_PROFILE says, when it says one. Lowercase, as the board names an actor:
 * `Factory` and `factory` are one profile.
 */
export const agentProfiles = (env: Record<string, string | undefined> = process.env): ReadonlySet<string | null> =>
  new Set([null, "factory", ...(env.BOARD_PROFILE ? [env.BOARD_PROFILE.toLowerCase()] : [])]);

/**
 * Whether the agent wrote a message, or reacted: this deployment (`principal`, which its watcher
 * reads from the board), under one of the agent's own profiles. What else the deployment writes
 * isn't the agent's: its watcher's own replies, under the watcher's ID; what someone asked through
 * its page, under the launcher's; what people post on its board page (`/board`), each under the name
 * they gave; and what its sync brings in from GitHub and Slack, each under a platform's profile of
 * who wrote it there (`slack:user:U0456`).
 */
export const byAgent = (by: Author, principal: string, profiles: ReadonlySet<string | null> = agentProfiles()): boolean =>
  by.principal === principal && profiles.has(by.profile === null ? null : by.profile.toLowerCase());

/** Profiles nobody posts under from the board page, lowercase: the agent's, its watcher's, and the launcher's. */
export const reservedProfiles = (env: Record<string, string | undefined> = process.env): ReadonlySet<string> =>
  new Set([...agentProfiles(env)].filter((profile): profile is string => profile !== null).concat(WATCHER, LAUNCHER));

/** Whether a name someone gives on the board page is one nobody posts under there, in any case: `Factory` is the agent. */
export const isReserved = (profile: string, env: Record<string, string | undefined> = process.env): boolean => reservedProfiles(env).has(profile.toLowerCase());
