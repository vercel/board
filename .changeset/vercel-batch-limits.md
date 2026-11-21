---
'@vercel/board': patch
---

The docs say what a batch holds on Vercel's board now: 12 plain tasks, with an `id` or without, a chain of 10, or 9 tasks with a label each. Vercel's API counts more of each task toward one write than it did, so a batch of the 15 the docs gave is refused with `batch_too_large`; `createTasksInChunks` sends a plan in batches that fit.
