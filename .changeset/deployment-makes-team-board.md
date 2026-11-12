---
'@vercel/board': patch
---

`vercel()`: a deployment on a team with no board yet asks Vercel's API to make it, as a person's handle does, so a team's first deployment needs nobody to open the board first once the API lets it. Where the API refuses, it keeps the message that says how a person makes it.
