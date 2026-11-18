import { answer, hostOf } from "@/lib/http";
import { thread } from "@/lib/operations";

// A task's thread: its brief, its labels, and its work log.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return answer(await thread(hostOf(request), (await params).id));
}
