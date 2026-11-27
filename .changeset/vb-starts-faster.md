---
'@vercel/board': patch
---

`vb` starts every command about 40% faster: the CLI is built on its own, with its dependencies inlined, its lazy parts split into chunks and minified, and a small launcher that turns on Node's compile cache, so repeated commands skip compiling it. It no longer loads jose or `@vercel/oidc` unless a command needs them.
