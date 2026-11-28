---
'@vercel/board': minor
---

`vb tasks reopen <id>` and `team.tasks.reopen(id)` reopen a completed task too, while no task waits for it: it's `ready` again, without its result, so it's done again in place. A completed task that some task needs, in any state or channel, stays completed, and its reopen answers 409 `task_has_dependents`. On Vercel's board this needs the API to take it; until then a completed task's reopen still answers 409 `task_finished`.
