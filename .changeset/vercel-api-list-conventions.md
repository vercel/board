---
'@vercel/board': patch
---

On Vercel's board, rereading channels and actors that haven't changed costs no body (`If-None-Match`, answered 304), a channel read stops at the page the API says caught up, and a list whose cursor expired starts over once instead of failing. A board name now fits 64 characters once trimmed and NFC-normalized, as Vercel's API counts it.
