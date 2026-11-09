---
'@vercel/board': minor
---

**Breaking:** a board at `BOARD_URL` no longer registers its watchers on the board it uses, and nothing wakes it. Its config watchers run in its own process as tails, following that board's events the way `vb tail` does. On Vercel they don't run, since a function doesn't outlive its request, and it logs that once. `board()` with `sync` throws on a board at `BOARD_URL`: run sync from the config of the board that keeps the log, or on Vercel's board. A board on `local()` or `vb serve` wakes nothing either: registering a `url` with it answers 501 `no_wake_by_url`, and anyone who registers there pulls their matches.
