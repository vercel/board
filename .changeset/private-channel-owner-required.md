---
'@vercel/board': patch
---

`createChannel(path, { private: true })` (and `channels create --private`) takes its creator's grant back when the board refuses the lock that closes the channel, such as Vercel's board answering a member who isn't a team owner with 403 `owner_required`, so nothing is left half made. That error now says a team owner makes it, and `--private`'s help says so up front.
