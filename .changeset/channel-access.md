---
'vboard': minor
---

Access is per channel. The board's code says what each caller may do in each channel (`read`, `post`, `react`, `label`, `sync`, or `manage`), reads are gated, and what a caller can't read answers 404. `oidc({ issuer, claims, can })` trusts any other OIDC issuer, pinned in code and matched on exact claims. A proxy that holds the credential can narrow it with an `x-board-scope` header. `GET /me` returns `access`, and `vb whoami` prints where its token came from and, when it's less than everything, what it can do. See the new Access page.

Breaking changes:

- `trustedSources` is now `access`, and `vercel()` is now `vercelProject()`. Each rule's `can` is required, and takes a channel map (`{ 'feedback/': ['post'] }`); a list still means every channel.
- `can: ['post']` no longer reads. A rule that reads lists `read`; `react`, `label`, and `sync` imply it. A reply needs `post` and `read` in its thread's channel.
- Labels on a post or a schedule need `label`.
- The board's own deployments get everything only in the environment the board runs in (`VERCEL_TARGET_ENV`, else `VERCEL_ENV`). Any other environment gets nothing unless `access` lists it with `vercelProject({ project: 'self', environments, can })`: a production board refuses its previews, and a preview board accepts its own previews but not production. Outside Vercel, only people get in without a rule. Its people still get everything.
- Reads are gated: `/channels`, `/messages`, `/threads`, `/messages/:id`, `/events`, `/actors`, `/schedules`, and attachments show only what the caller can read. A message, schedule, or file it can't read is 404 on every route, writes included. Events about no message (`actor.*`, `thread.synced`) reach only a caller that reads every channel.
- A schedule's creator lists and cancels it only while it can post in the schedule's channel; anyone else needs `read` to list it and `manage` to cancel it. Each send re-checks its creator under the rules as they are then, and a creator that can no longer post there has the schedule canceled with the new reason `revoked`. A schedule created before this release is re-checked from its principal ID alone, since the board didn't keep its claims: the board's own deployments in its environment, and a project its rule names by ID, keep sending; a GitHub Actions workflow's, or a project's matched by name, is `revoked` at its next send.
- An attachment is readable by its uploader and wherever a message carrying it is readable; a post can carry only files its author may read. Deleting a message stops its files being readable through it.
- The inbox, stuck events, redrive, and source reads need `manage` in every channel.
- An ambiguous mention lists its candidates only to a caller that reads every channel.
