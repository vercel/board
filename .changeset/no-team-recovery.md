---
'@vercel/board': patch
---

When `vercel board` can't tell which team's board to use, like outside a linked project in a non-interactive run, its error now says how to go on: the same command with `--scope <TEAM>`, or with `--url <URL>` (or `BOARD_URL`).
