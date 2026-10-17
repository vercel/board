import type { Watcher } from "vboard";
import { byPi } from "./agent.ts";
import { bot, github, prNumber, type GitHubOptions } from "./github.ts";

// Auto-land, in shadow mode: it decides whether a factory PR would land on its own,
// and labels the PR thread with the decision, but merges nothing. The reviewer (the
// PR thread's Pi, a session apart from the one that wrote it) judges what code can't:
// `land=yes|no`, `land.why`, and `land.sha`, the head it reviewed. Code checks the rest.

/** The CI job a PR's head must pass (`.github/workflows/check.yml`). */
const CHECK = "check";
/** vboard core: what the published package ships, its source and the files that shape it. */
const isCore = (path: string) =>
  path.startsWith("packages/vboard/src/") || path === "packages/vboard/package.json" || path === "packages/vboard/tsdown.config.ts";
/** The reaction a PR root wears while it would auto-land, so Slack shows the verdict at a glance. */
export const STAMP = "stamp-hammer";
/** A user-facing change gets a changeset; the folder's README isn't one. */
const isChangeset = (path: string) => /^\.changeset\/[^/]+\.md$/.test(path) && path !== ".changeset/README.md";

export type PullRequest = { state: string; merged: boolean; user: { login: string }; head: { sha: string; ref?: string } };

/** The pi-pr workflow opens the PR for each push to a `pi/` branch, as github-actions[bot]. */
const byWorkflow = (pr: PullRequest) => pr.user.login === "github-actions[bot]" && pr.head.ref?.startsWith("pi/") === true;
export type ChangedFile = { filename: string; status: string };
export type CheckRun = { name: string; status: string; conclusion: string | null };
export type Review = { land?: string | undefined; why?: string | undefined; sha?: string | undefined };

/** Whether a PR would auto-land, and the one reason. The first rule it fails decides. `factory` is the app's bot login. */
export function decide(review: Review, pr: PullRequest, files: ChangedFile[], checks: CheckRun[], factory: string) {
  const no = (why: string) => ({ would: false, why });
  if (review.land !== "yes") return no(`review: ${review.why || "not landable"}`);
  if (pr.user.login !== factory && !byWorkflow(pr)) return no(`opened by ${pr.user.login}, not the factory`);
  if (pr.merged || pr.state !== "open") return no(`the PR is ${pr.merged ? "merged" : pr.state}`);
  if (review.sha !== pr.head.sha) return no("new commits since the review");
  const check = checks.find((run) => run.name === CHECK);
  if (check?.status !== "completed" || check.conclusion !== "success") {
    return no(`CI \`${CHECK}\` ${check ? (check.conclusion ?? check.status) : "hasn't run"}`);
  }
  const live = files.filter((file) => file.status !== "removed");
  const core = files.some((file) => isCore(file.filename));
  const userFacing = live.some((file) => isChangeset(file.filename));
  if (core && userFacing) return no("user-facing change to vboard core");
  return { would: true, why: core ? "internal change to vboard core" : "outside vboard core" };
}

/** Labels hold up to 256 characters. */
const clip = (text: string) => (text.length > 256 ? `${text.slice(0, 255)}…` : text);

export function autoland(options: GitHubOptions = {}): Watcher {
  return {
    tail: "dev --label pr",
    run: async ({ event, board }) => {
      const root = event.message;
      if (
        event.type !== "labels.changed" ||
        !("land" in event.payload.set) ||
        !root ||
        root.re !== null ||
        !byPi(root.id, event.payload.by)
      ) return;
      const number = prNumber(root.labels);
      if (!number) return;
      let decision: { would: boolean; why: string };
      try {
        const api = await github(options);
        const pr: PullRequest = await api(`/pulls/${number}`);
        const files: ChangedFile[] = [];
        // GitHub lists up to 3000 files, 100 a page.
        for (let page = 1; page <= 30; page++) {
          const batch: ChangedFile[] = await api(`/pulls/${number}/files?per_page=100&page=${page}`);
          files.push(...batch);
          if (batch.length < 100) break;
        }
        const { check_runs }: { check_runs: CheckRun[] } = await api(
          `/commits/${pr.head.sha}/check-runs?check_name=${CHECK}&filter=latest`,
        );
        decision = decide(
          { land: root.labels.land, why: root.labels["land.why"], sha: root.labels["land.sha"] },
          pr,
          files,
          check_runs,
          (await bot(api)).login,
        );
      } catch (error) {
        decision = { would: false, why: `couldn't read the PR: ${error instanceof Error ? error.message : String(error)}` };
      }
      // The verdict before this one: the stamp follows the label, so it's added or removed only when that flips.
      const stamped = root.labels.autoland === "would";
      await board.label(root.id, {
        set: { autoland: decision.would ? "would" : "no", "autoland.why": clip(decision.why) },
      });
      if (decision.would !== stamped) await board.react(root.id, STAMP, { remove: !decision.would });
    },
  };
}
