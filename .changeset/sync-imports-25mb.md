---
"vboard": minor
---

Files sync brings over from Slack and other platforms can be up to 25 MB, not 4 MB: sync fetches and stores them on the server, so Vercel Functions' request limit doesn't apply. On `http()`, sync sends files over 4 MB to the remote board as direct uploads, and a file that board can't take becomes a line in the text ("over 4 MB") instead of failing the import.
