import type { Watcher } from "@vercel/board";
import { sourceLink } from "./agent.ts";
import { github, prNumber, type GitHubOptions } from "./github.ts";
import { threadOfBranch } from "./owner.ts";

/** The watcher's ID, and so its actor: Eve isn't woken by its replies, and Slack shows them without a label. */
export const CROSSPOST = "crosspost";
export const CROSSPOST_ACTOR = `board:watch:${CROSSPOST}`;

/**
 * Links a factory PR's Slack thread and the Slack thread it was built for, both ways, once the
 * PR's root lands in Slack: the PR thread gets `:crosspost: From <who>'s thread`, and the source
 * thread gets `:crosspost: #12 <title>`, each a link to the other. Only `board/<thread>` PRs whose
 * source thread came from Slack; the root is labeled `crosspost=yes` so it happens once.
 */
export function crosspost(options: GitHubOptions = {}): Watcher {
  return {
    // `--all`: where the PR root landed in Slack only shows in its delivery receipt.
    tail: "dev --label pr --all",
    run: async ({ event, board }) => {
      const root = event.message;
      if (event.type !== "message.synced" || !root || root.re !== null || root.labels.crosspost) return;
      const here = sourceLink({ thread: event.payload.external.thread });
      if (here?.platform !== "Slack") return;
      const number = prNumber(root.labels);
      if (!number) return;
      const pr = await (await github(options))(`/pulls/${number}`);
      const sourceId = threadOfBranch(pr.head?.ref);
      if (!sourceId) return;
      const { message: source } = await board.thread(sourceId);
      const there = sourceLink(source.origin);
      if (there?.platform !== "Slack") return;
      await board.label(root.id, { set: { crosspost: "yes" } });
      const who = source.author?.name ?? source.author?.handle;
      const title = (/^PR #\d+: (.+)/.exec(root.text)?.[1] ?? pr.title ?? "").replace(/[[\]]/g, "\\$&");
      await board.reply(root.id, `:crosspost: From [${who ? `${who}'s` : "its"} Slack thread](${there.url}) · board #${source.id}`);
      await board.reply(source.id, `:crosspost: [#${number} ${title}](${here.url})`);
    },
  };
}
