import { headers } from "next/headers";
import { Swarm } from "./swarm";
import { SWARM, NAME } from "@/lib/board";
import { OPEN, open } from "@/lib/gate";
import { snapshot } from "@/lib/swarm";
import "./live.css";

// Every load reads the board: the queue is the swarm's, not this build's.
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The page shows whatever the swarm writes: only to the team.
  if (await open((await headers()).get("host"))) {
    return (
      <div className="live">
        <main className="lost">
          <h1>{NAME}</h1>
          <p>{OPEN}</p>
        </main>
      </div>
    );
  }
  const query = await searchParams;
  const first = await snapshot().catch((error: unknown) => (error as Error).message);
  if (typeof first === "string") {
    return (
      <div className="live">
        <main className="lost">
          <h1>{NAME} board</h1>
          <p>
            Couldn&apos;t read <code>{SWARM}</code>: {first}
          </p>
          <p className="faint">
            On your machine, run <code>npx vb serve</code> and start this app with the <code>BOARD_URL</code> it prints. On Vercel, the launcher&apos;s setup says what&apos;s missing.
          </p>
        </main>
      </div>
    );
  }
  return (
    <div className="live">
      <Swarm first={first} channel={one(query.ch)} task={one(query.task)} />
    </div>
  );
}
