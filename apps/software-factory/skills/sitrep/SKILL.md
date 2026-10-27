---
name: sitrep
description: Do a sitrep for board, a recap that moves the project forward. Go through every open PR and recent thread, unstick what's stuck, land what's ready, close what's dead, and post a recap of what's left and who has to act. Use when you're asked for a sitrep or recap.
---

# Sitrep

A sitrep is project management, not a report. The goal is that after it,
less is open and nothing is stuck: work that's ready lands, dead work is
closed, stalled threads move again, and everyone who has to act knows exactly
what's being asked of them. The recap you post at the end is the record of
what's left.

Post the recap as a reply in your thread. Its root is the headline, so don't
repeat it.

## 1. Pick up from the last sitrep

You don't remember earlier sitreps, so find the last one:

```bash
vb read dev --label sitrep     # sitrep threads, old and new
```

The label matches a thread's root and its replies. The recap is the reply a
Eve posted under the root, or in older threads the root itself. Take the newest
recap before yours. Use its time as "since the last recap", and its items as
the list to follow up on: anything it said was blocked or waiting, check
whether it moved. If there's none, use the last 24 hours.

## 2. See what's open

Run `gh pr list --repo vercel-labs/board --state open` yourself, every time.
Don't trust what an earlier recap said about GitHub access: an error from
another run says nothing about yours. If gh fails, quote the error it printed
(status and message) in the recap, in one line. Then find the open PRs on the
board instead: the PR threads (`vb read dev --label pr`, the root labeled
`pr=vercel-labs/board#<n>` with its state label) and the `board/` branches
(`git branch -r` in a clone).

Then read each open PR's board and Slack threads, and the threads in `dev`
from the last few days that are still open.

## 3. Move each one forward

This is most of the job. For each PR and thread:

- **Ready**: approved and green. Merge it when GitHub lets you.
- **Dead or superseded**: close it, linking what replaced it.
- **Blocked on something you can fix** (a conflict, a review comment, a failing
  check): fix it and push, or ask the thread's own Eve to.
- **Blocked on a person**: ping the one person whose answer or review unblocks
  it, in that thread, and say exactly what you need from them.
- **Stuck with nobody moving it**: restart it. Ask the question that gets it
  going, or propose closing it or who should pick it up.
- **A thread with no answer**: answer it if you can.

When gh doesn't work, you can't merge or close: list those under "Ready to
merge" or "Left behind", and say so in one line.

## 4. Write the recap

List every open PR of vercel-labs/board, drafts and RFCs included, even when
nothing changed: none may drop out of the recap while it's open.

- A PR: `:pr: [#<n> <title>](<pr url>) · [Slack thread](<slack thread url>) cc @<owner> — <status>`.
  Take the Slack link from the "From …'s Slack thread" line at the top of the
  PR body, or else from the board threads of the PR and of any issue it links:
  when one of them has replies synced from Slack, link that Slack thread. Leave
  out the "· [Slack thread]" part only when none of them has one.
- A thread without a PR: `:slack: [<summary>](<slack thread url>) cc @<owner>`,
  with the summary as the link, never a bare url.
- Put the @ on the owner in every line, even when one person owns several (a
  bare "cc JB" notifies nobody), and never put a colon right after a handle:
  it stops being a mention.
- Link every PR and issue number you write, never a bare number:
  `[#<n>](https://github.com/vercel-labs/board/pull/<n>)` or `.../issues/<n>`
  (check which it is). Board numbers are not GitHub numbers: leave them as they are.

Lay it out for scanning: short bold section headers, each followed by a
markdown list ("- " per item), and a blank line between sections. These
sections, in this order, leaving out any that would be empty:

1. **Ready to merge**: approved and green, needs only a merge.
2. **Needs your call**: a person has to decide something. Put the question in the item.
3. **Waiting on review**
4. **Drafts and RFCs**
5. **Left behind**: stale PRs and threads, each with your proposal. PRs
   untouched for days can share one "Stale since …" line.
6. **Threads without a PR**
7. **Merged and closed since the last recap**: plain lists of linked numbers.
   Look them up, since you weren't there:
   `gh pr list --repo vercel-labs/board --state merged --search "merged:>=<last recap's time>"`,
   and `--state closed --search "is:unmerged closed:>=<…>"` for the closed ones
   (without `is:unmerged`, merged PRs show up too). When gh fails, use the
   `state` label on the board's PR roots (`vb read dev --label pr`).

Each PR or thread goes in exactly one section, on one line, with the status
after the "—" short enough to read at a glance.
