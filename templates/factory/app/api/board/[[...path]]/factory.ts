import { board } from "@vercel/board";
import { github, repos } from "@vercel/board/sync-github";
import { channels, slack } from "@vercel/board/sync-slack";
import { WATCHER } from "../../../../agent/lib/identity.ts";
import { wakeAgent } from "../../../../agent/lib/wake.ts";
import { channel, projectName } from "../../../../lib/project.ts";
import { repoChannels, serviceChannels, slackChannels } from "./channels.ts";
import { appLogin, withoutForksOrOwn } from "./github.ts";

// The factory's board: your team's board in Vercel's API, which keeps its messages, files, and
// schedules. This deployment keeps nothing: it runs the board's sync and its watchers.

/** Which repos and Slack channels come in, and where, and which channels reach which services: channels.ts is the file to edit. */
export { repoChannels, serviceChannels, slackChannels };

/** This factory's Vercel Connect connectors, named for its Vercel project: a team has one connector per name. */
export const connectors = { github: `github/${projectName()}`, slack: `slack/${projectName()}` };

/** What the agent hears: every message in this factory's channels, the one named for its project and the ones under it. */
export const hears = `${channel()}/`;

/** Production is on the team's default board. Anything else, your dev server included, is on one of its own, so it never answers production's threads. */
export const boardName = process.env.VERCEL_ENV === "production" ? null : "factory-dev";

export const factory = board({
  ...(boardName ? { name: boardName } : {}),
  basePath: "/api/board",
  sync: {
    // Nothing goes back to GitHub: the agent comments there itself, with gh.
    github: github(connectors.github, repos(withoutForksOrOwn(repoChannels, appLogin(connectors.github)))),
    // join: vb sources slack join <channel> adds the app to a public channel when someone asks.
    slack: slack({ adapter: connectors.slack, join: true }, channels(slackChannels)),
  },
  watch: {
    // A watcher writes as a profile named for its ID, and the agent as the deployment itself: the
    // board never wakes a watcher for its own writes, so this way the agent's check-ins reach it.
    [WATCHER]: { tail: hears, run: (context) => wakeAgent(context) },
  },
});
