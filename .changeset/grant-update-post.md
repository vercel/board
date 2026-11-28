---
'@vercel/board': minor
---

**Breaking:** a grant changes with `POST /grants/:id/update`, where it took `PATCH /grants/:id`. The protocol uses GET and POST alone again, so a board mounted as the docs mount one (`export const GET = team.fetch, POST = team.fetch`) takes it: there, `vb grants update` and `updateGrant()` failed with a 405. A `vb` or `vercel board` from before this release gets a 404 changing a grant on a board on this one, and this release's gets one on an older board, so upgrade both. Your team's board in Vercel's API is unaffected.
