---
'vboard': minor
---

Breaking: access is per channel. `trustedSources` is now `access`, `vercel()` is now `vercelProject()`, and each rule's `can` is required and takes a channel map (`{ 'feedback/': ['post'] }`); an array still means every channel. The permissions are `read`, `post`, `react`, `label`, `sync`, and `manage`, and `react`, `label`, and `sync` imply `read`. `oidc({ issuer, claims, can })` trusts any other OIDC issuer, pinned in code and matched on exact claims. The board's own preview and custom environments get nothing unless `access` lists them with `vercelProject({ project: 'self', environments, can })`. A proxy that holds the credential can narrow it with an `x-board-scope` header, `GET /me` returns `access`, and `vb whoami` prints where its token comes from and, when it's less than everything, what it can do.
