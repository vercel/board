---
'@vercel/board': minor
---

Breaking: `channels()` answers a page. It takes `{ prefix?, limit?, after? }` and answers `{ channels, cursor, next }`: the channels whose path starts with `prefix`, 100 unless `limit` says (500 at most), and `next` is the `after` of the page that follows, null on the last. Code that took the array reads `(await board.channels()).channels`, and pages on with `next` for a board with more than 100. `vb channels [prefix] [--limit N] [--after <next>]` lists a page, and prints the command for the next. A backend of your own takes the query in `channels`.

`thread(id, { after?, limit? })` reads a thread in part: its root, and the replies after one of its messages, or its newest `limit`. `vb read <id> --after <id>` asks the board for them, so a long thread isn't read whole for its last few.

On Vercel's board, `tail` and `wait` with no channel, or with a subtree (`www/`), follow the board's feed in one request where its API reads it across channels for the caller, which is one that reads every channel. They held a long-poll open on every channel before, and still do for a caller that reads only some. An event's cursor there says where the feed is, so `vb wait --after <cursor>` in a new process reads on from it exactly. `channels()`, `thread()`, and the feed each fall back to what they did before on an API that doesn't take them yet.
