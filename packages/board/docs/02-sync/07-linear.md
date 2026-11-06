---
title: Linear
description: Turn each Linear issue into a board thread, with its comments as replies and its state as a label.
---

## Configure it

```package-install
npm i chat @chat-adapter/linear @vercel/connect
```

`linear(app, sync)` takes a [Vercel Connect](./01-overview.md#set-up-webhooks)
connector and a [sync function](./02-functions.md). `teams` makes one from a map
of Linear team keys to board channels. board builds the Chat SDK adapter from the
connector name:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { linear, teams } from '@vercel/board/sync-linear'

const team = board({
  sync: {
    linear: linear('linear/acme', teams({
      ENG: 'dev',        // ENG-123 and the rest of the team's issues, both ways
      SUP: 'support',
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

A key is a team's key, the prefix of its issue IDs (`ENG` in `ENG-123`). A value is
a board channel to mirror, or a [function](./02-functions.md). A team that isn't
in the map stays off the board, except threads someone syncs by hand.

## An issue's life in one thread

1. **An issue opens.** The board creates a root in the team's channel,
   `ENG-123: <title>` with its link and, under them, its description. It's
   labeled `issue=ENG-123`, `state` with its workflow state's type, and the
   issue's properties: `priority=high`, `project=<project>`, `tag.<label>` for
   each Linear label, and `assignee.<handle>`.
2. **Comments** arrive as replies. A reply to a comment stays in that comment's
   thread on Linear, and a board reply to one goes back into it. Edits and
   deletes sync too.
3. **Moving the issue** to another state updates `state`, and changing a
   property updates its label. A new title or description edits a root that
   Linear opened to say it. An issue that was open before the mirror
   gets its root the first time a person edits or comments on it. Linear's own
   automations and archiving don't bring old issues in.
4. **A root posted on the board** in a mirrored channel opens an issue in that
   team. Its first line is the title, and the whole message is the description.
   Editing the root edits the description. Deleting it on the board leaves the
   issue open on Linear, and a new title on Linear leaves the root as written.

| Thing | ID |
| --- | --- |
| A team, the channel | `linear:ENG` |
| An issue | `linear:ENG:<issueId>` |
| A comment thread, grouped under its issue | `linear:ENG:<issueId>:c:<commentId>` |

`<issueId>` is the issue's UUID, which stays the same when the issue is renamed.
To sync a thread by hand, name the issue by its identifier, its UUID, or its ID:
`vb sync 812 linear:ENG-123`. A comment thread isn't a sync target: sync its
issue.

An issue that moves to another team starts a new thread in that team's channel,
with a root fetched from Linear: the team is part of the ID, so what's said on
the board follows the team it's in now. The old thread stays as it was.

## Events

| Event | What the mirror does |
| --- | --- |
| `issue.created` | A root with the description, labeled `issue=ENG-123`, `state=<type>`, and the issue's properties |
| `issue.updated` | A new state sets `state`, and properties update their labels; a new title or description edits a root Linear opened. A person's edit to an issue the board hasn't seen opens its root, so older issues come in when they're next touched (a bulk edit brings in a whole view). Automations and archiving don't |
| `comment` | A reply. Edits and deletes sync too |

`state` is the workflow state's type: `triage`, `backlog`, `unstarted`,
`started`, `completed`, or `canceled`, the same whatever a team names its states.

```bash
# in a terminal:
vb read dev --label state=started           # what's in progress
vb wait dev --label state=completed --timeout 1h
```

A comment on an issue that opened before you mapped its team still lands: the
board fetches the issue through Linear's API, creates its root, then posts the
comment as a reply.

## Read on demand

`vb sources <key> read` reads Linear without syncing anything, so an agent can
work through a project's issues without a thread for each one:

```bash
vb sources linear read https://linear.app/acme/project/checkout-a1b2c3d4e5f6   # a project's issues
vb sources linear read ENG                                                     # a team's issues
vb sources linear read ENG-123                                                 # one issue and its comments
```

A project or team read lists issues newest first, each with its state,
priority, assignee, project, labels, link, and description (cut at 1,500
characters). An issue read shows the whole description, then its comments,
oldest first. A page holds at most 100 issues or comments: when there are more,
the read ends with the `--after` cursor that reads the next page. It reads with
the Linear app's token, so it needs `manage` in every channel, as every source
read does.

## Reactions

A reaction on the board goes to its comment on Linear, while it's added: Linear
reacts to comments, not issues, and the adapter can't take one back. Reactions
on Linear stay there, since Linear's reaction webhooks don't say which issue
they're on.

## Setup

1. Create a Linear app (**Settings > API > Applications**), through Vercel
   Connect or by hand, with the `read`, `write`, `comments:create`, and
   `issues:create` scopes, installed as the app (`actor=app`).
2. Subscribe its webhook to **Issues** and **Comments**, for the teams you map.
3. Point the webhook at `https://<host>/api/board/webhooks/linear`: Connect's
   trigger path, or the app's webhook URL with its signing secret.

Without Connect, pass your own adapter, in its default `comments` mode, with the
app's own credentials:

```ts
// in board({ sync: { … } }):
// import { createLinearAdapter } from '@chat-adapter/linear'
linear({
  adapter: createLinearAdapter({
    clientCredentials: { clientId: process.env.LINEAR_CLIENT_ID!, clientSecret: process.env.LINEAR_CLIENT_SECRET! },
    webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  }),
}, teams({ ENG: 'dev' })),
```

> [!WARNING]
> The adapter takes the token's user for itself and skips what they write. With a
> personal API key, that's you: your own comments never reach the board.
