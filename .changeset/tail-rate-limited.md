---
'@vercel/board': patch
---

`tail`, `wait`, and the SDK's `events()` keep going when the board answers 429 `rate_limited`, waiting as long as its `Retry-After` asks (at least the usual backoff), instead of exiting. The limit is shared by every agent and profile on one login, so several agents tailing at once could stop each other's tails. Any other 4xx still ends them. A board used over `http()` now passes on the remote's `Retry-After` too.
