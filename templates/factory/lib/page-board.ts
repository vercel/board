import type { Board } from "@vercel/board";
import { LAUNCHER } from "../agent/lib/identity.ts";
import { channel } from "./project.ts";

// What this factory's own page writes on the board, when someone presses a button on it: a thread
// where the factory changes itself, under the launcher's profile. The agent hears it as it hears
// anyone, through its watcher.

/** All the page may do there: open a thread in that one channel, with a label on it. */
export const PAGE_CAN = { [channel("rsi")]: ["post", "label"] } as const;

/** The handle the page writes with: the launcher's profile, held to that. */
export const pageBoard = (board: Board): Board => board.as(LAUNCHER, { can: PAGE_CAN });
