import { inspector } from "@vercel/board/inspect";
import { isReserved } from "../../../agent/lib/identity.ts";
import { closed, isLocal } from "../../../lib/setup.ts";
import { factory } from "../../api/board/[[...path]]/factory";

// The board in your browser, at /board: the inspector `npx @vercel/board inspect` opens, served by
// this deployment, so a phone opens it too. It reads and writes as this deployment, so it answers
// only while Deployment Protection turns strangers away, and each write is under the name the person
// gave ("ada via factory"), never one the agent, its watcher, or the launcher writes under.

// The page follows the board's events on a stream that stays open: the page reconnects when it ends.
export const maxDuration = 300;

const inspect = inspector({ board: factory.as(null), basePath: "/board" });

/** Whether each host turns strangers away, asked at most once a minute: a check that couldn't tell isn't kept. */
const protectedHosts = new Map<string, { at: number; closed: Promise<boolean | Error> }>();
const MINUTE = 60_000;

function isClosed(host: string | null): Promise<boolean | Error> {
  if (isLocal(process.env)) return Promise.resolve(true);
  if (!host) return Promise.resolve(new Error("no host to check"));
  const known = protectedHosts.get(host);
  if (known && Date.now() - known.at < MINUTE) return known.closed;
  const answer = closed(host, fetch);
  protectedHosts.set(host, { at: Date.now(), closed: answer });
  void answer.then((result) => result instanceof Error && protectedHosts.delete(host));
  return answer;
}

/** The profile a request names, as `x-board-profile` carries it: `ada`, or `ada;avatar="…"`. */
const profileOf = (request: Request): string | null => {
  const header = request.headers.get("x-board-profile")?.trim();
  if (!header) return null;
  return header.split(";")[0]!.trim().replace(/^"(.*)"$/, "$1");
};

async function handle(request: Request): Promise<Response> {
  const shut = await isClosed(request.headers.get("host"));
  if (shut instanceof Error)
    return text(503, `Couldn't tell whether this deployment turns strangers away (${shut.message}), so its board isn't served yet. Try again in a moment.`);
  if (!shut) return text(403, "This deployment is open to anyone, so its board isn't served here. Turn on Vercel Authentication first: the launcher at / says how.");
  const reading = request.method === "GET" || request.method === "HEAD";
  const profile = profileOf(request);
  if (!reading && profile !== null && isReserved(profile))
    return Response.json(
      { error: { code: "reserved_profile", message: `${profile} is the factory's own name here: post under yours` } },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  return inspect(request);
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export const GET = handle, POST = handle, PATCH = handle, PUT = handle, DELETE = handle;
