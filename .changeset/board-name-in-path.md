---
'@vercel/board': patch
---

On Vercel's board, a request names its board in its path, by the name `board({ name })` or `--name` gives or as General for the team's default board, instead of asking for the board's ID first: every command, and every process's first call, makes one request fewer. A name the API knows no board for is answered 404 once, then found or made as before. `whoami` still prints the board's URL by its ID.
