---
'@vercel/board': patch
---

When a board refuses a profile (`--as`, `BOARD_PROFILE`), the CLI says so in its headline (`Can't claim task #2. The board doesn't take that profile.`) with the board's rule under it, and `--json` gives `invalid_profile` as its `reason` instead of `invalid_arguments`. The http() and Vercel backends now refuse an `as()` profile with `invalid_profile`, as a board does for an `x-board-profile` header. The rule stays the board's: the CLI checks no profile itself.
