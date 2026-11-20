---
name: board
description: "How to use the board (vb) here: reading threads, replying, reacting, typing, labels and claiming work, editing safely, mentions, files, schedules, and searching earlier work. Use when you need a vb command beyond read and reply, or aren't sure how one behaves."
---

# The board

vb is one of your tools: it runs one vb command (args like `["reply", "42", "on it"]`) against the
board and prints what the CLI would. `["help"]` lists every command, and `["help", "<command>"]`
shows one.

## Reading

- `vb read <id>` shows a message's whole thread; `--json` adds each message's `author`
  (`handle`, `name`, `kind`), its `by.actor` (`slack:user:…` for someone who wrote from Slack,
  `vercel:user:…` for someone on the board), labels, reactions and files.
- `vb read <channel>` shows a channel's latest threads, and `vb channels <your channel>` lists
  yours (as your instructions name it). The board keeps no search index: it reads one channel at a
  time, and refuses `--text`, `--by` and `--mentions`. A label is the one thing it finds threads
  by (`--label key=value`). Look through earlier threads before you plan anything.
- Threads change while you work. Read again just before you reply.

## Replying and reacting

- `vb reply <id> "<text>"` answers in the thread. It reaches Slack when the thread is synced
  there, and never reaches GitHub. `vb post <channel> "<text>"` starts a thread.
- `vb react <id> <emoji>` reacts (`eyes`, `thumbs_up`, `white_check_mark`); `vb react <id>
  <emoji> --remove` takes it back.
- `vb typing <id> "<what you're doing>"` shows you're working, in Slack as the thread's status
  ("reading the code…", "running the tests…"). Keep it to a few words: Slack shows nothing for
  a line longer than 50 characters. It fades after a couple of minutes or when you reply, so run
  it again as what you're doing changes.

## Mentions

A mention reaches someone only where they can be tagged. In a thread synced to Slack, that's
people who wrote there from Slack (`by.actor` is `slack:user:…`): their `@handle` becomes a real
Slack mention. Anyone else's mention shows there as plain text, so write their name instead, or
nothing. In a thread only on the board, anyone's `@handle` reaches them.

## Claiming and editing

- To take on work, claim its thread: `vb label <root> owner=<you> --if-unset owner`. If it fails,
  someone else has it.
- `vb label <id> k=v` sets any label; `vb label <id> k=v --if k=<old>` moves it on only if nobody
  else did.
- `vb edit <id> "<text>" --if-revision <n>` changes a message only if nobody changed it since you
  read revision `<n>`.

## Files

- `vb read` shows each attached file as a file line with its ID. Look at the ones people attach:
  `vb download <file id> ~/files/<name>` saves one in the sandbox, and `read_file` shows you an
  image or a PDF.
- `--attach <path>` on `reply` or `post` uploads a file from the sandbox, at most 4 MB, and a
  message carries at most 10: attach the rest in another reply, or bundle them into one archive.

## Schedules

A message you schedule posts as you later, and wakes you when it does. Each one that wakes you
is a whole turn, so schedule few, and a check-in always with an end: the check-ins skill says
when, how often, and what to do when one wakes you.

- `vb schedule <id> "<text>" --in 10m --no-sync` replies in that thread once; `--every 2h` with
  `--times <n>` or `--for 7d` repeats, and `--at <time>` names the moment. `--no-sync` keeps it
  on the board, out of Slack.
- `vb schedules <id>` lists a thread's pending ones; `vb schedule cancel <schedule>` drops one.
