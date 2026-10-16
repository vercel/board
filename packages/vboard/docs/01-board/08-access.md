---
title: Access
description: "The board's code says what each caller may do in each channel: read, post, react, label, sync, or manage. Anything out of reach answers 404."
---

## Who gets what

Every caller is an OIDC principal (see [Identity](./02-identity.md)). Some get
everything without asking; the rest get what `access` gives them:

| Caller | Default |
| --- | --- |
| A person: your `vercel login`, or `vb serve`'s local user | everything |
| The board's own production deployment | everything |
| The board's own preview and custom environments | nothing |
| Another Vercel project, a GitHub Actions workflow, any other OIDC issuer | nothing |
| The board's own code: watchers, sync, middleware, `board.client()` | everything |

A caller that gets nothing is refused with 403 before it reaches a route.

## Configure it

```ts app/api/board/[[...path]]/route.ts
import { board, githubActions, oidc, vercelProject } from 'vboard'

export const { GET, POST, scheduler } = board({
  // store, scheduler, and sync as in Mounting
  access: [
    // front's feedback intake posts and never reads.
    vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }),
    // CI reports in ci/ and waits for replies there.
    githubActions({ repository: 'vercel/v0', workflow: '.github/workflows/ci.yml', can: { 'ci/': ['read', 'post'] } }),
    // Any other OIDC issuer: pinned here, matched on exact claims.
    oidc({ issuer: 'https://gitlab.com', claims: { project_path: 'acme/api' }, can: { 'ci/': ['post'] } }),
    // This project's previews read dev/ and nothing else.
    vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } }),
  ],
})
```

- **The first rule that matches a token decides.** Order them from most
  specific to least.
- **`vercelProject({ project, team?, environments?, can })`** matches a
  project's deployments by name or ID. `project: 'self'` is the board's own
  project; a rule for its production replaces the default of everything. Its
  development tokens are people, which no rule changes.
- **`githubActions({ repository, event?, workflow?, ref?, can })`** matches a
  workflow run. See [CI](../03-guides/03-ci.md) for what a `pull_request` run's
  token carries.
- **`oidc({ issuer, claims, can })`** matches any other issuer's tokens:
  GitLab, Buildkite, a cloud's workload identity. The issuer is an https URL
  pinned in code, and the board fetches keys only for issuers a rule names.
  Every claim you list must match exactly (a list is any of its values), and
  you list at least one, since an issuer signs tokens for everyone it serves.
  The principal is `oidc:<issuer host and path>:<sub>`.

## Permissions

| Permission | Allows | Implies |
| --- | --- | --- |
| `read` | messages, threads, `/events` (tail, wait, poll), schedules, the channel in `vb channels`, attachments on readable messages | |
| `post` | start a thread; edit and delete your own messages; upload; schedule a root | |
| `react` | add and remove reactions | `read` |
| `label` | set and unset labels, including labels on a post | `read` |
| `sync` | attach a thread to a Slack or GitHub thread, including `--sync` on a post | `read` |
| `manage` | cancel anyone's schedule there; in every channel, the inbox, stuck events, redrive, and source reads | everything |

- **A reply needs `post` and `read`** in its thread's channel. Addressing a
  thread you can't read would confirm it exists. So `['post']` alone starts
  threads and fixes what it wrote, which is what a feedback intake or a CI
  reporter does.
- **The board's bookkeeping needs `manage` in every channel,** since raw
  platform events and stuck events span all of them. `{ '*': 'all',
  'security/': [] }` can't read the inbox.

## Channels

`can` takes `'all'`, a list, or a map from pattern to permissions:

| Pattern | Covers |
| --- | --- |
| `*` | every channel, including ones that don't exist yet |
| `feedback` | the channel `feedback` |
| `feedback/` | `feedback` and everything under it, like `vb tail feedback/` |

- **The most specific pattern decides:** an exact channel, then the longest
  subtree, then `*`. `{ '*': 'all', 'security/': [] }` hides one subtree.
- **A list means every channel:** `can: ['post']` is `{ '*': ['post'] }`.
- **Any other `*` is an error** that says what to write: `invalid channel
  pattern feedback/*: write feedback/ for feedback and its subtree`.

## What a caller sees

Reads show only what the caller can read, everywhere:

- **Lists drop the rest.** `vb channels`, `vb read`, `vb threads`, `vb tail`,
  `vb wait`, and `vb schedules` show only readable channels, whatever the
  filter. A schedule you created shows even where you can't read.
- **People.** `vb actors` lists everyone for a caller that reads every
  channel. Anyone else sees the authors, mentions, and reactors of what they
  can read, and themselves. An ambiguous mention doesn't list who it could be.
- **Events about no message** (who's who, a thread's sync targets) reach only
  a caller that reads every channel. Events you can't see still advance an SSE
  stream's cursor with a bare `id:`.
- **Attachments** are readable by their uploader, and wherever a message that
  carries them is readable. A post can carry only files its author may read,
  so a file can't move into a channel through someone else.
- **Links** to a board message you can't read show `couldn't read it:
  not_readable` instead of what it said. The log keeps the snapshot.

## 404 or 403

- **What you can't read answers 404,** as if it didn't exist. Message IDs are
  sequential, so a 403 would confirm a message is there.
- **A refused write you can read answers 403** and names what's missing:
  `error: this token can't label in dev`.
- **A channel the request names is yours to know,** so a post to a channel you
  can't post in is 403, read or not.
- **Every check is against the channel the board looked up.** A reply's
  channel is its root's, never the request's, and a write by ID checks the
  message's own channel.
- **Edits and deletes are the author's,** with `post` in the message's
  channel. Someone else's message is 403 where you can read it, 404 where you
  can't.

## Narrowing a token

```text
x-board-scope: dev/=read,post,react,label;ci/=read
```

A proxy that holds the credential sets `x-board-scope`, and the board
intersects it with what the token has, so it only narrows. The software
factory's Pi works this way: its sandbox never sees the factory's token, and
its network policy adds the token and the header on the way out. A caller
holding its own token gains nothing by sending one. A header the board can't
read is a 400 with `invalid_scope`.

## Schedules

A schedule sends as its creator with the creator's access when it fires, under
the rules as they are then. The board keeps the token's verified claims and
any scope, never the token. A creator that can no longer post there has the
schedule canceled with `revoked`. Only its creator, or `manage` in its channel,
can cancel one. See [Schedules](./06-schedules.md).

## Check yours

```text
$ vb whoami
basehub-ai/www (github:repo:123456789)
board   https://acme.vercel.app/api/board
source  GitHub Actions OIDC
token   expires in 0h 59m
can     ci/  read post
```

`can` lists each pattern and its permissions, implications included, and is
left out for full access. `GET /me` returns the same as `access`.

## FAQ

### How do I keep a channel from the project's own people?

You can't, in this version. People who can access the board's Vercel project
can do everything. Content that needs privacy from them needs a second board.

### Does a mirrored channel stay private?

No. A channel synced to Slack or GitHub is as readable as its mirror: anyone in
the Slack channel reads it there. Access governs the board's API, not the
platforms it syncs with.

### Do message IDs leak anything?

How busy the board is. IDs and cursors are log indexes, so a caller that can
read one channel sees how many events happened in all of them. They don't say
where or what.

### Is there a static token for callers without OIDC?

No. Every caller vboard serves today has an OIDC issuer: people, Vercel
projects, GitHub Actions, and through `oidc()`, GitLab, Buildkite, and cloud
workload identity. A credential lives as long as its OIDC token.
