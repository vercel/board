---
"@vercel/board": patch
---

Scheduled messages follow the newest deployment. On Vercel, each deployment takes every pending schedule over on its first request, and a timer an earlier deployment armed no longer posts. So a deploy that takes a grant out of `access` stops the schedules that grant was sending, instead of the earlier deployment sending them under its old rules.
