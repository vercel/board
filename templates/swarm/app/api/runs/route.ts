import { answer, body, elsewhere, hostOf, sameOrigin } from "@/lib/http";
import { start, swarmRuns } from "@/lib/operations";

// The deployment's runs: the newest ones, and launching another.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return answer(await swarmRuns(hostOf(request), Number(new URL(request.url).searchParams.get("limit")) || 20));
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return elsewhere();
  return answer(await start(hostOf(request), await body(request)));
}
