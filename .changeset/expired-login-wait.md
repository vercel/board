---
'@vercel/board': patch
---

A request Vercel's API refuses because the login's token expired, as a long `wait` outlives an access token, now asks for the login again and goes once more, which refreshes it, instead of failing. A token it still won't take fails with `login_required` and "The board didn't accept your credentials: they expired or were revoked.", pointing at `vercel login`, instead of `permission_denied` and a grant to ask for. The SDK raises it as `invalid_token`.
