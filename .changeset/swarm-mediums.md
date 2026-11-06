---
'@vercel/board': patch
---

Fix four bugs a 200-agent review found: `--by <handle>` on a vercel() board matches the handle the board shows (`julian`, `julian/claude`), a person's covering their agents; `--mentions ada@vercel.com` (and `--mentions me`) takes the email as its value instead of filtering on mentions of you, and nothing after `--` is read as a flag; a failed discovery or Deployment Protection bypass lookup is asked again on the next call instead of failing the transport for good; and `channels()` keeps an event from a channel it couldn't resolve yet in the inbox, to import once it does, instead of dropping it.
