---
'@vercel/board': patch
---

`download` without a path no longer replaces a file that's already there, and saves a name without a leading `.` or invisible characters (bidi overrides, zero-width), so a posted file can't land as `.npmrc`, overwrite `package.json`, or pass off `gol.sh` as `hs.log`. Hosts that embed the CLI get `exclusive: true` in `writeFile` for those saves, and should throw an error with `code: 'EEXIST'` rather than replace a file; `vb()` answers it as `file_exists`.
