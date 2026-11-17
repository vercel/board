import { defineTool } from "eve/tools";
import { z } from "zod";
import { ORIGIN, ownToken } from "../lib/identity.ts";

export default defineTool({
  description:
    "The factory's setup, checked now. `steps`: each step the setup page shows (Vercel, GitHub, Slack, Try it) and its tasks, done or not, with the exact commands and links. `repos`: how many are onboarded, and how many more the GitHub app is on (`waiting`). With `repo`, `asked` says where that repo shows when it's onboarded already, or whether the GitHub app is on it (`app`: true, false, or null when that couldn't be told), which your own GitHub access can't tell. Use it whenever someone asks about setting the factory up, and quote its commands as they are.",
  inputSchema: z.object({
    repo: z.string().optional().describe("A repo to ask about, as owner/name: whether it's onboarded, or whether the GitHub app is on it."),
  }),
  async execute({ repo }) {
    // This deployment's own setup page, which runs the checks. Its OIDC token gets the call through
    // Deployment Protection, which trusts a project's calls to its own environment.
    const token = await ownToken();
    const response = await fetch(`${ORIGIN}/api/launcher/steps${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, {
      headers: token ? { "x-vercel-trusted-oidc-idp-token": token } : {},
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    return response.ok ? body : `The setup page's checks answered ${response.status}: ${body.slice(0, 300)}`;
  },
});
