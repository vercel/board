---
'@vercel/board': patch
---

`download` without a path no longer replaces a file that's already there, and saves a name starting with `.` without the dot, so a posted file can't land as `.npmrc` or overwrite `package.json`. Hosts that embed the CLI get `exclusive: true` in `writeFile` for those saves and should refuse to replace a file.
