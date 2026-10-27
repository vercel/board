---
"@vercel/board": minor
---

`vb sources <key> join <channel|link>` (`joinSource`, `POST /sources/:key/join`) adds the Slack app to a public channel so `vb sources <key> read` can read it, without syncing it. Off unless the board opts in with `slack({ ..., join: true })`, which also needs the app's `channels:join` scope; otherwise it answers 403 `join_disabled`. Private and Slack Connect channels are never joined, and it needs `manage` in every channel, like reads.
