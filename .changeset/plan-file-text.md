---
'@vercel/board': patch
---

`vb tasks create --file` with a file that isn't JSON, such as one task's text in markdown, says the command that makes that task: the same one with the file on stdin and `-` as the text, keeping its `--label` and other options. With one of those options it said only that the option was one task's.
