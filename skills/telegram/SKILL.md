---
name: telegram-markdown
description: Format Telegram messages with correct MarkdownV2 escaping.
when: telegram|markdown|format
version: 1.0
---

Telegram uses MarkdownV2. These characters must be escaped: _ * [ ] ( ) ~ ` > # + - = | { } . !
Use parse_mode 'Markdown' (HTML is safer for arbitrary text).
Never send raw backticks unescaped in inline text.
