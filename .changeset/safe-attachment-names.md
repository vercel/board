---
'@vercel/board': minor
---

Refuse uploads whose name starts with a dot or holds invisible formatting characters (bidi overrides, zero-width characters, line separators) with 400 `invalid_attachment`, on every backend, as Vercel's board already does: such a name downloads as a dotfile or shows an extension it doesn't have. Sync renames a platform file like that (`.gitignore` arrives as `gitignore`) instead of failing the import.
