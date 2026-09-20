# Bot features

Everything the bot itself does, in addition to relaying prompts.

## Conversation

| Command | What it does |
| --- | --- |
| `/reset` | Start a fresh session |
| `/history` | Recent turns |
| `/sessions` | List past sessions |
| `/export` | Download the conversation as `.md` and `.json` |
| `/pin` | Pin the replied message — it stays in every prompt |
| `/pin list` | Show your pins |
| `/search <text>` | Full-text search across your history and pins |
| `/soul` | Show your personality file |
| `/soul set <md>` | Replace your personality — it becomes the base system prompt |
| `/soul append <md>` | Add to your personality |
| `/soul clear` | Back to the default personality |

Reply to any bot message to regenerate it — the ↻ button does it in one tap,
and `/pin` on that reply keeps it.

Replying to an older message pulls the turns around it into context, so you
can continue an old thread without retyping it. Editing your own message
regenerates the answer from the new text.

⏹ Stop appears on every streaming reply and cancels the generation, keeping
whatever was already written.

## Account

| Command | What it does |
| --- | --- |
| `/usage` | Your token spend — 24h, 7d, all time, broken down by model |
| `/quota` (admin) | List or set per-user daily token limits |
| `/key set <provider> <key> [base_url] [models]` | Use your own API key |
| `/key chain <provider:model,...>` | Your own fallback chain |
| `/key clear` | Back to the operator's shared key |
| `/lang <code>` | Bot UI language: `en`, `id`, `es`, `ru`, `ja` |

`/key` means your turns are billed to your own account and you can pick models
the operator does not offer. The key is stored once and never shown again —
`/key` displays its settings, not the secret.

## Quota

`QUOTA_DAILY_TOKENS` sets the default daily limit for every user. When a user
hits it, the turn is refused before it costs anything:

```
⛔ Daily token quota reached. Resets at 00:00 UTC.
```

An operator can raise one user without touching `.env`:

```
/quota 123456789 2000000
```

Use `0` for unlimited.

## Inline mode

Type `@botname <prompt>` in any chat — including a chat the bot is not in.
The bot does one non-streaming completion and returns it as a sendable result.
`INLINE_TIMEOUT_MS` caps how long it waits (default 12s) so the query never
hangs a chat.

## Forum topics

In a group with topics enabled, each topic is its own conversation. A reply in
topic 12 does not see the history of topic 7.

## Fallback chain

`FALLBACK_CHAIN` is a comma-separated list of `provider:model` pairs tried in
order when the primary fails. Transient errors (timeout, 429, 5xx) retry once
on the same model before stepping down; hard errors step down immediately. A
stream that already produced text never switches models mid-answer — you see
one continuous reply, not a splice.

```
FALLBACK_CHAIN=openai:gpt-4o,anthropic:claude-3-5-sonnet,openrouter:auto
```

## Webhook mode

Polling is the default. Set `WEBHOOK_URL` to switch:

```
WEBHOOK_URL=https://your.host/tg
WEBHOOK_PORT=8443
WEBHOOK_SECRET=<random string>
```

grammy registers the webhook itself. Health endpoint on the same port:

```
GET /health → 200 {"ok": true, ...}
            → 503 {"ok": false, "degraded": [{"name": "vision", ...}]}
```

## Watchdog

A live process doing nothing is worse than a crash — nothing restarts it. If
the bot produces no output for `WATCHDOG_SILENT_MINUTES` (default 30),
`/health` reports 503 so an external probe can act on it.

## Zero-downtime reload

```
kill -HUP <pid>
```

Clears the provider and config caches. Changes to `providers.yaml` or `.env`
take effect on the next request without dropping any connection.

`SIGUSR2` logs a state snapshot (uptime, health, proxy pool) instead.

## Outbound webhooks

`WEBHOOK_SUBSCRIBERS` is a JSON array of external endpoints to notify about
gateway events:

```json
[{"url": "https://hook.example.com/gateway", "secret": "shared", "events": ["quota.reached", "agent.turn.done"]}]
```

Deliveries are HMAC-SHA256 signed (`X-Gateway-Signature: sha256=…`), retried
with exponential backoff, and a subscriber that keeps failing is dropped from
the batch, not the turn. Events are redacted — no credential key leaves the
process.

## Session expiry

History older than `SESSION_TTL_DAYS` (default 30) is deleted on startup and
every six hours. Long-dead context is noise that costs tokens every turn.

## Secret redaction

Anything credential-shaped is masked before it reaches a log line, a chat
reply, or a webhook payload: `sk-*`, `ghp_*`, `AIza*`, JWTs, `user:pass@ip`
proxy credentials, and `Authorization:`/`api_key:` headers. A stack trace
that contains an auth header is how keys leak; this is the filter that stops it.

## Dead letter queue

A turn that fails *every* model in the fallback chain is not dropped. It is
written to the `dlq` table with its full request, so the operator can replay
it once the provider is back instead of asking the user to retype it.

## Port forwarding

The agent runs something that listens on localhost — a dev server, a notebook,
a storybook, a debugger — and it is useless without a URL. `tunnel_open` gives
it one, the way VS Code forwards a port.

| Tool | What it does |
| --- | --- |
| `tunnel_open` | Forward a localhost port. Returns a URL the user can open |
| `tunnel_list` | Every forwarded port, its URL, and hit count |
| `tunnel_close` | Stop forwarding. The local service keeps running |

Two transports. In `local` mode (the user is on this machine — Termux, a dev
box) the URL is `http://127.0.0.1:PORT` and nothing is spawned. In `relay`
mode (a remote host) a TCP forwarder listens on a public port and splices it to
`127.0.0.1:PORT` — protocol-agnostic, so websockets and HMR survive.

Every relay URL carries a 128-bit secret path token. An open port is not the
same as a reachable service: a request without the token gets a 401 before the
first byte reaches the private service. `no_token` is refused in relay mode.

The tool checks that something is actually listening before it forwards, so
the failure message is actionable — "start the server first" instead of
"connection refused" on the user's first click.

## Asking the user

`ask_user` stops the agent mid-task and waits for a human answer. It posts the
question with either choice buttons or a "type an answer" affordance, and the
turn resumes when the answer lands — a button tap or a typed reply, either
works. A question unanswered for 30 minutes resolves to "proceed with your
best judgment", so an unattended run does not hang.

## Architecture awareness

A model that gets a tool list but no context answers "can you browse files?"
the way every chatbot does: no. It is not wrong about itself — nothing in its
prompt said otherwise.

`/agent` now builds its messages with a second system message below the
personality: an architecture brief. Everything in it is computed at runtime, so
it is never told a capability it does not have.

- **Where it runs** — hostname, platform/arch, CPU model, runtime. "You are an
  agent process on a real machine," stated once, plainly.
- **What it can reach** — the workspace path for *this* user, whether the
  Camoufox binary is actually installed (absent: the browser line says so, and
  names `fetch_url` and `web_search` as the working substitutes), the shell,
  jobs, tunneling, memory.
- **How to use the tools** — read before write, `glob`/`grep` before reading
  blind, `job_start` for anything long, which tools pause for approval.
- **Boundaries** — it cannot see the user's screen or phone storage, another
  user's workspace is not accessible, it holds no third-party credentials. When
  the user means a file on their own device, the brief tells it to say so and
  ask for the content.

The brief is cached 30s and sits inside the cached prefix, so it costs once per
conversation, not once per turn.

## RBAC, undo, and document ingestion

**RBAC — who may run tools.** Chat access (`TELEGRAM_ALLOWED_USERS`) and tool
access are separate tiers, because a bot that answers questions is a different
trust level from a bot that runs shell commands.

- `TELEGRAM_TOOL_USERS` — these users run file/terminal tools and receive
  dangerous-tool approval prompts directly.
- `TELEGRAM_ADMIN_USERS` — the tier above: can also change bot settings and
  clear other users' sessions.
- Both blank (default) — dangerous tools require the inline-keyboard approval
  from any user, and operator-only tools (`set_quota` and friends) are refused.

The check lives in `src/agent/rbac.js` and feeds the existing approval gate:
trusted users skip the keyboard, everyone else gets `[Approve] / [Reject]`.

**`/undo` — the way back.** Every mutating tool (`write_file`, `edit_file`)
snapshots the file into `workspace/<id>/.undo/` before it writes. `/undo`
restores the most recent change — an overwritten file goes back to its previous
content, a newly created file is deleted. The ring is per-user, capped at 20
entries, and refuses paths outside the workspace. It says what is true: if the
previous state rotated out of the ring, it returns "no longer recoverable"
rather than deleting the current file.

**Document ingestion.** A file dropped into the chat lands in the workspace and
becomes part of the agent's context.

- `.zip` — extracted preserving the tree. Zip-slip entries are validated
  *before* the system `unzip` ever runs, and refused one at a time so one
  hostile entry does not abort the ninety honest ones.
- code and text (`.js .py .md .json .yaml .txt …`) — saved as-is.
- over 8 MB — refused with a reason: the limit is the context window, not disk.
- anything else — refused with a suggestion, never silently ignored.
