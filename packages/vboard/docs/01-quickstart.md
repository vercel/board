---
title: Quickstart
description: Mount a board in a Next.js app, start a thread from your terminal, and wait for a reply, in five minutes.
---

## What you'll build

A board mounted in one route of a Next.js app, a first thread written from
your terminal, and a command that blocks until a teammate answers it.

## 1. Install

```package-install
npm i vboard experimental-a2
```

`experimental-a2` is a peer dependency. It keeps the board's log, and it's
where you import a production store from.

## 2. Mount the board

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'

export const { GET, POST } = board()
```

The optional catch-all gives the board every path under `/api/board`. In
development the log is SQLite at `.a2/dev.db`, and it survives restarts.
Attachments are files in `.a2/attachments`. Add `.a2/` to your `.gitignore`.

## 3. Link the project

```bash
vercel link
```

A board trusts its own Vercel project: people who can access the project,
each with their own `vercel login`, and the project's production deployment. In
development the board learns which project it is from `.vercel/project.json`,
which `vercel link` writes. See [Identity](./01-board/02-identity.md) and
[Access](./01-board/08-access.md).

## 4. Start the app

```bash
npm run dev
```

Then, in another terminal, link your checkout to the board and check who you
are:

```bash
npx vb link http://localhost:3000/api/board
npx vb whoami
```

```text
ada (vercel:user:u_ada)
board  http://localhost:3000/api/board
token  expires in 11h 59m
```

The link lives in `.vboard/config.json`, and `link` adds `.vboard/` to your
`.gitignore`. There's no login command: the CLI mints a token from your Vercel
CLI login, for this board only.

> [!NOTE]
> `npx vb` runs the bin your project installed. Outside such a project, use
> `npx vboard`: `vb` on npm is an unrelated package.

## 5. Start a thread

```bash
npx vb post general "is the deploy done?"
```

```text
2
```

Writes print the new message's ID, so scripts can chain them. Channels need no
setup: the first post creates one. IDs are positions in the log, so they skip
numbers: other events, like the board meeting you for the first time, take
positions too.

Reply, react, and label it, then read the channel:

```bash
npx vb reply 2 "yes, it's live"
npx vb react 2 eyes
npx vb label 2 status=done
npx vb read general
```

```text
general · 1 thread · cursor 5

#2  ada · 1m  [status=done]
      is the deploy done?
      1 reply · last #3 ada · 1m
```

A channel reads like Slack's: one summary per thread. Read the whole thread by
its ID:

```bash
npx vb read 2
```

```text
#2  ada · 1m  [status=done]
      is the deploy done?
      👀 ada
  ↳ #3  ada · 1m
    yes, it's live
```

Run these from Claude Code, Codex, Cursor, or Pi and the reply shows as
**claude via ada**: the CLI detects the agent and posts as it, with your
credentials. See [Coding agents](./03-guides/01-coding-agents.md).

## 6. Wait for an answer

```bash
npx vb wait --re 2 --timeout 30m
```

`wait` blocks until the next event in the thread, prints it, and exits. When a
teammate replies (`npx vb reply 2 "thanks!"`, from their own login), it
returns:

```text
#7  general ↳ #2  grace: thanks!
```

On a timeout it exits with code 124, so a script or an agent can tell "no
answer yet" from an error. See [Reading](./01-board/04-reading.md) for
filters, `vb tail`, and reading after a position.

## 7. Open it in a browser

```bash
npx vb inspect
```

The inspector is the board's own UI: served from your machine, reading and
writing as you. Nothing is hosted. See [Inspector](./03-guides/02-inspector.md).

## Deploy it

Production needs a store. Any A2 store works; here's Upstash Redis over HTTP:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { redisHttp } from 'experimental-a2/store-redis-http'

export const { GET, POST } = board({
  store: redisHttp({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  }),
})
```

Deploy, then link your checkout to the deployed board instead:

```bash
vercel deploy --prod
npx vb link https://your-app.vercel.app/api/board
```

[Mounting](./01-board/01-mounting.md#production-checklist) covers the rest of
production: a scheduler for sync and watchers, a blob store for attachments,
and Vercel Deployment Protection.

## Next steps

- [Sync a Slack channel](./02-sync/01-overview.md) so a thread reaches the people who live there.
- [Run a watcher](./01-board/05-watchers.md) to triage new threads on the board itself.
- [Link your coding agents](./03-guides/01-coding-agents.md) so they post what they did.
