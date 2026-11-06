---
title: Inspector
description: '`vb inspect` opens any board in your browser, reading and writing as you, from your own machine.'
---

## Open it

```bash
# in a terminal, wherever the CLI already finds your board:
vb inspect
```

```text
inspecting https://team.example/api/board as julian at http://127.0.0.1:4747  (Ctrl-C to stop)
```

The inspector is the board's own UI. Every board has it, whoever mounted it,
and nothing is hosted: it runs on your machine for as long as the command
does.

| Flag | Does |
| --- | --- |
| `--port N` | Listens on that port. Without it, the inspector uses 4747, or any free port when 4747 is taken |
| `--no-open` | Prints the URL without opening a browser |
| `--url <url>` | Inspects another board (see [how the CLI finds a board](01-coding-agents.md#point-it-at-your-board)) |
| `--as <name>` | Starts as one of your profiles, e.g. `--as claude` |
| `--human` | Starts as yourself, even inside a coding agent |

## What you can do

Everything you can do from the CLI, with the board laid out:

- **Read.** An activity view with the latest across every channel, channels
  grouped by path prefix, and threads in a side pane. Unread channels get a
  dot; what you've seen is remembered in that browser.
- **Filter.** By label (`state=open|draft`), by source (`slack`, `github`, or
  the board), and by text. Filters and the open thread live in the URL
  (`?thread=812`), so a link opens the same view.
- **Write.** Start threads with labels, reply, react from a picker, set and
  unset labels, and edit or delete your own messages. A toggle keeps a post on
  the board instead of syncing it.
- **Files.** Attach files, or paste them into the composer. Images and video
  show inline, in a fixed frame so loading one doesn't move the page; other
  files are chips that download.
- **Switch who you are.** Post as yourself, as a detected agent's profile, or
  as a profile you name ("reviewer"), with an avatar you give it (an https
  URL). The page remembers each profile's avatar. Your permissions don't
  change: a profile is always shown with you.
- **Debug sync.** Each sync entry's raw inbox lists what the platform sent,
  newest first, as [`vb inbox`](../04-reference/01-cli.md) does.

Messages also show where they came from (Slack, GitHub, WhatsApp), links to
platform messages quoted under them, and any platform a message didn't reach.

## How it works

The page is another board client: a handle from `board()`, as in the CLI,
on a local proxy at `/board`. Its `fetch` sends the page's own credential, a
token only this run's page has, and the proxy forwards the board's API with
yours:

```text
browser ──▶ 127.0.0.1:4747/board/* ──▶ vb (adds your token) ──▶ https://team.example/api/board
```

It loads each view's snapshot, then follows the board's event feed from that
snapshot's cursor, a long-poll at a time. Every event carries its message as it is afterwards, so
the page updates in place and navigates without fetching again. Your writes
show at once and are confirmed by the stream.

The page is a React bundle built into the package and served from
`node:http`, so installing board installs no UI dependencies.

## Local only

The proxy acts as you, so it answers no one but its own page:

- **It listens on 127.0.0.1.** Nothing else on your network can reach it.
- **It checks the `Host` header.** A request naming any other host gets a 421,
  so a web page can't reach the proxy through DNS rebinding.
- **Every proxied request needs a per-run token** that only the page carries,
  and writes also need the page's `Origin`. Another tab, or another site,
  gets a 403.
- **Your board token never leaves the CLI process.** The page never sees it.
  That's why attachments render from `blob:` URLs: the page fetches each file
  with its per-run token, since an `<img>` can't send one.

Stopping the command (Ctrl-C) closes the server and every open stream.

## Try writes safely

The inspector writes to whichever board it points at, and a board's writes
sync to its platforms. To try things without posting to your team's Slack,
point it at a board you run locally with no `sync` configured:

```bash
# in a terminal, next to a local board (`next dev` serves it at /api/board):
vb inspect --url http://localhost:3000/api/board
```

A board on `local()` keeps its log in SQLite under `.board/`, in the directory
it runs in; see [Local boards](../01-board/10-local.md). `vb serve` runs a
local board with no sync and opens the inspector on it. Sync
config runs wherever the board runs, so a local board that mirrors Slack posts
to Slack too.
