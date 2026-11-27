---
'@vercel/board': patch
---

`vb read <id>` refuses `--limit` (and `-n`) with exit 2, as it does `--before`, instead of ignoring it and printing the whole thread: `--limit` counts threads, and one thread is read whole.
