import { answer, hostOf, refused } from "@/lib/http";
import { stop } from "@/lib/operations";

// Stops a run: its agents stop, and its sandboxes go.
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const no = await refused(request);
  if (no) return no;
  return answer(await stop(hostOf(request), (await params).slug));
}
