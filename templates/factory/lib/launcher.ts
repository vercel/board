import { boardName, connectors, factory, repoChannels, slackChannels } from "@/app/api/board/[[...path]]/factory";
import { ownRepo } from "./github.ts";
import { channel, projectOf } from "./project.ts";
import { runningOf, type Running } from "./running.ts";
import { boardDeps, inspectCommand, isLocal, liveDeps, setup, type Setup } from "./setup.ts";

export type { Running };

// The launcher, checked now, for whichever of its faces was asked: the page, its markdown, or the
// steps the agent's setup_steps tool reads.

export type Launcher = {
  result: Setup;
  /** The command that opens this factory's board in a browser. */
  inspect: string;
  /** Where this was asked, as a URL. */
  origin: string;
  /** A dev server, not a deployment. */
  local: boolean;
  running: Running | null;
};

/** Checks this deployment as `host` sees it: a preview can be open while production is closed. */
export async function check(host: string | null): Promise<Launcher> {
  const home = channel();
  const deps = await liveDeps(boardDeps(factory), { connectors, repoChannels, slackChannels, board: boardName, home });
  deps.host = host;
  const result = await setup(deps);
  const team = await deps.oidc().then((token) => projectOf(token)?.team, () => undefined);
  const local = isLocal(deps.env);
  const origin = `${local ? "http" : "https"}://${host ?? deps.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost"}`;
  const running = runningOf(result, { repoChannels, slackChannels, home }, { origin, team, board: boardName, repo: ownRepo(deps.env) }, new Date());
  return { result, inspect: inspectCommand(team, boardName), origin, local, running };
}
