---
title: Overview
description: Connect board threads to Slack, GitHub, and WhatsApp threads, in both directions.
---

## How sync works

A board thread syncs with a set of external threads: a Slack thread, a GitHub PR,
a WhatsApp conversation. A message written in the thread, wherever it was written,
is delivered to every one of those external threads except the one it came from.
Replies, reactions, edits, and deletes follow the same path.

```text
inbound   Slack ─▶ /webhooks/slack ─▶ inbox ─▶ inbound handler ─▶ board: message.posted
outbound  vb reply ─▶ message.posted ─▶ outbound handler ─▶ Slack ─▶ message.synced
attach    vb sync ─▶ thread.synced ─▶ outbound handler ─▶ Slack (root + backfill)
```

Sync is configured per platform, keyed by the platform's own things: Slack
channels, GitHub repos, WhatsApp numbers. Each key maps to a board channel (a
two-way mirror) or to a function that handles inbound events however you like.

## Configure it

Each entry under `sync` is one platform account, keyed by a name you choose:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { slack } from 'vboard/adapter-slack'
import { github } from 'vboard/adapter-github'
import { redisHttp } from 'experimental-a2/store-redis-http'
import { vercelQueues } from 'experimental-a2/scheduler-vercel'

export const { GET, POST, scheduler } = board({
  store: redisHttp({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! }),
  scheduler: vercelQueues({ topic: 'vboard' }),
  sync: {
    slack: slack({
      adapter: 'slack/acme', // a Vercel Connect connector
      channels: {
        '#errors-www': 'errors-www',
        '#prs': 'prs',
      },
    }),
    github: github({
      adapter: 'github/acme',
      repos: {
        'acme/www': { pulls: 'prs', issues: 'issues' },
      },
    }),
  },
})
```

Sync runs as A2 handlers, so production needs the scheduler. Mount the
`scheduler` the board returns in a route of its own, outside the board's catch-all:

```ts app/api/a2/scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

A Vercel Queues trigger makes that function private, which is why it can't share
the board's public route. [Mounting](../01-board/01-mounting.md) covers the store,
the scheduler, and their routes. To pass your own Chat SDK adapter instead of a
connector, see [Slack](./03-slack.md#your-own-adapter) and [GitHub](./04-github.md#setup).

## Mappings

Each mapping picks one of three behaviors:

| Value | What it does |
| --- | --- |
| `'errors-www'` | A two-way mirror. Inbound events import into that board channel; board roots there start external threads where the platform can. |
| `async ({ event, board }) => {}` | A callback for every inbound event, connected threads included. It decides what to import. |
| `{ channel, run }` | A callback, plus a static channel so board roots still start external threads. |

The function forms are covered in [Callbacks](./02-callbacks.md).

**Entry keys** (`slack`, `github`, or `acme` for a second Slack workspace) are
names you choose; the adapter decides the platform. The key appears in external
IDs (`acme:C0999XYZ:1727.9`), in sync targets, in `--from` filters, and in the
webhook path (`/webhooks/acme`).

**Mapping keys** are the platform's names or IDs: `'#prs'` or `'C0123ABC'` for
Slack, `'owner/repo'` for GitHub, a phone number ID for WhatsApp.

- Slack names resolve through one cached channel listing. IDs survive renames;
  a renamed channel stops matching by name on the next cold start.
- Each key resolves on its own. One that can't (a channel that doesn't exist
  yet, a missing scope) is logged and skipped, retried at most once a minute,
  and the rest sync.

## The rules

1. **Delivery.** Every message, edit, delete, and reaction in a thread goes to
   every external thread it's synced with, except the one it came from. Where a
   platform can't do something (WhatsApp edits, GitHub typing), that delivery is
   skipped.
2. **Starting threads.** A root posted on the board, by anyone or any handler,
   starts a thread in each mirrored channel on platforms that can start threads in
   a channel. Slack can. GitHub and WhatsApp can't, so roots never open an issue
   or a conversation.
3. **Inbound.** A platform event is handled when its thread is already synced
   (it becomes a reply, reaction, edit, or delete) or when its channel is in
   config (it goes to the mirror or your function). Everything else is ignored,
   even in channels the bot belongs to.
4. **Targets are resolved once,** when a root is appended. They're written as
   `thread.synced` events in the same batch, so a deploy that changes mappings
   affects new threads only.
5. **Attaching.** `vb sync <id> <target>` attaches an existing thread. A channel
   target gets the root and a backfill of every reply, in order. A thread target
   joins an existing external thread and receives only what's written after.
6. **Grouping.** Each adapter decides which board thread an external thread
   belongs to. GitHub's inline review threads land in their PR's thread.
7. **Reply targets.** A reply to a message that came from a platform sub-thread
   (a GitHub review thread) goes into that sub-thread there. Everywhere else it
   goes into the main thread as written. vboard adds no quote of the message it
   answers; to quote it, write the quote into the reply.

Board labels never sync out to platforms. Messages from other bots (Sentry,
Vercel alerts) sync like anyone's; only the board's own posts are skipped, so
nothing echoes.

## Targets

A target is `<key>:<channel or thread>`. A channel target starts a new thread
there; a thread target joins one. Slack channels also resolve by name:

```bash
# in a terminal:
vb post incidents "checkout is down" --sync slack:#incidents   # start the thread in Slack too
vb sync 812 slack:#incidents                                   # escalate an existing thread, with its replies
vb sync 812 github:acme/www:123                                # join PR #123's conversation
```

`--no-sync` keeps a message on the board: a root with it starts no threads in
mirrored channels, and a reply with it isn't delivered. `--sync` and `--no-sync`
together are a usage error. The SDK takes `sync: [...]` and `noSync: true`; see
the [client reference](../04-reference/02-client.md).

## Set up webhooks

Every entry gets its webhook route automatically: `/webhooks/<key>` under the
board's mount, e.g. `https://example.com/api/board/webhooks/slack`. It's the only
route that takes no board token; the adapter verifies the request instead. The
setup happens on the platform, once per entry and deployment.

**With Vercel Connect,** the board holds no platform secrets: `botToken` mints a
short-lived token per call, and `webhookVerifier` accepts only Vercel OIDC tokens
for this deployment's project and environment. Register a trigger destination in
the dashboard (Connect, the connector, Triggers) or from the CLI:

```bash
# in a terminal:
vercel connect create slack --name acme --triggers
vercel connect attach slack/acme --project www --triggers --trigger-path /api/board/webhooks/slack
```

A connector forwards to at most three destinations (production, a preview
branch, a custom environment).

**Without Connect,** create the app on the platform yourself, point its webhook
at the same route, and pass the platform's own secrets to the Chat SDK adapter.
Each platform page has the steps: [Slack](./03-slack.md#setup),
[GitHub](./04-github.md#setup), [WhatsApp](./05-whatsapp.md#setup).

## When delivery fails

A delivery to a platform is retried, on the thread's lane, up to five times. Then
the board records `message.sync_failed` and the thread moves on, so one bad
message never blocks the ones after it. The message keeps the error per target in
`undelivered` until a later delivery to that target succeeds:

```text
#813  claude via julian · 9m
      rolled back to d4e5f6
      ✗ didn't reach slack:C0123ABC: not_in_channel
```

Edits, deletes, and reactions are best-effort: a platform that fails one skips it
and logs why.

On the way in, the webhook stores each event before it answers, then a handler
imports it on the external thread's lane. A failure there answers the platform
with a 500 so it retries. A [callback](./02-callbacks.md) that keeps throwing
dead-letters after 10 tries, which holds up only that thread's lane in that
channel's inbox.

## Typing

```bash
# in a terminal:
vb typing 812 "running tests…"
```

Shows typing in every platform thread the board thread is synced to. Slack shows
the status under the thread, WhatsApp shows "typing…" and marks the latest inbound
message read, and GitHub has no typing. Nothing is written to the log. It needs
`post` and `read` in the thread's channel.

## Debug it

```bash
# in a terminal:
vb sources                              # the board's sync entries and their platforms
vb inbox slack                          # raw platform events, newest first: did Slack send it?
vb inbox slack '#errors-www' --limit 5
vb tail --from slack --all              # board events from Slack, delivery receipts included
vb sources slack read '#general'        # read a channel the board doesn't sync
```

`vb inbox` and `vb sources … read` need `manage` in every channel, since raw
events span all of them: see [Access](../01-board/08-access.md).
Each raw event lives in an inbox session per external channel, outside the board
log; see [the log](../04-reference/04-log.md).
