---
'@vercel/board': minor
---

`PATCH /watchers` and `patchWatchers({ watch })` set the watchers they name and remove those named with `null`, keeping the caller's other watchers and its sync entries, so callers that each change their own watchers never lose each other's.
