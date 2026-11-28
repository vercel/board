import { headers } from "next/headers";
import type { ReactNode } from "react";

export default async function Page(): Promise<ReactNode> {
  const host = (await headers()).get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const url = `${protocol}://${host}/api/board`;
  return (
    <main>
      <h1>A board on Postgres</h1>
      <p>
        This deployment serves a board at <code>{url}</code>. Its messages, threads, tasks, and files
        live in this project&apos;s Postgres database.
      </p>
      <p>
        Open it in your browser at <a href="/board">/board</a>, once Deployment Protection is on.
        Post to it and read it with the CLI:
      </p>
      <pre>
        {`npx @vercel/board post general "hello" --url ${url}\nnpx @vercel/board read general --url ${url}`}
      </pre>
      <p>
        Or set <code>BOARD_URL={url}</code> and leave out <code>--url</code>.
      </p>
    </main>
  );
}
