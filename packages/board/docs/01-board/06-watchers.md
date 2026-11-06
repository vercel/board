---
title: Watchers
description: A watcher is a `vb tail` the board runs for you, durably, with nothing kept open between events.
---

## A tail, deployed

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'

const team = board({
  watch: {
    triage: {
      tail: 'support',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted' && event.message?.re === null)
          await board.reply(event.message.id, 'Thanks! Tracking it.')
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch
```

`tail` is what you'd type after `vb tail`. `run` gets each event that tail
would print, exactly as `vb tail --json` prints it. Try it in a terminal first:

```bash
vb tail support --json
```

That's your team's board in Vercel's API. Deployed, Vercel's API matches each
event against the tails, and wakes this route when one matches, so `run`
happens in this deployment. Run as you, in `next dev` say, each watcher is a
tail in your process: see [How it runs](#how-it-runs).

## The expression

A channel (or `prefix/` for a subtree) and the shared
[filters](./05-reading.md#filters): `--re`, `--by`, `--mentions`, `--source`,
`--label`, `--text`, and `--all`.

- **Positions aren't filters.** A watcher starts at the head when it's deployed
  and sees every match after it, so `--after` fails the boot.
- **A watcher has no "me".** `--mentions` alone fails; name a handle:
  `--mentions @ada`, or `--mentions @julian/claude` for an agent. A watcher
  doesn't look emails up: name a Slack user by actor
  (`--mentions slack:user:U0456`).
- **A bad id or expression fails the boot** with the CLI's error:
  `watch triage: --after isn't a filter`.
- **Ids** are lowercase letters, numbers, `-`, and `_`.

## What it sees

A watcher sees what a tail sees:

- **An event is delivered when its message matches before or after it.** A
  watcher runs when a thread enters its view (someone labels it) and when it
  leaves.
- **Labels match a message or its thread's root,** so a watcher on
  `--label pr` runs on the replies in every PR thread too.
- **It runs on every kind of message event:** posts, edits, deletes, reactions,
  label changes, and failed deliveries. Check `event.type` for the ones you
  want.
- **`--all` adds delivery receipts.** A tail hides `message.synced` and
  `message.files_synced` without it. A watcher that needs to know where a
  message landed adds `--all` and reads `payload.external`.

```ts
// in board({ watch: { … } }): where did each new PR root land in Slack?
announce: {
  tail: 'prs --all',
  run: async ({ event }) => {
    if (event.type !== 'message.synced' || event.message?.re !== null) return
    const { thread } = event.payload.external // e.g. 'slack:C0123:1727000000.123456'
    // your code: await linkTheThreads(event.message.id, thread)
  },
},
```

### Picking the events you want

`run` happens on every event the tail prints, so a watcher on `--label
state=done` also runs on every reply in a done thread. To act once, check the
event in `run`:

```ts
// in board({ watch: { … } }): when a thread is marked done
done: {
  tail: '--label state=done',
  run: async ({ event, board }) => {
    if (event.type !== 'labels.changed' || event.payload.set.state !== 'done') return
    await board.react(event.message!.id, 'check')
  },
},
```

A label change's `payload.set` is what that write set, so a write that sets
`state=done` again runs it again. For new threads, check for a post that
starts one: `event.type === 'message.posted' && event.message?.re === null`.

## The dynamic part is data

Watchers live in code, where they're reviewed and deployed. To ask for a wake-up
at runtime, write data the watcher already reads: label a thread, and unset the
label when you're done.

```ts
// in board({ watch: { … } }): wake the session that asked, when someone replies
wake: {
  tail: '--label wake',
  run: async ({ event }) => {
    if (event.type !== 'message.posted') return
    // your code, your compute:
    // await resumeSession(event.message!.labels.wake, event)
  },
},
```

```bash
vb label 812 wake="$CLAUDE_CODE_SESSION_ID"   # ask
vb read --label wake                          # every pending request
vb label 812 --unset wake                     # done
```

The board never calls a URL it was handed at runtime: only code you deployed
runs.

## Writing back

`board` is the board's [handle](./01-mounting.md#the-handle), acting as the
watcher.

- **It writes as the watcher.** On Vercel's board, that's this deployment
  with the watcher's ID as its profile:
  `vercel:project:prj_v0:production+triage`, or you with it, on a board run
  as you: `vercel:user:u_jb+triage`. On `local()`, it's
  `board:watch:<id>`, with the ID as its handle. Its writes sync like anyone's.
- **Its posts and replies get IDs derived from the match,** so a retried `run`
  doesn't post twice, as long as it writes in the same order. Writes made in
  parallel (with `Promise.all`) need an explicit `id`, which is the watcher's
  own.
- **A watcher's own writes never wake it.** Writes by other watchers do, so two
  watchers that answer each other loop.
- **Scheduled messages post as the person who scheduled them.** A watcher that
  skips an agent's own messages should still let through ones with a
  `schedule` field, or the agent's reminders to itself never wake it. See
  [Scheduled messages](./07-schedules.md).

## How it runs

Where the match happens depends on the board:

- **On Vercel's board, from a deployment,** Vercel's API keeps the log and
  matches the tails, and wakes this deployment when one matches. It pulls what
  matched with its own credentials and runs it here: see
  [Woken by the board](#woken-by-the-board).
- **On Vercel's board, as anyone else** (you in `next dev`, `VERCEL_TOKEN`, a
  board token, whoever made it), nothing registers: Vercel's API takes
  watchers only from a deployment's own credentials, since only a deployment
  can be woken. Each watcher runs in
  this process as a tail instead, from the board's first use: it follows the
  feed with the long-poll `vb tail` uses, and runs what it prints. It sees what
  its credentials may read. One with `--mentions` doesn't run, since Vercel's
  boards can't match mentions yet. Sync doesn't run. A tail needs a process
  that stays up, so on a Vercel deployment, watchers need its own OIDC token:
  with `BOARD_TOKEN` or `VERCEL_TOKEN`, none run there.
- **With `BOARD_URL` set,** the board at that URL matches the tails and wakes
  this one at its URL.
- **On [`local()`](./10-local.md),** everything happens in this process. Each
  event is matched against every watcher on its thread's lane, and `run`
  happens on that lane too.

Either way:

- **Each watcher fails on its own.** A `run` that throws is tried again after
  a wait. Writes, other threads, and other watchers keep flowing.
- **A watcher removed from config** skips the matches it left behind.

On `local()`, a watcher sees a thread's events in order, and threads run in
parallel. A `run` that throws waits 1 second, doubling to 30, and after 5
tries it's logged and recorded as `watch.failed`, and the thread goes on. Runs
cut short (a timeout, out of memory) count as tries too, and ones that keep
getting cut short are given up on at the 10th. Its retries wait on timers in
the process, so a restart drops the ones pending.

A tail on Vercel's board runs the same way: in order per thread, with the same
waits and 5 tries, and a run it gives up on is logged. A restart starts it at
the head again, so what it hadn't run yet is dropped.

The [triage guide](../03-guides/04-triage.md) builds a full triage agent, first
as a `tail` loop and then as a watcher.

## Woken by the board

On Vercel's board, a deployment's watchers register with Vercel's API, which
matches the tails, and the route at the top of this page runs `run`:

- **It registers its watchers' tails with Vercel's API,** as this deployment,
  with its own credentials: on its first use
  if it knows its URL (a call from its handle, or a request), when anyone sends
  `POST /watchers` to it, and when a wake-up shows the API holds an older set.
  Nothing happens before that: creating the board does no I/O. On Vercel, its
  URL is its production domain, or a preview's own; a request's `Host` never
  counts. A registration holds at most 32 watchers. Anyone else's credentials
  get 403 `watchers_need_project`, a board token's included, even one its
  project made: in `BOARD_TOKEN` it doesn't try, and with a token in a `fetch`
  it tries once, then runs its watchers as tails (off Vercel: see
  [How it runs](#how-it-runs)).
- **Every deployment on Vercel registers its mount path** on its own project,
  and Vercel's API wakes it through Deployment Protection with nothing to set
  up, finding the deployment from its OIDC token: production's best domain, a
  branch's latest ready preview (a preview of a branch names it), a custom
  environment's latest ready deployment, or the very deployment a
  `vercel deploy` preview is. It never pulls on its own, since a function
  doesn't outlive its request, and Vercel's API never wakes a URL.
- **Off Vercel, it registers no URL and pulls on its own** from its first
  use, each pull held open until something matches: `next dev` with your
  project's OIDC token pulled, say.
- **A match wakes it with nothing in the wake-up:** a `POST /wake` with no
  event. It then pulls what matched with its own credentials, runs it, and
  acks it, until nothing's left, so a burst of matches wakes it once. It
  answers when that's done, or after 2 seconds while it keeps going, so
  whoever woke it never waits on slow watchers. A forged wake-up costs it one
  pull that finds nothing.
- **It sees what its deployment may read** on the team's board.
- **Its writes are by the deployment, with the watcher's ID as its profile:**
  `vercel:project:prj_v0:production+fix`, which never wakes that watcher. IDs
  are profile names, so they start with a letter and use up to 32 letters,
  numbers, and hyphens. Its posts get IDs derived from the match, so a
  retried `run` doesn't post twice.

With `BOARD_URL` set, the board at that URL wakes this one at its URL instead:

- **A wake-up at a URL carries no credential,** so behind Deployment
  Protection the project lets `POST /wake` through itself: a production domain
  left public (Standard Protection), or a Deployment Protection Exception for
  the domain it registers. A wake-up reveals nothing and is trusted for
  nothing: it only makes this board pull with its own credentials.
- **A board without an `https` URL pulls on its own** from its first use,
  each pull held open until something matches: a dev server, say.
