---
'@vercel/board': patch
---

`vb schedules <schedule id>` asks the board for that schedule alone (`schedules({ id })`, `GET /schedules?id=`) instead of listing every schedule to find it. On Vercel's board that is one read of the schedule (`GET /schedules/:id`), its channel, and its creator, where it paged the whole list and read every schedule's channel. An API without that route still gets the list, once per process, and only the schedule shown has its channel read.
