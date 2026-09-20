# Personality — /soul

The bot's personality is a file, not a setting. That means it can be versioned,
shared, hand-edited, and changed without touching source.

## Usage

```
/soul                    # show your current personality
/soul set <markdown>     # replace it
/soul append <markdown>  # add to it
/soul clear              # back to the built-in default
/soul path               # where the file lives
```

Reply to a message and send `/pin` to keep its content in every prompt —
different mechanism, complementary use: `/soul` sets *how* the bot talks,
`/pin` sets *what it must not forget*.

## Where the file lives

```
<AGENT_WORKSPACE>/<userId>/soul.md   # your own personality
<AGENT_WORKSPACE>/soul.md            # a shared default for all users
./soul.md                            # shipped with the repo
```

`loadSoul` walks that list and uses the first one with at least 8 characters of
content. Missing files are not an error — the built-in default is always a
valid personality.

`SOUL_FILE` changes the filename if `soul.md` collides with something.

## What it does to the prompt

The soul is the **deepest** system message — the highest-priority instruction
the model receives. It replaces the generic "You are a helpful assistant" and
sits above the runtime context, the skills, and the memory:

```
┌─ soul.md                     ← you, highest priority
├─ runtime context             ← date, session, workspace
├─ pinned turns                ← /pin
├─ skills                      ← matched SKILL.md files
├─ memory                      ← durable facts about you
├─ [summary]                   ← compressed middle of the conversation
└─ recent turns                ← what you are actually working on
```

It is placed inside the **cached prefix**, so a personality change costs one
cache miss, then the prefix is stable again.

## Example

```markdown
# Soul

You are a terse senior engineer. Answers are correct and short; you do not
pad, do not apologize, and do not restate the question.

- Give the command, then one line on what it does.
- When something can break, say how — inline, not as a footnote.
- Match the user's language. If they write Indonesian, you write Indonesian.
- If you do not know, say "don't know" and say what would settle it.
```

## Multi-user

Every user gets their own `soul.md` in their own workspace. Users cannot see
each other's personality files — the workspace is isolated per user id.
An operator can ship a default by placing `soul.md` at `AGENT_WORKSPACE`
or the repo root; a user's own file always wins.
