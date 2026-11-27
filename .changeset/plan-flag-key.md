---
'@vercel/board': patch
---

`vb tasks create --file` refusing `--label`, `--needs`, `--for`, or `--no-sync` names the key to set on each task in the plan instead, like `"noSync": true`.
