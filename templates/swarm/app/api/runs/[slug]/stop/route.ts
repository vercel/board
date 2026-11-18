import { answer, elsewhere, hostOf, sameOrigin } from "@/lib/http";
import { stop } from "@/lib/operations";

// Stops a run: its agents stop, and its sandboxes go.
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return elsewhere();
  return answer(await stop(hostOf(request), (await params).slug));
}
