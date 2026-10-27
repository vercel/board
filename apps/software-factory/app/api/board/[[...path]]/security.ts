import type { Watcher } from "@vercel/board";
import type { tellEve } from "./agent";
import { prNumber, REPO } from "./github.ts";

/** Long enough for deepsec at its maximum thinking on a PR's diff, inside the 45m a sandbox session gets (`agent/sandbox.ts`). */
const DEEPSEC_TIMEOUT = "30m";

/**
 * A person's :security: reaction on a PR thread's root (from Slack) has Eve run deepsec on the
 * PR's diff and report back, reacting :secure: when it comes out clean. Anyone in the channel
 * can ask, the same rule as :shipit:. On a thread that isn't a PR, the watcher says so itself.
 */
export function security(options: { tellEve: typeof tellEve }): Watcher {
  return {
    // Not `--label pr`: a reaction on a non-PR thread gets an answer too.
    tail: "dev",
    run: async ({ event, board }) => {
      const root = event.message;
      if (
        event.type !== "reaction.added" ||
        event.payload.emoji !== "security" ||
        event.payload.from !== "slack" ||
        !event.payload.by.principal.startsWith("slack:user:") ||
        root?.re !== null
      ) return;
      const pr = root.labels.pr;
      const number = prNumber(root.labels);
      if (!number) {
        await board.reply(root.id, `\`:security:\` works on PR threads: react on a ${REPO} pull request's thread to have Eve run a deepsec review of its diff.`);
        return;
      }
      const requester = event.actor?.handle ?? event.payload.by.actor;
      // Named, not $(mktemp -d): each of Eve's commands runs in a new shell, so a variable wouldn't last.
      const dir = `/tmp/deepsec-${event.cursor}`;
      await options.tellEve({
        board,
        task: "review",
        thread: root.id,
        key: `security-${event.cursor}`,
        message: [
          `${requester} (${event.payload.by.actor}) reacted with :security: to request a deepsec security review of ${pr} in board thread #${root.id}.`,
          `1. Check out the PR (gh pr checkout ${number} in your clone of ${REPO}), and git fetch origin so its base branch is current. Install Claude Code if it's missing (command -v claude || npm i -g @anthropic-ai/claude-code); deepsec uses it as its agent.`,
          `2. Make a fresh worktree outside the clone and work there: git worktree remove --force ${dir} 2>/dev/null; rm -rf ${dir}; git worktree prune && git worktree add --detach ${dir} HEAD, and run the next step from ${dir}. The remove and prune clear a worktree an earlier run for this reaction left registered, which rm -rf alone doesn't, so git worktree add would refuse the path. deepsec keeps state in data/ and only fails on net-new findings, so a run in a reused checkout can come back clean with findings still there. This also keeps its files out of the clone.`,
          `3. In ${dir}, run: timeout ${DEEPSEC_TIMEOUT} env CLAUDE_CODE_EXECUTABLE=claude npx -y deepsec process --diff origin/<base>...HEAD --comment-out deepsec.md > deepsec.log 2>&1, where <base> is the PR's base branch (gh pr view ${number} --json baseRefName). The three dots diff from where the PR branched, so commits that landed on the base since aren't reviewed as its changes. Note its exit code.`,
          `4. Exit 0 (no new findings): reply that deepsec found nothing, attach ${dir}/deepsec.log, and react on the root with vb react ${root.id} secure.`,
          `   Exit 1 (findings): reply with a short line per finding (file, issue, severity), attach ${dir}/deepsec.md, and don't react :secure:.`,
          `   Any other exit is a failed run: 2 (deepsec needs input), 3 (it hit its cost cap), 124 (the timeout), or anything else. Say why, from ${dir}/deepsec.log, and don't react :secure:.`,
          `5. Back in your clone, git worktree remove --force ${dir}.`,
          "Mention the requester in your reply. Don't change the PR's code for this unless someone asks.",
        ].join("\n"),
      });
    },
  };
}
