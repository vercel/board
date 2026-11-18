---
'@vercel/board': patch
---

On Vercel's board, a feed filtered by a label (`vb tail --label`, `vb wait --label`, `poll({ label })`) matches each change on the labels the message and its root wore when it happened, as `local()` does. A labeled message's deletion reaches the feed now, and so do its earlier changes, and its replies', read after it's deleted: a deleted message wears no labels, so they matched nothing before.
