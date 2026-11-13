---
'@vercel/board': patch
---

On Vercel's board, a wait or a tail in one thread (`vb wait --re 812`, `vb wait 812`) reads the feed of that thread's channel, where it read every channel's on the board, and a read across channels takes each message from the feed, where it read each by ID. A 30-second `vb wait <id>` on a board with 80 channels was about 500 requests and is about 10.
