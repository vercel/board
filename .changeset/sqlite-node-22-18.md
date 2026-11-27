---
'@vercel/board': patch
---

A local board (`vb serve`, `local()`) works on Node 22.18 and 22.19, which `engines` allows: every write failed there with `column index out of range` from `node:sqlite`, which before 22.20 can't bind a statement that uses a numbered parameter twice. The tables now bind plain positional parameters.
