---
'@vercel/board': patch
---

`vb tasks create <channel> <text>` takes `--attach`, as `post` does, so a task's files go on its root instead of a separate reply. Making a task of a thread that's there, or of a plan (`--file`), refuses it: a plan's tasks take their files as `attachments`.
