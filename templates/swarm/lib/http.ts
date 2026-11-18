import { OPEN, open } from "./gate.ts";
import type { Result } from "./operations.ts";

// What every route in app/api does around an operation: who may ask, and the answer as JSON.

/**
 * Whether a write comes from this deployment's own pages: the browser says where a request came from
 * (`Origin`, and `Sec-Fetch-Site` where it sends it), and another site's page can't make it say this
 * one. Deployment Protection's cookie goes along with any request to the deployment, so without this
 * a page elsewhere could make a signed-in teammate's browser launch a run.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The answer to a request: an operation's result as JSON, with a status that says how it went. */
export function answer(result: Result<object>): Response {
  return Response.json(result, { status: result.ok ? 200 : 400, headers: { "cache-control": "no-store" } });
}

/** A write from somewhere other than this deployment's pages. */
export const elsewhere = () => answer({ ok: false, problem: "This only takes requests from this deployment's own pages." });

/** The domain a request came in on, which Deployment Protection is checked for. */
export const hostOf = (request: Request) => request.headers.get("host");

/** The most a request's body holds: a launch's config, or a task's brief, is a few kilobytes. */
const BODY_MAX = 64 * 1024;

/**
 * What a write is refused for before its body is read, or null: from anywhere but this deployment's
 * own pages, or while strangers can reach it. Nothing is read from a request no one may make.
 */
export async function refused(request: Request): Promise<Response | null> {
  if (!sameOrigin(request)) return elsewhere();
  if (await open(hostOf(request))) return answer({ ok: false, problem: OPEN });
  return null;
}

/** A request's JSON body, or an empty object: an operation checks what it was sent. A body past BODY_MAX isn't read. */
export const body = async (request: Request): Promise<Record<string, unknown>> => {
  if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return {};
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) {
      await reader.cancel().catch(() => {});
      return {};
    }
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
