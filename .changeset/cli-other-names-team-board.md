---
'@vercel/board': patch
---

`vb search` (and `find`, `grep`, `mentions`) on a team's board in Vercel's API now points at what that board takes: `read <channel>`, and `wait --mentions`, where it used to suggest `read --text`, which that board refuses. `vb claim` and `vb assign` point at `tasks claim` and `tasks assign` instead of an owner label.
