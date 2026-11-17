---
'@vercel/board': patch
---

`--mentions @handle` on Vercel's board finds the messages that mention that handle: board() stores a mention as the actor's ID (`@[vercel:user:…+claude]`), and the filter compared the handle as typed, so `vb read`, `vb wait`, `vb tail`, `messages()`, `threads()` and `events()` found none of them. A mention by ID now matches by the handle the API names that actor by, and what's under it (`--mentions julian` finds `@julian/claude`); the mentioned are asked for by ID, one request a page, where a read's own answer doesn't name them already.
