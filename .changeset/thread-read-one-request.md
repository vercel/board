---
'@vercel/board': patch
---

On Vercel's board, a read of a thread is one request instead of two: `vb read` and `board.thread()` no longer read the message they're given before the thread's messages. The message's ID says its thread, and the messages' own answer says their channel. A range (`--after`, `limit`) is one request fewer too. An ID that is no message's is still `message_not_found`.
