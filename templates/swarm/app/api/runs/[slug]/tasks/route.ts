import { answer, body, elsewhere, hostOf, sameOrigin } from "@/lib/http";
import { ask } from "@/lib/operations";

// Adds what someone typed on the live page to a running run, as its tasks.
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return elsewhere();
  return answer(await ask(hostOf(request), (await params).slug, (await body(request)).prompt));
}
