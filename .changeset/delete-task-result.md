---
'@vercel/board': patch
---

Deleting a task's root on a local board drops its result, and a reason someone gave when canceling it, with the rest of the text: before, `vb read` showed them on the tombstone. A task the deletion cancels still says `deleted`.
