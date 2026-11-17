import { check } from "@/lib/launcher";
import { markdown } from "@/lib/markdown";

// The launcher as markdown. `/` answers with this to whatever doesn't ask for a page (next.config.ts),
// so an agent told "set up <this URL>" reads the steps, not a page's scripts.

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { result, inspect, running } = await check(request.headers.get("host") ?? new URL(request.url).host);
  return new Response(markdown(result, inspect, running), { headers: { "content-type": "text/markdown; charset=utf-8", vary: "accept" } });
}
