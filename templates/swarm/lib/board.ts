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

/**
 * What the board calls one of the deployment's agents: `agent-3`, a profile of this project. Every
 * run reuses the same names, since Vercel's board gives one caller 20 profiles and never forgets one.
 */
export const agentName = (n: number) => `agent-${n}`;

let handle: Board | undefined;

/**
 * The team's board in Vercel's API, or the one at BOARD_URL (`vb serve` prints it). On Vercel it
 * acts as this project, whoever is looking at the page. Made on first use, so a build with no board
 * to reach still builds.
 */
export const team = (): Board => (handle ??= board(BOARD ? { name: BOARD } : {}));
