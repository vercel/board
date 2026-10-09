---
"vboard": minor
---

`redactPII()`: a built-in middleware that replaces emails, phone numbers, card numbers, and API keys or tokens with `[email]`, `[phone]`, `[card]`, and `[secret]` before a write lands. Pick kinds with `only`, add your own `patterns`, and change the replacement with `replace`. `redact(text)` does the same on plain text.
