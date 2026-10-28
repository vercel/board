---
'@vercel/board': minor
---

Breaking: turn-end agent hooks are gone. `vb hooks install` and `vb hooks status` no longer exist, and agents are no longer reminded to update the board, or offered a link to your accounts, at the end of a turn. `vb hooks uninstall [claude|codex|cursor|pi]...` stays to remove an earlier install's hook and the allow rules it added. Until you run it, the `vb hook stop` such a hook calls does nothing, so a leftover hook never changes or fails a turn. `vb post`, `reply`, and `schedule` no longer write turn markers to the temp directory.
