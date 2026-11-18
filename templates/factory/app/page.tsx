import { headers } from "next/headers";
import type { ReactNode } from "react";
import { LauncherView } from "@/components/launcher";
import { check } from "@/lib/launcher";

// Every load checks this deployment as it is now, and the page asks again by itself (components/live.tsx).
export const dynamic = "force-dynamic";

export default async function Page(): Promise<ReactNode> {
  // The host this page is open on.
  return <LauncherView {...await check((await headers()).get("host"))} />;
}
