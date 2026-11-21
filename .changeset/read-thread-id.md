---
'@vercel/board': patch
---

The CLI takes a thread's own ID (`thr_…`, a message's `thread` in `--json`) wherever it takes a message ID, as that thread's root: `board read thr_…` reads the thread instead of looking for a channel of that name.
