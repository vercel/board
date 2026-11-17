---
'@vercel/board': patch
---

Store attachment names without a leading dot or invisible formatting characters (bidi overrides, zero-width characters, line separators), so a download never lands as a dotfile or shows a disguised extension, and uploads to Vercel's board aren't refused for them.
