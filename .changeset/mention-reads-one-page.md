---
'@vercel/board': minor
---

On Vercel's board, `vb read <channel> --mentions` and `--text` (`threads({ channel, mentions })`, `threads({ channel, text })`) answer from the one page of the channel's threads a plain read lists, keeping the threads whose first or newest message matches, where they were 501 `not_supported`. They cost the requests a plain read sends, and one more for who `me` is: the actors their mentions name are asked for by ID, together, as a plain read's are. The page says how many threads it looked through, as `scanned`, and its `older` pages back the same way. The CLI prints `(looked through N threads, at the first and latest message of each: a match under a newer reply is not found)`, the `--before` line for older ones, and, for what's new since, the `wait` with the same filters from the read's cursor, so a mention posted after the read isn't missed. `--by` and `--source` there are still 501, and so are `mentions` and `text` with `re`, `label`, or `after`.
