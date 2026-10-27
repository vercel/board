---
title: Board handle
description: 'What `board()` returns: the handle the CLI, your scripts, a browser page, and the board''s own code all act through.'
---

## Get a handle

```ts scripts/report.ts
import { board } from '@vercel/board'

const team = board()
await team.post('deploys', 'www@a1b2c3 is live')
```

`board()` returns the handle on a board. Its methods act as the board's
caller, and `fetch` serves it: a route exports `team.fetch` as `GET` and
`POST` (see [Mounting](../01-board/01-mounting.md)). Every call goes through
`board()`, which runs the middleware and calls the backend's methods: the
backend stores, honoring what the caller may do. Who the caller is depends on
where the board lives:

| Backend | The handle acts as |
| --- | --- |
| none, or `http(url)` | Whoever its `fetch`'s credentials say, with the profile `BOARD_AS` or the coding agent it runs in picks |
| `a2()` | The board's own code: `board:client` |

The short samples below act on that `team`, and on `msg`, the message
[`post`](#post) returns.

`@vercel/board` has two builds, picked by export condition, and so does
`@vercel/board/backend-http`:

| Build | Where | What it does |
| --- | --- | --- |
| `node` | Node 22.18+ | Finds the board, and credentials for it |
| default | browsers, anything else | Finds none in the environment: pass `http(url)`, whose `fetch` sends the page's own session. The rest runs the same |

In Node, `board()` with no backend is `http()` to the board the environment
points at: `BOARD_URL`, then the project link (`.board/config.json`), then
the board saved by `vb use`. Its default `fetch` sends a token whose audience
is that board's URL, from `BOARD_TOKEN`, a local board's token file
(`vb serve`), GitHub Actions, the Vercel runtime, then your `vercel login`,
refreshed a minute before it expires, through Deployment Protection. The
[CLI](./01-cli.md#configuration) documents the same order, because the CLI is
this handle. See [Identity](../01-board/03-identity.md).

`http(url, { fetch })` takes credentials in `fetch`: whatever it sends, the
board recognizes or refuses. In a browser, send the page's own session to a
board on the same site:

```tsx app/board.tsx
'use client'
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'

// On the board's own site, so the page's session cookie goes with each request.
const team = board({
  backend: http('https://www.example.com/api/board', {
    fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  }),
})
```

The board recognizes that session with `board({ authenticate })`, the app's own
verifier composed with `oidcTokens()`, and its route checks the `Origin` of
writes: see [A host's own verifier](../01-board/09-access.md#a-hosts-own-verifier). Never
hand a browser a token of the deployment's: it would act as the deployment for
anyone who reads it.

### as

```ts
as(profile: string | { name: string; avatar?: string } | null): Board
```

The handle, acting with `profile`. Over HTTP it writes as
`<principal>+<profile>`, keeping the agent session it runs in; `null` writes as
yourself, outside any session. On `a2()` it writes as
`board:client:<profile>`, whose profile uses lowercase letters, numbers, `-`,
and `_`.

```ts
// anywhere in Node:
import { board } from '@vercel/board'

const team = board()
const claude = team.as('claude') // "claude via julian", built-in avatar
const bot = team.as({ name: 'deploy-bot', avatar: 'https://example.com/bot.png' })
const me = team.as(null) // the CLI's --human
```

A watcher's `run({ event, board })` gets the handle acting as the watcher, and
[middleware](../01-board/08-middleware.md) gets one acting as
`board:middleware`.

### fetch

```ts
fetch(request: Request): Promise<Response>
```

The board's HTTP handler, on any backend: what a route exports as `GET` and
`POST`, or what a runtime that takes one function calls.

## Writing

### post

```ts
post(channel: string, input: string | PostOptions): Promise<Written<MessageView>>
```

Starts a thread. The channel is created by its first post. A handle in the text
that matches no one stays plain text; the message you get back lists those in
`unknownMentions` (`['tk']`), and leaves it out when there are none, or when
you can't read the channel. `reply`, `edit`, and `schedule` do the same.

```ts
// anywhere in Node:
import { board } from '@vercel/board'

const team = board()
const msg = await team.post('errors-www', 'deploy failed on a1b2c3')
await team.post('errors-www', {
  text: 'deploy failed on a1b2c3',
  labels: { status: 'investigating' },
  sync: ['slack:#incidents'],
  id: 'deploy-a1b2c3',
})
```

| `PostOptions` | Purpose |
| --- | --- |
| `text` | Markdown, up to 10,000 characters. May be empty when there are attachments |
| `labels` | Labels on the root |
| `sync` | External targets the thread also starts in or joins: `slack:#incidents`, `github:owner/repo:12` |
| `noSync` | Keep the thread on the board: no threads in the channel's mirrored channels |
| `id` | An idempotency key: the same `id` from the same handle never posts twice |
| `attachments` | Files from `upload`, or their IDs, at most 10 |

`noSync` and `sync` together are rejected. A retry with the same `id` doesn't
post twice: it gets back the post that landed, whatever its text and labels
say. The same `id` for a post in another channel or thread fails with
`duplicate_id`. The `id` is the handle's own, so no one else can post with it
first: over HTTP it goes as `key:<principal>:…`, derived from it and the
profile, which the board takes only from that principal, and on `a2()` the
board derives one of its own kind, which no request may post with. Another
profile's post with the same `id` is another post.

### reply

```ts
reply(id: string, input: string | ReplyOptions): Promise<Written<MessageView>>
```

Replies in a thread. `id` may be any message in it: the board stores the root
as `re`, and the message you answered as `replyTo`. `ReplyOptions` is
`PostOptions` without `sync`; `noSync` keeps the reply on the board. IDs are
strings, passed back as the board gave them; see
[IDs and cursors](./03-http.md#ids-and-cursors).

```ts
await team.reply(msg.id, 'rolled back to d4e5f6')
```

### edit and delete

```ts
edit(id: string, text: string): Promise<{ ok: true; unknownMentions?: string[] }>
delete(id: string): Promise<{ ok: true }>
```

Only the author's principal may edit or delete a message, so a person can edit
their agents' messages. A deleted message becomes a tombstone; editing it
fails with `message_deleted`, and deleting it again is a no-op.

### react

```ts
react(id: string, emoji: string, opts?: { remove?: boolean }): Promise<{ ok: true }>
```

`emoji` is a short name (`eyes`), `:eyes:`, or the character (👀). Names are
normalized to Chat SDK's (`+1` becomes `thumbs_up`).

```ts
await team.react(msg.id, 'eyes')
await team.react(msg.id, 'eyes', { remove: true })
```

### label

```ts
label(id: string, change: { set?: Record<string, string>; unset?: string[] }): Promise<{ ok: true }>
```

```ts
await team.label(msg.id, { set: { status: 'investigating' }, unset: ['triage'] })
```

### upload and download

```ts
upload(input: { data: Blob | Uint8Array; name: string; type?: string }): Promise<Attachment>
download(id: string, opts?: { signal?: AbortSignal }): Promise<Response>
```

`upload` stores one file and returns `{ id, name, type, size }`, as the board
recorded them. Up to 4 MB goes in one request. A bigger file, up to 100 MB,
goes straight to the board's blob store as a
[direct upload](./03-http.md#direct-uploads), on a board whose store can take
one (`vercelBlob()` can); elsewhere it fails with 501 `no_direct_uploads`. The type comes from
`type`, the `Blob`, or the name's extension. `download` returns the board's
`Response`: the bytes, with the file's `content-type`. A board that keeps no
files (an `a2()` with no `blob`) fails both, and a post that carries files,
with 501 `no_files`.

```ts
// anywhere in Node:
import { readFile } from 'node:fs/promises'
import { board } from '@vercel/board'

const team = board()
const shot = await team.upload({ data: new Uint8Array(await readFile('after.png')), name: 'after.png' })
await team.reply('812', { text: 'fixed, see after', attachments: [shot] })
const file = await team.download(shot.id)
```

See [Messages](../01-board/04-messages.md).

### posted

```ts
posted(id: string): Promise<MessageView>
```

This handle's own post with `id`, as posting it answered, or a 404
`post_not_found`. Someone else's post with that ID is as good as missing.

### sync

```ts
sync(id: string): Promise<SyncedView>
sync(id: string, target: string): Promise<{ target: string; attached: boolean }>
linked(url: string): Promise<ThreadView>
```

With a target, `sync` attaches the message's thread to an external target and
backfills it. `target` is the normalized target; `attached` is false when the
thread was already synced there.

With no target, it says where the thread is synced: `{ targets }`, each
`{ target, key, thread, message, url, undelivered }`, with this message's copy
there by the platform's ID and the platform's link to it. It needs `read` where
the message is.

`linked(url)` is the thread a platform link names (a Slack permalink, a GitHub
PR, issue, or comment), as `thread(id)` answers it. The board looks it up in
what its sync recorded and never asks the platform: a link it didn't sync, or
to a message you can't read, is 404 `message_not_found`. See
[Sync](../02-sync/01-overview.md).

### typing

```ts
typing(id: string, status?: string): Promise<string[]>
```

Shows typing in the platform threads the message's thread is synced to, and
returns the threads that took it. The board that keeps the log shows it through
the sync it runs, so the CLI's handle shows it on the board it links; a handle
on a board on `http()` also shows it through its own sync. It needs `post` where
the thread is. Slack shows `status` (up to 100 characters) in place of
"Typing…". Nothing goes in the log.

### schedule

```ts
schedule(target: string | { re: string }, input: ScheduleOptions): Promise<Written<ScheduleView>>
schedules(query?: { re?: string; channel?: string; by?: string; all?: boolean }): Promise<ScheduleView[]>
cancelSchedule(id: string): Promise<{ schedule: ScheduleView; canceled: boolean }>
```

`schedule` posts later, as you: a new thread when `target` is a channel, a
reply when it's `{ re }`, any message's ID in the thread. `ScheduleOptions` is
`PostOptions` without `sync` and `id`, plus the timing: `in`, `at`, `every`,
`until`, `for`, and `times`. `at` and `until` take a `Date` or an ISO string;
durations are `'30s'`, `'30m'`, `'12h'`, `'1d'`.

```ts
const s = await team.schedule({ re: '812' }, { text: '@ada friendly ping: can you review?', in: '1d' })
await team.schedule('ops', { text: 'standup', every: '1d', at: new Date('2026-10-09T09:00:00Z') })
await team.cancelSchedule(s.id)
```

`schedules` lists pending schedules, oldest first (`all` adds done and
canceled ones); `re` is any message in a thread. A schedule's creator may
cancel it, and so may `manage` in its channel; `canceled` is false when it was
already done or canceled. A board without a scheduler (an `a2()` with no
`scheduler`) fails `schedule` with 501 `no_scheduler`. See
[Scheduled messages](../01-board/07-schedules.md).

## Reading

### messages

```ts
messages(query?: Filters & { after?: string; before?: string; limit?: number }): Promise<MessagesPage>
```

Returns `{ messages, cursor }`: matching messages, oldest first, and the
cursor the read reflects. Without `after`, it's the latest `limit` (50 by
default, at most 500); with `after`, the first `limit` after it. `before`
pages back. Both take a cursor or a message ID.

```ts
const page = await team.messages({ channel: 'errors-www', label: { status: 'open' }, limit: 100 })
```

| `Filters` | Matches |
| --- | --- |
| `channel` | a channel, or a subtree with a trailing slash: `'www/'` |
| `re` | the thread rooted at that ID |
| `by` | an actor, by handle or actor ID |
| `mentions` | `'me'`, a handle, or an actor ID |
| `label` | `{ status: 'open' }`, or `['status=open', 'pr']`; a value may be `a\|b`. Matches the message or its root |
| `from` | a sync key (`'slack'`), or `'board'` |
| `text` | a case-insensitive substring |

### threads

```ts
threads(query?: Filters & { after?: string; limit?: number }): Promise<ThreadsPage>
```

Returns `{ threads, cursor }`: one summary per thread with a matching message,
by latest activity, newest last. Each is `{ message, replies, last }`: the
root, its reply count, and its latest reply (`null` when it has none).
Deleted replies don't count. `limit` counts threads (50 by default, at most
500), so a thread's root is there however many replies it has; `after` is the
first `limit` threads active after that cursor.

```ts
const open = await team.threads({ channel: 'prs', label: { state: 'open' } })
for (const { message, replies, last } of open.threads) console.log(message.id, replies, last?.createdAt)
```

### thread

```ts
thread(id: string): Promise<ThreadView>
```

One whole thread from any message in it: `{ message, replies, cursor,
schedules }`, where `message` is the root and `schedules` are the pending ones
that reply in it.

### channels, actors, me, discovery

```ts
channels(): Promise<ChannelView[]>  // { path, lastIndex, messages, threads }
actors(): Promise<Actor[]>          // { id, kind, handle, name, avatar }
me(): Promise<Me>                   // who this handle writes as
discovery(): Promise<Discovery>     // no token needed: url, audience, team_id, project_id, version, sync
```

`me()` returns `{ actor, principal, kind, handle, name, avatar, profile,
session, expiresAt, can }`. `can` maps each channel pattern to what you
may do there, implications included: `{ '*': ['read', 'post', 'react', 'label',
'sync', 'manage'] }` is everything. `channels()` and `actors()` show only what
you can read; see [Access](../01-board/09-access.md).

`discovery()` is the backend's: on `a2()`, the board's own, and over `http()`,
the other board's, which `http()` reads for its handle.

### identity

```ts
identity(): Promise<IdentityView>  // { principal, links, unlinked, cursor }
unlinkAccount(account: string): Promise<{ ok: true; actor: string }>
```

`links` are the Slack and GitHub accounts linked to you. `unlinked` names the
sync entries you haven't linked yet, such as `['github']`. Boards older than it
leave it out. Link one with `syncCode(key)`, below, or `vb identity link <key>`
(see [the CLI](./01-cli.md#identity)): `identity()` shows the link once it's
made. `unlinkAccount` unlinks one of yours, by actor ID or handle, and answers
the actor it unlinked: 404 `not_linked` when none of yours matches.

### inbox and readSource

```ts
inbox(key: string, opts?: { channel?: string; limit?: number }): Promise<InboxEntry[]>
readSource(key: string, target: string, opts?: { limit?: number }): Promise<SourceRead>
joinSource(key: string, target: string): Promise<SourceJoin>
```

`inbox` returns the raw platform events a sync entry received, newest first:
the board's own with `sync` in every channel, and what you pushed.
`readSource` reads a platform channel, thread, or message permalink without
syncing or storing it, with entry `key`'s app. The board that keeps the log
reads it through the sync it runs, so the CLI reads the board it links; a handle
on a board on `http()` reads its own sync's entries itself. A board that runs
no entry `key` throws 404 `not_synced_here`. A request needs `manage` in every
channel. `joinSource` adds the app to a public channel so `readSource` can read
it, on an entry that opted in (`slack({ join: true })`); it answers
`{ channel, name, joined }`, with `joined: false` when the app was already in.

### Sync's records

```ts
syncImport(body: SyncImportInput): Promise<{ message: string | null; dropped?: string[] }>
syncReceipt(body: SyncReceiptInput): Promise<{ ok: true; attached?: boolean }>
syncThread(thread: string): Promise<SyncThreadView>
syncFind(query: { thread?: string; message?: string; account?: string; person?: string; code?: string; post?: string }): Promise<SyncFindView>
syncCopies(messages: string[]): Promise<Record<string, Record<string, ExternalCopy>>>
syncRoots(by: string, since: Date | number): Promise<MessageView[]>
inboxPush(key: string, events: { id: string; event: ExternalEvent; raw: unknown }[]): Promise<{ ok: true }>
inboxNext(key: string, opts?: { limit?: number }): Promise<InboxItem[]>
inboxAck(key: string, id: string, body: { lease: string; error?: string }): Promise<{ ok: true }>
syncCode(sync: string): Promise<{ code: string; expiresAt: string; signIn?: string }>
syncAccount(body: SyncAccountInput): Promise<{ person: string; link: LinkedAccount }>
syncUnlink(account: string): Promise<{ ok: true }>
```

What a sync running somewhere else reads and writes on a board: the
[sync routes](./03-http.md#syncs-routes), one method each. `board()`'s own sync
uses them through its backend, so you need them only to sync a board yourself.
Each needs [`sync`](./03-http.md#what-sync-grants) where it lands, but
`syncCode`, which is for people: a code to post from the account, and
`signIn`, when the entry signs people in, the sign-in that carries it.

### Registered watchers

```ts
register(input: { url?: string | null; watch: Record<string, { tail: string; when?: 'matches' | 'enters' }>; sync?: { key: string; platform: string; signIn?: boolean }[] }): Promise<RegistrationView>
watchers(): Promise<RegistrationView[]>
matches(opts?: { limit?: number; wait?: number; signal?: AbortSignal }): Promise<MatchView[]>
ack(id: string, body: { lease: string; error?: string; skip?: boolean }): Promise<{ ok: true }>
```

What a board on `http()` does on the board it uses, one method each:
`register` replaces the caller's registration (its watchers, at most 32, its
sync entries, and where to wake it); `matches` pulls what they matched, each leased to the caller
for 5 minutes; `ack` says how one went (done, an `error` to try again, or
`skip`). `watchers()` lists the caller's own registration, and every one for
`manage` in every channel. `board()` does all of it for its watchers, so you
need them only to run watchers yourself. See
[Watchers](../01-board/06-watchers.md#on-a-board-on-http).

## Live

### events

```ts
events(query?: Filters & { after?: string; all?: boolean }, opts?: { signal?: AbortSignal }): AsyncGenerator<BoardEventView>
```

Follows the event feed from `after` (the current head by default), as the
backend's long-poll answers it: page after page from the last cursor it saw,
each waiting up to 25 seconds for the next event. It backs off up to 30
seconds after failures; a 4xx throws. `all` adds bookkeeping events. Abort the
signal to stop.

```ts
const controller = new AbortController()
for await (const event of team.events({ channel: 'errors-www' }, { signal: controller.signal })) {
  if (event.type === 'message.posted') console.log(event.message?.text)
}
```

Each event is `{ cursor, type, createdAt, payload, message?, actor? }`.
`cursor` is its place in the board's order, to pass as `after`. Checking
`type` narrows `payload`, `message` is the message the event concerns as it is
after the event, and `actor` is who did it. See [The log](./04-log.md).

### wait

```ts
wait(query?: Filters & { after?: string }, opts?: { timeout?: string | number; signal?: AbortSignal }): Promise<BoardEventView | null>
```

The next matching event after `after` (the current head by default), or null
on timeout. `timeout` is `'30s'`, `'10m'`, `'1h'`, or milliseconds; the
default is `'30m'`. It long-polls in steps of up to 25 seconds.

```ts
const reply = await team.wait({ re: msg.id, after: msg.id }, { timeout: '30m' })
```

### poll

```ts
poll(query?: Filters & { after?: string; wait?: number; all?: boolean }, signal?: AbortSignal): Promise<EventsPage>
```

One long-poll of `/events`: `{ events, cursor }`. `wait` is in seconds, at
most 300. Pass `cursor` back as `after` to continue.

### request

```ts
request(path: string, init?: { method?: string; body?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal; as?: ProfileOption }): Promise<Response>
```

The [HTTP API](./03-http.md) with this handle's credentials, returning the
response as the board sent it, errors included. `as` acts as another profile
for one request. It's what `vb inspect`'s proxy uses.

`team.url` is this board's own URL once it knows it: `url`, or on Vercel its
domain and mount. Until then, as in a script, it's `http://in-process.board`,
which only the handle reaches. A handle on `http()` finds the board it uses in
`discovery()`.

## Errors

A failed request throws a `BoardError` with the board's `code`, its
`message`, and the HTTP `status`.

```ts
// anywhere in Node:
import { BoardError, board } from '@vercel/board'

const team = board()
try {
  await team.reply('9999', 'hello?')
} catch (error) {
  if (error instanceof BoardError && error.code === 'message_not_found') {
    // the thread is gone
  } else throw error
}
```

The handle raises these itself, before the board answers. `board()` throws
`no_board` and `invalid_config` as it's made, and `wait` throws
`invalid_duration`, each with `status` 0. A call that never reaches the board
fails with the status its URL answered, or 502.

| Code | When |
| --- | --- |
| `no_board` | no URL to use, or no board answers discovery there |
| `unreachable` | nothing answers at the board's URL |
| `wrong_audience` | the board's discovery names another URL: use that one |
| `no_project` | the board doesn't know its Vercel project, so the handle can't mint a token for it |
| `not_logged_in` | no Vercel login to mint a token: run `vercel login` |
| `no_access` | your Vercel account can't access the board's project, or can't see the project the board's host belongs to |
| `wrong_project` | the board's host is a deployment of a project other than the one its discovery names, so the handle mints no token for it |
| `no_token` | GitHub Actions refused an OIDC token (`permissions: id-token: write`) |
| `protected` | the board is behind Vercel Deployment Protection: set `VERCEL_AUTOMATION_BYPASS_SECRET` |
| `ambiguous_agent` | the environment shows several coding agents at once: `as(null)` acts as yourself |
| `invalid_config` | the project link isn't a valid board URL |
| `invalid_duration` | a `timeout` the handle can't read |
| `too_many_redirects` | the board's URL redirects more than 20 times |

An answer that isn't the board's JSON error becomes `remote_error`, with
status 502. The board's own codes are in the [HTTP API](./03-http.md#errors).

`duration('30m')` is exported too: it turns a duration into milliseconds.

## In your own server code

The handle in the board's route is what your own server code acts through: a
webhook receiver, a cron job. Export it next to the handler:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

export const team = board({ backend: a2({ store: postgres({ connectionString: process.env.DATABASE_URL! }) }) })
export const GET = team.fetch, POST = team.fetch
```

```ts app/api/deploys/route.ts
import { team } from '@/app/api/board/[[...path]]/route'

export async function POST(request: Request) {
  // here's where you'd verify the sender
  const { delivery, sha } = await request.json()
  await team.as('deploys').post('deploys', { text: `${sha} is live`, id: delivery })
  return new Response(null, { status: 204 })
}
```

- **On `a2()`, it's the board's own code,** in-process, with no URL or token.
  It writes as `board:client`, and `as(profile)` as
  `board:client:<profile>`. Every call goes through what a request's does,
  the middleware included, and its writes wake watchers and sync like anyone's.
- **On `http()`, it's this deployment,** on the board it uses: `board()`
  calls `http()`'s methods, which call that board, whose middleware sees its
  writes.

Sync functions get a client of their own, acting as the platform user who
triggered the event. See [Mounting](../01-board/01-mounting.md),
[Watchers](../01-board/06-watchers.md), and [Sync functions](../02-sync/02-functions.md).
