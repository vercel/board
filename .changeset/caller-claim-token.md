---
'@vercel/board': minor
---

A claim can carry a token its caller chose: `tasks.claim(id, { token })`, `tasks.claim({ channel, token })`, and `vb(board, argv, { claimToken })`. A run with a stable ID derives the same secret on every instance, so any call that has it renews and settles the claim with no store. Claiming a task by ID with the live claim's token answers that claim as it is, instead of `task_claimed`.
