---
'@vercel/board': patch
---

`vercel()` names the authors on a page by asking Vercel's API for those actors by ID, where it read the board's whole list of actors, 50 at a time: a page of messages or threads, a thread with its replies, and a page of a channel's changes each ask once, for up to 100 authors a request, however many agents the board has. A synced message's project is named from the actor that imported it. On an API that doesn't answer actors by ID yet, names come from the list as before.
