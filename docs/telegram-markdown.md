# Telegram Markdown — the gotcha field

The Bot API is strict and the model's output is not. This is the single
most common source of "the reply never arrived".

## Two modes, two flavours

| Mode string | Spec | Use for |
|---|---|---|
| `Markdown` | Bot API v1 subset | most replies (what this bot uses) |
| `MarkdownV2` | expanded, much stricter escape rules | only if you need nested formatting |
| `HTML` | `<b>` `<i>` `<code>` `<a href>` | safest for untrusted output |

This bot sends `Markdown`. Do not switch to `MarkdownV2` without
escaping everything — it requires 19 characters to be backslash-escaped,
including `.` and `-`, and unescaped ones hard-fail.

## The v1 `Markdown` grammar

```
*bold*          _italic_        `code`
```pre```       [text](url)     ||spoiler||  (v2 only)
```

That is it. There is no heading, no list, no table, no blockquote. The
model will emit `## Heading` and `- item` and `| a | b |` — they render
as literal text in Telegram, not as formatting. That is acceptable.

## What breaks it

1. **Underscores inside a word.** `user_model_name` → the parser treats
   the underscores as italic markers. If the model's reply contains
   snake_case identifiers, the message 400s.
   Fix: `toTelegramMarkdown()` (in `src/format.js`) escapes these.
2. **Unbalanced markers.** One stray `*` with no closing partner rejects
   the entire 4000-char message.
3. **`:` inside link text.** `[a:b](url)` breaks. Colons outside links
   are fine.
4. **Nested formatting.** `*bold _both*_` is invalid in v1.
5. **Unclosed code fence.** A ``` ``` with no closing ``` swallows the
   rest of the message into a code block.

## Model IDs and Markdown

Model IDs routinely contain `/` and `:`:

```
deepseek/deepseek-chat-v3-0324:free
meta-llama/llama-3.3-70b-instruct
```

Inside backticks (`` `deepseek/deepseek-chat-v3-0324:free` ``) they are
completely safe — code spans are not parsed for markers. Every place
this bot prints a model ID wraps it in backticks for that reason. Do the
same in any reply you build.

## Hard limits

- **4096 characters per message**, including formatting markers.
  `splitLong()` in `src/format.js` splits on paragraph boundaries first,
  sentence boundaries second, and hard-chops as a last resort.
- **100 messages per second** per bot (flood limit). Broadcasts and
  long model replies approach this; `sendReply` is sequential.
- **64 inline keyboard buttons** per message, ~100 rows.
- **`editMessageText` rate limit** — roughly one edit per second per
  chat. The streaming handler throttles edits to every 700ms because
  of this; faster editing gets the bot rate-limited and the replies
  stop appearing.

## The failure signature

When formatting fails, the user sees nothing. The error surfaces only
in logs as a 400 from `sendMessage`. The pattern in this codebase:

```js
try {
  await ctx.reply(part, { parse_mode: 'Markdown' });
} catch {
  await ctx.reply(part);   // retry as plain text, no formatting
}
```

`sendReply` in `src/bot/handlers/message.js` does exactly this, so a
malformed chunk still reaches the user — just unformatted.

## When in doubt

Send `HTML`. Escaping is a single function (`&` `<` `>`), nothing is
position-dependent, and it renders bold/italic/code/links identically.
The bot uses `Markdown` only because the model's raw output tends to
already look like it; for generated UI or tables, `HTML` is more robust.
