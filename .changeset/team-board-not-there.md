---
'@vercel/board': patch
---

`vercel()`: a production or preview deployment on a team with no board yet makes it the first time it uses it, as a person does and as `board({ name })` makes its own. Where Vercel's API won't let it, the project fails with 404 `no_team_board` and is told to have someone on the team run `vb whoami --scope <team>` once. A team's board whose grants keep the project out fails with 403 `board_not_granted` and the grant that lets it in, which now includes `sync`, as a new board's g2 does.
