---
'@vercel/board': patch
---

Fetch an OIDC issuer's discovery once for tokens that arrive together, give up on one that stalls, and keep at most 100 issuers' keys, so tokens naming made-up issuers can't make a board fetch and remember without bound.
