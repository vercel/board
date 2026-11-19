---
'@vercel/board': patch
---

`vb tasks create --file` says what a need looks like when it refuses one: a task's ID as it is, like `"812"`, or `{"key": "fix"}` for a task of the plan's own. An object such as `{"id": "812"}` was refused with only "isn't a task's ID".
