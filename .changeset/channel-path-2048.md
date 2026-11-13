---
'@vercel/board': minor
---

Channel paths can be up to 2048 characters, up from 80. The board no longer holds a path to a backend's own limit: on `vercel()`, Vercel's API still caps channel names at 80 for now, and refuses a longer one with its `invalid_channel_name`. Clients on an older `@vercel/board` still refuse paths over 80 in events and requests, so upgrade them along with the board.
