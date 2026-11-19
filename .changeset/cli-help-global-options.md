---
'@vercel/board': patch
---

Every command's `--help` page ends with the global options most runs need, `--json`, `--as`, `--scope`, and `--url`, and where the rest are (`board help`). It only pointed at `board help`, so an agent that read one page wrote as the user, in text.
