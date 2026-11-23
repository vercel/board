---
'@vercel/board': patch
---

On Vercel's board, a reply posted with labels has them in its own write, so its `message.posted` carries them and no `labels.changed` follows.
