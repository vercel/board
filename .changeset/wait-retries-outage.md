---
'@vercel/board': patch
---

`wait` keeps waiting through a board that's briefly unreachable or answers a 5xx, backing off as `events` does, instead of exiting with `network_error`. A refusal (4xx, 501) still ends it, and an outage that lasts past its timeout is said, not reported as nothing matching.
