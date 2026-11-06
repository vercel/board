---
title: Mounting
description: "`board()` is your team's board in Vercel's API, or with `BOARD_URL` set, the board at that URL. With a backend it's any other: `local()` keeps one in this process, and any object that answers the protocol works. What it returns is the handle: it serves the board and acts on it."
---

## One route

```package-install
npm i @vercel/board
```

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'

export const team = board()
export const GET = team.fetch, POST = team.fetch
```

That's your team's board, in Vercel's API. The board lives there, so this
deployment keeps nothing: people and the CLI use it in Vercel's API, and `vb`
finds it in any linked project. The route answers what Vercel's API sends this
deployment, the wake-ups that run its [watchers](./06-watchers.md), and serves
no other callers. `fetch` is its one handler; Next.js wants it under each
method's name. Call `board()` once, at module scope.

Code that only acts on the board needs no route: `board()` in a script or a
function is the same handle (see [The handle](#the-handle)). A team has boards
of its own, each with a name: see [A board by its name](#a-board-by-its-name).

## Backends

`backend` says where the board lives:

| Backend | What it does |
| --- | --- |
| none | Your team's board in Vercel's API, the one `name` names. In Node with `BOARD_URL` set, the board at that URL instead: see [A handle on a board elsewhere](#a-handle-on-a-board-elsewhere) |
| `local()` | Keeps the board in this process, in SQLite under `.board/` or in memory: for development, `vb serve`, tests, and working offline. See [Local boards](./10-local.md) |
| your own | Any object that answers the protocol: see [A backend of your own](#a-backend-of-your-own) |

`board()` does the same on every backend. It routes and validates each
request, verifies its caller, works out what it may do (see
[Access](./09-access.md)), runs the [middleware](./08-middleware.md), and
calls the backend's method for that route with the caller it verified and the
parsed input. Who may use the board
and what its writes go through are `board()`'s, so the policy is in one place
on any backend, and the backend stores. SSE, [the handle](#the-handle),
[watchers](./06-watchers.md), and [sync](../02-sync/01-overview.md) are
`board()`'s too.

### Vercel's board

`board()` with no backend keeps nothing here:

- **Vercel's API keeps the board:** messages, threads, reactions, labels, a
  channel's changes, schedules, and files, up to 100 MB each as a
  [direct upload](../04-reference/03-http.md#direct-uploads).
- **Its watchers run here.** Vercel's API matches each event against their
  tails and wakes this route when one matches: see
  [Watchers](./06-watchers.md#woken-by-the-board).
- **Its sync runs here too.** `board({ sync })` takes webhooks on this route
  and delivers to the platforms from it, as this deployment's project, and
  Vercel's API keeps sync's records: see [Sync](../02-sync/01-overview.md).
- **It acts as this deployment, or as you.** In a Vercel deployment it sends
  the deployment's OIDC token and writes as its project,
  `vercel:project:prj_x:production`. Elsewhere it sends `VERCEL_TOKEN`, or
  your Vercel CLI login, and writes as you. `fetch` sends other credentials.
- **A board token reaches its own board, by its ID.** `BOARD_TOKEN` goes to
  Vercel's API as it is, and acts as whoever minted it. Name its board in
  `BOARD_URL`, `--url`, or `vercel({ board })`: finding one by name, or the
  team's default, answers 403 `board_token_scope`. Registering watchers with
  one answers 403 `board_token_unsupported`,
  `a board token can't register watchers yet.`
- **What Vercel's API doesn't keep yet answers 501 `not_supported`:** files on
  a scheduled message, labels on a scheduled reply, and a post's `sync`
  targets. A platform message's files come over as links to them there. A
  channel's message and thread counts are left out.

A request's caller is who `board()` verified it is: `authenticate` checks its
credential for the board's URL, which a token's audience must equal, works out
the actor from its claims (the profile it writes as, its session, its scope),
and works out what it may do (see [Access](./09-access.md)). Nothing runs for
a request before that.

## Options

`board()` takes the backend, who a request is, and what runs here, on any
backend:

| Option | What it does |
| --- | --- |
| `backend` | `local()`, or your own. Default: your team's board in Vercel's API, the one `name` names, or in Node with `BOARD_URL` set, the board there, as [the handle](#a-handle-on-a-board-elsewhere) finds it |
| `fetch` | Without a `backend`: how requests reach Vercel's API, with credentials it takes. In Node it defaults to `VERCEL_TOKEN`, the deployment's OIDC token, then your `vercel login`. A board at `BOARD_URL` never gets it |
| `name` | Which of the team's boards this is, by its name: `security`. Default: the team's default board. See [A board by its name](#a-board-by-its-name) |
| `team` | Whose board this is: another team's, by its ID or slug, with `name` or without it for that team's default board. Default: the team the environment finds |
| `authenticate` | Who a request is. Default `oidcTokens()` from `@vercel/board/access`, which verifies its bearer token for the board's URL. Or a host's own verifier, `(request) => ({ id, kind, handle })`: see [Callers of your own](#callers-of-your-own) |
| `middleware` | Runs on every post and edit before it reaches the backend, whatever it came from. See [Middleware](./08-middleware.md) |
| `watch` | Tails the board runs for you, keyed by id: `{ triage: { tail, run } }`. See [Watchers](./06-watchers.md) |
| `sync` | Two-way sync, keyed by a name you choose: `{ slack: slack('slack/acme', channels({…})) }`. See [Sync](../02-sync/01-overview.md) |
| `url` | The board's public URL, which every token's audience must equal. Inferred from requests otherwise |
| `basePath` | The mount path, e.g. `/api/board`. Inferred from requests otherwise: a request can only make it look deeper than it is (`/api/board/x/messages/1`), so the board keeps the shallowest it's seen |
| `streamMaxMs` | How long an SSE stream stays open before the board closes it and the client reconnects. Default `280000` |

`board()` knows its own Vercel project from `VERCEL_PROJECT_ID` on Vercel, or `.vercel/project.json` locally.
`local({ dir, memory })` takes where it keeps its files: see
[Local boards](./10-local.md#options).

Set `url` when the board sits behind a proxy or rewrite that changes the
origin it sees, so the audience it checks matches the one clients mint for.
Clients then use that URL: a handle in Node mints for the URL it talks to, and
refuses one whose discovery names another.

## A board by its name

A team in Vercel has boards of its own, each with a name. `name` says which
one this is, `team` whose, on the board `board()` uses with no backend:

```ts lib/board.ts
import { board } from '@vercel/board'

export const security = board({ name: 'security' })
export const acme = board({ team: 'acme', name: 'security' })
export const acmeGeneral = board({ team: 'acme' })
```

- **`name` is one of the team's boards, and `team` another team's.** Without
  a name, it's the team's default board, named General, so `general` finds it
  too. A name matches whatever its case.
- **A name is 1 to 64 characters with no `/`,** and `team` is a team's ID
  (`team_…`) or its slug. `board()` throws on either that isn't. Without
  `team`, it's the team the environment finds: in Node, the deployment's,
  `VERCEL_ORG_ID`, or the linked project's.
- **`board({ name })` makes the board** the first time anyone uses a name the
  team has none for: this project's own code, and a person too (`next dev`
  with a login, a script). Vercel's API grants a project's new board to that
  project, in the environment it runs in, and anyone on the team can use it.
- **`ensure: false` only finds one.** A name the team has none for fails with
  404 `no_board`, `no board named security on this team, or none you can see.`
- **`vb` makes one only with `--ensure`,** so a typo at a terminal makes no
  board. Without it, `vb` fails with that 404, and its way out is the same
  command with `--ensure`.
- **Names are unique across the team's boards,** private ones included. One a
  board you can't see has fails with 409 `board_name_taken`,
  `the board name vault is taken.`, and makes nothing: pick another name, or
  ask whoever can see it for access.
- **A board this project has no access to** fails with 403
  `board_not_granted`,
  `this project has no access to board security (prj_pong, preview).` Every
  project on the team gets in unless the board's grants were narrowed, so
  someone who manages the board grants it. The team's default board says the
  same.

The backend reads them once, when `board()` binds it: `binding.name`, null for
the team's default board, `binding.team`, null for the environment's team, and
`binding.ensure`. `board({ ensure: true })` without a `name` throws. With
`BOARD_URL` set, the board is the one at that URL, whatever the name, and
`local()` keeps a file per name: see [Local boards](./10-local.md).

## On Vercel

A route on your team's board needs little:

- **The board granted to the project.** Someone on the team grants it the
  team's default board, in each environment that uses it: until then, the
  project's code fails with 404 `no_board`. A named board the team doesn't
  have yet, the project's own code makes, granted to it; one the team has
  answers 403 `board_not_granted` until someone grants it.
- **The route, for watchers.** From production, or a preview of a branch,
  Vercel's API wakes it by its path on this project, through Deployment
  Protection, with nothing to set up. Anywhere else it registers its URL, or
  pulls on its own without an `https` one.

## A dev server

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

// SQLite at .board/local.db, files in .board/local/, and timers in this process.
export const team = board({ backend: local() })
export const GET = team.fetch, POST = team.fetch
```

`local()` keeps its timers in the process, and a restart drops the pending
ones. It's for development, `vb serve`, tests, and working offline, never
serverless functions, which stop between requests. `vb serve` runs it under
`.board`. See [Local boards](./10-local.md).

## The handle

What `board()` returns is the handle on the board. `fetch` serves it, and its
other methods act on it, as the [handle reference](../04-reference/02-board.md)
lists them:

```ts app/api/deploys/route.ts
import { team } from '@/app/api/board/[[...path]]/route'

export async function POST(request: Request) {
  const delivery = (await request.json()) as { id: string; sha: string }
  // here's where you'd verify the sender, or any other checks
  await team.as('deploys').post('deploys', { text: `${delivery.sha} is live`, id: delivery.id })
  return Response.json({ ok: true })
}
```

| Name | What it is |
| --- | --- |
| `fetch` | The board's HTTP handler. Export it from the route as `GET` and `POST` |
| `post`, `reply`, `messages`, … | What the board's caller can do: see the [handle reference](../04-reference/02-board.md) |
| `as(profile)` | The handle, acting with that profile |

- **On Vercel's board, it's this deployment,** with its OIDC token: it writes
  as `vercel:project:prj_x:production`, and `team.as('deploys')` as
  `vercel:project:prj_x:production+deploys`. Profiles start with a letter and
  use up to 32 letters, numbers, and hyphens.
- **With `BOARD_URL` set, it's whoever its credentials say:** see
  [A handle on a board elsewhere](#a-handle-on-a-board-elsewhere).
- **On `local()`, it's the board's own code,** in-process, with no URL or
  token. It writes as `board:client`, and `team.as('deploys')` as
  `board:client:deploys`, with the profile as its handle. Profiles there use
  lowercase letters, numbers, `-`, and `_`, and one that doesn't fails its
  first call.
- **A post's `id` makes it idempotent.** The same `id` from the same handle
  never posts twice, so a redelivered webhook does nothing: use the delivery's
  own ID. The `id` is the handle's own: another profile's post with it is
  another post, and no request can post with it first. `posted(id)` finds it.
- **Its writes are ordinary writes.** They go through the
  [middleware](./08-middleware.md) and wake [watchers](./06-watchers.md) and
  [sync](../02-sync/01-overview.md) like anyone's.

`POST /watchers` on the route registers its watchers with the board now, and
`local()`'s backend has `close()`, which closes its file.

## A handle on a board elsewhere

`board()` with no backend is your team's board in Vercel's API, the one `name`
names (see [A board by its name](#a-board-by-its-name)):

```ts scripts/report.ts
import { board } from '@vercel/board'

const team = board()
await team.post('deploys', 'www@a1b2c3 is live')
```

In Node it finds the team and credentials as the Vercel CLI and a deployment
do. The team is `VERCEL_ORG_ID`, the deployment's, or the nearest
`.vercel/project.json`'s, unless `team` says another (`acme`). The
credentials are `VERCEL_TOKEN`, the deployment's OIDC token, then your
`vercel login`, or what `fetch` sends: a deployment writes as its project, and
you as yourself. Its profile is `BOARD_AS`, or the coding agent it runs in,
with that agent's session; `team.as(null)` acts as yourself.

With `BOARD_URL` set, it's the board at that URL instead, whatever the name:
a board `vb serve` runs, say:

```bash
# in a terminal: vb serve prints the URL that reaches it
BOARD_URL=http://127.0.0.1:4100/api/board node scripts/report.ts
```

It acts as whoever its credentials say, and the default ones are a token from
`BOARD_TOKEN`, a local board's token file (`vb serve`), GitHub Actions OIDC,
Vercel OIDC, then your `vercel login`, made out to that URL, through
Deployment Protection. `fetch` doesn't go there: credentials for Vercel's API
never reach another host. The [CLI](../04-reference/01-cli.md#configuration)
works the same way, because it's this handle.

Its calls go through `board()` like any handle's: `board()` runs its
middleware and calls the backend's methods, which call the board at
`BOARD_URL`, whose middleware sees its posts too.

`@vercel/board` has two builds, picked by export condition: the `node` one
finds boards and credentials as above, and the default one, for browsers,
finds none in the environment; the rest runs the same. There,
`board({ team, name, fetch })` reaches Vercel's board with what `fetch` sends:
credentials Vercel's API takes. Nothing in a browser finds a team, so it's
`team`'s, or with none, the token's own team. Never hand a browser a token of
the deployment's: it would act as the
deployment for anyone who reads it.

## A backend of your own

A backend is an object: one async method per route of the protocol, and three
fields. `board()` only ever calls these: it verifies each caller and decides
what it may do, and the backend stores and answers, honoring that. `board()`
does the HTTP, so each method gets the caller, the input as the route's schema
parsed it, and the request's signal, and returns what the route answers. What it throws as an `HttpError`, the board
answers with that status and code; anything else is a 500.

The shortest one is another backend with a method changed:

```ts app/api/board/[[...path]]/route.ts
import { board, HttpError, type Backend } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

const kept = local()

// local()'s board, except that its messages are never deleted.
const backend: Backend = {
  ...kept,
  async delete() {
    throw new HttpError(403, 'forbidden', 'messages on this board stay')
  },
}

export const team = board({ backend })
export const GET = team.fetch, POST = team.fetch
```

What a backend has:

| Field | What it is |
| --- | --- |
| `discovery`, `me`, `messages`, `post`, … | One method per protocol route, `(caller, input, signal)`, named for it: the [HTTP reference](../04-reference/03-http.md#routes) lists them, and the `Protocol` type from `@vercel/board` says what each takes and answers |
| `routes` | Routes of its own beside the protocol: `{ method, path, handle(request, { caller, param }) }`. One at a protocol route's path takes its place. `board()` verifies nothing for them: `caller` is null for a request, or the handle's own when its call reaches one |
| `keeps` | Whether the board lives here. `true` serves its callers: the board's people, its own deployments, and whoever grants and board tokens let in. `false`, as on Vercel's board and the board at `BOARD_URL`, serves no requests but wake-ups and webhooks |
| `trust` | Its [grants](./09-access.md#grants) and [board tokens](./09-access.md#tokens), for a backend that keeps them: `grants()`, `token(hash)`, and `live(id)`. `board()` checks each request against them as they are then. Without it, they let no one in |
| `bind(binding)` | Called once, when `board()` is created, before any request. It does no I/O. `binding.name` and `binding.team` are `board({ name, team })`'s, or null |

- **A caller is one `board()` verified, or its own code.** `{ identity, origin }`
  is a request's, or for work the backend does outside requests, the one it
  does it for (a schedule's creator, at its send): `identity.principal` is who
  it is with its `access` (a `scope` it sent included, which only narrows),
  `identity.author` the author record its writes carry, and `identity.actor`
  the actor it writes as. A backend trusts it as it is, since only `board()`
  makes one, and honors what it may do in each channel: see
  [Access](./09-access.md#a-backend-of-your-own). `origin.via` says where it
  came from: `api` for a request.
  `{ self, origin }` is this deployment's own code: the handle (`self` is the
  profile from `as()`, or null, and `profile` what `as()` asked for, absent on
  the handle itself), a watcher, the middleware's handle, or sync (its
  `origin.via.kind` says which). Who that is on your board is yours to decide
  too.
- **`events` long-polls.** It answers what's after `after` at once, or waits
  up to `wait` seconds for the next. `board()` serves SSE from it.
- **Sync's methods keep its records** (`syncImport`, `syncReceipt`, the
  lookups, and the inbox): `board()`'s sync reads and writes only through
  them and the rest of the protocol, so a backend that answers them syncs.
- **The binding is what background work needs from the board:** what runs on
  its events (`subscriptions`: each watcher's tail, and sync's at `@sync`, with
  `run(id, event, { trigger, attempt })` to run one), sync's inbound
  (`receive(key, event, { id, attempt })` for a backend that delivers what
  sync pushed in-process, `pull()` for one that queues it), its sync entries
  (`sync`), what only its sync can do (`readSource(key, target, limit)` and
  `typing(messages, status)`, which answer the methods of those names), its
  policy for what the backend stored (`accessNow(principal)`, null once it may
  do nothing, for a schedule's send and a registrant's matches), its project
  (`project()`), a handle through it (`handle(caller)`, a schedule's creator
  for its send, so the middleware sees what the backend writes for someone),
  and its own URL (`url()`).
- **IDs and cursors are yours,** as strings: see
  [IDs and cursors](../04-reference/03-http.md#ids-and-cursors).

`vb conformance` checks one against the whole protocol: see
[Conformance](../04-reference/05-conformance.md).

### Callers of your own

`board({ authenticate })` says who a request is. It's one function,
`oidcTokens()` from `@vercel/board/access` by default, and composing verifiers
is plain code. Each answers null when the request carries nothing it
recognizes, so the next one gets it, and a 401 when it carries a credential
that fails. A board on an app's own site can take the app's session cookie
from its staff, and `vb`'s tokens from people, agents, and deployments:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { oidcTokens, type CallerRequest } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'

const tokens = oidcTokens()

/** The staff member the app's session cookie names, or null for anyone else. */
async function staff(request: CallerRequest) {
  // const user = await readSession(request.headers.get('cookie'))   // yours
  const user = null as { id: string; username: string; staff: boolean } | null
  return user?.staff ? ({ id: `support:staff:${user.id}`, kind: 'person', handle: user.username } as const) : null
}

export const team = board({
  backend: local(),
  authenticate: async (request) => (await staff(request)) ?? (await tokens(request)),
})
export const GET = team.fetch
export const POST = async (request: Request) => {
  if (request.headers.has('cookie') && request.headers.get('origin') !== 'https://support.example.com') return new Response('forbidden', { status: 403 })
  return team.fetch(request)
}
```

A browser sends the cookie with requests that other sites' pages make, so the
route checks the `Origin` of every write that carries one. A bearer token
doesn't ride along like that, so `vb`, deployments, and webhooks need no such
check. board ships no helper for it: it's the route's to say which pages may
write.

- **A verifier gets what the request said:** `credential`, its bearer token or
  null, `headers`, for a cookie, `audience`, the board's URL, `claims`, what it
  claims for itself, and `board`, what the board knows that verifying needs
  (its project, and the issuers its grants name), which `oidcTokens()` reads.
- **A host's own returns the principal:** `id` in the board's scheme
  (`vercel:user:<id>`, `vercel:project:<id>:<env>`, …), `kind`, `handle`, and
  optionally `expiresAt`. Its handle stands: the one the CLI sends doesn't
  replace it, so a verifier that wants it returns `request.claims.handle`
  itself. The name, profile, and `x-board-scope` the caller sends still apply
  on top of it.
- **`kind: 'person'` is a person on the team:** it gets what grants give
  people, as the board's own people do (g1 gives everything), and a channel
  closed to `everyone` keeps it out unless a grant names it. So your verifier
  decides who counts as one.
- **Anyone else gets what grants give its ID.** A host's principal carries no
  claims past its ID, and only a deployment's, `vercel:project:<id>:<env>`,
  says what a grant matches: the grants naming that project in that
  environment. Any other is refused with 403. One whose `expiresAt` has passed
  is refused, and a schedule it made is canceled `revoked`.
- **Name your principals in a scheme no sync registers.** A sync writes as
  the users of the platforms it registers, `support:…` for a platform named
  `support`, and the board tells a host's principal from them only once that
  principal has written or registered watchers. Give `sync` carefully: see
  [what `sync` grants](../04-reference/03-http.md#what-sync-grants).
- **To reject, throw an `HttpError` or return or throw a `Response`.** The
  board sends that response as is. Anything else thrown is a 500, so turn a
  bad credential into a 401 yourself.
- **It's asked once per request,** however many times a stream polls, and a
  token `oidcTokens()` verified is kept until it expires. What a principal may
  do is worked out again for each page a stream sends.
- **Nothing else is trusted.** Without `oidcTokens()` in its verifier, no
  people, own-project deployments, audience check, or platform token header
  count. A board whose verifier is `oidcTokens()` alone takes no host's
  principals: schedules one made before the board switched are revoked.

A host that serves many teams' boards from one server can't use the built-in
verifier: its callers can't access the host's project, and every team's board
would trust the host's own deployments. It makes a `board()` for each team,
each with its own `local({ dir })` and a verifier that answers only that
team's callers as people, and caches them.

## Discovery

`GET` on the mount is discovery, and needs no token. Clients read it to learn
which Vercel project to mint a token for. `board()` says who the board is, the
URL a token's audience must equal and the project people mint with, and the
backend lists the sync entries accounts link on:

```bash
curl https://www.example.com/api/board
```

```json
{
  "version": "0.14.0",
  "url": "https://www.example.com/api/board",
  "audience": "https://www.example.com/api/board",
  "team_id": "team_a1b2c3",
  "project_id": "prj_d4e5f6",
  "sync": [{ "key": "slack", "platform": "slack" }]
}
```

`board()` knows its project from `VERCEL_PROJECT_ID` on Vercel, or
`.vercel/project.json` locally. Run `vercel link` in the app once, so a local
board can verify the development tokens people send it. A route with no
backend answers no discovery: it serves only wake-ups and webhooks.

The CLI doesn't take discovery's word for it. It mints a person's token only
for the project Vercel says the board's host is a deployment of, so a board
must be served from its own project's deployments or domains (or localhost).
See [Identity](./03-identity.md#from-your-terminal).
