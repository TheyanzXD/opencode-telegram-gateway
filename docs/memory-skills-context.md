# Memory, Skills, and Context

How this bot remembers things. Short answer: barely, and on purpose.

## What exists today

```
HISTORY_LIMIT=20        # turns of context resent with each message
sessions table          # /sessions new|resume|delete — separate histories
users table             # chosen provider/model/temperature/system prompt
```

That is the whole memory subsystem. Each message, the bot builds the
array to send the provider like this:

```js
[ {role:'system',  content: user.system_prompt || SYSTEM_PROMPT},
  ...last HISTORY_LIMIT rows from messages (in order),
  {role:'user',    content: text} ]
```

Nothing is summarized, nothing is embedded, nothing is recalled from
outside this conversation. When the limit rolls over, old turns are gone
from context (still in SQLite, retrievable with `/history`).

## Bump the memory

```bash
# .env
HISTORY_LIMIT=50      # more continuity, more tokens per call
HISTORY_LIMIT=5       # cheaper, faster, amnesiac
```

Cost scales linearly: 20 turns × ~300 tokens ≈ 6k input tokens per
message before you've typed anything.

## Sessions — the actual context switch

```
/sessions new research       # fresh history, same provider/model
/sessions resume coding      # back to that history
/sessions list
/sessions export research    # zip → home channel
```

Sessions share the user row — provider, temperature, and system prompt
are per-user, not per-session. If you want a different system prompt per
project, that's `/sessions` + `/system` together, and the prompt flips
back when you resume the other session unless you set it again.

## What is NOT here

- **No embeddings / vector store.** Nothing is semantically recalled.
- **No skill loader.** There is no plugin directory, no tool registry,
  no function-calling bridge. The bot does not know how to call tools.
- **No summarizer.** Old context is dropped, not compressed.
- **No cross-user memory.** User A's history is invisible to user B.

## If you want real recall

The seams are already there; each of these is a contained change:

**Long-term facts** — add a `memories` table in `db.js` mirroring the
`sessions` one (`user_id`, `key`, `value`, `created_at`), then in
`conversation.js` `buildMessages()`, prepend the user's memory rows as
a system note:

```js
const mem = getMemory(user_id);   // new db.js export
if (mem.length) arr.splice(1, 0, { role: 'system',
  content: 'Known facts:\n' + mem.map(m => `- ${m.key}: ${m.value}`).join('\n') });
```

Keep the injected block small (5–10 lines) or it eats the context
window every single call.

**Summarization** — when `messages` for a session exceeds
`HISTORY_LIMIT + N`, run a cheap model over the oldest slice, store the
result in a `summaries` table, and send the summary instead of the
dropped rows. Trigger it in `buildMessages()`, not in the request path,
or the first message after rollover gets slow.

**Skills** — the bot has no tool-call support, so "skills" here means
prompts, not executables. A `skills/` directory of Markdown files plus
a `/skill <name>` command that appends the file to the system prompt is
~40 lines and gives you reusable personas/instructions. Do not build a
plugin system with code execution — the bot deliberately cannot run
shell commands and `child_process` is not imported anywhere in `src/`.

## Privacy

Every message is stored in `data/gateway.db` in plaintext (SQLite WAL).
`/reset` clears the active session's rows. Deleting the file wipes all
history — the bot recreates the schema on next boot.

Backups of `data/` are backups of every conversation. Treat the file the
way you'd treat the chat logs.
