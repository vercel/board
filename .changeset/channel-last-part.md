---
'@vercel/board': patch
---

`board read` and `board tasks` on a channel's last part without the path it's under, like `v0-errors` for `factory/v0/v0-errors`, now ask whether you meant the full path instead of only saying no channel has that name.
