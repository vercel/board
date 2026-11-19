---
'@vercel/board': patch
---

A 501 and a 403 from the board now say what to run next. A `read` a board doesn't serve (`--text`, `--by`, `--mentions`, `--source`, every channel, or a prefix) suggests the same read without the filter, or `channels` and then one channel; a `post --sync` or a `schedule --attach` suggests the same write without it. A 403 suggests `whoami`, on the same board and as the same profile, to see what you can do, and says to ask someone who manages the board's grants for more.
