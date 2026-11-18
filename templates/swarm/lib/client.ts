import type { Result } from "./operations.ts";
import type { history } from "./swarm.ts";

// The pages' calls to the routes in app/api, from the browser. Each answers what the route did, and a
// request that never got an answer says so the same way.

async function call<T extends object>(path: string, init?: { body: unknown }): Promise<Result<T>> {
  try {
    const response = await fetch(path, init ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : { cache: "no-store" });
    return (await response.json()) as Result<T>;
  } catch (error) {
    return { ok: false, problem: `Couldn't reach this deployment: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const part = encodeURIComponent;

export const start = (config: Record<string, unknown>) => call<{ slug: string }>("/api/runs", { body: config });
export const stop = (slug: string) => call(`/api/runs/${part(slug)}/stop`, { body: {} });
export const ask = (slug: string, prompt: string) => call<{ made: number }>(`/api/runs/${part(slug)}/tasks`, { body: { prompt } });
export const say = (id: string, text: string) => call(`/api/tasks/${part(id)}/replies`, { body: { text } });
export const thread = (id: string) => call<Awaited<ReturnType<typeof history>>>(`/api/tasks/${part(id)}`);
export const runs = (limit = 20) => call<{ runs: unknown[] }>(`/api/runs?limit=${limit}`);
