---
name: check-ins
description: "Come back to what you left open, with messages you schedule: a deploy or a CI run, something you asked a person to do outside the board (an approval, a key, an install), something you said you'd do later. Says how often and for how long, what to do when one wakes you, and how to tell a thread that its news arrived somewhere else. Use before you end a turn with anything open, on every check-in that wakes you, on an app's message a thread may be waiting on, and when someone wants something on a repeat."
---

# Come back to what you left open

You only wake when a board message arrives. A deploy finishing, a person approving a request in a
dashboard, a key being added: none of those is a board message, so none of them wakes you. A
message you schedule does. It posts in the thread as you, later, and wakes you there.

## Before you end a turn

Something is open when the thread's people care how it ends, and its end won't be posted there:

- **Something that takes minutes:** a deploy, a CI run, a job you started.
- **Something you asked a person to do where you can't hear it happen:** approve a request, add a
  key or a permission, install an app, change a setting.
- **Something you said you'd do or look at later.**

A question you asked in the thread wakes you when it's answered. It's open only when the work
can't go on without the answer.

For each open thing, schedule its check-ins in that thread, then say in your reply, in a few
words, that you'll look again ("I'll check in a few minutes"). Nobody should have to come back
and tell you it's done.

```bash
vb schedule <id> "Check whether <what> happened: <how to tell>. Then <what's next>." --every 5m --times 3 --no-sync
```

- **Write it for a reader who remembers nothing:** what to check, how, and what comes next. By
  then this thread's session may be a new one.
- **`--no-sync` keeps it out of Slack.** A check-in is a note to yourself.
- **One set per open thing.** `vb schedules <id>` lists what's pending in the thread: don't add a
  second for the same thing.

## How often, and for how long

Each check-in is a whole turn of yours, and most find nothing. Ask for the fewest that still catch
it in time: often while it's likely to happen, rarely after that, and never without an end.

| Waiting on | Schedule |
| --- | --- |
| Minutes: a deploy, CI, a job | `--every 5m --times 4` |
| A person who's in the thread right now | `--every 5m --times 3`, and behind it `--in 1h --every 4h --times 3` |
| A person, whenever they get to it | `--in 1h`, and behind it `--in 1d --every 1d --times 3` |
| An answer the work can't go on without | `--in 1d`, once |
| A time you know: a retry on the 18th, a trial's end | `--at <that time>`, once |

These are where to start: go by how long this kind of thing takes here. A PR you opened has its
own, in the pr-lifecycle skill.

## When a check-in wakes you

Look at the thing itself, not the board: the service's API or CLI, `gh`, the deployment.

- **It happened:** do the next step if it's yours to do, say so in the thread in one line with
  what's next, and cancel what's still pending for it.
- **Not yet:** post nothing, and end your turn.
- **The last one, and still nothing:** say once where it stands and what it's waiting on, to
  whoever it's waiting on. Then leave it with them: schedule no more unless they ask. It's the
  last when `vb schedules <id>` shows nothing pending for it.
- **It no longer matters** (someone did it another way, the thread moved on): cancel what's
  pending.

```bash
vb schedules <id>               # what's pending in the thread
vb schedule cancel <schedule>   # each one that's settled
```

## When the news arrives somewhere else

Some of what you wait on does reach the board, in a thread of its own: an app's alert in a
mirrored Slack channel ("subscription canceled"), a PR's or an issue's thread from GitHub. Each
thread has its own session, so the you that picks it up doesn't know another thread was waiting
on it.

So before you answer an app's message, look for the thread waiting on what it names (the ID, the
email, the PR). The board keeps no search index: read the channels that thread would be in, one at
a time (`vb channels <your channel>` lists them).

When a thread was waiting on it, the news belongs there:

- **Reply in that thread** with what happened and what's next, as its check-in would have.
- **Cancel that thread's check-ins for it.**
- **On the app's message, leave a reaction, or one line that links that thread.** Whoever did it a
  minute ago doesn't need a report of it.

## On a repeat

A report or a sweep someone wants every morning, or every Monday:

```bash
vb schedule <channel> "<what to do, as a title>" --at <the first time, with its UTC offset> --every 1d
```

Each send starts a thread in that channel and wakes you there. These do reach Slack: people read
them.

- **Only what someone asked for.** When you think one would help, offer it, and schedule it on a
  yes.
- **One schedule per report.** `vb schedules --channel <channel>` shows what's already there.
- **At a time the team is around.** A send with nothing new says so in one line.
- **When nobody reads it any more, ask whether to stop it.**
