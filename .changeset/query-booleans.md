---
'vboard': patch
---

`?all=false` means false. `GET /events` and `GET /schedules` read `all` as `true` or `1`, `false` or `0`, and answer 400 for anything else. Before, any value turned it on, so `all=false` showed delivery receipts and done schedules.
