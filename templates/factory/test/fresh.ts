// A fresh factory's files, as the launcher reads them the day it's deployed. The tests read these
// and not this checkout's own: a factory edits its channels.ts when it onboards a repo, its
// factory.ts to name another connector, and its README in its first task.

/** app/api/board/[[...path]]/channels.ts, before any repo is onboarded. */
export const CHANNELS = `import { ownRepo } from "../../../../lib/github.ts";
import { channel, slackChannel } from "../../../../lib/project.ts";
import type { ServiceName } from "../../../../agent/lib/services.ts";

// Which repos and Slack channels come into the board, and where. This is the file to edit, and the
// agent edits it when you ask it to onboard a repo. This factory's channels are all under one
// named for its Vercel project: channel("web") is project-factory/web for a project named factory.

const own = ownRepo();

/** Each repo (\`owner/name\`, as GitHub writes it) and the board channel its PRs and issues come into: one per repo. */
export const repoChannels: Record<string, string> = {
  // This factory's own repo: where it changes itself.
  ...(own ? { [own]: channel("rsi") } : {}),
  // "acme/web": channel("web"),
};

/** Each Slack channel (a name or an ID) and the board channel it mirrors, both ways. */
export const slackChannels: Record<string, string> = {
  // Where the factory updates itself: its own PRs and issues, and talk about how it works. Named
  // for this factory's Vercel project, #factory-rsi for one named factory.
  [slackChannel("-rsi")]: channel("rsi"),
  // "#web": channel("web"),
};

/**
 * Each board channel and the services (agent/lib/services.ts) its threads reach, with the keys in
 * the Vercel project's env. A thread anywhere else reaches none. Every thread in the channel does,
 * a PR's or an issue's included: give a channel whose repo is public only what a stranger's issue
 * may use.
 */
export const serviceChannels: Record<string, readonly ServiceName[]> = {
  // [channel("web")]: ["stripe"],
};
`;

/** app/api/board/[[...path]]/factory.ts, as far as the launcher links into it: where the connectors are named. */
export const FACTORY = [
  'import { projectName } from "../../../../lib/project.ts";',
  "",
  "/** This factory's Vercel Connect connectors, named for its Vercel project: a team has one connector per name. */",
  "export const connectors = { github: `github/${projectName()}`, slack: `slack/${projectName()}` };",
  "",
].join("\n");

/** README.md while it's still the template's: it carries the button that deploys a copy. */
export const README = `# Software factory

A software factory on your team's board.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Fboard%2Ftree%2Fmain%2Ftemplates%2Ffactory&project-name=factory&repository-name=factory)

## Deploy it

1. **Click Deploy.** It makes your copy of this repo and a Vercel project.
`;
