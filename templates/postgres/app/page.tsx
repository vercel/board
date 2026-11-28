import { headers } from "next/headers";
import type { ReactNode } from "react";
import { backend } from "@/lib/board";
import { isClosed } from "@/lib/protection";

// Every load checks the deployment and its database as they are now.
export const dynamic = "force-dynamic";

type Tables = { applied: number | null; current: number } | Error;

export default async function Page(): Promise<ReactNode> {
  const host = (await headers()).get("host") ?? "localhost:3000";
  const local = host.startsWith("localhost") || host.startsWith("127.");
  const url = `${local ? "http" : "https"}://${host}/api/board`;
  const [shut, tables] = await Promise.all([
    isClosed(host),
    backend.tables().catch((error: unknown): Tables => (error instanceof Error ? error : new Error(String(error)))),
  ]);
  const protectedNow = shut === true;
  // A version only goes up: a database ahead of this deployment is a later release's, which this one uses as it is.
  const ready = !(tables instanceof Error) && tables.applied !== null && tables.applied >= tables.current;

  return (
    <main>
      <h1>A board on Postgres</h1>
      <p>
        This deployment serves a board at <code>{url}</code>, kept in this project&apos;s Postgres database.
      </p>

      <h2>1. Deployment Protection {protectedNow ? "✓" : ""}</h2>
      {protectedNow ? (
        <p>Strangers can&apos;t open this deployment, so its board and its setup are served here.</p>
      ) : (
        <p>
          {shut instanceof Error ? `Couldn't tell whether strangers can open this deployment (${shut.message}). ` : "Anyone can open this deployment. "}
          Set Vercel Authentication to All Deployments in the project&apos;s Settings → Deployment Protection, then
          reload: Standard Protection leaves a production domain open. The CLI gets through it with your{" "}
          <code>vercel login</code>.
        </p>
      )}

      <h2>2. The board&apos;s tables {ready ? "✓" : ""}</h2>
      {tables instanceof Error ? (
        <p>Couldn&apos;t reach the database: {tables.message}. Connect a Postgres database to the project, which sets <code>DATABASE_URL</code>.</p>
      ) : ready ? (
        <p>
          {tables.applied === tables.current
            ? "The database has this release's tables."
            : "The database has a later release's tables, which this deployment uses as they are."}
        </p>
      ) : (
        <>
          <p>{tables.applied === null ? "The database has none of the board's tables yet." : "The database has an older release's tables."}</p>
          <form method="post" action="/api/migrate">
            <button type="submit" disabled={!protectedNow}>
              Migrate
            </button>
          </form>
          {protectedNow ? null : <p>Migrate works once step 1 is done.</p>}
        </>
      )}

      {protectedNow && ready ? (
        <>
          <h2>Use it</h2>
          <p>
            Open it in your browser at <a href="/board">/board</a>, or from the CLI:
          </p>
          <pre>{`npx @vercel/board post general "hello" --url ${url}\nnpx @vercel/board read general --url ${url}`}</pre>
        </>
      ) : null}
    </main>
  );
}
