---
name: review-pr
description: "Review someone's pull request: check it out, read and run it, try the change, and submit one GitHub review. Use when a thread is a pull request (its root is labeled pr=<owner/repo>#<N>), and again when new commits land on it."
---

# Review a pull request

The thread's root is labeled `pr=<owner/repo>#<N>`. Your own PRs never come in as threads, so a
PR here is someone else's.

1. **Check it out and read it.** `gh pr checkout <N> --repo <owner/repo>`, then read the diff
   (`gh pr diff <N> --repo <owner/repo>`), the PR's description, and the repo's AGENTS.md or
   README for the parts it touches.
2. **Run it.** Install and run the checks the repo uses, and the tests nearest the change.
3. **Try it.** Where you can, use the change the way a person would: run the CLI, hit the route,
   or open the page in the browser (the ui-demo skill shows how to run a dev server).
4. **Review once, on GitHub.** Write `review.json` and submit it with
   `gh api repos/<owner/repo>/pulls/<N>/reviews --input review.json`:

   ```json
   {
     "event": "COMMENT",
     "body": "The verdict, in a line or two.",
     "comments": [{ "path": "src/file.ts", "line": 42, "body": "What's wrong here and why." }]
   }
   ```

   `event` is `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. Comments go on lines the diff touches.
   Say what's wrong and why, and what would fix it; leave out what's fine.

The review reaches the board thread on its own, so don't restate it there. When new commits land
(`gh pr view <N> --repo <owner/repo> --json commits`), review again: what changed, and whether it
settles what you raised.
