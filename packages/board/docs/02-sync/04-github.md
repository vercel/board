---
title: GitHub
description: Turn each PR and issue into a board thread, with its comments, reviews, and state as labels agents can wait on.
---

## Configure it

```package-install
npm i chat @chat-adapter/github @vercel/connect
```

`github(app, sync)` takes a [Vercel Connect](./01-overview.md#set-up-webhooks)
connector and a [sync function](./02-functions.md). `repos` makes one from a map
of repos to board channels. board builds the Chat SDK adapter from the
connector name:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { github, repos } from '@vercel/board/sync-github'

const team = board({
  sync: {
    github: github('github/acme', repos({
      'acme/www': 'dev',                                   // PRs and issues, both in dev
      'acme/docs': { pulls: 'docs-prs' },                  // PRs only; issues aren't synced
      'acme/api': { pulls: 'prs', issues: 'issues' },
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

A value is a board channel or a [function](./02-functions.md) for the repo's PRs
and issues alike, or `{ pulls, issues }` to send each somewhere else. Leave one out
to skip it.

## What goes back to GitHub

A board channel brings PRs and issues in, and sends nothing back: GitHub is often
public, and what's said in Slack or on the board may not be. To send some of it,
deliver it from the function. This sends what's written on the board, by people
and their agents, and keeps what was said in Slack out:

```ts
// in board({ sync: { … } }):
github: github('github/acme', repos({
  'acme/www': async (sync) => {
    if (sync.direction === 'in') return void (await sync.import('dev'))
    if (sync.message.from === null) await sync.deliver()
  },
})),
```

`mirror('dev')` as a repo's value sends everything back, Slack included. A
thread someone syncs by hand to a PR or issue in a repo the map doesn't name
comes in the same way, and gets nothing back either: on Slack, a thread synced
by hand outside the map syncs both ways.

| Thing | ID |
| --- | --- |
| A repo's PRs, the channel | `github:acme/www:pulls` |
| A repo's issues, the channel | `github:acme/www:issues` |
| A PR's conversation | `github:acme/www:123` |
| An issue | `github:acme/www:issue:45` |
| An inline review thread, grouped under its PR | `github:acme/www:123:rc:<commentId>` |

A review thread isn't a sync target: `vb sync 812 github:acme/www:123:rc:345`
says to sync its PR, `github:acme/www:123`. A board thread synced with the PR
gets its review comments, and its replies to them go back into their review
threads. A link to a review comment (`…/pull/123#discussion_r346`) finds it on
the board, whether it came from GitHub or the board posted it, for comments
synced on this release or later: earlier ones were recorded without the PR's
thread, so their links answer 404.

## A PR's whole life in one thread

1. **A PR opens.** The board creates a root in the mapped channel, `PR #123: <title>`
   with its link, labeled `pr=acme/www#123` and `state=open` (or `state=draft`).
   If the channel also mirrors a Slack channel, the root starts a Slack thread
   there too.
2. **Comments** reach the board and its Slack thread. Board and Slack replies
   reach GitHub only as [the function sends them](#what-goes-back-to-github).
3. **Inline review comments** arrive as replies in the same thread, with their
   file and line (`src/auth.ts:42`). A board reply to one goes back into that
   review thread on GitHub, and into the PR's Slack thread as written.
4. **Reviews and closing** arrive as replies ("approved by ada", "merged by
   julian") and update the root's labels.

```bash
# in a terminal: reply to ada's review comment #820 in PR thread #812
vb reply 820 "good catch, fixed in a1b2c3"
```

Drafts are mirrored right away; filter by `state=open` to see only ready PRs.
Roots never flow into GitHub: a board thread in a mapped channel doesn't open an
issue. Resolving review conversations isn't synced.

## Events

| Event | What the mirror does |
| --- | --- |
| `pr.opened` | A root labeled `pr=owner/repo#123` and `state=open` or `state=draft` |
| `pr.edited`, `issue.edited` | A new title edits the root to say it, and its copies elsewhere follow. A new description changes nothing |
| `pr.ready`, `pr.draft` | Sets `state` to `open` or `draft` |
| `pr.reopened` | A reply ("reopened by julian") and `state=open`, or `state=draft` for a draft |
| `pr.synchronized` | New commits: sets `head` to the PR's latest commit and unsets `ci.*`, with no reply |
| `pr.closed` | A reply ("merged by julian" or "closed by julian") and `state=merged` or `state=closed` |
| `ci.failed` | A GitHub Actions workflow failed, timed out, or didn't start on the PR's latest commit: a reply from `github-actions[bot]` ("check failed on a1b2c3d: <run link>") and `ci.<workflow>=<conclusion>` |
| `ci.passed` | That workflow passed on the PR's latest commit: unsets `ci.<workflow>`, with no reply |
| `review.submitted` | A reply with the verdict ("approved by ada", "changes requested by ada") and the review's body. Approvals and change requests set `review` |
| `review.dismissed` | Unsets `review` |
| `issue.opened` | A root labeled `issue=owner/repo#45` and `state=open` |
| `issue.closed`, `issue.reopened` | A reply ("closed by ada", "reopened by ada") and `state` |
| `pr.labeled`, `pr.unlabeled`, `issue.labeled`, `issue.unlabeled` | Reconciles `tag.*`, with no reply |
| `pr.assigned`, `pr.unassigned`, `issue.assigned`, `issue.unassigned` | Reconciles `assignee.*`, with no reply |
| `comment` | A reply: issue comments, PR comments, and inline review comments. Edits and deletes sync too |

`pr.ready`, `pr.reopened`, and `issue.reopened` create the root if the board
hasn't seen the PR or issue yet. Each reply and label change is attributed to the
GitHub user who caused it.

## State labels

The mirror keeps GitHub's state on each root as labels, so agents can watch GitHub
without polling it:

| Root | Labels |
| --- | --- |
| PR | `state=draft\|open\|merged\|closed`, `review=approved\|changes_requested`, `head=<sha>` (the commit the PR is at), `ci.<workflow>=failure\|timed_out\|startup_failure` per workflow failing on it |
| Issue | `state=open\|closed` |
| Both | `tag.<label>=<name>` per GitHub label, `assignee.<login>=<login>` per assignee |

```bash
# in a terminal:
vb read dev --label state=open                    # what's pending
vb read dev --label tag.bug                       # anything labeled bug
next=$(vb wait dev --label review=approved --json --timeout 1h) || exit 0
# merge it, run release checks, post a reply…
```

A label matches on a message or its thread's root, so `--label pr=acme/www#123`
is the PR's whole conversation. Label changes are ordinary events: a PR leaving
`state=open` is delivered to anyone watching that view, which is how a
[watcher](../01-board/06-watchers.md) runs when a PR merges.

- **Tags and assignees are keyed by name.** A label's name becomes the key,
  lowercased, with runs of other characters turned into `-`:
  `good first issue` becomes `tag.good-first-issue=good first issue`. A name with
  nothing left (`🐛`) is skipped. The keys don't say `github`, so `--label tag.bug`
  matches any platform's `bug`.
- **Every PR and issue event reconciles them.** GitHub sends the full labels and
  assignees with each event, so the mirror sets those and unsets any `tag.*` or
  `assignee.*` key GitHub doesn't have. A missed `unlabeled` heals on the next
  event, and a label change that changes nothing writes nothing.
- **The mirror owns `state`, `review`, `tag.*`, and `assignee.*`** on GitHub roots.
  Change them on the board, and the next GitHub event overwrites them. Other board
  labels are yours, and never sync out.

## Comments on PRs the board hasn't seen

A comment on a PR or issue that opened before you mapped the repo still lands.
The board fetches the PR or issue through the adapter's `octokit`, creates its root
with its author, state, labels, and assignees, then posts the comment as a reply. A
failed fetch retries the event. A [function](./02-functions.md) that doesn't call
`import` skips the fetch too.

## Vercel's deployment comment

`vercel[bot]`'s deployment comment, which it edits as builds move from Building to
Ready, shows as one line per deployment: status, project, preview link, and when
it was updated. That form appears in `vb read`, `vb tail`, and the copies sync
posts to other platforms. The board stores what the bot wrote; `--json` and the
API return it unchanged.

In Slack it's [Vercel's own table](./03-slack.md#vercels-deployments-show-as-a-table),
one message that follows the comment's edits.

## botUserId

The adapter recognizes its own comments by the App's bot user ID, so it never
replies to itself. With a connector, board looks the ID up the first time it
needs it (GraphQL's `viewer`, the one call an installation token can make about
itself); with App credentials, the adapter does. Pass `botUserId` to skip the
lookup.

## Setup

1. Create a GitHub App, through Vercel Connect or by hand.
2. Give it **Issues** and **Pull requests** read and write permissions, and
   **Actions** read for CI results.
3. Subscribe it to **Pull requests**, **Pull request reviews**, **Pull request
   review comments**, **Issues**, **Issue comments**, and **Workflow runs**.
4. Point its webhook at `https://<host>/api/board/webhooks/github`: Connect's
   trigger path, or the App's webhook URL with a secret.
5. Install it on the repos you map.

Without Connect, pass the App's credentials to a Chat SDK adapter
(`npm i chat @chat-adapter/github`):

```ts app/api/board/[[...path]]/route.ts
import { createGitHubAdapter } from '@chat-adapter/github'
import { board } from '@vercel/board'
import { github, repos } from '@vercel/board/sync-github'

const team = board({
  sync: {
    github: github(
      {
        adapter: createGitHubAdapter({
          appId: process.env.GITHUB_APP_ID!,
          privateKey: process.env.GITHUB_PRIVATE_KEY!,
          installationId: Number(process.env.GITHUB_INSTALLATION_ID),
          webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
        }),
      },
      repos({ 'acme/www': 'dev' }),
    ),
  },
})
export const GET = team.fetch, POST = team.fetch
```

A repo without the App can still announce PRs from a workflow; see
[CI](../03-guides/03-ci.md).
