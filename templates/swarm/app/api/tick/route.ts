import { isLocal } from "@/lib/gate";
import { reconcileAll } from "@/lib/run";

// What Vercel's cron calls (vercel.json): every running run gets its agents started, its
// credentials renewed, and its budget and time limit checked, whether or not anyone has the page
// open. Vercel sends CRON_SECRET as a bearer token when the project has one, and nothing else may
// call this.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!isLocal() && (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)) return new Response("not the cron", { status: 401 });
  return Response.json({ runs: await reconcileAll() });
}
