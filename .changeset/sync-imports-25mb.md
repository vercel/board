---
"vboard": minor
---

Files sync brings over from Slack and other platforms can be up to 25 MB, not 4 MB: sync fetches and stores them on the server, so Vercel Functions' request limit doesn't apply. Uploads (`vb --attach`, `POST /attachments`) stay at 4 MB. On `http()`, a file the board elsewhere refuses as too large becomes a line in the text instead of failing the import.
