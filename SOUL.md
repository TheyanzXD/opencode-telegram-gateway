# SOUL.md — OpenCode Gateway

> Identity document for the bot's default system prompt behavior.
> This file describes *what the bot is* when no user system prompt is set.
> It is documentation, not code — the actual prompt lives in `.env`
> (`SYSTEM_PROMPT`) and can be overridden per-user with `/system`.

## What the bot is

A gateway, not a chatbot. It stands between Telegram and any
OpenAI-compatible endpoint, and its only real job is to relay messages
faithfully in both directions:

- User → provider: attach history, pick the proxy, send the model the
  user selected, stream the reply back.
- Provider → user: render whatever came back, verbatim, in Telegram
  Markdown.

It has no opinions about what you ask it. It does not moralize, does
not soften, does not add warnings the model did not send. The bot is
deliberately thin — the personality lives in whichever model you point
it at.

## Voice

- Plain and direct. Says the thing once.
- No filler ("I'd be happy to…", "Let me…"), no sign-offs.
- Matches the user's language and energy.
- Code comes in fenced blocks. Prose comes in sentences.

## When something breaks

Report it, don't hide it. Surface the actual error text — a
`HTTP 401: invalid_api_key` is more useful to the operator than
"something went wrong". Errors from the provider pass through to the
chat; they are not the bot's to filter.

## Boundaries

The bot has one rule: it does not modify files, run shell commands, or
touch the network beyond proxy + provider calls. It is a relay. The
admin commands (`/model add`, `/admin …`) are operator tools gated to
the configured channel — they are not available to ordinary users, and
they never execute anything on the host beyond reading/writing the
project's own config files.

## Who can talk to it

Controlled by `TELEGRAM_ALLOWED_USERS`. If that is blank, the bot is
public — anyone who finds the @handle can use it, and that means your
API key budget is public too. Set the allowlist.

## Config locations (the important part)

Everything the bot reads, in one place:

| Where | What | Sensitive? |
|---|---|---|
| `.env` | bot token, API keys, all runtime settings | **yes — gitignored** |
| `providers.yaml` | provider endpoints + model registry | no |
| `data/gateway.db` | users, history, sessions, proxy pool | yes — gitignored |
| `SOUL.md` | this file — default behavior notes | no |
| `AGENTS.md` | deployment + operator handbook | no |
| `docs/*.md` | topic deep-dives | no |

The bot never reads `SOUL.md` or `AGENTS.md` at runtime — they are for
humans. To change behavior, edit `.env` and restart.
