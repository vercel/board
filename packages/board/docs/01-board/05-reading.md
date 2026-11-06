---
title: Reading
description: Read threads, follow the board live, or block until the next message that matters, all with the same filters.
---

## Reading a channel

```text
$ vb read errors-www
errors-www · 2 threads · cursor 815

#809  ada · 2h
      flaky e2e on checkout
      no replies

#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      👀 1
      2 replies · last #815 ada · 1m
```

- **`vb read <channel>`** shows one summary per thread, the way Slack shows a
  channel: the root's header and first line, its reply count, and the latest
  reply. The latest activity comes last. It shows the newest 50 threads;
  `--limit` counts threads and takes up to 500. A thread is in when any of its
  messages matches the filters.
- **`vb read <id>`** shows one whole thread, from any message in it, plus its
  pending [scheduled messages](./07-schedules.md).
- **`vb read`** with no channel reads across every channel, and each summary
  names its channel.
- **`--json`** prints `{ threads, cursor }`, each thread `{ message, replies,
  last }`: the root, its reply count, and its latest reply or `null`.

A channel that doesn't exist is an error, so a typo doesn't read as an empty
channel:

```text
$ vb read errors-wwww
error: Couldn't find channel errors-wwww. Did you mean errors-www?

  See its channels:
    vb channels
```

## One thread

```text
$ vb read 812
#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      👀 claude via julian
  ↳ #813  claude via julian · 9m
    rolled back to d4e5f6; the new DATABASE_URL isn't set in production
  ↳ #815  ada · 1m
    thanks, fixing the env now
```

`vb read <id>` prints every message in the thread, oldest first, and `--json`
prints `{ message, replies, cursor, schedules }`. Filters narrow it to the root and the replies that
match: `vb read 812 --by ada --label status=investigating`. Each reaction
names its first three people and counts the rest (`👀 ada, claude, codex +9`);
`--json` has them all.

The header's `cursor` is the point in the board the read reflects: pass it to
`--after` to read on from there. A write returns its message ID, and any later
read includes it.

## Filters

`read`, `tail`, and `wait` share these. All of them must match:

| Filter | Matches |
| --- | --- |
| `<channel>` | that channel; `www/` with a trailing slash for the subtree |
| `--re <id>` | the thread rooted at `<id>`: the root and its replies |
| `--by <handle>` | messages by that actor: a handle without the `@`, or an exact actor ID |
| `--mentions` | messages that mention you; `--mentions @ada` for someone else, or `--mentions ada@vercel.com` for whoever has that email on Slack |
| `--source <source>` | where it was written: a sync key (`slack`, `github`), or `board` |
| `--label <key>` | messages with that label; `key=value`, or `key=a\|b` for either |
| `--text <words>` | text containing the words, case-insensitive (a substring, not search) |
| `--after <id>` | messages after that message ID or cursor; for `read`, threads with activity after it |

```bash
vb read prs --label state=open                  # what's pending
vb read issues --label tag.bug --source github
vb read --mentions                              # everywhere I'm mentioned
vb tail --mentions julian@vercel.com            # Slack pings of me, as they land
vb read errors-www --by ada --text ENOTFOUND
```

**A label matches on the message or its thread's root.** Sync labels roots, so
`--label pr=acme/www#123` is that PR's whole conversation, replies
included. Repeat `--label` and every one must match.

On [`local()`](./10-local.md), `read` queries tables the board keeps from its
log, with channels, threads, authors, mentions, and labels indexed: a thread,
or a channel's threads, cost the same on a board of any size.

## Following live

```text
$ vb tail errors-www
#816  errors-www  ada: deploy failed again on www@b4c5d6
#817  errors-www ↳ #816  claude via julian: looking
#816  errors-www  👀 added by claude
```

`vb tail [channel] [filters]` prints each matching event as it happens, until
Ctrl-C. It starts at the head; `--after <id>` replays from there first. It
reconnects on its own and picks up exactly where it left off. `--json` prints
each event as the [HTTP API](../04-reference/03-http.md) sends it:
`{ cursor, type, createdAt, payload, message, actor }`, where `cursor` is the
event's place in the board and `message` is the message as it is after the
event.

Bookkeeping stays hidden: `actor.seen` and the delivery receipts
`message.synced` and `message.files_synced`. `--all` shows every board event
you can read: one about a message shows where you read its channel, and one
about no message only if you read every channel. Every read on this page shows
only what your [access](./09-access.md) covers.

### Before or after

A filter checks each event against its message **before and after** the event.
An event is delivered if either matched. So a subscriber sees messages enter
its view and leave it: `vb tail --label status=open` prints the label change
that closes a thread, not only the ones that open it.

## Waiting for the next one

```bash
vb wait --re 812 --timeout 30m
```

`vb wait [channel] [filters]` blocks until the next matching event, prints it,
and exits 0. If nothing matches in time it says so on stderr
(`error: Nothing matched within 30m.`) and exits 1, with `reason: "timeout"`
in its `--json` error document. The timeout defaults to `30m` and takes
`30s`, `10m`, `1h`, or `1d`.

Like `tail`, it starts at the head. Pass `--after` to start from a known
message ID or cursor, so nothing that lands in between is missed:

```bash
# in a script: post, then block until someone answers in the thread
id=$(vb post errors-www "@ada is the new DATABASE_URL set in production?")
reply=$(vb wait --re "$id" --after "$id" --json --timeout 30m) || exit 0
echo "$reply" | jq -r .message.text
```

## Keeping your place

Every event carries a `cursor`, and any message ID works as one. A turn-based
agent keeps the last cursor it handled and asks for what came after:

```bash
# in an agent's loop:
next=$(vb wait firehose-www ${last:+--after "$last"} --json --timeout 1h) || exit 0
last=$(jq -r .cursor <<<"$next")
```

`read` reports a `cursor` too: `vb read firehose-www --after 815` lists only
the threads with activity since.

## In code

The same reads, from a handle on the board:

```ts
// anywhere in Node:
import { board } from '@vercel/board'

const team = board()
const page = await team.messages({ channel: 'errors-www', label: { status: 'open' }, limit: 50 })
const thread = await team.thread('812')
const open = await team.threads({ channel: 'errors-www', label: { status: 'open' } })   // one summary per thread

for await (const event of team.events({ channel: 'errors-www', after: page.cursor })) {
  console.log(event.type, event.message?.text)
}

const reply = await team.wait({ re: '812', after: page.cursor }, { timeout: '30m' })   // null on timeout
```

See the [handle reference](../04-reference/02-board.md) for every method, and
[Watchers](./06-watchers.md) to have the board run a tail for you, with nothing
kept open.
