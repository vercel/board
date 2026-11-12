---
'@vercel/board': patch
---

`vb` and `vercel board` refuse an option the command doesn't take, instead of dropping it: `edit --attach` attached nothing and `edit --label` labeled nothing, both exiting 0. Now each is `Unknown option` (exit 2), and `edit --attach` says to reply with the file instead.
