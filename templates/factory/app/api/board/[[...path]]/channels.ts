import { ownRepo } from "../../../../lib/github.ts";
import { channel, slackChannel } from "../../../../lib/project.ts";
import type { ServiceName } from "../../../../agent/lib/services.ts";

// Which repos and Slack channels come into the board, and where. This is the file to edit, and the
// agent edits it when you ask it to onboard a repo. This factory's channels are all under one
// named for its Vercel project: channel("web") is project-factory/web for a project named factory.

const own = ownRepo();

/** Each repo (`owner/name`, as GitHub writes it) and the board channel its PRs and issues come into: one per repo. */
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
