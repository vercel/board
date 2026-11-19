---
'@vercel/board': patch
---

`vb tasks claim --ready` and `vb tasks run --ready` refuse the list's label filters, `--label key=a|b` and a bare `--label key`, with the claim of one value and the list of what's ready. A claim matches one exact value, so `role=worker|reviewer` waited out its `--wait` for a task labeled `worker|reviewer`, and a bare key said only that labels look like key=value. A label with no key before its `=` says that instead.
