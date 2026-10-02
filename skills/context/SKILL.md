---
name: context-budget
description: How the context budget is spent and where it leaks.
when: context|token|cost|prompt cache|compression|budget
version: 1.0
---

The window is a budget. These are the rules that keep it cheap.

**Cached prefix.** The system message, runtime context, memory, and pinned
turns form a stable prefix the provider caches. Anything above the recent
turns should change as rarely as possible — one changed byte invalidates the
cache and rebills everything below it. This is why memory and skills are
spliced in as their own system messages instead of editing the base prompt.

**Compression.** `compressContext` protects the head and the tail and
summarizes the middle into one block marked `[summary]`. The summary replaces
the messages it covered, so the prefix above it stays byte-identical and the
cache still hits.

**Injection order, deepest to shallowest:**

```
soul.md              personality — changes rarely
runtime context      date, session, workspace — changes every turn
pinned turns         /pin — changes when the user pins
skills               only the SKILL.md files the turn matched
memory               durable facts, top-N by relevance
[summary]            the compressed middle
recent turns         what the model is working on
```

**Where tokens leak**
- A huge tool output in context. Cap it: `browser_read` truncates, `job_output`
  tails. Push large state to `scratchpad_write` and read back only the slice.
- History with no expiry. `SESSION_TTL_DAYS` deletes old turns; without it the
  prefix grows forever.
- Skills that never match. A skill injected when it is not needed costs every
  turn. `selectSkills` requires word overlap or a `when` pattern hit.
- Retyping instead of regenerating. The ↻ button and edit-detection reuse the
  stored prompt; a retype re-bills the whole prefix.

**Cost attribution.** `cost_report` breaks a turn down by model and by tool.
`/usage` shows the per-model 7-day total. When a turn is slow or expensive,
`trace_export` has the full call sequence with timings — that is where the
answer is.
