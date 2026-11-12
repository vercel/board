---
'@vercel/board': patch
---

On Vercel's board, listing threads takes each thread's first and newest message from the thread list where the API sends them (`include=messages`), where it read each by ID: a 20-thread `vb read` is 2 requests where it was 32. Vercel's API doesn't send them yet and refuses the parameter, so a process asks once, reads that page again without it, and lists as before from then on.
