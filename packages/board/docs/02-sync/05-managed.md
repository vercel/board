---
title: Syncs the board runs
description: Bring Vercel's events into a channel, or mirror a Slack channel, with one command and no deployment of your own.
---

## One command, no deployment

Sync usually runs in your own deployment, in `board({ sync })`. On Vercel's
board, the board can run a sync itself: you name a channel and a source, and it
keeps the sync going with no code and no project of yours.

```bash
# in a terminal:
vb sync deploys vercel --events deployment.error --project web   # Vercel's events, into deploys
vb sync alerts slack/vercel:#alerts                               # a Slack channel, both ways
vb syncs                                                          # what the board runs, and its state
vb sync remove syn_4f9a2c                                         # stop one: what it brought in stays
```

It takes `sync` in the channel, which for a person is `manage`. A board keeps at
most 100 of them. Only Vercel's board runs syncs itself: `local()` and a
backend of your own answer 501 `no_managed_sync`.

## Vercel's events

```bash
vb sync deploys vercel --events deployment.error,deployment.succeeded --project web
```

`--events` takes the names Vercel's webhooks use: `deployment.created`,
`deployment.error`, `firewall.attack`, `domain.created`, and every other event
a team webhook can send. `--project` keeps it to some projects, each by its name
or its ID, and repeats. Without it, the sync brings in every project's events,
which takes access to every project.

Each event lands as a message from Vercel: a line a person reads, the link to
what it is about, and the event's payload as a
[block](../01-board/04-messages.md#data) whose schema is the event's name, so
an agent reads the data instead of parsing the line:

````text
web: production deployment failed (main)
https://vercel.com/acme/web/8fK2

```json#vercel.deployment.error@1
{
  "project": { "id": "prj_web" },
  "target": "production",
  …
}
```
````

A payload too big for one message stays off it: the line and the link still
say what happened.

Events about the same thing share a thread: one per project and branch for
deployments (or per target, for one with no branch), one per domain, one per
project for the rest. A failed deployment and the one that fixes it are in the
same thread.

The board makes a webhook on your team for each sync, as whoever asked for it.
So a person asks, not a deployment, and that person may create the team's
webhooks and read each project the sync names. The webhook shows with the
team's other webhooks. Deleting it there pauses the sync.

## A Slack channel

```bash
vb sync alerts slack/vercel:#alerts
```

This mirrors a Slack channel and a board channel both ways through Vercel's
Slack app: what is said in Slack lands on the board as the Slack user who said
it, and what is posted on the board shows up in Slack under its author's name
and picture, replies in their threads. It needs Vercel's Slack app connected to your team and added to the
Slack channel. A team with more than one Slack workspace names one with
`--workspace <domain|id>`.

A channel's content is its members' to share. So a mirror asked for from
outside the Slack channel is `pending`, and nothing syncs, until someone in the
channel agrees: the app asks there. Asked for from inside the channel, it starts
at once:

```text
/vercel board sync alerts
```

A board mirrors a Slack channel once. To mirror a Slack channel with an app and
a sync function of your own, see [Slack](./03-slack.md).

## State

`vb syncs` lists every sync the board runs, and `vb syncs <channel>` or
`vb sync <channel>` one channel's. One that isn't running says so, and why:

```text
$ vb syncs
syn_4f9a2c  deploys  vercel --events deployment.error --project prj_web
syn_9c2f7b  alerts   slack/vercel:#alerts  pending: waiting for the channel to agree
syn_1b77e0  builds   vercel --events deployment.created  paused: its webhook is gone
```

| State | What it means |
| --- | --- |
| `active` | It runs. |
| `pending` | It never started: its source has yet to agree to it, as a Slack channel must. |
| `paused` | It ran, and its source is gone: someone deleted its webhook, or Vercel's Slack app can no longer reach the channel. |

A paused Slack mirror starts again when the app is back in the channel and
someone there runs `/vercel board sync` for the same board channel. A paused
`vercel` sync is removed and made again.

## From code

The handle and the client make, list, and remove them:

```ts
import { board } from '@vercel/board'

const team = board()

const sync = await team.createSync({ channel: 'deploys', source: 'vercel', events: ['deployment.error'], projects: ['web'] })
const mirror = await team.createSync({ channel: 'alerts', source: 'slack', slack: { channel: '#alerts' } })
mirror.state // 'pending', with mirror.reason: 'waiting for the channel to agree'

await team.syncs({ channel: 'deploys' }) // [{ id, channel, source, events, projects, state, by, createdAt }]
await team.removeSync(sync.id)
```

## Shape it yourself

A sync the board runs lands every event the same way. To filter events, post
them differently, or open tasks from them, run the same source in your own
deployment, with a [sync function](./02-functions.md):

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { into } from '@vercel/board/sync'
import { vercel } from '@vercel/board/sync-vercel'

const team = board({
  sync: {
    'vercel-events': vercel({ secret: process.env.VERCEL_WEBHOOK_SECRET! }, into('deploys')),
  },
})
export const GET = team.fetch, POST = team.fetch
```

Make a webhook in your team's settings that delivers to
`<your board's URL>/webhooks/vercel-events`, and give `vercel()` its secret:
it verifies each delivery's `x-vercel-signature` before it reads anything. The
function gets each event with `sync.event.name` as the webhook's type and
`sync.event.raw` as the delivery, and `sync.channel` as the project's ID, or
`team` for an event about no project. Name the entry anything but `vercel`:
an ID that starts with `vercel:` is one of Vercel's own principals. Vercel's
events only come in, so nothing is sent back.
