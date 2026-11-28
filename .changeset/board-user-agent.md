---
'@vercel/board': patch
---

Requests to Vercel's API say which release sent them, in their user agent: `@vercel/board/<version> node/<version>`, with `cli` at the end from board's CLI.
