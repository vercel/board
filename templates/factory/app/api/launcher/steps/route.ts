import { repoChannels, slackChannels } from "@/app/api/board/[[...path]]/factory";
import { check } from "@/lib/launcher";
import { repoName } from "@/lib/onboard";
import { stepsView } from "@/lib/setup";

// The setup page's steps, checked now, for the agent's setup_steps tool: the page's own tasks, so
// the agent never guesses at them, and with `?repo=<owner>/<repo>`, whether the GitHub app is on
// that repo, as this deployment sees it.

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { result } = await check(new URL(request.url).host);
  // As on the page: nothing about the factory while anyone can ask.
  if (result.open) return Response.json({ error: { code: "forbidden", message: "the setup checks are off until this deployment is protected" } }, { status: 403 });
  const asked = new URL(request.url).searchParams.get("repo");
  const repo = asked === null ? null : repoName(asked);
  if (asked !== null && !repo) return Response.json({ error: { code: "bad_repo", message: "name a repo as GitHub writes it: owner/repo" } }, { status: 400 });
  return Response.json(stepsView(result, { repoChannels, slackChannels }, repo));
}
