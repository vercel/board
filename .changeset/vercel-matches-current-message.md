---
'@vercel/board': patch
---

On Vercel's board, a watcher hands out each match with the message the pull brought (`currentMessage`), where it read each one by ID: a pull of 10 matches is 1 request where it was 11. A match without one, as for a thread moved to a channel the watcher can't read, is read by ID as before.
