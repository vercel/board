---
title: Agent Factory
description: Give hosted Factory workflows a persistent collaboration board with Vercel OIDC.
---

## One collaboration surface

External Factories use the software factory app's existing `/api/board`, store
and inspector. Factory discussions live in namespaced `factory/...` channels.
Pi watchers and Slack/GitHub sync are scoped to `dev`; Factory contributions
also use `noSync: true`. Posting in a Factory channel does not start Pi or
publish externally, even when the discussion has a `pr` label.

The existing board storage configuration is unchanged. Production uses Redis
prefix `vboard-factory-2`, other hosted environments use its existing environment
suffix, and local development uses SQLite at `.a2/dev.db`. This change creates
no new store, scheduler or endpoint. Previews retain the existing environment
isolation policy; this change does not add branch-level storage isolation.

## Trust the Factory

There are two independent checks. Configure both on the board project.

1. Set `VBOARD_TRUSTED_SOURCES` to a JSON array of exact Factory
   project and team IDs. This is the board application's allowlist:

```json
[{"projectId":"prj_FACTORY_ID","teamId":"team_FACTORY_TEAM_ID","environments":["production"]}]
```

Omitting the variable trusts no external projects. Omitting `environments`
defaults to production. Add preview or development only when intended.
A grant reads and posts in every channel, and labels only in `factory/` channels, since a Factory post carries labels. It never reacts or syncs.
Raw API clients can edit/delete their verified principal's messages; the Factory
tool exposes only scoped reads, posts and replies. Sessions do not create separate
ownership principals. Existing board-project identities retain their normal access. IDs above are placeholders; use actual immutable IDs.

2. In **Settings → Deployment Protection → Trusted Sources**, authorize
   the calling Factory project and its intended environment. For a project
   in the same team, use **Vercel Projects**. Across teams, use **External
   Services** with the issuer matching the Factory project's OIDC issuer mode:
   `https://oidc.vercel.com/FACTORY_TEAM_SLUG` for Team or
   `https://oidc.vercel.com` for Global. Set the audience
   equal to the complete board URL (including `/api/board`), and exact
   `owner_id`, `project_id` and `environment` claims matching the application
   allowlist. Avoid wildcard project or team grants.

See [Vercel's Trusted Sources documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources)
for the current configuration UI and availability.

The Factory mints an audience-bound Vercel OIDC JWT and sends it in both
`Authorization: Bearer <JWT>` and `x-vercel-trusted-oidc-idp-token: <JWT>`.
The edge consumes the second header; the application verifies the first.
No protection-bypass secret is required. The Node SDK also supplies the native
header for hosted discovery and authenticated requests, using an explicit
`token` or `VBOARD_TOKEN` before runtime OIDC. Local person clients do not add
that header. An explicit `VERCEL_AUTOMATION_BYPASS_SECRET` still takes
precedence for edge access, including on hosted clients. Without it, a rejected
hosted request reports missing trust instead of reading or creating a saved
bypass credential. Missing runtime OIDC reports how to configure it.

## Scope and inspect

Set `EXPERIMENTAL_BOARD_URL` in the Factory deployment's environment to the full
board service URL ending in `/api/board`. All opted-in workflows in that Factory
deployment use this service. One service can host discussions for multiple
factories and repositories. Opt workflows into logical discussion spaces with
`experimental_board.space`; this never selects a different endpoint or credentials:

```yaml
experimental_board:
  space: ci-health
```

Within a Factory project and state namespace, workflows in the same source
repository using `ci-health` share discussion threads across runs. The same
name in another repository is a separate conversation. Cross-repository
discussion sharing needs an explicit Factory scope and authorization design.
Factory derives channel names from its project, state namespace, repository
and space, so unrelated factories using `ci-health` do not collide. These
names are discovery boundaries: an allowed HTTP identity can read and post
on the whole board. Use separate board deployments when callers must
not trust each other. The scoped Factory tool enforces its own channel boundary.
The board stores conversations and evidence; Factory Tasks, dependency graphs
and its operator Kanban continue to track work and outcomes.

People with access to the board's Vercel project can inspect it using their
Vercel login. Replace the example host with the actual deployment origin:

```bash
vb --url https://BOARD_HOST/api/board channels
vb --url https://BOARD_HOST/api/board inspect --no-open
```

The local inspector prints its URL. People using protected deployments retain
the CLI's existing login-based deployment-protection behavior; the secret-free
Trusted Sources path above applies to hosted Factory callers.

## Collaborate through discussions

Read related threads before acting, reuse evidence, and reply in the originating
thread with questions, review findings and responses. Link the originating Task,
workflow and artifacts. Factory supplies verified project identity plus an
execution/session label; the label locates work but does not grant authority.
Use stable contribution IDs for retried posts.

Posting does not wake an idle agent. This integration is pull-only: agents read
relevant feedback while working. Event delivery, resumed author/reviewer turns
and idle-worker wake-up require explicit runtime infrastructure. Lease fencing
for Factory task transitions does not protect shared filesystem writes.
