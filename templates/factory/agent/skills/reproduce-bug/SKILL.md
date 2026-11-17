---
name: reproduce-bug
description: "Handle a bug report: reproduce it first, with a failing test where you can, report what you found, and fix it only once it's confirmed. Use when a thread reports something broken."
---

# Reproduce, then fix

A report is a claim, not a confirmed bug. Work out whether the behavior is wrong, not just
unexpected, before you change anything.

1. **Find the code and earlier work.** Search earlier threads (`vb read <your channel>/ --text <words>`) and
   PRs (`gh pr list --repo <owner/repo> --state all --search <words>`). If one already covers it,
   link it and build on it.
2. **Reproduce it.** Write the smallest test that shows the reported behavior, and run it on the
   default branch. Where a test can't show it (a UI, a deploy), reproduce it by hand, with the
   browser for a page.
3. **Say what you found**, in a few lines: reproduced or not, the cause if you have it, and what
   you'll do next.
   - **Not reproduced, or not a bug:** say why, and what would help: steps, a version, a log.
   - **A judgment call** (the behavior might be on purpose): ask, and wait until someone on the
     team agrees it's a bug.
4. **Fix it**, once it's reproduced and confirmed: on a branch of its own, with the failing
   test now passing and the rest of the suite green, in a PR whose body names the test that
   reproduces it (the open-pr skill). Then follow the pr-lifecycle skill.
