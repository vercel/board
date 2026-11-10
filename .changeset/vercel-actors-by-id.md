---
'@vercel/board': patch
---

`vercel()` names the authors on a page by asking Vercel's API for those actors by ID, in one request, where it read the board's whole list of actors, 50 at a time: a `vb read` on a board with hundreds of agents spends one request on names. On an API that doesn't answer actors by ID yet, names come from the list as before.
