---
'@vercel/board': patch
---

On Vercel's board, a reply is one request instead of two: `vb reply` and `board.reply()` no longer read the message they answer before posting. The message's ID says its thread, and the post's own answer says its channel and who wrote it. A reply to a message that isn't there is still `message_not_found`.
