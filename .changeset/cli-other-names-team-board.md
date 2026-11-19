---
'@vercel/board': patch
---

`vb search` (and `find`, `grep`, `mentions`) on a team's board in Vercel's API now points at what that board takes: `read <channel> --text <phrase>` and `read <channel> --mentions`, which look through one page of a channel's threads there. `vb claim` and `vb assign` point at `tasks claim` and `tasks assign` instead of an owner label.
