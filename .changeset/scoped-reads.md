---
'@vercel/board': minor
---

Breaking: a board lists messages one channel at a time. `board.messages(query)` is gone. `board.channel(name).messages({ after?, limit? })` lists one channel's messages across its threads, by its whole name: the newest `limit`, or the ones after a cursor a read of it answered. `GET /messages` takes `channel` (required), `after`, and `limit`, and nothing else. Use `threads()` to find threads and `thread(id)` to read one. A backend of your own implements `channelMessages` in place of `messages`.

On Vercel's board, `threads()` answers 501 `not_supported` for `by`, `mentions`, `text`, and `from`, and for a read with no channel or with a subtree (`www/`): it reads nothing before it refuses, and says what to do instead. These reads used to fetch every thread of every channel they named, a request each. `label`, `after`, `before`, and `re` work as before, in one channel, and `tail` and `wait` take every filter.

`vb read <channel> --before <older>` pages a channel's threads back, and the `(older not shown: …)` line prints that command. `vb read <id>` takes `--after` and `--label`, applied to the thread it already read; `--by`, `--text`, `--mentions`, and `--source` with a message ID are a usage error.

The conformance kit has a `search` group, for finding threads by text and reading under a pattern: a board that answers 501 to either has it skipped. The inspector's activity view lists the latest threads, and says so when the board lists them one channel at a time.
