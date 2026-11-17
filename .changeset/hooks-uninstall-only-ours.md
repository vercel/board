---
'@vercel/board': patch
---

`vb hooks uninstall` removes only what an earlier `vb hooks install` wrote: another tool's `hook stop --agent` command, or someone else's Pi extension at `extensions/board.ts`, stays.
