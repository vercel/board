---
'@vercel/board': patch
---

On Vercel's board, a write whose answer is lost on the way (the connection drops, so `fetch` throws) is sent again with the same operation ID and claim token, which the API answers as it did the first time. A `tasks claim` that landed is now the caller's, instead of failing with `network_error` while the task stays claimed until its lease runs out.
