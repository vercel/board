import { backend } from "@/lib/board";
import { isClosed } from "@/lib/protection";

// The page's Migrate button: applies @vercel/board's schema.sql unless the database has this
// release's. Only while Deployment Protection turns strangers away, and only from the page itself.
export async function POST(request: Request): Promise<Response> {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== host) return new Response("Migrate from this deployment's own page.", { status: 403 });
  const shut = await isClosed(host);
  if (shut !== true) return new Response("Turn on Deployment Protection before migrating.", { status: 403 });
  await backend.migrate();
  return Response.redirect(new URL("/", origin), 303);
}
