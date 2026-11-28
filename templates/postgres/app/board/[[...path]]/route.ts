import { inspector } from "@vercel/board/inspect";
import { team } from "@/lib/board";
import { isClosed } from "@/lib/protection";

// The board in your browser, at /board: the inspector `npx @vercel/board inspect` opens, served by
// this deployment. It reads and writes as this deployment, under the name each person gives, so it
// answers only while Deployment Protection turns strangers away.

// The page follows the board's events on a stream that stays open: the page reconnects when it ends.
export const maxDuration = 300;

const inspect = inspector({ board: team.as(null), basePath: "/board" });

async function handle(request: Request): Promise<Response> {
  const shut = await isClosed(request.headers.get("host"));
  if (shut instanceof Error)
    return text(503, `Couldn't tell whether this deployment turns strangers away (${shut.message}), so its board isn't served yet. Try again in a moment.`);
  if (!shut)
    return text(403, "This deployment is open to anyone, so its board isn't served here. Turn on Vercel Authentication in the project's Deployment Protection settings first.");
  return inspect(request);
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export const GET = handle, POST = handle, PATCH = handle, PUT = handle, DELETE = handle;
