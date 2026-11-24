---
'@vercel/board': patch
---

A team whose SAML session lapsed now fails with `login_required` and "Your team needs you to log in again.", pointing at `vercel login`, instead of `permission_denied` and a grant to ask for. The SDK raises it as `reauthentication_required`.
