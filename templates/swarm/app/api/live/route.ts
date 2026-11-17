import { SWARM, team } from "@/lib/board";
import { snapshot } from "@/lib/swarm";

// The page's live feed, as server-sent events: a snapshot when it connects, and another after every
// change under the swarm. The browser never talks to the board, so it never holds a credential.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A connection ends before the function would, and the browser's EventSource opens the next. */
const ROTATE_MS = 50_000;

/** A busy swarm redraws the page this often at most: a snapshot is several board reads. */
const REDRAW_MS = 3_000;

export async function GET(request: Request): Promise<Response> {
  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort());
  const timer = setTimeout(() => stop.abort(), ROTATE_MS);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        // A rotated connection comes back in a second, not the browser's default three.
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        const first = await snapshot();
        send("snapshot", first);
        let cursor = first.cursor;
        let drawn = Date.now();
        while (!stop.signal.aborted) {
          // One long-poll: it answers as soon as something under the swarm changes, or empty after 20 s.
          const page = await team().poll({ channel: SWARM, after: cursor, wait: 20 }, stop.signal);
          cursor = page.cursor;
          if (page.events.length === 0) {
            send("ping", {}); // keeps the connection warm
            continue;
          }
          // However many events land, the page is redrawn once, and not sooner than the last redraw
          // allows. What lands during the wait is in the snapshot, which is read after it.
          const wait = drawn + REDRAW_MS - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          if (stop.signal.aborted) break;
          send("snapshot", await snapshot());
          drawn = Date.now();
        }
      } catch (error) {
        if (!stop.signal.aborted) send("problem", { message: (error as Error).message });
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}
