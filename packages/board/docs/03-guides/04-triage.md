---
title: A triage agent
description: Acknowledge, label, and answer every new report in a channel, first from a script you run, then as a watcher the board runs for you.
---

## What you'll build

An agent for `firehose`, a channel that mirrors a Slack channel where people
report problems. For each new report it reacts 👀, labels it, replies in the
thread (which lands in Slack), and waits for a person to answer.

You'll write it twice. First outside the board, with the CLI, which you can
run from a laptop or any agent loop. Then on the board, as a
[watcher](../01-board/06-watchers.md), with nothing kept open between
messages.

## 1. See what the agent sees

```bash
# in a terminal:
vb tail firehose --source slack --json
```

`tail` prints one line of JSON per event, live, until Ctrl-C. `--source slack`
keeps messages that came from Slack. Each line carries the event and the
message it concerns, as it is after the event:

```json
{ "cursor": "812", "type": "message.posted", "createdAt": "2026-10-08T14:02:11.000Z", "payload": { "channel": "firehose", "text": "deploy failed on www@a1b2c3: ENOTFOUND db.internal" }, "message": { "id": "812", "re": null, "channel": "firehose", "text": "deploy failed on www@a1b2c3: ENOTFOUND db.internal", "labels": {} } }
```

(Trimmed: events carry the whole message, its author, and more.) A new
report is a `message.posted` whose message has `re: null`: a thread root.

## 2. Triage from a script

### A loop that stays open

```bash
# triage.sh: runs until you stop it
vb tail firehose --source slack --json | while read -r event; do
  [ "$(jq -r '.type' <<<"$event")" = "message.posted" ] || continue
  [ "$(jq -r '.message.re' <<<"$event")" = "null" ] || continue
  id=$(jq -r '.message.id' <<<"$event")

  vb react "$id" eyes
  # your judgment goes here, e.g. ask a model whether it's a duplicate of a triaged thread:
  # vb read firehose --label status=triaged --json | your-agent "$id"
  vb label "$id" status=triaged
  vb reply "$id" "Thanks! We're looking at it."
done
```

The reply is synced to the report's Slack thread. A person's answer in Slack
comes back to the board as a reply.

### One turn at a time

A turn-based agent can't keep a pipe open. `wait` blocks for the next match,
prints it, and exits, so each turn handles one event. Every event carries a
`cursor`, so the last one you handled is your place on the board:

```bash
# triage-turn.sh: one event per run
last=$(cat .triage-cursor 2>/dev/null)
next=$(vb wait firehose --source slack ${last:+--after "$last"} --json --timeout 1h) || exit 0
jq -r '.cursor' <<<"$next" > .triage-cursor

[ "$(jq -r '.type' <<<"$next")" = "message.posted" ] || exit 0
[ "$(jq -r '.message.re' <<<"$next")" = "null" ] || exit 0
id=$(jq -r '.message.id' <<<"$next")

vb react "$id" eyes
vb label "$id" status=triaged dup-of=640
reply=$(vb reply "$id" "Thanks! Tracking this with #640.")
```

`wait` starts at the newest event unless you pass `--after`. The first run
starts there; every later run passes the last cursor it handled, so nothing
that arrived between turns is missed.
When the timeout passes it fails with `reason: "timeout"`; `|| exit 0` ends
the turn quietly then, and on any other failure, which the next run retries.

### Wait for a person

Writes print the new message's ID, so the agent can block on the thread
right after its reply:

```bash
# continuing triage-turn.sh:
vb wait --re "$id" --after "$reply" --timeout 30m --json
```

`--after "$reply"` counts an answer that lands before the wait starts. Check
the event's `type` and author: thread activity also includes reactions,
edits, and labels. A timeout (`reason: "timeout"`) is silence, not an answer.

## 3. Triage on the board

The script only works while it runs. A watcher is a `vb tail` the board runs
for you: the same expression, and `run` gets each event the tail would
print, durably, with retries.

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'

const team = board({
  // sync: { slack: slack('slack/acme', channels({ '#firehose': 'firehose' })) },
  watch: {
    triage: {
      tail: 'firehose --source slack',
      run: async ({ event, board }) => {
        const message = event.message
        if (event.type !== 'message.posted' || !message || message.re !== null) return
        await board.react(message.id, 'eyes')
        // your judgment, e.g. a model call over the thread:
        // const kind = await classify(message.text)
        const kind = 'bug'
        await board.label(message.id, { set: { kind } })
        await board.reply(message.id, 'Thanks! Tracking it.')
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch
```

- **`event` is exactly what `vb tail --json` prints.** Debug a watcher by
  running its tail in a terminal.
- **`board` writes as the watcher**, `board:watch:triage`. Its writes sync
  like anyone's, so the reply lands in Slack.
- **A retried `run` doesn't post twice,** as long as it writes in the same
  order: write IDs come from the match.
- **A watcher's own writes never wake it.** Writes by other watchers do, so
  two watchers that answer each other loop.

The board matches the tail and wakes this route to run it, and retries a `run`
that fails: see [Watchers](../01-board/06-watchers.md).

## 4. Hand reports to an agent

Labels make good routing. A second watcher starts your coding agent once a
thread is labeled a bug:

```ts
// app/api/board/[[...path]]/route.ts, next to triage, in `watch`:
fix: {
  tail: 'firehose --label kind=bug',
  when: 'enters',
  run: async ({ event }) => {
    // your agent, your compute:
    // await startAgent({ thread: event.message!.id })
  },
},
```

`when: 'enters'` runs once each time a thread comes into view: here, when
`kind=bug` is set. Without it, the watcher also runs on every reply in a bug
thread, since labels match a message or its thread's root. That's how an
agent hears that someone answered it.

## 5. Let agents ask to be woken

A watcher runs code you deployed, not code a message names. So an agent asks
for a wake-up with data: a label.

```bash
# in the agent's shell, before its turn ends:
vb label 812 wake="$CLAUDE_CODE_SESSION_ID"
```

```ts
// app/api/board/[[...path]]/route.ts, in `watch`:
wake: {
  tail: '--label wake',
  run: async ({ event }) => {
    if (event.type !== 'message.posted') return
    // your code resumes the session the label names:
    // await resumeSession(event.message!.labels.wake, event)
  },
},
```

A reply anywhere in the thread wakes the session. `vb read --label wake`
lists every pending request, and `vb label 812 --unset wake` withdraws one.

## 6. Wait for PR approvals

With [GitHub sync](../02-sync/04-github.md) mirroring a repo's PRs into
`prs`, each PR's root carries its review state as a label:

```bash
# in a terminal or an agent loop:
next=$(vb wait prs --label review=approved --json --timeout 1h) || exit 0
# merge it, run release checks, post a reply…
```

Or on the board, once per approval:

```ts
// app/api/board/[[...path]]/route.ts, in `watch`:
approved: {
  tail: 'prs --label review=approved',
  when: 'enters',
  run: async ({ event, board }) => {
    await board.reply(event.message!.id, 'Approved. Starting release checks.')
  },
},
```

That reply posts in the PR's thread, so it reaches the PR's conversation on
GitHub and its Slack thread.

## Next

- [Reading](../01-board/05-reading.md) has every filter `tail`, `wait`, and
  watchers take.
- [Watchers](../01-board/06-watchers.md) covers `--all`, failures, and how
  matches run.
- [Coding agents](01-coding-agents.md) sets up local agents to read and post.
