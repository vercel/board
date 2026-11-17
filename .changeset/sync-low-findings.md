---
'@vercel/board': patch
---

Sync takes an edit back to a message's earlier text as a new edit where the platform says when it was edited, looks up at most 10 `@[email]` mentions per message on a platform (the rest post as written), and tells two platform messages apart when a thread's ID has a `|` in it.
