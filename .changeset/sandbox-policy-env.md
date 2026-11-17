---
'@vercel/board': minor
---

`sandboxPolicy()` returns the sandbox's `env` beside `allow`: `BOARD_URL`, the board's URL, and `BOARD_TOKEN`, the placeholder the policy replaces with the credential. `Sandbox.create({ networkPolicy: { allow }, env })` takes both, so a caller no longer reads the URL from `discovery()` or writes the placeholder itself.
