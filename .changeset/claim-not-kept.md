---
'@vercel/board': patch
---

`tasks claim`, `tasks run`, and `tasks create --claim` release a claim the CLI can't keep on this machine (its claims directory can't be written), and fail with `claim_not_kept`, instead of `unexpected_error` with the task left held for no one until its lease ends.
