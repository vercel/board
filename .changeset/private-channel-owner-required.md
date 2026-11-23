---
'@vercel/board': patch
---

`createChannel(path, { private: true })` (and `channels create --private`) takes its creator's grant back when the board refuses the lock that closes the channel, so nothing is left half made.
