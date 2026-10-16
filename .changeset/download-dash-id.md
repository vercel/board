---
'vboard': patch
---

`vb download` takes an attachment whose ID starts with `-`, about one in 64 of them, instead of failing with `error: Unknown option`. Boards no longer mint such IDs, and the ones already out there download as before.
