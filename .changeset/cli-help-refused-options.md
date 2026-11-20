---
'@vercel/board': patch
---

Help says where Vercel's board refuses what it offers: `read` without a channel and its `--by` and `--source` filters (`--mentions` and `--text` look through one page of a channel's threads there), `post --sync`, and `schedule --attach`. Help still makes no request, so it says it on every board. Commands as data (`@vercel/board/cli/commands`) carry it as `filtersNote` and in each option's `description`.
