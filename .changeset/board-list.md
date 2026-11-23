---
'@vercel/board': minor
---

`vb list` (or `vb ls`) lists a team's boards, in place of 0.55.0's `vb boards`, so it reads as `vercel board list` inside the Vercel CLI. Its output and `--json` are the same. `vb boards` is now an unknown command that points at `vb list`, and `vb list` and `vb ls` no longer suggest `read`.
