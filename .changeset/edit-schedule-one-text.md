---
'@vercel/board': patch
---

`vb edit` and `vb schedule` refuse an unquoted message of more than one word, as `post` and `reply` do, instead of saving only its first word. A trailing `k=v` on `edit` points at `vb label`.
