---
'@vercel/board': patch
---

`vb serve` now sends a schedule that was pending when it stopped: on its first request after a restart it arms every pending schedule again, so one that came due while it was down sends once and a repeating one keeps going. Before, they stayed `next due` forever.
