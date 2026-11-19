---
'@vercel/board': patch
---

`vb tasks create --file` says what a need looks like when it refuses one: a task's ID as vb prints it, or `{"key": "fix"}` for a task of the plan's own, and a need like `{"id": "msg_…"}` is told the ID to write instead.
