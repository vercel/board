import type { Task } from "./harness.ts";

// One eve session per thread task, kept in Redis.

export type EveMessage = { task: Task; thread: string; key: string; message: string };

export const boardContext = (task: Task, thread: string) => ({ board: { task, thread } });

export type Sessions = {
  get(key: string): Promise<string | null>;
  claim(key: string, value: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type EveSessions = {
  create(): Promise<string>;
  send(session: string, message: string, clientContext: object): Promise<void>;
  reset(session: string): Promise<void>;
};

/** Ended (idle timeout, reset) or built by an older eve. */
const gone = (error: unknown) =>
  error instanceof Error &&
  (error.name === "SessionNotActiveError" ||
    error.name === "ClientSessionStrandedError" ||
    (error as { code?: string }).code === "session_stranded");

/** Sends a message once per `key`. Two racing first messages each make a session; the loser's is reset. */
export async function sendToEve(
  { task, thread, key, message }: EveMessage,
  deps: { sessions?: Sessions; eve?: EveSessions } = {},
) {
  const sessions = deps.sessions ?? (await kv());
  const eve = deps.eve ?? (await client());
  const name = `${task}-${thread}`;
  if (!(await sessions.claim(`told:${name}:${key}`, "1"))) return;
  try {
    let session = await sessions.get(`session:${name}`);
    if (!session) {
      const made = await eve.create();
      if (await sessions.claim(`session:${name}`, made)) session = made;
      else {
        await eve.reset(made).catch(() => {});
        session = (await sessions.get(`session:${name}`))!;
      }
    }
    const context = boardContext(task, thread);
    try {
      await eve.send(session, message, context);
    } catch (error) {
      if (!gone(error)) throw error;
      const fresh = await eve.create();
      await sessions.set(`session:${name}`, fresh);
      await eve.send(fresh, message, context);
    }
  } catch (error) {
    await sessions.delete(`told:${name}:${key}`).catch(() => {});
    throw error;
  }
}

async function client(): Promise<EveSessions> {
  const [{ Client }, { getVercelOidcToken }] = await Promise.all([import("eve/client"), import("@vercel/oidc")]);
  const host = process.env.VERCEL_URL;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const eve = new Client({
    baseUrl: host ? `https://${host}` : `http://localhost:${process.env.PORT ?? 3000}`,
    ...(host ? { auth: { vercelOidc: { token: () => getVercelOidcToken() } } } : {}),
    ...(bypass ? { headers: { "x-vercel-protection-bypass": bypass } } : {}),
  });
  return {
    create: async () => (await eve.sessions.create()).session.id,
    send: async (session, message, clientContext) => {
      await eve.sessions.attach(session).send(message, { clientContext: clientContext as never });
    },
    reset: async (session) => {
      await eve.sessions.attach(session).reset();
    },
  };
}

async function kv(): Promise<Sessions> {
  const env = process.env.VERCEL_ENV;
  if (!env) return memory();
  const prefix = env === "production" ? "board-factory-eve" : `board-factory-eve:${env}`;
  const call = async (...command: string[]) => {
    const response = await fetch(process.env.KV_REST_API_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok || data.error) throw new Error(`Upstash: ${data.error ?? response.status}`);
    return data.result;
  };
  return {
    get: async (key) => ((await call("GET", `${prefix}:${key}`)) as string | null) ?? null,
    claim: async (key, value) => (await call("SET", `${prefix}:${key}`, value, "NX")) === "OK",
    set: async (key, value) => void (await call("SET", `${prefix}:${key}`, value)),
    delete: async (key) => void (await call("DEL", `${prefix}:${key}`)),
  };
}

const local = new Map<string, string>();

/** Locally, and in tests. */
export function memory(map = local): Sessions {
  return {
    get: async (key) => map.get(key) ?? null,
    claim: async (key, value) => (map.has(key) ? false : (map.set(key, value), true)),
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
  };
}
