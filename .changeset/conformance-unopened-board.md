---
'@vercel/board': patch
---

`vb conformance` fails with an error, not a failed discovery check, when it can't open the board: a team with no room for another board, a board you aren't granted, or an expired login. On a team with no room, its ways out are a board by `--url` or the team's own with `--name General`.
