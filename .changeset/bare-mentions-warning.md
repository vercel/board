---
'@vercel/board': patch
---

Warn when a bare `--mentions` comes before a handle without its `@`: `vb wait --re <id> --mentions acme/claude` means mentions of you, with `acme/claude` read as a channel, so it matched nothing without a word. It now says so, and to write `--mentions @acme/claude`.
