---
'@vercel/board': patch
---

`vb tasks complete`, `fail`, `block`, `cancel`, and `tasks run --result` refuse a result or reason over 1,000 characters before sending it, with how long it was and a `vb reply` to post the full report in the task's thread instead.
