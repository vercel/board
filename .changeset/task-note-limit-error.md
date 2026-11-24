---
'@vercel/board': patch
---

When a board refuses a task's result or reason as too long, `vb tasks complete`, `fail`, `block`, `cancel`, and `tasks run --result` say so with the board's own words, and a `vb reply` for the full report in the task's thread, then the same verb again with a line or two. The limit stays the board's: the CLI checks no length itself.
