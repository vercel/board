---
'vboard': patch
---

`vb hooks status` tells an outdated install from a current one. An agent's hook is `outdated` when installing again would change it (an older hook command or Pi extension, a rule for the removed `vb update`, or `vb post` and `vb channels` not allowed yet), or when the `vb` it runs is an older vboard. It says what's off and how to fix it, like `fix with npm i -g vboard, then vb hooks install claude`.
