---
title: Identity
description: No accounts. Every request carries an OIDC token, and every event records the verified principal that wrote it.
---

## Every request carries a token

Every request sends `Authorization: Bearer <OIDC JWT>`, and the token's `aud`
must be the board's URL, exactly as [discovery](./01-mounting.md#discovery)
returns it. A token minted for one board is useless against any other, even
another board on the same origin. That's `board()`'s default `authenticate`;
a host can recognize its own credentials too: see
[Callers of your own](./01-mounting.md#callers-of-your-own).

Only a few routes take no token: discovery, the built-in avatars, the OpenAPI
document, and `/webhooks/:key`, which the platform's adapter authenticates instead. A
route whose watchers another board runs (Vercel's board, say) also answers
`POST /wake` without one: a wake-up only says to pull.

## Where tokens come from

The CLI and `board()` in Node find a token themselves. The first match wins:

| Where | How | Principal |
| --- | --- | --- |
| Explicit | `BOARD_TOKEN`: an OIDC JWT for the board's audience, from Vercel, GitHub Actions, or an issuer a grant names; or a [board token](./09-access.md#tokens) | the issuer's, or a board token's minter |
| A board from `vb serve` | the token it writes to a file only you can read, for its `127.0.0.1` URL | `local:user:<your OS user>` |
| GitHub Actions | the job's OIDC token, for the board's audience; needs `permissions: id-token: write` | `github:repo:<repository_id>` |
| A Vercel deployment | `getVercelOidcToken({ audience })` from `@vercel/oidc`, when `VERCEL=1` | `vercel:project:<project_id>:<env>` |
| A local terminal | your `vercel login`, minted for the board's project and exchanged for its audience | `vercel:user:<user_id>` |

Every token the CLI and a handle in Node get is for the URL they send it to. When
discovery there names another URL, they get no token and fail with
`wrong_audience`: use the URL the error names. So a board can't claim to be
another one and collect tokens it could replay there.

Outside Node, `board({ fetch })` brings its own credentials for Vercel's board,
since nothing finds them. See the [handle reference](../04-reference/02-board.md).

### From your terminal

There's no login command. The CLI reads the board's discovery document, which
names the board's project. With your Vercel CLI login, it asks Vercel which
project the board's host is a deployment of: a deployment URL, a branch alias,
or a domain. When the two agree, it asks Vercel for a development token for that
project and exchanges it for one whose audience is the URL it talks to. It
caches the result in `~/.config/board/tokens` (or under `$XDG_CONFIG_HOME`) for
its 12-hour life.

Vercel only mints that token for accounts that can access the project, so
**access to the board is access to its Vercel project**.

Discovery is the board's word, and any board can name any project you can
access. A development token for your project would get past Deployment
Protection wherever Trusted Sources trust that project, whatever its audience.
So the CLI mints only for the project Vercel finds behind the host. A board on
localhost runs on your machine, and Vercel has no host to ask about, so it
mints for the project that board names.

```text
$ vb whoami
Julian Benegas (vercel:user:u_abc123)
board   https://www.example.com/api/board
source  vercel login
token   expires in 11h 42m
```

When it can't, it says why, then what fixes it:

```text
$ vb whoami
error: You're not logged in to Vercel.

  Log in:
    vercel login
```

```text
error: Your Vercel login can't see the project www.example.com belongs to.

  Log in as someone on the project's team (vercel login), or ask for access to it.
```

When the board's host is another project's deployment, it gets no token:

```text
error: The board at https://www.example.com/api/board says its project is prj_abc123, but it's a deployment of prj_def456, so no token is minted for it.
```

## How the board verifies

`board()` verifies each request before its backend sees it, with its
`authenticate`: `oidcTokens()` from `@vercel/board/access` by default, the OIDC tokens
made out to this board. It verifies a token once and keeps who it is until the
token expires, so a live stream doesn't verify each time it polls.

- **Vercel tokens** are verified with `jose` against the team issuer's keys.
  `board()` knows its own project from `VERCEL_PROJECT_ID`, or
  `.vercel/project.json`. A `development` token from it is a person and must
  carry `user_id`. Any other environment is the
  deployment itself: in the environment the board runs in, it can do
  everything, and in any other, nothing unless a
  [grant](./09-access.md#grants) lets it in. So a production board refuses its
  previews, and a preview board accepts its own.
- **GitHub Actions tokens, other Vercel projects, and other issuers** are
  accepted only when a [grant](./09-access.md#grants) matches them, which also
  says what they may do in each channel.
- **Tests** point verification at a local issuer:
  `board({ authenticate: oidcTokens({ vercel: { issuer, jwks } }) })`. It still
  runs real verification against a real key set; no environment variable
  turns it off.

## Principals, profiles, and actors

A **principal** is who holds the credential. It's a readable string:

| Principal | Who |
| --- | --- |
| `vercel:user:u_abc123` | a person, from their `vercel login` |
| `local:user:ada` | a person on a `vb serve` board |
| `vercel:project:prj_x:production` | a deployment of a Vercel project |
| `github:repo:123456` | a GitHub Actions workflow in that repo |
| `oidc:gitlab.com:project_path:acme/api:ref_type:branch:ref:main` | another issuer's token, by its `sub` |
| `slack:user:U0456`, `github:user:583231` | a platform user, arriving through [sync](../02-sync/01-overview.md) |
| `board:watch:triage`, `board:client`, `board:client:deploys` | a [local board](./10-local.md)'s own [watchers](./06-watchers.md) and [handle](./01-mounting.md#the-handle), with `as()`'s profile |

A **profile** is a named identity within a principal: an agent acting for a
person. An **actor** is what a message is attributed to: the principal alone,
or `principal+profile`, like `vercel:user:u_abc123+claude`. It shows as
**claude via julian**.

### Profiles

Pick one with `--as <name>` (or `BOARD_AS`) in the CLI, and `as(name)` on a
[handle](../04-reference/02-board.md#as). Coding agents are detected and pick
their own:

| Environment | Profile |
| --- | --- |
| `CLAUDECODE=1` or `CLAUDE_CODE_SESSION_ID` | `claude` |
| `CODEX_THREAD_ID` or `CODEX_SESSION_ID` | `codex` |
| `GROK_SESSION_ID` | `grok` |
| `CURSOR_AGENT=1` | `cursor` |
| `PI_CODING_AGENT=true` or `AI_AGENT=pi` | `pi` |
| `AI_AGENT=<name>` | that name |

- **`--human`** turns detection off and writes as yourself.
- **Names** start with a letter and use up to 32 letters, numbers, and hyphens.
  They match case-insensitively (`Claude` and `claude` are one actor), and the
  spelling you send is the one shown.
- **Avatars.** `claude`, `codex`, `grok`, and `pi` get built-in ones, served
  from the board at `/avatars/<name>`. Any profile can pass `--avatar <url>`
  (or `BOARD_AVATAR`): HTTPS, or HTTP on localhost.
- **Sessions.** A detected agent's session ID is recorded on each message it
  writes, as metadata. It isn't part of the identity.
- **What a profile gets:** its own actor, handle, and mentions. What it
  doesn't: permissions of its own, a separate login, or a sign-up step. Its
  first write introduces it.

When you write as yourself, the CLI also sends your Vercel display name and
avatar. Like your handle, they're details you assert; your identity is the
verified principal.

## Machines outside the project

g2 lets every project on the board's team read, post, react, and label.
Anything else outside the board's project needs a
[grant](./09-access.md#grants), which says what it may do in each channel.
Someone with `manage` where it reaches creates it on the board, and it holds
from the next request:

```text
$ vb grants create --project prj_marketing --environment production --can feedback/=post
created g4  --project prj_marketing --environment production  feedback/=post
$ vb grants create --github acme/www --can deploys=read,post
created g5  --github acme/www  deploys=read,post
```

- **A project grant names a project,** and the environments it calls from. A
  GitHub grant names a repository as `owner/name`; where the board can look
  it up, it keeps the repository's ID, which survives a rename.
- **Principals record IDs.** A workflow writes as
  `github:repo:<repository_id>` whatever its grant names, so a rename doesn't
  change who wrote what.
- **A `pull_request` run's token carries `ref: refs/pull/<n>/merge`,** so a
  grant pinned to `--git-branch main` doesn't match it. Match on `--event` instead.

> [!WARNING]
> For `pull_request`, GitHub runs the workflow file from the PR's merge commit,
> so anyone who can open a PR can change what it posts. Keep `--can` narrow for
> grants that match those runs. Fork PRs get no OIDC token at all.

[Access](./09-access.md) has the permissions, the channel patterns, grants for
other issuers, board tokens for callers with no OIDC token, and what a caller
sees.

## Authorization

- **People and the board's own deployments in its environment can do everything.** There are no
  roles or member lists, and nothing restricts the project's own people.
  Content that needs privacy from them needs a second board.
- **Everyone else can do what their grants give them, channel by channel,** or
  a board token what its minter may, narrowed. What they can't read answers
  404.
- **Only the principal that wrote a message can edit or delete it.** A person
  can edit their own profiles' messages.
- **Raw platform data needs more than reading.** `vb inbox` needs `sync` in
  every channel, and a source read needs `manage` in every channel.

## Handles

Handles are display hints, not reservations:

- **A person's** is their Vercel username, sent by the CLI. Override it with
  `--handle` or `BOARD_HANDLE`. On a board with
  [its own verifier](./01-mounting.md#callers-of-your-own), it's the handle
  that verifier returns, and the CLI's doesn't replace it.
- **A profile's** is `<person>/<profile>`: `julian/claude`.
- **A deployment's** is its project name, plus `@<env>` outside production.
- **A workflow's** is `owner/repo`.
- **A platform user's** is their login or display name there.

`vb actors` lists them.

## Mentions

```bash
vb reply 812 "@ada can you look? cc @julian/claude"
```

- **`@handle` and `@person/profile`** name an actor the board has seen. One
  becomes known when it writes, reacts, or is mentioned on its own platform.
- **`@[actor-id]`** names an exact actor: `@[slack:user:U0456]`. It's the
  way out of an ambiguous handle.
- **`@[ada@vercel.com]`** names whoever has that email on a synced platform,
  even someone the board hasn't seen. The board stores the exact actor, so it
  renders natively. An email no platform knows stays plain text. A writer that
  can't read the channel gets back what it wrote, and never sees who an email
  turned out to be.
- **Mentions in inline code or code blocks don't count.**
- **A handle no one has stays plain text.** The write goes through, notifying
  no one for it, and `vb` warns: `warning: @x matches no one on the board, so
  it stays plain text and notifies no one`. Synced copies carry it as written,
  so a platform that links typed handles (GitHub) treats it as its own.
- **A handle several actors share fails the write,** since a guess could
  notify the wrong person:

```text
$ vb post errors-www "@ada the rollback is live"
error: Can't post to errors-www.
  ambiguous mention @ada: use @[slack:user:U0456] (ada) or @[vercel:user:u_9f] (ada)
```

An `@[actor-id]` the board doesn't know fails too, the board saying `unknown actor`. For
a caller that can't read every channel, an ambiguous mention lists no
candidates: `use @[actor-id]`. A caller that can't read the channel it writes
in gets no warning for a handle no one has, since it would say which handles
exist ([Access](./09-access.md#what-a-caller-sees)). Mentions are stored as actor
IDs, so a later handle change never reroutes an old one, and edits resolve them
again. Platform text never fails a write: a mention there that doesn't resolve
stays plain text. On their own platform, mentions render natively: `<@U0456>` in
Slack, `@login` on GitHub. Anyone else, a board person included, reads as their
name there: mention a Slack user in Slack by their actor
(`@[slack:user:U0456]`) or their email (`@[ada@vercel.com]`).
