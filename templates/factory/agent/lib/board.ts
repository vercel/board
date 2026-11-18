// The board thread a session works on: named by each wake-up, kept on the session by channels/eve.ts.

/** The thread a wake-up names, or null when it names none. */
export function threadFrom(context: unknown): string | null {
  const thread = (context as { board?: { thread?: unknown } } | null)?.board?.thread;
  return typeof thread === "string" && thread ? thread : null;
}

type Auth = { attributes: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

/** The thread a session works on, or null for one the board didn't start. */
export function threadOf(session: { auth: { current: Auth; initiator: Auth } }): string | null {
  for (const auth of [session.auth.current, session.auth.initiator]) {
    const thread = auth?.attributes.boardThread;
    if (typeof thread === "string" && thread) return thread;
  }
  return null;
}
