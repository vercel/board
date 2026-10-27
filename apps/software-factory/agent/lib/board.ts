import type { Task } from "../../app/api/board/[[...path]]/harness.ts";

// The thread a session works on: sent with each message, kept in the turn's auth by channels/eve.ts.

export type Board = { task: Task; thread: string };

const THREAD = /^[A-Za-z0-9_-]{1,64}$/;

export function boardFrom(context: unknown): Board | null {
  const board = (context as { board?: { task?: unknown; thread?: unknown } } | null)?.board;
  if (!board || (board.task !== "thread" && board.task !== "review")) return null;
  if (typeof board.thread !== "string" || !THREAD.test(board.thread)) return null;
  return { task: board.task, thread: board.thread };
}

type Auth = { attributes: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

export function boardOf(session: { auth: { current: Auth; initiator: Auth } }): Board | null {
  for (const auth of [session.auth.current, session.auth.initiator]) {
    const { boardTask: task, boardThread: thread } = auth?.attributes ?? {};
    const board = boardFrom({ board: { task, thread } });
    if (board) return board;
  }
  return null;
}

type Caller = { principalType?: string } | null | undefined;

/**
 * Only this deployment's own watchers: `vercelOidc()` calls a token `runtime` when it's from this project in this
 * environment, and `service` for any other environment, so a preview can't drive production.
 */
export const sameDeployment = <T extends Caller>(caller: T) =>
  caller?.principalType === "runtime" || caller?.principalType === "local-dev" ? caller : null;
