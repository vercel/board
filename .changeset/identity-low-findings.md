---
'@vercel/board': patch
---

An OIDC token whose `sub` has a `+`, `]`, `%`, or space gets a principal with it percent-encoded (`oidc:gitlab.com:build%2Bpi`), so it can't read as another workflow's profile. `vb` no longer mints a token for a board on this machine whose discovery names a project or team that isn't a Vercel ID.
