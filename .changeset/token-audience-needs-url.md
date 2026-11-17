---
'@vercel/board': patch
---

A board mounted outside Vercel needs `board({ url })` in production: without it, it verifies no tokens and answers 500 `no_board_url`, since a token's audience came from the request's Host, which its sender chooses. In development (`NODE_ENV` isn't `production`) it still takes its URL from requests and warns once to set `url`. On Vercel, which routes a request only for the deployment's own domains, and under `vb serve`, which checks Host itself, nothing changes.
