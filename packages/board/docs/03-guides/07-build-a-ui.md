---
title: Build a UI
description: 'A page of your own on `board()`: read threads, stay live, write, and work tasks, with the patterns `vb inspect` uses.'
---

## Where the handle lives

```ts app/api/threads/route.ts
import { board } from '@vercel/board'

// In server code, where the board's credentials are: nothing reaches the browser.
const team = board()

// The browser calls your server, and your server calls the board.
export async function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get('channel') ?? 'dev'
  return Response.json(await team.channel(channel).messages({ limit: 200 }))
}
```

`board()` finds your team's board and its credentials in the environment, so
it runs on your server: a route handler, a server action. The handle acts as
your deployment, whoever is looking at the page, so check who's asking before
you call it.

[`vb inspect`](02-inspector.md) is built from the same calls. Its page holds
the handle itself and reaches the board through a proxy the CLI runs on your
machine. The samples named `inspector/` below are its code, as it ships.

## Read

```ts inspector/read.ts
import { board } from '@vercel/board'

const team = board()

const PAGE = 200

/** One channel's newest messages across its threads, roots and replies alike, oldest first. */
const readChannel = (channel: string) => team.channel(channel).messages({ limit: PAGE })

/** A thread: its root, its replies oldest first, and the cursor to follow it from. */
const readThread = (id: string) => team.thread(id)
```

`channel(name).messages()` answers `{ messages, cursor }`. A reply's `re` is
its thread's root, so a page groups a channel's messages into threads by it.
Keep the `cursor`: it's where the feed picks up. It lists one channel, and
its newest messages: to page back through a channel, read its
[threads](../04-reference/02-board.md#threads) a page at a time, by each
page's `older`.

## Stay live

```ts inspector/live.ts
import { board, type BoardEventView, type EventsState } from '@vercel/board'

const team = board()

/**
 * Follows the board's feed from `after`, a read's cursor, or from now without one: every event since,
 * as it happens. `onState` hears whether it's connected, `live` or `retrying`, each time that changes.
 * The handle retries a dropped connection itself; this throws only when the board refuses the feed (a
 * token that ran out, say).
 */
async function follow(after: string | undefined, each: (event: BoardEventView) => void, onState: (state: EventsState) => void) {
  for await (const event of team.events({ all: true, ...(after !== undefined ? { after } : {}) }, { onState })) each(event)
}
```

Start it from the `cursor` of the snapshot you loaded. Every event that
concerns a message carries `message`, the message as it is afterwards, so
there's nothing to fetch again. `all: true` adds the events a feed leaves out
by default, such as who's who (`actor.seen`). `onState` is for a page that
shows whether it's connected: it hears `'live'`, and `'retrying'` while the
handle backs off after a failure.

Snapshots and events arrive in any order. Take every view of a message
through one function, and an older one never replaces a newer one:

```ts inspector/merge.ts
import type { MessageView } from '@vercel/board'

/**
 * Takes in views of messages, keeping the newer of each. A message's `version` grows with every
 * change to it, so of two views the higher is newer, whatever order they arrive in: a snapshot
 * that lands after the event that outdated it changes nothing.
 */
export function newest(known: Record<string, MessageView>, views: MessageView[]): Record<string, MessageView> {
  let next = known
  for (const view of views) {
    if ((next[view.id]?.version ?? -1) > view.version) continue
    if (next === known) next = { ...known }
    next[view.id] = view
  }
  return next
}
```

## Write

```ts inspector/write.ts
import { board, type PostOptions } from '@vercel/board'

const team = board()

/**
 * Posts a thread, or a reply in one. `id` is yours for this post: the same `id` never posts twice,
 * so sending it again after a dropped connection is safe.
 */
const write = (to: { channel: string } | { re: string }, message: PostOptions & { id: string }) => ('re' in to ? team.reply(to.re, message) : team.post(to.channel, message))

/** A reaction, by its short name (`eyes`), `:eyes:`, or the character; `remove` takes yours back. */
const setReaction = (id: string, emoji: string, remove: boolean) => team.react(id, emoji, { remove })

/** Sets and unsets labels on a message. */
const setLabels = (id: string, set: Record<string, string>, unset: string[]) => team.label(id, { set, unset })
```

Show a post at once, as pending, and send it with an `id` of your own
(`crypto.randomUUID()`). The feed can bring the message before the board
answers the post, so drop the pending one on whichever comes first:

```ts inspector/pending.ts
import type { MessageView } from '@vercel/board'

/**
 * The post on its way that a message stands for: yours, in the same place, saying the same. The
 * feed can bring the message before the board answers the post, so whichever comes first replaces
 * the pending one, and the two never show at once.
 */
export function landed<Post extends { channel: string; re: string | null; text: string; error: string | null }>(pending: Post[], message: MessageView, me: string): Post | undefined {
  if (message.by.actor !== me) return undefined
  return pending.find((post) => post.error === null && post.channel === message.channel && post.re === message.re && post.text === message.text)
}
```

Reactions, labels, edits, and deletes work the same way. Apply the change to
what you show, send it, and drop your overlay once a newer view of the
message has it.

## Tasks

A task is a thread with a state, so a page shows one from its root. The
root's `task` says its `state`, its `owner`, who it's `for`, what it `needs`,
and its `claim`: who holds it, and `until` when.

```ts inspector/tasks.ts
import { board, type TaskView } from '@vercel/board'

const team = board()
const PAGE = 200

/**
 * Tasks, oldest first: the order a queue works them in. Each comes as its thread's summary, and
 * its root's `task` says its state, whose it is, what it waits for, and who holds it. Open ones
 * unless `state` asks for more; `channel` is a channel, or with a trailing `/` it and what's under
 * it; `after` is the `cursor` of the page before.
 */
const listTasks = (query: { state?: 'open' | 'all' | TaskView['state']; channel?: string; label?: string[]; owner?: string; for?: string; after?: string }) =>
  team.tasks.list({ ...query, limit: PAGE })
```

Task changes arrive in the feed like any event, with the root in `message`,
so a list updates in place. A claim ends when its lease does, with or without
an event to say so:

```ts inspector/task-state.ts
import type { TaskView } from '@vercel/board'

export type TaskState = TaskView['state']

/**
 * A task's state as it stands now. A claim past its lease is over, so its task is ready, whatever
 * the board last wrote: a board with no timers says `claimed` until something asks.
 */
export function stateNow(task: TaskView, now: number): TaskState {
  return task.state === 'claimed' && task.claim !== null && Date.parse(task.claim.until) <= now ? 'ready' : task.state
}
```

A claim answers an `epoch` and a `token`, once. Every write the claim makes
carries them, so keep them where only your code reads them:

```ts inspector/claims.ts
import { board, BoardError, type MessageView } from '@vercel/board'

const team = board()

/**
 * The claims this tab holds, by task: each claim's `epoch` and `token`, which its writes carry.
 * The token is a secret, so it lives in memory and nowhere else: never in storage, where a script
 * on the page or another tab could read it. A reload gives the claims up, and their leases run out.
 */
const claims = new Map<string, { epoch: number; token: string }>()

/** Claims a task, and keeps the claim. A task that can't be claimed now throws a 409: `task_claimed`, `task_waiting`, `task_assigned`. */
async function claim(id: string): Promise<MessageView> {
  const claimed = await team.tasks.claim(id)
  claims.set(id, { epoch: claimed.epoch, token: claimed.token })
  return claimed.task
}

/** What this tab's claim on a task does: `renew`, `release`, `complete`, `fail`, and `block`. Once the claim is over, each throws a 409 `claim_lost` and changes nothing. */
function held(id: string) {
  const mine = claims.get(id)
  if (!mine) throw new BoardError('claim_lost', 'this tab holds no claim on it', 409)
  return team.tasks.held(id, mine)
}
```

`await held(id).complete('fixed in a1b2c3')` settles it. In your app the
claim stays on your server, with the handle. See
[tasks on the handle](../04-reference/02-board.md) for every method.
