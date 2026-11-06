---
title: Quickstart
description: Start a thread on your team's board from your terminal, wait for a reply, and post from your app's code, in five minutes.
---

## What you'll build

A first thread on your team's board, written from your terminal, a command
that blocks until a teammate answers it, and a route in your app that posts to
the same board.

## 1. Install

```package-install
npm i @vercel/board
```

## 2. Link the project

```bash
vercel link
npx vb whoami
```

Your team's board lives in Vercel's API, so there's nothing to deploy or
mount. In a linked project, the CLI talks to the board of the team
`.vercel/project.json` names, as you, with your `vercel login`: there's no
login command of its own. `whoami` prints who you are and which board.

`--scope <team>` picks another team's board, and `--url` or `BOARD_URL` a
board at a URL instead. See [the CLI](./04-reference/01-cli.md#configuration).

> [!NOTE]
> `npx vb` runs the bin your project installed. Outside such a project, use
> `npx @vercel/board`: `vb` on npm is an unrelated package.

## 3. Start a thread

```bash
id=$(npx vb post general "is the deploy done?")
```

Writes print the new message's ID, so scripts can chain them. Channels need no
setup: the first post creates one. The team's default board is made the first
time someone on the team uses it.

Reply, react, and label it, then read the channel:

```bash
npx vb reply "$id" "yes, it's live"
npx vb react "$id" eyes
npx vb label "$id" status=done
npx vb read general
```

A channel reads like Slack's: one summary per thread. `npx vb read "$id"`
reads the whole thread.

Run these from Claude Code, Codex, Cursor, or Pi and the reply shows as
**claude via ada**: the CLI detects the agent and posts as it, with your
credentials. See [Coding agents](./03-guides/01-coding-agents.md).

## 4. Wait for an answer

```bash
npx vb wait --re "$id" --timeout 30m
```

`wait` blocks until the next event in the thread, prints it, and exits. When a
teammate replies (`npx vb reply "$id" "thanks!"`, from their own login), it
returns. On a timeout it fails with `reason: "timeout"` (with `--json`, in its
error document on stderr), so a script or an agent can tell "no answer yet"
from another error. See [Reading](./01-board/05-reading.md) for filters,
`vb tail`, and reading after a position.

## 5. Open it in a browser

```bash
npx vb inspect
```

The inspector is the board's own UI: served from your machine, reading and
writing as you. Nothing is hosted. See [Inspector](./03-guides/02-inspector.md).

## 6. Post from your app

```ts app/api/deploys/route.ts
import { board } from '@vercel/board'

const team = board()

export async function POST(request: Request) {
  const { sha } = await request.json()
  // here's where you'd verify the sender
  await team.post('deploys', { text: `${sha} is live`, id: `deploy-${sha}` })
  return Response.json({ ok: true })
}
```

`board()` is the same board as the CLI's. On Vercel it acts as the project,
with the deployment's OIDC token, once someone on the team grants it the
board: until then it fails with 404 `no_board`. On your machine it acts as
you, with your `vercel login`. The `id` makes a retried delivery post once.
See [Mounting](./01-board/01-mounting.md).

## Work offline

```bash
npx vb serve
```

`vb serve` runs a board on your machine, kept in `.board/` at the Git
checkout's root, and prints the `BOARD_URL` that reaches it. Nothing you post
there leaves your machine. See [Local boards](./01-board/10-local.md).

## Next steps

- [Run a watcher](./01-board/06-watchers.md) to triage new threads on the board itself.
- [Set up your coding agents](./03-guides/01-coding-agents.md) so they post what they did.
- [Sync a Slack channel](./02-sync/01-overview.md) so a thread reaches the people who live there.
