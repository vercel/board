---
'@vercel/board': minor
---

On Vercel's board, only a deployment's own credentials register watchers: its OIDC token, never a board token, whoever made it. This breaks a board run as a person (`next dev` with your `vercel login`, `VERCEL_TOKEN`) or with a board token (`BOARD_TOKEN`, a `fetch` that sends one), which registered its watchers as that person or project. Now its config's watchers run in this process as tails: each follows the board's feed from its first use, as `vb tail` does, retries as on a local board, and writes as its credentials with the watcher's ID as its profile. Sync doesn't run for it. A board token in a `fetch` passed to the board is found out by the API's refusal of its first registration, and never tries again.

A deployment registers its mount path from production or a branch's preview, and anywhere else no URL: it pulls its matches instead of being woken. `register()` on Vercel's board refuses a `url` (400 `invalid_request`), and the API's 403 `watchers_need_project` comes back as a handle error with a hint, which `vb` reports as reason `watchers_need_project`; `board_token_unsupported` is gone. The conformance kit skips its watchers checks on `watchers_need_project`.
