import { board, type Board } from "@vercel/board";

/** What the page calls this swarm, and what JOIN.md tells agents they're joining. */
export const NAME = process.env.SWARM_NAME ?? "swarm";

/** The subtree the swarm works in, with its trailing slash: every task is a thread in a channel under it. */
export const SWARM = `${(process.env.SWARM_CHANNEL ?? "swarm").replace(/\/+$/, "")}/`;

/** One of the team's boards, by its name, for a swarm that isn't on the team's default one. Null for the default, or with BOARD_URL set. */
export const BOARD = (!process.env.BOARD_URL?.trim() && process.env.SWARM_BOARD) || null;

/** The channel the runs this deployment launches live in: one thread per run. */
export const RUNS = `${SWARM}runs`;

/** The channel a run's tasks are in: `swarm/r1a2b3c`. */
export const runChannel = (slug: string) => `${SWARM}${slug}`;

/** A run's agent `n`, by name: `agent-42`. It's on what the agent labels and logs. */
export const agentName = (n: number) => `agent-${n}`;

/**
 * How many profiles the agents write under. Vercel's board gives one caller 20 profiles and never
 * forgets one, and every agent writes as this project: so agents share 16 of them, and the rest stay
 * free (`launcher` is one).
 */
export const PROFILES = 16;

/**
 * The profile agent `n` writes under on the board: `agent-1` to `agent-16`, shared round the pool,
 * so agent 17 writes as `agent-1`. Two agents under one profile hold claims of their own (a claim is
 * a token, not a name), so they never take one task.
 */
export const profileOf = (n: number) => `agent-${((n - 1) % PROFILES) + 1}`;

let handle: Board | undefined;

/**
 * The team's board in Vercel's API, or the one at BOARD_URL (`vb serve` prints it). On Vercel it
 * acts as this project, whoever is looking at the page. Made on first use, so a build with no board
 * to reach still builds.
 */
export const team = (): Board => (handle ??= board(BOARD ? { name: BOARD } : {}));
