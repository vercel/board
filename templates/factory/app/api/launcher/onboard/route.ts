import { factory, repoChannels, slackChannels } from "@/app/api/board/[[...path]]/factory";
import { ownRequest } from "@/lib/first-task";
import { check } from "@/lib/launcher";
import { shows } from "@/lib/markdown";
import { onboarded, repoName, startOnboarding } from "@/lib/onboard";
import { pageBoard } from "@/lib/page-board";
import { channel } from "@/lib/project";
import { hasApp, reposOf } from "@/lib/setup";

// Asks the factory to onboard a repo, with `{ "repo": "<owner>/<repo>" }`: the page's Onboard
// button posts here, and so can an agent. The page opens a thread where the factory changes itself,
// as the launcher, and the agent hears it there and opens the pull request.

export const dynamic = "force-dynamic";

const refuse = (message: string) => Response.json({ error: { code: "forbidden", message } }, { status: 403 });

export async function POST(request: Request): Promise<Response> {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!ownRequest(request.headers.get("origin"), host)) return refuse("only this deployment's own page asks it to onboard a repo");
  const asked = (await request.json().catch(() => null)) as { repo?: unknown } | null;
  const repo = repoName(asked?.repo);
  if (!repo) return Response.json({ error: { code: "bad_repo", message: "name a repo as GitHub writes it: owner/repo" } }, { status: 400 });
  const { result } = await check(host);
  // As on the page: nothing about the factory, and nothing from it, while anyone can ask.
  if (result.open) return refuse("onboarding is off until this deployment is protected");
  // Already in: say where, as its row on the page says it.
  const listed = onboarded(repo, reposOf({ repoChannels, slackChannels }));
  if (listed) return Response.json({ started: false, repo: listed.repo, where: shows(listed) });
  // The app isn't on it, as far as the checks read: nothing to ask the agent for yet.
  const app = hasApp(repo, result.found);
  if (app === false) return Response.json({ started: false, repo, missing: true });
  // As GitHub writes it, when the checks came across it.
  const name = app ?? repo;
  const root = await startOnboarding(pageBoard(factory), channel("rsi"), name);
  return Response.json({ started: true, repo: name, thread: root.id });
}
