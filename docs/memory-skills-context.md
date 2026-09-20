# Memory, Skills, and Context

How the gateway builds the message array it sends to a provider, and what it
remembers between sessions.

## What exists today

Three layers, each injected as its own system message **below** the system
prompt. Ordering matters: providers cache by exact prefix match, so the system
prompt sits first and is assembled once per user. Everything volatile — the
date, the session name, remembered facts, matched skills — goes below it, where
a change does not invalidate the cached prefix.

```
[0] system prompt          ← cached prefix; one per user until /system changes
[1] memory facts           ← cross-session, declarative
[2] matched skills         ← only when the turn matches a skill
[3] runtime environment    ← current date, session name, workspace
[4..N] history             ← compressed when it grows too large
[N+1] user turn            ← this message
```

### Context compression

`src/agent/context.js` — `compressContext()`.

History is bounded by a soft character budget. When it overflows, the oldest
and newest turns are protected and the middle is summarized into one block:

- **Head** (system prompt + first turns) — protected. These are the
  load-bearing instructions, and dropping them invalidates the prompt cache.
- **Tail** (recent turns) — protected. This is what the model is working on.
- **Middle** — summarized into a single `[summary]` block, or truncated to a
  hard cap when no summarizer is configured. The failure mode is safe: if the
  summarizer model fails, the middle is kept verbatim rather than lost.

A list already carrying a `[summary]` marker is not re-compressed — one
compression per build.

### Skills

`src/agent/skills.js` — `loadSkills()`, `selectSkills()`, `skillBlock()`.

A skill is a directory containing a `SKILL.md` with YAML frontmatter:

```yaml
---
name: telegram-markdown
description: Format Telegram messages with correct MarkdownV2 escaping.
when: telegram|markdown|format
version: 1.0
---
```

Not executed code. The loader reads every skill once at startup, then each turn
is matched against skill descriptions; matches are injected as a system message
below the prefix. Adding or removing a skill never invalidates the cache.

**Authoring standards are enforced, not advisory.** A skill that fails is
skipped with a warning, never crashes:

- `name` — lowercase, hyphens only
- `description` — one sentence, ≤ 60 chars, ends with a period, no marketing
  words ("amazing", "powerful", "ultimate", …)
- matching — ≥ 2 words of the description appear in the turn, or an explicit
  `when` pattern hits

At most 3 skills per turn; injecting ten costs more context than the knowledge
is worth.

### Memory

`src/agent/memory.js` + the `memory` table.

Not conversation history — that lives in `messages` and it expires from context.
Memory is the small set of **declarative facts** that survive a `/reset` and a
new session: who the user is, their standing conventions, their environment.

- Facts are stored as `user_id` + `fact`, upserted, one per row.
- Injected as a system message, declarative phrasing only. A fact reads
  "User prefers concise responses" — not "Always respond concisely", which
  would read as an order and could override what the user actually asked for.
- `autoLearn` watches turns for preference declarations ("I prefer X",
  "aku suka X") and stores them. It is opt-in and heuristic.
- No cross-user memory. User A's facts are invisible to user B.

## Bumping the budget

```bash
HISTORY_LIMIT=20     # turns of context resent with each message
```

Above the limit, compression takes over rather than a hard truncate.

## What is still not here

- No vector store, no embeddings. Memory is a small table of strings.
- No multi-backend memory — one SQLite table, no plugin providers.

## Privacy

Every message is stored in `data/gateway.db` in plaintext (SQLite WAL).
`/reset` clears the active session's rows. Memory rows survive `/reset` — that
is what they are for; clear them in the DB directly if needed. Deleting the file
wipes everything — the bot recreates the schema on next boot.

Backups of `data/` are backups of every conversation. Treat the file the way
you'd treat the chat logs.
