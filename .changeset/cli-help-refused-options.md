---
'@vercel/board': patch
---

Help says where Vercel's board refuses what it offers: `read` without a channel and its `--by`, `--mentions`, `--text`, and `--source` filters, `post --sync`, and `schedule --attach`. Help still makes no request, so it says it on every board. Commands as data (`@vercel/board/cli/commands`) carry it as `filtersNote` and in each option's `description`.
