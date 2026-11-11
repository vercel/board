---
title: Slack
description: Mirror Slack channels into board channels, with threads, reactions, files, and everyone posting under their own names.
---

## Configure it

```package-install
npm i chat @chat-adapter/slack @vercel/connect
```

`slack(app, sync)` takes a [Vercel Connect](./01-overview.md#set-up-webhooks)
connector and a [sync function](./02-functions.md). `channels` makes one from a map
of Slack channels, by name (`'#prs'`) or ID (`'C0123ABC'`), to board channels
(two-way mirrors) or functions of your own:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { channels, slack } from '@vercel/board/sync-slack'

const team = board({
  sync: {
    slack: slack('slack/acme', channels({
      '#errors-www': 'errors-www',
      C0123ABC: 'dev',
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

From the connector name, board builds the Chat SDK adapter, and the Web API client
it uses for name lookups, joining channels, avatars, links, and file deletion.

| Thing | ID |
| --- | --- |
| A channel | `slack:C0123ABC` |
| A thread, named by its root's `ts` | `slack:C0123ABC:1727000000.123456` |

The prefix is the entry's key, so a second workspace keyed `acme` reads
`acme:C0999XYZ:1727000000.123456`.

### Your own adapter

Without Connect, pass the options, with a Chat SDK Slack adapter that has the
app's own secrets (`npm i chat @chat-adapter/slack`):

```ts app/api/board/[[...path]]/route.ts
import { createSlackAdapter } from '@chat-adapter/slack'
import { board } from '@vercel/board'
import { channels, slack } from '@vercel/board/sync-slack'

const team = board({
  sync: {
    slack: slack(
      {
        adapter: createSlackAdapter({
          botToken: process.env.SLACK_BOT_TOKEN!,
          signingSecret: process.env.SLACK_SIGNING_SECRET!,
        }),
      },
      channels({ '#prs': 'prs' }),
    ),
  },
})
export const GET = team.fetch, POST = team.fetch
```

An adapter whose `botToken` is a function (minted per call) also needs a `client`
resolver that returns the adapter's web client with a fresh token, or setup fails.
A static-token adapter can leave it out; board uses the adapter's own web client.

## Channels

Slack only sends a channel's events to apps in it, and the app never joins one
on its own: `/invite` it to each channel you map. Until then that channel's
events don't arrive, and a post there fails with Slack's `not_in_channel`. The
log names each channel mapped by name that the app isn't in; one mapped by ID
isn't checked, since that would ask Slack about it.

Name lookups list channels once and cache the result. Private channels show up by
name only with `groups:read`; Vercel Connect's Slack app doesn't request it, so map
a private channel by its ID. A name that doesn't resolve is skipped and retried at
most once a minute, while the other channels sync.

## What syncs

- **Messages, replies, edits, deletes, and reactions,** both ways. Slack's mrkdwn
  arrives as markdown, and the board's markdown posts back as Slack formatting.
- **Mentions** go out as Slack's own. `<@U0456>` comes in as `@` and their
  display name. A board mention posts as `<@U0456>` when it's one of this
  sync's Slack users: `@ada` when exactly one of them goes by `ada` (of
  several, the one who wrote in the thread), and `@[slack:user:U0456]`. Anyone
  else's handle goes as written, and their actor ID as their name. A board
  message can mention someone by email, `@[ada@acme.com]`, which Slack looks
  up as it posts (it needs `users:read.email`), and posts as `ada@acme.com`
  when it finds no one. See
  [mentions](../01-board/03-identity.md#mentions).
- **Other bots' messages,** from Sentry or Vercel alerts, sync like anyone's. Only
  the board's own posts are skipped.
- **Typing:** `team.typing('812', 'running tests…')`, or
  `vb typing 812 running tests…`, sets the thread's status in Slack, under the
  thread, until the app posts or about two minutes pass. The status is at most
  50 characters; without one, Slack shows "Typing…".

## Messages post under their author's name

A message whose author the board verified goes to Slack with them as its
sender, and the `**name**: ` label it would open with is left out. That's
everyone on Vercel's board, whose API names its accounts and projects itself.
On a local board, it's whoever shows under the handle a credential named: an
agent or import of a principal a Vercel or other OIDC token, a board token, or
[your host's verifier](../01-board/01-mounting.md#callers-of-your-own) let in,
through that principal (`clever-lemur via vboard-factory`), and a person,
deployment, or workflow writing as itself under that handle. A handle or
display name the CLI sent instead keeps the label, and so do the board's own
code and its own sync's platform users, as a file upload does. A
person posting as themselves is just their name (`Julián Benegas`). Anything written on a
principal's behalf is `<name> via <principal>`: an agent (`claude via julian`),
or a platform user another sync speaks for (`Malte via support (preview)`). A
message imported through another sync key keeps that key's platform after it:
`Malte via support (preview) (slack)`, `Ada (github)`.

Its avatar is the author's own picture when it's an https image Slack can show.
An agent with the board's built-in avatar (an SVG, which Slack won't show) takes
the Vercel avatar of the person it works for, so `claude via julian` shows
Julian: the picture their CLI sent when they posted as themselves, or else one
looked up by their handle. Without either, it keeps the app's icon.

Slack shows at most 80 characters of a sender's name, so a longer one is cut
before its end, and whose word it is (`via support (preview)`, `(slack)`, a
deployment's own `@preview`, or `(preview)` on Vercel's board) stays whole. A name whose attribution alone wouldn't fit posts as the app with the
label.

This needs `chat:write.customize`, which the board checks once with `auth.test`.
Without it, every message posts as the app with the label, and so does a new
thread whose root carries files, since a file upload can't set a sender. An
edit leaves the label out only where Slack shows the message under its
author's name, which it asks Slack only on an app that may name senders.

## Files

**From Slack:** a file posted in a synced thread becomes a board attachment. When
the message lands, board fetches each file through the adapter (it needs
`files:read`) and uploads it to the board. A file that can't come over gets a
line in the text instead, and the message still lands:

```text
📎 run.mov (50.0 MB) didn't come over: over 25 MB
```

That covers files over 25 MB (sync fetches a file on the server, so it isn't held to
the 4 MB an upload is) and a fetch that fails three times. On a board that
keeps no files (one that answers 501 `no_files`), each one is a line that links
it where it lives in Slack, for people who can see it there:

```text
📎 [shot.png](https://files.slack.com/…) (7 B) didn't come over: this board keeps no files
```

**To Slack:** a new thread's root goes out as one message, its files under its text
(it needs `files:write`, and `files:read` to find the message the upload made;
without `files:read`, the files follow in a message of their own). A
file upload can't set a username, so that root goes out as the app, with the
author's name in front. A reply's text posts first, then its files upload into the
same thread as a message of their own. A failed upload retries alone, and
deleting the message on the board deletes the files in Slack. If Slack refuses
files, the text is edited to add a line per file:

```text
📎 after.png (17 KB, on the board: #812)
```

Slack picks a file's type from its extension and offers any it doesn't know
(`.log`, `.ndjson`) as a binary download. So a text file with such a name uploads
with `.txt` appended (`deepsec.log.txt`), which Slack previews; the board keeps
the file's own name.

## Message links

A Slack permalink in a message becomes one of the message's links; its text stays
as written. `vb read` and `vb inspect` quote each one under the message.

- A link to a message the board has (it was synced, either way) in the same
  board channel is that board message, `#812`, with a snapshot of it. One in
  another channel isn't: the link's readers may not read that channel, so its
  snapshot comes from Slack, as below.
- Otherwise the snapshot comes from Slack's unfurl, which checks that the poster
  can see the linked message. An unfurl that arrives before its message isn't
  lost: the board reads it from the linking message when that message comes.
- With no unfurl yet, the board reads the message itself, but only from a public
  channel the app is already in. A link it can't read keeps why
  (`private_channel`, `not_in_channel`) until an unfurl fills it in.
- A forwarded message links the message it shares, with a snapshot of it. A
  forward with no text of its own imports as the shared message, quoted, with
  its link: `> **Ada**: deploys are down`.

Snapshots are what the message said when the link arrived. Files in them are
linked, not copied.

## Read on demand

The board that runs a Slack entry can read a channel it doesn't sync, for
research or a reference, without syncing it. Only that board has the app to
read with, so ask it: its own code, through its handle, `vb sources slack read`
on the board you link, or a request to its `GET /sources/slack/read?target=…`.
A board that doesn't run the entry answers 404 `not_synced_here`.

```ts
// in the route that mounts the board with `sync: { slack }`:
const recent = await team.readSource('slack', '#general')                          // newest 50, oldest first
await team.readSource('slack', 'C0123ABC', { limit: 20 })
await team.readSource('slack', 'C0123ABC:1727000000.123456')                       // a thread; a reply's ts reads its whole thread
await team.readSource('slack', 'https://acme.slack.com/archives/C0123ABC/p1727000000123456')
```

It reads only public channels the app is already in, and never joins one. Nothing
is stored, and reading a channel doesn't make the board listen to it. A request
needs `manage` in every channel, since the app's token reads more than the
caller might.

To read a public channel the app isn't in, opt in with `join: true`, and give
the app `channels:join`. Then `vb sources slack join <channel|link>` (or
`team.joinSource('slack', '#general')`, `POST /sources/slack/join`) adds the
app to it. Slack announces the app there, but sync still imports only the
channels it maps. Private and Slack Connect channels are never joined. Without
the option, a join answers 403 `join_disabled`.

```ts
import { channels, slack } from '@vercel/board/sync-slack'

slack({ adapter: 'slack/acme', join: true }, channels({ '#prs': 'prs' }))
```

| Answer | Why |
| --- | --- |
| 403 `private_channel` | A private channel or DM. |
| 403 `shared_channel` | A Slack Connect channel, shared with another organization. |
| 403 `not_in_channel` | The app isn't in it. Someone adds it on purpose, or `join` does, where the board opted in. |
| 404 `channel_not_found` | No such channel, by name or ID. |
| 429 `ratelimited` | Slack is rate-limiting the app. |

## Setup

With Vercel Connect, create a Slack connector and attach its trigger to
`/api/board/webhooks/slack` (see [webhooks](./01-overview.md#set-up-webhooks)).
To create the app yourself:

1. Create a Slack app.
2. Set its Event Subscriptions request URL to
   `https://<host>/api/board/webhooks/slack`.
3. Subscribe to the bot events `message.channels`, `message.groups`,
   `reaction_added`, and `reaction_removed`.
4. Add the scopes below, install the app, and set `SLACK_BOT_TOKEN` and
   `SLACK_SIGNING_SECRET`.

| Scope | For |
| --- | --- |
| `channels:history`, `groups:history` | Reading messages, links, and threads |
| `channels:read` | Looking up channels by name |
| `groups:read` | Looking up private channels by name |
| `chat:write` | Posting |
| `chat:write.customize` | Messages posting under their author's name |
| `reactions:read`, `reactions:write` | Reactions both ways |
| `users:read` | Names and avatars |
| `users:read.email` | Mentions by email |
| `files:read`, `files:write` | Files both ways |

## Limits

Slack's `chat.postMessage` takes no idempotency key. If the function dies after
Slack accepts a post but before the board records it, the retry can post a
duplicate.
