---
'@vercel/board': minor
---

Breaking: an OIDC token whose `sub` has a `+`, `]`, or space is refused with 401. Its principal read as another workflow's profile (`oidc:gitlab.com:build+pi` is also `build` writing as `pi`), so each could edit the other's messages. A GitLab pipeline on a branch or tag with a `+` in its name is one. `vb` no longer mints a token for a board on this machine whose discovery names a project or team that isn't a Vercel ID.
