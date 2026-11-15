---
'@vercel/board': minor
---

Breaking: Vercel's board never sends `VERCEL_TOKEN`. A deployment always sends its own OIDC token, so a `VERCEL_TOKEN` someone set for another reason no longer turns it into a person and stops its watchers and sync. Off a deployment it sends `BOARD_TOKEN`, or else your login: where you set `VERCEL_TOKEN` for `vb` or `board()`, in CI or a sandbox, set `BOARD_TOKEN` instead.
