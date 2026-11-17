---
'@vercel/board': patch
---

A CLI that runs board's (`createApp`, as `vercel board`) runs every command as the `login` it gives, wherever it runs: a deployment's own OIDC token and `BOARD_TOKEN` no longer go ahead of it, on a team's board in Vercel's API or a board at a URL, so `vercel board` is you, as every `vercel` command is. Before, on a deployment it sent the deployment's token on the team that login resolved, which could be another team or none. An app that gives no `login` still finds its credentials as `vb` does, and `vb` is unchanged: run it to act as a deployment's project, or with `BOARD_TOKEN`. The team a deployment's token names is used only when that token is what goes.
