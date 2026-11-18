import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { LauncherView } from "@/components/launcher";
import { SWARM } from "@/lib/board";
import { check } from "@/lib/launcher";

// Every load checks this deployment as it is now, and the page asks again by itself (components/live.tsx).
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<ReactNode> {
  // The live view used to be here: its links (`/?ch=…&task=…`) still open it.
  const query = await searchParams;
  if (query.ch || query.task) redirect(`/live?${new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : []))).toString()}`);
  const host = (await headers()).get("host");
  const origin = `${host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https"}://${host ?? "localhost:3000"}`;
  return <LauncherView {...await check(host)} swarm={SWARM} origin={origin} />;
}
