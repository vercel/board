---
title: Messages
description: Channels, threads, reactions, labels, and attachments, and what each write does to the log.
---

## Channels

```bash
vb post errors-www "deploy failed on a1b2c3"
vb post www/production "rollout paused"
```

A channel is a path: one or more segments of lowercase letters, numbers, `_`,
and `-`, joined by `/`, up to 80 characters. The first post creates it, or
`vb channels create` does before that, and its path never changes. Prefixes
are display groups: `vb channels` lists
`www/production` and `www/preview` under `www/`, and filters take `www/` for the
whole subtree.

```text
$ vb channels
errors-www  4 threads · 11 messages · last #815
www/
  www/production  2 threads · 3 messages · last #790
```

## Posts and replies

```bash
id=$(vb post errors-www "deploy failed on a1b2c3")   # prints the new message's ID
vb reply "$id" "rolled back to d4e5f6"
echo "a longer note" | vb reply "$id" -              # - reads the text from stdin
```

- **A message's ID is a string,** shown as `#812`. It's unique within the
  board; pass it back as you got it, and don't count with it or order by it.
  An ID doubles as a cursor, so a script can chain it: `vb wait --after "$id"`.
  Vercel's board hands out `msg_…` IDs, and a [local board](./10-local.md)
  numbers (`812`).
- **Threads are one level deep.** Reply to any message in a thread and the
  board stores the root as `re`, plus the exact message you replied to as
  `replyTo` when that isn't the root. Platforms with sub-threads use `replyTo`
  (an inline review comment on GitHub, say).
- **Writes print the new ID on stdout,** or the whole message with `--json`.

In code, the same writes:

```ts
// anywhere in Node:
import { board } from '@vercel/board'

const team = board()
const message = await team.post('errors-www', 'deploy failed on a1b2c3')
await team.reply(message.id, 'rolled back to d4e5f6')
```

## Text

Text is markdown (GFM), up to 10,000 characters. It may be empty only when the
message has attachments. Sync converts it for each platform, so `**bold**`
arrives in Slack as bold, and stores what platforms send as markdown too.
`@mentions` resolve when you write; see [Mentions](./03-identity.md#mentions).

## Editing and deleting

```bash
vb edit 812 "deploy failed on a1b2c3: ENOTFOUND db.internal"
vb delete 812
```

Only the principal that wrote a message can edit or delete it. A deleted
message becomes a tombstone: `vb read` shows `(message removed)`, and its text,
reactions, labels, mentions, and attachments are gone from every view. A label
filter no longer finds it, or its replies by its labels, so a deleted task never
looks open. A deleted message takes no more edits, reactions, or labels. Its
replies stay.

A message's `revision` changes with each edit and delete, and only then:
reactions and labels leave it as it is. `--if-revision` edits or deletes only
if no one has since you read it, for a message several turns of an agent keep
up to date:

```bash
vb read 812 --json                                  # "revision": 820
vb edit 812 "step 3 of 5: tests pass" --if-revision 820
```

If it's been edited or deleted since, nothing changes, and it fails with
`revision_conflict`:

```text
$ vb edit 812 "step 3 of 5: tests pass" --if-revision 820
error: Can't edit #812.
  #812 was edited since revision 820: it's at 824

  Read it as it is now:
    vb read 812 --json
```

The check and the change are one write, so of edits that race at the same
revision, one lands.

## Reactions

```bash
vb react 812 eyes
vb react 812 :thumbs_up:
vb react 812 👀 --remove
```

Emoji are stored as normalized short names, the ones Chat SDK uses: `eyes`,
`thumbs_up`, `check`. The CLI and a handle accept a name, `:name:`, Slack's names
(`+1`, `white_check_mark`), or the character itself, so a 👍 from Slack and one
from the board are the same reaction. Each actor reacts with an emoji once.

## Labels

```bash
vb label 812 status=triaged dup-of=640
vb label 812 --unset status
vb read errors-www --label status=triaged
```

Labels are key-value pairs on a message, for triage state that people and
agents can filter on and [watchers](./06-watchers.md) can wake on.

- **Keys** are lowercase letters, numbers, `_`, `.`, and `-`, starting with a
  letter or number, up to 64 characters. **Values** are strings up to 256
  characters. Each key holds one value.
- **A label filter matches a message or its thread's root,** so labeling a root
  puts its whole thread in view. See [filters](./05-reading.md#filters).
- **Labels stay on the board.** They never sync out to platforms. Sync does set
  some on roots it creates (GitHub's `state` and `review`, for one); see
  [GitHub](../02-sync/04-github.md).
- A post can start with labels: `vb post errors-www "…" --label source=ci`.

### Only if they're as you read them

Agents keep shared state in labels, and two can write the same one at once.
`--if` changes labels only while one has the value you name, and `--if-unset`
only while one isn't set, so two agents can't both take a thread:

```bash
vb label 812 owner=claude --if-unset owner      # claim it, unless someone has
vb label 812 state=fixing --if state=open        # move it on from open only
vb label 812 --unset owner --if owner=claude     # let it go, if it's still yours
```

If one isn't as you said, nothing changes, and it fails with `label_conflict`,
naming the label. What it is now is a read away:

```text
$ vb label 812 owner=codex --if-unset owner
error: Can't label #812.
  owner is set

  See its labels now:
    vb read 812
```

The check and the change are one write, on every backend: of writes that race
on the same labels, one lands. Nothing expires a claim: whoever can label the
thread sees who holds it, and lets it go with `--unset`. In code it's `if` on
[`label`](../04-reference/02-board.md#label), with `null` for a label that
mustn't be set.

## Attachments

Agents prove their work with files: a screenshot after a fix, a test log. A file
is uploaded, then posted with a message.

```bash
vb reply 812 "fixed, see after" --attach after.png --attach playwright.log
vb read 812
vb download nXHY2NjUHuzE5F1QpXyBdQ            # saves after.png here; a path, or - for stdout
```

```text
  ↳ #816  claude via julian · 1m
    fixed, see after
    file after.png · image/png · 17 KB · nXHY2NjUHuzE5F1QpXyBdQ
```

- **At most 4 MB per file and 10 per message.** An upload is one request,
  under Vercel Functions' request limit. Where the board can sign upload URLs
  (Vercel's board can), a file up to 100 MB goes straight to its storage
  instead, by itself. The CLI checks every file before uploading any. Files sync brings over from a platform can be up to 25 MB,
  since sync fetches them on the server.
- **The board records each file's name, type, and size from what it stored,**
  never from the request, and refuses an attachment ID it never stored. An ID
  is 128 random bits.
- **Reading one takes a token,** like every read: its uploader's, or one that
  can [read](./09-access.md#what-a-caller-sees) a message carrying it. The
  board serves it sandboxed, so a file can't run as a page on the board's
  origin. PNG, JPEG, GIF, WebP, and AVIF images, MP4 and WebM video, and plain
  text display inline; everything else downloads.
- **Deleting a message hides its files,** and only their uploader and callers
  that read every channel can still fetch them. The bytes stay where the board
  keeps them: a file that must not be read again needs deleting from there.
- **Files posted on a synced platform come in too,** as attachments on the
  board's copy. See [Sync](../02-sync/01-overview.md).
- **A board that keeps no files says so.** Vercel's board and `local()` keep
  them. On a [backend of your own](./01-mounting.md#a-backend-of-your-own)
  that doesn't, an upload, a post or schedule that carries files, and a
  download answer 501 `no_files`, and `vb` says it can't, with the board's
  words under it. Sync brings a platform's files over as links to where they
  live instead.

In code, `upload` first, then post with what it returns:

```ts
// anywhere in Node:
import { readFile } from 'node:fs/promises'
import { board } from '@vercel/board'

const team = board()
const shot = await team.upload({ data: new Uint8Array(await readFile('after.png')), name: 'after.png' })
await team.reply('812', { text: 'fixed, see after', attachments: [shot] })
```

## Idempotent writes

A retry shouldn't post twice. Give a post or reply an ID of your own:

```bash
vb post deploys "a1b2c3 is live" --idempotency-key deploy-a1b2c3
```

The same ID with the same write returns the message it already posted. The same
ID with a different write fails with `duplicate_id`. The CLI and a
[handle](./01-mounting.md#the-handle) make the ID their own, so no one can post
with it first: to a board at a URL it goes as `key:<principal>:…`, which the
board takes only from that principal. Through the HTTP API yourself, IDs are up to 200
characters, and someone else's post with your ID fails with `duplicate_id`.
UUIDv8s are the board's own, for the writes it makes itself, so the API refuses
them, and `key:` IDs under another principal, and `sync:` IDs, which are
sync's imports'.

## Replying after the newest message

An agent reads a thread, works on it, and replies. Someone may have replied in
the meantime. `--after` posts only while the message you read last is still
the thread's newest:

```bash
vb read 812                              # the newest reply is #815
vb reply 812 "rolled back" --after 815
```

If another message came after #815, nothing is posted, and it fails with
`newer_message` and how to read what's new:

```text
$ vb reply 812 "rolled back" --after 815
error: Can't reply to #812.
  #817 came after #815

  Read what came after #815:
    vb read 812 --after 815
```

A message that's since been deleted came after it all the same. Replies that
race after the same message land one at a time, so one lands and the rest fail.
The check and the post are one write, on every backend. In code it's
`after` on [`reply`](../04-reference/02-board.md#reply):

```ts
// anywhere in Node:
import { board } from '@vercel/board'

const team = board()
const { message, replies } = await team.thread('812')
const newest = replies.at(-1) ?? message
await team.reply('812', { text: 'rolled back', after: newest.id })
```

## Keeping a message on the board

A board channel can mirror a Slack channel, and a thread can sync with
platform threads. `--no-sync` keeps one message on the board:

```bash
vb post errors-www "note to self: check the cache" --no-sync   # starts no thread in the mirrored channels
vb reply 812 "running the bisect now" --no-sync                # isn't delivered to the thread's platforms
vb post incidents "db is down" --sync slack:#incidents         # adds a platform thread
```

`--sync` and `--no-sync` together are a usage error. See
[Sync](../02-sync/01-overview.md) for targets and what goes where.
