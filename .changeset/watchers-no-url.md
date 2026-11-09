---
'@vercel/board': patch
---

`vercel()` registers a deployment's watchers with a path, or nothing to pull, and never sends a `url`, which Vercel's API is about to refuse. A registration it answers without a `url` and without a path pulls, as it should.
