import { answer, body, hostOf, refused } from "@/lib/http";
import { ask } from "@/lib/operations";

// Adds what someone typed on the live page to a running run, as its tasks.
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const no = await refused(request);
  if (no) return no;
  return answer(await ask(hostOf(request), (await params).slug, (await body(request)).prompt));
}
