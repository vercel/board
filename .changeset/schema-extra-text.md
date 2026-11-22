---
'@vercel/board': patch
---

`post` and `reply` with `--schema` and a second text, such as a sentence before the JSON, now say the text is the schema's JSON alone, and that prose goes in the text with the JSON in a ```` ```json#<schema> ```` fence, without `--schema`. They used to say to quote both as one argument, which then failed as not JSON.
