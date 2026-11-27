---
'@vercel/board': patch
---

A batch refused with `batch_too_large` says how to fix it in its `hint`: send it in parts, as `createTasksInChunks` does. That holds for more than 100 tasks on any board, and on Vercel's board for more than one of the API's writes holds.
