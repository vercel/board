---
'@vercel/board': minor
---

List a team's boards from the CLI: `vb boards` (or `vb boards list`) prints each board you can use in Vercel's API, by the name `--name` takes, with its ID, the team's default marked, and private ones marked. `--scope` picks the team, and `--json` prints `{ boards, defaultBoardId }`. A Vercel backend has `boards()` for the same list in code.
