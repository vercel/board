---
name: open-pr
description: "Name a branch, and write a pull request's title and description so a person can review it without asking you anything. Use before every gh pr create, and when a push changes what your PR does."
---

# Open a pull request people can read

People meet a PR as its title: in a list, in Slack, in their inbox. They read its description
before the diff, to decide what to look at. Both are for someone who wasn't in the thread.

The repo comes first: its AGENTS.md or CONTRIBUTING, its pull request template
(`.github/pull_request_template.md`), and how its last merged PRs read
(`gh pr list --repo <owner/repo> --state merged --limit 10 --json title,headRefName`). Where the
repo has a convention, follow it. The rest is for where it has none.

## Branch

`factory/<what it does>`, in two to four lowercase words joined by hyphens:
`factory/fix-login-redirect`, `factory/onboard-web`. Never an ID: the branch names the PR's
preview deployment, and shows wherever the PR does.

A name like that isn't yours alone: another thread may have asked for the same thing, and a push
to its branch would land on its PR. Before your first push of a new branch, check the name is
free (`git ls-remote --exit-code --heads origin factory/<name>` finds nothing, and so does
`gh pr list --repo <owner/repo> --head factory/<name> --state all`), and pick another when it
isn't. Once the branch is yours, with your PR on it, keep pushing to it.

## Title

What the change does for whoever uses the thing, in the imperative, in about 60 characters at
most: "Stop the login page redirecting twice". Not what you edited ("Update channels.ts"), and
not the request repeated when it doesn't say what changes.

## Description

Short enough to read on one screen, in this order:

1. **Where it came from**, as one quoted line with a link someone can open. A Slack thread
   (`vb sync <thread id>` lists its link): `> From <who>'s [Slack thread](<link>)`. An issue:
   `> From <owner/repo>#<issue>`, with `Closes #<issue>` under it when the PR fixes it. A thread
   that's only on the board has no link: `> Asked by <who> on the board, in <channel>`. Never a
   board ID: it means nothing on GitHub.
2. **What changes** for the people who use it, in a sentence or two: what they'll see or can
   now do, and where (the page, the command, the channel).
3. **That it works:** for a fix, the test that fails without it. For something visible, a
   screenshot or a video (the ui-demo skill). For a command, what it printed.
4. **What the reviewer has to do or decide**, each a line they can act on, and whether it's
   before or after merging: a channel to create, a setting to change, a choice you made that
   they may not want. Leave this out when there's nothing.

Leave out the list of files, a walk through the diff, and how you got there.

## Keep it true

When a push changes what the PR does, change its title and description to match:
`gh pr edit <N> --repo <owner/repo> --title "<title>" --body-file <file>`.
