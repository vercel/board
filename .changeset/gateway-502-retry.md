---
'@vercel/board': patch
---

On Vercel's board, a request its gateway answers 502 or 504 goes again after a second, doubling each time, as a 503 does: reads always, and writes the API can tell it has seen. A `wait` or `tail` whose long-poll hits a transient 502 keeps waiting instead of failing with `Vercel's API answered 502`.
