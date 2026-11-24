---
title: Overview
description: Connect board threads to Slack, GitHub, Linear, and any platform with a Chat SDK adapter, in both directions.
---

## How sync works

A board thread syncs with a set of external threads: a Slack thread, a GitHub PR,
a Linear issue. A message written in the thread, wherever it was written,
is delivered to every one of those external threads except the one it came from.
Replies, reactions, edits, and deletes follow the same path.

```text
inbound   Slack ─▶ /webhooks/slack ─▶ inbox ─▶ import ─▶ board: message.posted
outbound  vb reply ─▶ message.posted ─▶ sync ─▶ Slack ─▶ receipt: message.synced
attach    vb sync ─▶ receipt: thread.synced ─▶ sync ─▶ Slack (root + backfill)
```

Each platform takes one sync function, which board calls for every event in
both directions: it imports what comes in, and delivers what goes out. Helpers
build it from the platform's own things (Slack channels, GitHub repos, Linear
teams), each mapped to a board channel or to a function of your own.

Sync runs in `board()`, wherever the board lives. It keeps its records on the
backend through routes every backend answers: imports as platform authors,
delivery receipts, lookups by platform ID, and an inbox of platform events. So
it works the same on Vercel's board, on `local()`, and on a
[backend of your own](../01-board/01-mounting.md#a-backend-of-your-own).

On Vercel's board, the board can also run a sync for you, with no deployment:
Vercel's own events into a channel, or a Slack channel through Vercel's Slack
app. See [Syncs the board runs](./05-managed.md).

### With `BOARD_URL` set

Sync runs where the board's log is. `board()` with `BOARD_URL` set and `sync`
throws: configure sync on the board at that URL, or on Vercel's board.

## Configure it

Each entry under `sync` is one platform account, keyed by a name you choose:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { channels, slack } from '@vercel/board/sync-slack'
import { github, repos } from '@vercel/board/sync-github'

const team = board({
  sync: {
    // A Vercel Connect connector, and what each event does.
    slack: slack('slack/acme', channels({
      '#errors-www': 'errors-www',
      '#prs': 'prs',
    })),
    github: github('github/acme', repos({
      'acme/www': { pulls: 'prs', issues: 'issues' },
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

> [!NOTE]
> On Vercel's board, sync runs as this deployment's project, and Vercel's API
> keeps its records and wakes this route to retry what failed. A file posted on a
> platform comes over as an attachment on the board, uploaded as this project.

To pass your own Chat SDK adapter instead of a connector, see
[Slack](./03-slack.md#your-own-adapter) and [GitHub](./04-github.md#setup). Any
other Chat SDK adapter syncs through
[`chatSdk()`](./06-providers.md#any-chat-sdk-adapter).

## Sync functions

A platform's first argument is its app: a connector name, or the options
(`{ adapter, … }`). The second is its sync function. The helpers make one from a
map, where a string is a board channel:

| Helper | A string means |
| --- | --- |
| `channels({ '#prs': 'prs' })` (Slack) | `mirror('prs')`: a two-way mirror. What comes in lands in `prs`, and a root posted in `prs` starts a thread in #prs. |
| `repos({ 'acme/www': 'prs' })` (GitHub) | `into('prs')`: PRs and issues come in, and nothing goes back unless a function sends it. |
| `teams({ ENG: 'dev' })` (Linear) | `mirror('dev')`. |

A map's value can also be a function of your own, and the whole thing can be:
see [Sync functions](./02-functions.md).

**Entry keys** (`slack`, `github`, or `acme` for a second Slack workspace) are
names you choose; the adapter decides the platform. The key appears in external
IDs (`acme:C0999XYZ:1727.9`), in sync targets, in `--source` filters, and in the
webhook path (`/webhooks/acme`).

**Map keys** are the platform's names or IDs: `'#prs'` or `'C0123ABC'` for
Slack, `'owner/repo'` for GitHub, a team key (`'ENG'`) for Linear.

- Slack names resolve through one cached channel listing. IDs survive renames;
  a renamed channel stops matching by name on the next cold start.
- Each key resolves on its own. A channel that doesn't exist yet is logged and
  skipped, retried at most once a minute, and the rest sync. One Slack couldn't
  check (a failed listing) holds what it might be in; see
  [Helpers](./02-functions.md#helpers).

## The rules

1. **Delivery.** Every message, edit, delete, and reaction in a thread goes to
   the sync function once for each external thread it's synced with, except the
   one it came from, and `deliver()` sends it. Where a platform can't do
   something (GitHub typing), that delivery is skipped.
2. **Starting threads.** A root posted on the board, by anyone or any watcher,
   goes to the sync function of each platform that can start threads in a
   channel, which may `start` one; `mirror` does in its channel. Slack and
   Linear can; on Linear a root opens an issue. GitHub can't, so roots never
   open an issue there.
3. **Inbound.** A platform event goes to the sync function when its thread is
   already synced, or when its channel is one the helpers route (their keys;
   a function of your own at the top gets every channel). The function decides
   whether it lands. Everything else is
   dropped at the webhook, even in channels the bot belongs to.
4. **Threads start once,** when their root is posted, or when someone syncs
   them by hand. A deploy that changes a function changes what it does from
   then on: threads it started stay synced, and what reaches them is up to it.
5. **Attaching.** `vb sync <id> <target>` attaches an existing thread. A channel
   target gets the root and a backfill of every reply, in order. A thread target
   joins an existing external thread and receives only what's written after.
6. **Grouping.** Each adapter decides which board thread an external thread
   belongs to. GitHub's inline review threads land in their PR's thread.
7. **Reply targets.** A reply to a message that came from a platform sub-thread
   (a GitHub review thread) goes into that sub-thread there. Everywhere else it
   goes into the main thread as written. board adds no quote of the message it
   answers; to quote it, write the quote into the reply.

Board labels never sync out to platforms. Messages from other bots (Sentry,
Vercel alerts) sync like anyone's; only the board's own posts are skipped, so
nothing echoes.

## Who an import is by

A platform user is named under the sync key they came through, not the
platform: `slack:user:U0456` through key `slack`, `slack-eu:user:U0456` through a
key `slack-eu` for a second Slack workspace, shown with Slack's logo either way.
On `local()`, the board's own sync checks each platform webhook itself, so what
it imports is by the platform user: `slack:user:U0456`. Every other sync, a
project that registers one on the board and every sync on Vercel's board, only
says who wrote a message, so what it imports is by that project's profile of the
user, `<project>+<sync key>:<user>`, and shows through the project:

```text
$ vb read firehose
firehose · 2 threads · cursor 6

#2  Malte via support (preview) · 0s
      ship it, I checked
      no replies

#6  Ada · 0s
      the export page is blank
      no replies

new since then: vb read firehose --after 6
```

Each sync's Malte is an actor of its own, named only by that sync's imports. A
mention names one of them: support's Malte is `@support/malte`, stored as his
actor ID when it's written. It renders natively (`<@U0456>`) only through the
key he came through, and for a sync elsewhere's user only through that sync;
any other posts his name. Renaming a key changes its users' IDs. See
[platform users](../01-board/03-identity.md#platform-users).

## Each project's keys

On Vercel's board, a project's sync keys are its own. Support's `slack` and
www's `slack` are two keys on one board: each project imports and delivers
through its own, and an import through one reaches the other's Slack threads
like any message on the board, but never goes back through the key it came by.

Within a project, one deployment holds each key, so a message never goes out
twice. Production takes a key over from the project's previews and development;
otherwise the first deployment to register a key keeps it, though a preview
never takes a key the project's production held. A deployment that
doesn't hold a key runs nothing through it: its webhook for that key answers 200
before its adapter reads anything, and it pulls, imports, starts, and delivers
nothing there.
Its watchers run as usual. It says once who holds the key:

```text
[board] slack is synced by production
```

Another project's key reads `<project>/<key>`, by the name its deployments go
by on the board, or its ID where Vercel's API doesn't name it: in a message's
`from`, in `vb sync <id>`, and in `--source`, which takes either. A
deployment's own project's keys are bare, and a person sees each key under its
project:

```text
$ vb read general --source www/slack --json   # trimmed to text and from
{"text": "checkout is down", "from": "www/slack"}

$ vb sync 812
support/slack  C0123ABCDEF  message 1792780353.701549
www/slack      C0D2K4R7Q1M  message 1792780391.118204
```

Only the project's own sync links its copies, since it has the platform's app.

## Targets

A target is `<key>:<channel or thread>`. A channel target starts a new thread
there; a thread target joins one. Slack channels also resolve by name:

```bash
# in a terminal:
vb post incidents "checkout is down" --sync slack:#incidents   # start the thread in Slack too
vb sync 812 slack:#incidents                                   # escalate an existing thread, with its replies
vb sync 812 github:acme/www:123                                # join PR #123's conversation
```

`vb sync 812` with no target says where the thread is: each target, and the
platform's link to #812's copy there. `vb read <link>` goes the other way, from
a Slack permalink or a GitHub PR, issue, or comment to the board thread it's
synced with. Both answer from sync's records, never from the platform, and only
for messages you can read: a link to anything else is `no message on this board
for that link`. A handle has them as `board.sync(id)` and `board.linked(url)`.

```text
$ vb sync 812
slack   C0123ABCDEF  https://acme.slack.com/archives/C0123ABCDEF/p1792780353701549

$ vb read https://acme.slack.com/archives/C0123ABCDEF/p1792780353701549
#812  ada · 2h
      checkout is down
```

The links come from each provider: its `locate(url)` reads a link as the
platform's own IDs, and `url(thread, message)` makes one. A board with several
entries of one platform (two Slack workspaces, or a project's Slack sync
registered beside the team's) looks the IDs up under each of them, since any
may have synced it. See [Providers](./06-providers.md#links).

`--no-sync` keeps a message on the board: a root with it starts no threads in
mirrored channels, and a reply with it isn't delivered. `--sync` and `--no-sync`
together are a usage error. A handle's `post` takes `sync: [...]` and
`noSync: true`; see the [handle reference](../04-reference/02-board.md).

## Set up webhooks

Every entry gets its webhook route automatically: `/webhooks/<key>` under the
board's mount, e.g. `https://example.com/api/board/webhooks/slack`. A platform
can't send a credential the board verifies, so the adapter verifies the request
instead. The setup happens on the
platform, once per entry and deployment.

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
[GitHub](./04-github.md#setup),
[Linear](./07-linear.md#setup).

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

On the way in, the webhook stores each event in the inbox before it answers,
then sync imports it on the external thread's lane. If storing fails, the
webhook answers the platform with a 500 so it retries. On `local()`, a
[sync function](./02-functions.md) that keeps throwing is given up on after 10
tries, which holds up only that thread's lane in that channel's inbox. On
Vercel's board it's given up on after 5, a second after the first and doubling
to 30 seconds between tries.

## Typing

```ts
// anywhere with a handle on the board, the CLI included (`vb typing 812 running tests…`):
await team.typing('812', 'running tests…')
```

Shows typing in every platform thread the board thread is synced to, through
the sync the board that keeps the log runs beside it, so `vb typing` on the
board you link shows it there. Slack shows the status under the thread, and GitHub has no typing.
Nothing is written to the log. It needs `post` and `read` in the thread's channel.

## Debug it

```bash
# in a terminal:
vb sources                              # the board's sync entries and their platforms
vb inbox slack                          # raw platform events, newest first: did Slack send it?
vb inbox slack '#errors-www' --limit 5
vb tail --source slack --all              # board events from Slack, delivery receipts included
```

`vb inbox` needs `sync` in every channel for the board's own inbox, and every
registered sync's, since raw events span all of them. It shows a sync elsewhere
only what it pushed.
To read a channel the board doesn't sync, see [Read on demand](./03-slack.md#read-on-demand).
Raw events live in an inbox per external channel, apart from the board's
events, so they never reach a tail.
