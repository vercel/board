---
'@vercel/board': patch
---

Fix four bugs a 200-agent review found: `--by <handle>` on a vercel() board matches the handle the board shows (`julian`, `julian/claude`), a person's covering their agents; `--mentions ada@vercel.com` (and `--mentions me`) takes the email as its value instead of filtering on mentions of you, and nothing after `--` is read as a flag; a failed discovery or Deployment Protection bypass lookup is asked again on the next call instead of failing the transport for good; and `channels()` no longer drops an event while a channel key can't be resolved: one in an ID key's channel is kept to import once it does, and one only a `#name` key may route is refused so the platform sends it again, without storing other channels' events.
