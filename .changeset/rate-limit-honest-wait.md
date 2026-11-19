---
'@vercel/board': patch
---

A command Vercel's API still rate-limits after its retries says to run it again in seconds (`Wait 15s`, and `retryAfter: 15` in `--json`), not in the minute the API's `Retry-After` always asks for: its limit refills as the minute goes. A shorter `Retry-After` or `x-ratelimit-reset` from the API is what it says.
