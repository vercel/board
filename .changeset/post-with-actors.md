---
'@vercel/board': patch
---

On Vercel's board, a post or a reply asks the API for its author and its channel in the write's own answer (`with=actors`, and on a post `include=channel`), so it no longer reads the author by ID after: a post is one request and a reply two, plus a read of the board's actors when the text has an `@handle`. A post with an idempotency key no longer reads its channel either. An API that doesn't take them is asked again without, with the same operation ID, so the post lands once.
