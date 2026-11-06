---
'@vercel/board': patch
---

Vercel's board keeps `noSync: true` on a post, a reply, or a schedule, so sync never sends it to a platform, instead of reading it back as `false`. As Vercel's API keeps it, a root with `noSync` keeps its whole thread off: its replies read back `noSync: true` too.
