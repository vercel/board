import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { serviceRules, services, type Service } from "./services.ts";

// Real credentials go in the sandbox's network policy, which adds them on the way out. Anything the
// sandbox runs can use them, so each is the least the thread needs.

/** What the sandbox's requests get on the way out: GitHub, when this thread has a token, the keys of this thread's services, and nothing else. */
export function policy(
  tokens: { github: string | null; services?: readonly string[] },
  env: Record<string, string | undefined> = process.env,
  all: Record<string, Service> = services,
): NetworkPolicy {
  const github: Record<string, NetworkPolicyRule[]> = tokens.github
    ? {
        "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${tokens.github}` } }] }],
        "github.com": [{ transform: [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${tokens.github}`).toString("base64")}` } }] }],
      }
    : {};
  return {
    allow: {
      ...(serviceRules(tokens.services ?? [], env, all) as Record<string, NetworkPolicyRule[]>),
      // After the services, so none of them can take GitHub's hosts.
      ...github,
      "*": [],
    },
  };
}
