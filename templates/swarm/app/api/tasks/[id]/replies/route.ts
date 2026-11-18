import { answer, body, hostOf, refused } from "@/lib/http";
import { say } from "@/lib/operations";

// Replies in a task's thread from the live page, under the launcher's profile.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const no = await refused(request);
  if (no) return no;
  return answer(await say(hostOf(request), (await params).id, (await body(request)).text));
}
