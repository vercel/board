"use server";

import { history } from "@/lib/swarm";

/** A task's thread, for the panel a click opens. The page has no action that writes. */
export async function thread(id: string) {
  if (!/^[\w.:-]{1,128}$/.test(id)) throw new Error("not a message id");
  return history(id);
}
