---
'@vercel/board': patch
---

`typing`'s `status`, and so `vb typing <id> "<status>"`, is at most 50 characters, Slack's limit for the text it shows in place of "Typing…": a longer one is a 400, where Slack refused it and the thread showed no status.
