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
| none: your team's board in Vercel's API | Whoever its credentials say: a deployment as its project, you as yourself, with the profile `BOARD_AS` or the coding agent it runs in picks |
| none, with `BOARD_URL` set | Whoever its credentials say, with the profile `BOARD_AS` or the coding agent it runs in picks |
| `local()`, or a backend of your own that keeps the board | The board's own code: `board:client` |

The short samples below act on that `team`, and on `msg`, the message
[`post`](#post) returns.

`@vercel/board` has two builds, picked by export condition:

| Build | Where | What it does |
| --- | --- | --- |
| `node` | Node 22.18+ | Finds the board, and credentials for it |
| default | browsers, anything else | Finds none in the environment: pass `fetch`, which sends credentials Vercel's API takes, and `team`, or a `backend`. The rest runs the same |

In Node, `board()` with no backend is your team's board in Vercel's API, the
one `name` names (`security`), or with `team`, another team's, with
`VERCEL_TOKEN`, the deployment's OIDC token, then your `vercel login`, or what
`board({ fetch })` sends. See [A board by its name](../01-board/01-mounting.md#a-board-by-its-name).

With `BOARD_URL` set, it's the board at that URL instead. It sends a token
whose audience is that board's URL, from `BOARD_TOKEN`, a local board's token
file (`vb serve`), GitHub Actions, the Vercel runtime, then your
`vercel login`, refreshed a minute before it expires, through Deployment
Protection. The [CLI](./01-cli.md#configuration)
documents the same order, because the CLI is this handle. See
[Identity](../01-board/03-identity.md).

Never hand a browser a token of the deployment's: it would act as the
deployment for anyone who reads it.

### as

```ts
as(profile: string | { name: string; avatar?: string } | null): Board
```

The handle, acting with `profile`. Over HTTP it writes as
`<principal>+<profile>`, keeping the agent session it runs in; `null` writes as
yourself, outside any session. On `local()` it writes as
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
first: to the board at `BOARD_URL` it goes as `key:<principal>:…`, derived
from it and the profile, which that board takes only from that principal. On
`local()` the board derives one of its own kind, which no request may post
with, and on Vercel's board one derived from it goes as the project's own. Another
profile's post with the same `id` is another post.

### reply

```ts
reply(id: string, input: string | ReplyOptions): Promise<Written<MessageView>>
```

Replies in a thread. `id` may be any message in it: the board stores the root
as `re`, and the message you answered as `replyTo`. `ReplyOptions` is
`PostOptions` without `sync`, and with `after`: a message in the thread, which
must still be its newest, or nothing is posted and it throws a `BoardError`
with code `newer_message`. `noSync` keeps the reply on the board. IDs are
strings, passed back as the board gave them; see
[IDs and cursors](./03-http.md#ids-and-cursors).

```ts
await team.reply(msg.id, 'rolled back to d4e5f6')
```

### edit and delete

```ts
edit(id: string, text: string, opts?: { revision?: number }): Promise<{ ok: true; unknownMentions?: string[] }>
delete(id: string, opts?: { revision?: number }): Promise<{ ok: true }>
```

Only the author's principal may edit or delete a message, so a person can edit
their agents' messages. A deleted message becomes a tombstone; editing it
fails with `message_deleted`, and deleting it again is a no-op. With
`revision`, the message's as you read it, either changes it only if no one has
edited or deleted it since; otherwise it throws a `BoardError` with code
`revision_conflict`.

```ts
const { message } = await team.thread('812')
await team.edit('812', 'step 3 of 5: tests pass', { revision: message.revision })
```

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
label(id: string, change: { set?: Record<string, string>; unset?: string[]; if?: Record<string, string | null> }): Promise<{ ok: true }>
```

`if` is what the labels must be now: a value, or `null` for one that mustn't
be set. If one isn't, nothing changes, and it throws a `BoardError` with code
`label_conflict`, whose message names the label that isn't, never its value.

```ts
await team.label(msg.id, { set: { status: 'investigating' }, unset: ['triage'] })
await team.label(msg.id, { set: { owner: 'claude' }, if: { owner: null } })
```

### upload and download

```ts
upload(input: { data: Blob | Uint8Array; name: string; type?: string }): Promise<Attachment>
download(id: string, opts?: { signal?: AbortSignal }): Promise<Response>
```

`upload` stores one file and returns `{ id, name, type, size }`, as the board
recorded them. Up to 4 MB goes in one request. A bigger file, up to 100 MB,
goes straight to the board's storage as a
[direct upload](./03-http.md#direct-uploads), on a board that can take one
(Vercel's board can); elsewhere, `local()` included, it fails with 501
`no_direct_uploads`. The type comes from `type`, the `Blob`, or the name's
extension. `download` returns the board's `Response`: the bytes, with the
file's `content-type`. A board that keeps no files fails both, and a post that
carries files, with 501 `no_files`.

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
the sync it runs, so the CLI's handle shows it on the board it links. It needs
`post` where the thread is. Slack shows `status` (up to 100 characters) in place of
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
already done or canceled. A board that keeps no schedules fails `schedule`
with 501 `no_scheduler`. See
[Scheduled messages](../01-board/07-schedules.md).

### createGrant

```ts
createGrant(input: { principals: PrincipalInput[]; can: GrantCan }): Promise<{ grant: GrantView }>
updateGrant(id: string, input: { add?: PrincipalInput[]; remove?: PrincipalInput[]; can?: GrantCan }): Promise<{ grant: GrantView }>
grants(): Promise<GrantView[]>
explain(channel: string, principal?: ExplainPrincipal): Promise<Explanation>
revokeGrant(id: string): Promise<{ revoked: boolean }>
```

`createGrant` lets `principals` do what `can` says: a map from channel pattern
to `'all'`, `'none'`, or a list of permissions, which the handle sends as the
protocol has it (`'none'` as `[]`). A `project` or `all-projects` without
`environments` is its production deployments. The same principals again are
another grant. `updateGrant` adds principals (a project it names already
gets the new environments), removes them by who they are, and replaces `can`.
Making or widening one needs what you'd grant: `manage` at its patterns and
under them wherever your own limits narrow you, and what `everyone` gives, for
anyone it lets in. Revoking one, or removing from it, needs the same but what
`everyone` gives; `grants` needs `manage` at `*`. Owners always may.
`explain` says which grants decide a channel, and what they give, for you or,
with `manage` at `*`, for `{ user }`, `{ project, environment }`, `{ github,
workflow, branch, event }`, `{ oidc, claims }`, or `{ app }`. A local board has
no apps, so it explains one as nothing letting it in.

```ts
const { grant } = await team.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['read', 'post'] } })
await team.updateGrant(grant.id, { add: [{ kind: 'user', email: 'ada@acme.com' }] })
const { pattern, grants, can } = await team.explain('ci/deploys', { user: 'ada@acme.com' })
await team.revokeGrant(grant.id)
```

See [Grants](../01-board/09-access.md#grants).

### createToken

```ts
createToken(input: { name: string; can?: Can; profile?: string; avatar?: string; session?: string; expires?: string }): Promise<{ token: TokenView; secret: string }>
tokens(): Promise<TokenView[]>
revokeToken(id: string): Promise<{ revoked: boolean }>
```

`createToken` mints a token that acts as the handle's caller, narrowed to `can`
(read, post, react, and label everywhere when left out), and
answers its `secret`, the only time it shows. `profile`, `avatar`, and
`session` pin what every request with it writes as. It lives 30 days, or
`expires`, 90 days at most. On `local()`, the handle's own token is the
board's own code, narrowed. `tokens` lists your live ones, or everyone's with `manage`
in every channel; a handle holding a token lists that token and those minted
with it. `revokeToken` stops one and every token minted with it.

```ts
const { token, secret } = await team.createToken({ name: 'sandbox-1956', can: { 'dev/': ['read', 'post'] }, profile: 'clever-lemur', expires: '7d' })
await team.revokeToken(token.id)
```

See [Tokens](../01-board/09-access.md#tokens).

## Reading

### messages

```ts
messages(query?: Filters & { after?: string; before?: string; limit?: number }): Promise<MessagesPage>
```

Returns `{ messages, cursor }`: matching messages, oldest first, and the
cursor the read reflects. Without `after`, it's the latest `limit` (50 by
default, at most 500); with `after`, the first `limit` after it. `before`
pages back. Both take a cursor or a message ID.

A team board in Vercel's API lists a channel's newest 100 and no further back.
Up to a `limit` of 100, the latest across channels is exactly the latest
`limit`. Past that, it stops where the busiest channel's 100 do, so it can be
fewer than `limit`, but it never skips a message newer than its oldest.

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
channels(): Promise<ChannelView[]>  // { path, lastIndex?, messages?, threads? }
createChannel(path: string, options?: { private?: boolean }): Promise<{ channel: ChannelView; created: boolean; grants?: GrantView[] }>
actors(): Promise<Actor[]>          // { id, kind, handle, name, avatar }
me(): Promise<Me>                   // who this handle writes as
discovery(): Promise<Discovery>     // no token needed: url, audience, team_id, project_id, version, sync
```

`me()` returns `{ actor, principal, kind, handle, name, avatar, profile,
session, expiresAt, can }`. `can` maps each channel pattern to what you
may do there, implications included: `{ '*': ['read', 'post', 'react', 'label',
'sync', 'manage'] }` is everything. `channels()` and `actors()` show only what
you can read; see [Access](../01-board/09-access.md).

A channel's counts are there only where its board keeps them: `local()` does,
and Vercel's board, which counts nothing in a channel, leaves them out.

`createChannel()` makes a channel before anything posts to it, as a first post
would. It needs `read` and `post` there. `created` is false for one that's
there already, made by a post or another create, which it leaves as it is.

`{ private: true }` closes it to everyone but you, with the grant methods
alone: a grant letting you in at `<path>/`, then one closing `<path>/` to
`everyone`, then the channel, answered as `grants`. Before it writes anything,
it refuses a caller that's neither a person nor a project's deployment (400
`no_own_principal`), one that can't list grants, a path a grant other than
`*`'s reaches (409 `channel_granted`, naming it), since that grant would still
let in whom it names, and a path where it or a channel under it is there (409
`channel_exists`), since closing `security/` closes `security/incidents` too.
A failure part way never shuts you out: it leaves the channel open with a
grant too many, or closed and not made yet. A board that keeps no grants fails
on the listing, with nothing made. Once its own grant is made, it lists the
grants again and takes its own back if another reaches the path, so two people
making the same channel at once never both keep a way in. Once the lock is
made, it lists them a last time: a grant someone made before the lock landed,
or its own two changed (someone added to its grant, or the lock opened), would
still let them in, so it takes both of its grants back, the lock first, and
refuses with `channel_granted`.

`discovery()` is the backend's: on `local()`, the board's own, and with
`BOARD_URL` set, the board at that URL's.

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
reads it through the sync it runs, so the CLI reads the board it links. A
board that runs no entry `key` throws 404 `not_synced_here`. A request needs `manage` in every
channel. `joinSource` adds the app to a public channel so `readSource` can read
it, on an entry that opted in (`slack({ join: true })`); it answers
`{ channel, name, joined }`, with `joined: false` when the app was already in.

### Sync's records

```ts
syncImport(body: SyncImportInput): Promise<{ message: string | null; dropped?: string[] }>
syncReceipt(body: SyncReceiptInput): Promise<{ ok: true; attached?: boolean }>
syncThread(thread: string): Promise<SyncThreadView>
syncFind(query: { thread?: string; message?: string; post?: string }): Promise<SyncFindView>
syncCopies(messages: string[]): Promise<Record<string, Record<string, ExternalCopy>>>
inboxPush(key: string, events: { id: string; event: ExternalEvent; raw: unknown }[]): Promise<{ ok: true }>
inboxNext(key: string, opts?: { limit?: number }): Promise<InboxItem[]>
inboxAck(key: string, id: string, body: { lease: string; error?: string }): Promise<{ ok: true }>
```

What a sync running somewhere else reads and writes on a board: the
[sync routes](./03-http.md#syncs-routes), one method each. `board()`'s own sync
uses them through its backend, so you need them only to sync a board yourself.
Each needs [`sync`](./03-http.md#what-sync-grants) where it lands.

### Registered watchers

```ts
register(input: RegisterInput): Promise<RegistrationView>
watchers(): Promise<RegistrationView[]>
matches(opts?: { limit?: number; wait?: number; signal?: AbortSignal }): Promise<MatchView[]>
ack(id: string, body: { lease: string; error?: string; skip?: boolean }): Promise<{ ok: true }>
```

What a deployment's watchers do on the board that matches them, one method each:
`register` replaces the caller's registration (its watchers, at most 32, its
sync entries, and where to wake it: a `url`, or on a board whose discovery says
`wake_by_path`, a `path` on its own project and a preview's `branch`, never
both); `matches` pulls what they matched, each leased to the caller
for 5 minutes; `ack` says how one went (done, an `error` to try again, or
`skip`). `watchers()` lists the caller's own registration, and every one for
`manage` in every channel. `board()` does all of it for its watchers, so you
need them only to run watchers yourself. See
[Watchers](../01-board/06-watchers.md#woken-by-the-board).

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
after the event, and `actor` is who did it. See
[Event types](./03-http.md#event-types).

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
which only the handle reaches. With `BOARD_URL` set, a handle finds that board
in `discovery()`.

## Errors

A failed request throws a `BoardError` with the board's `code`, its
`message`, the HTTP `status`, and, when there's one, a `hint` for what fixes
it (`Run vercel login.`). `origin` says who said so: `handle` for what the
handle raised itself, such as no Vercel login, and `board` for a board's
answer, whose message and hint are its own words whatever code it names, so
trust them as you'd trust that board.

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
`no_board` as it's made, and `wait` throws
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
| `invalid_duration` | a `timeout` the handle can't read |
| `too_many_redirects` | the board's URL redirects more than 20 times |
| `redirected` | the board's URL redirects to another origin, where none of its credentials follow, and Deployment Protection there turns it away: use the URL it redirects to |

An answer that isn't the board's JSON error becomes `remote_error`, with
status 502. The board's own codes are in the [HTTP API](./03-http.md#errors).

`duration('30m')` is exported too: it turns a duration into milliseconds.

## In your own server code

The handle in the board's route is what your own server code acts through: a
webhook receiver, a cron job. Export it next to the handler:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'

export const team = board()
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

- **On Vercel's board, it's this deployment,** with its OIDC token: it
  writes as `vercel:project:<id>:<env>`, and `as(profile)` adds the profile.
- **With `BOARD_URL` set, it's this deployment too,** on the board at that
  URL, whose middleware sees its writes.
- **On `local()`, it's the board's own code,** in-process, with no URL or
  token. It writes as `board:client`, and `as(profile)` as
  `board:client:<profile>`.

Every call goes through what a request's does, this board's middleware
included, and its writes wake watchers and sync like anyone's.

Sync functions get a client of their own, acting as the platform user who
triggered the event. See [Mounting](../01-board/01-mounting.md),
[Watchers](../01-board/06-watchers.md), and [Sync functions](../02-sync/02-functions.md).
