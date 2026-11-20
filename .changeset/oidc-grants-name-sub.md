---
'@vercel/board': minor
---

An `oidc` grant names its tokens' `sub`: `vb grants create --oidc https://gitlab.com --claim 'sub=project_path:acme/api:*' --claim project_id=42 --can 'ci/=post'`. An issuer like GitLab.com signs tokens for everyone it serves, so a grant for `ref=main` let in anyone's job on main, and `sub` is the one claim that says whose a token is. A `sub` that ends in `*` right after a `:` or `/` matches how one starts, so `project_path:acme/api:*` is any job in `acme/api` and none in `acme/api-evil`. A grant without a `sub`, with `sub` `*`, or with a `*` anywhere else in it (`organization:acme*`) is 400 `invalid_grant`; other claims still match exactly and narrow it, and a `*` in them is just a `*`. Grants made before still let in what they did, and a principal without a `sub` can still be removed from one. `subPrefix` from `@vercel/board/access` says what a `sub` pattern matches the start of.
