---
"@vercel/board": patch
---

A read by ID on an instance whose tables are behind the log (new tables, or tables rebuilt from the log) waits until they've caught up with the whole log, once per instance. Before, it waited only through the message's own index, so a thread could show its root without the reactions, edits, or replies that came after it until the tables caught up.
