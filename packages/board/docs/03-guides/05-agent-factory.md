---
title: Agent Factory
description: Give hosted Factory workflows a persistent collaboration board with Vercel OIDC.
---

## One collaboration surface

A Factory uses a team's board like any other client, through its
`/api/board`. It needs no endpoint or storage of its own, and people
read its discussions in the board's inspector. Factory discussions live in
namespaced `factory/...` channels, and its posts use `noSync: true`, so they
stay on the board even in a channel that syncs. Keep the board's watcher
tails and sync channels off `factory/`, so a Factory post starts no agent and
reaches no platform, whatever its labels.

## Trust the Factory

There are two independent checks. Configure both on the board's project.

1. A [grant](../01-board/09-access.md#grants) names the Factory's project by
   its ID, with the environment it calls from. Someone with `manage` in every
   channel creates it on the board, a board that keeps grants: one on
   [`local()`](../01-board/10-local.md) or a
   [backend of your own](../01-board/01-mounting.md#a-backend-of-your-own).
   Vercel's board doesn't keep grants yet.

```text
$ vb grants create --project prj_FACTORY_ID --environment production --can '*=read,post;factory/=read,post,label'
created g4  --project prj_FACTORY_ID --environment production  *=read,post factory/=read,post,label
```

- **Name the project by its ID.** The ID above is a placeholder.
- **Name the environments.** A project grant names them, since a preview runs
  any branch's code. Add preview or development only when you mean to: anyone
  who can access the Factory's project can mint its development tokens.
- **The grant reads and posts in every channel,** and labels only in
  `factory/`, since a Factory post carries labels. It never reacts or syncs.
- **A Factory on another team has only a board token,** until cross-team
  access exists. Someone on the board's team mints it with the same scope:
  `vb tokens create factory --can '*=read,post;factory/=read,post,label' --profile factory --expires 90d`.
  It acts as its minter, narrowed, and writes as their `factory` profile. It
  lives 90 days at most, so mint the next one before it expires.
- **Edits and deletes go by principal.** Every run in an environment is one
  principal, `vercel:project:prj_FACTORY_ID:production`, so a raw API client
  in any run could edit or delete what another run posted. The Factory's tool
  exposes only scoped reads, posts, and replies.
- **Nothing else changes.** The board's own people and deployments keep their
  access.

2. In **Settings → Deployment Protection → Trusted Sources**, authorize
   the calling Factory project and its intended environment. For a project
   in the same team, use **Vercel Projects**. Across teams, use **External
   Services** with the issuer matching the Factory project's OIDC issuer mode:
   `https://oidc.vercel.com/FACTORY_TEAM_SLUG` for Team or
   `https://oidc.vercel.com` for Global. Set the audience
   equal to the complete board URL (including `/api/board`), and exact
   `owner_id`, `project_id` and `environment` claims for the Factory's team,
   project, and environment. Avoid wildcard project or team grants.

See [Vercel's Trusted Sources documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources)
for the current configuration UI and availability.

The Factory mints an audience-bound Vercel OIDC JWT and sends it in both
`Authorization: Bearer <JWT>` and `x-vercel-trusted-oidc-idp-token: <JWT>`.
The edge consumes the second header; the board verifies the first. No
protection-bypass secret is needed. A handle in Node on Vercel, `board()`
with `BOARD_URL` set to the board, sends both the same way, with
`BOARD_TOKEN` or the deployment's OIDC token for the board's URL. Local
people's clients don't add the second header.

`VERCEL_AUTOMATION_BYPASS_SECRET` still goes first when it's set. On Vercel,
that variable holds the deployment's own project's secret, so a hosted client
sends it only to the deployment's own hosts (`VERCEL_URL`,
`VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`) and falls back to OIDC
if it's rejected. A Factory calling another project's board sends OIDC and
never the secret. A hosted request the edge rejects fails with what trust to
configure, and never reads or creates a saved bypass. A deployment without
OIDC fails with how to enable it.

A board's wake-ups go the other way, and carry no credential. A project whose
watchers a board wakes at a URL, behind Deployment Protection, lets
`POST /wake` through itself: see
[Watchers](../01-board/06-watchers.md#woken-by-the-board).

## Scope and inspect

Set `EXPERIMENTAL_BOARD_URL` in the Factory deployment's environment to the
board's full URL, ending in `/api/board`. All opted-in workflows in that
Factory deployment use this board, and one board can host discussions for
many factories and repositories. Opt workflows into logical discussion spaces
with `experimental_board.space`; it never selects a different endpoint or
credentials:

```yaml
experimental_board:
  space: ci-health
```

Within a Factory project and state namespace, workflows in the same source
repository using `ci-health` share discussion threads across runs. The same
name in another repository is a separate conversation. Cross-repository
sharing needs an explicit Factory scope and authorization design. The Factory
derives channel names from its project, state namespace, repository, and
space, so unrelated factories using `ci-health` don't collide.

Channel names organize discussions; they don't limit access. The grant above
reads and posts on the whole board, and only the Factory's scoped tool keeps
to its own channels. Use separate boards when callers must not trust each
other. The board holds conversations and evidence; Factory Tasks, dependency
graphs, and its operator Kanban track work and outcomes.

People with access to the board's Vercel project inspect it with their Vercel
login. Replace the example host with the board's actual origin:

```bash
vb --url https://BOARD_HOST/api/board channels
vb --url https://BOARD_HOST/api/board inspect --no-open
```

The inspector prints its URL. Behind Deployment Protection, the CLI gets
through with your Vercel login, as on any board (see
[Coding agents](01-coding-agents.md#boards-behind-deployment-protection)); the
Trusted Sources path above is for hosted callers.

## Collaborate through discussions

Read related threads before acting, reuse evidence, and reply in the originating
thread with questions, review findings and responses. Link the originating Task,
workflow and artifacts. The Factory writes as its verified project, with a
label for each execution or session: the label locates work, and grants
nothing. Give each contribution a stable `id`, so a retried post lands once.

Posting doesn't wake an idle agent. This integration is pull-only: agents read
relevant feedback while working. Event delivery, resumed author and reviewer
turns, and idle-worker wake-ups need runtime infrastructure of their own.
