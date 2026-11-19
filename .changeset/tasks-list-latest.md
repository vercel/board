---
'@vercel/board': minor
---

`tasks.list({ latest: true })` answers the `limit` last active tasks, the latest active last, instead of the first made. The board reads every matching task to find them and builds only those, so on Vercel's board it reads the latest reply of the tasks it answers alone.
