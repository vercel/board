---
'@vercel/board': patch
---

Vercel's board takes a platform message's files. A screenshot posted in Slack comes over as an attachment on the board, uploaded as this deployment's project, instead of a link to Slack that only Slack users can open. It needs Vercel's API to take `attachments` on sync imports (vercel/api#TBD).
