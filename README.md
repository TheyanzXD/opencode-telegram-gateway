# OpenCode Telegram Gateway

A multi-provider OpenAI-compatible **Telegram gateway** with streaming, vision, conversation sessions, a 10k+ free-proxy pool rotated per chat, admin channel-gating, a full **agent harness** (file + bash + GitHub tools), and full SQLite-backed state. Built with Node.js — **no root required**, runs from a plain user account using only Node's built-in tooling (no native package manager steps; no system services; no `sudo`).

## Features

- 🛰 **Multi-provider** — any OpenAI-compatible endpoint. Five auth modes (`header` / `xheader` / `query` / `body` / `none`) cover OpenAI, OpenRouter, Groq, DeepInfra, OpenAI-style clones, local Ollama, and custom gateways.
- 🛡 **Zod-validated** config — malformed `providers.yaml` is rejected at boot, never silently accepted.
- 💬 **Conversation sessions** — `/sessions new|list|resume|delete|rename|export|active`. Each session scopes its own history in SQLite.
- 🖼 **Vision** — image attachments forwarded to vision-capable models automatically; override via `VISION_PROVIDER`/`VISION_MODEL`.
- ⚡ **Streaming** — Telegram edit-in-place as the model types.
- 🤖 **Agent harness** — tool-calling loop with `read_file`, `write_file`, `edit_file`, `bash_exec`, plus GitHub/git/memory/web-search tools. Live-status updates and inline-keyboard approvals. Toggle with `AGENT_ENABLED`. Details in [`AGENTS.md`](AGENTS.md).
- 📎 **Document upload** — text/code files dropped in chat are read into the agent (PDF: ponytail).
- 🧠 **Long-term memory** — `memory_recall`/`memory_remember` tools, FTS5 BM25 ranking.
- 🔌 **MCP client** — connects to any Model Context Protocol server (`stdio` or `http`) and unions its tools with the hardcoded set. See `mcp.json.example`.
- 🐙 **GitHub account manager** — `/gitconfig <token>` stores a PAT per user; manage via inline keyboard (profile, repos, gists, revoke). Agent tools `github_list_repos`, `github_view_repo`, `github_create_gist` use the same token.
- 📊 **Per-user stats** — `/stats [7d|30d|all]` aggregates messages, token usage, tool counts, memory chunks.
- 🪝 **Webhook mode** — set `WEBHOOK_ENABLED=true` + domain to switch from polling.
- 🌐 **Proxy pool (10k+)** — auto-fetches public proxies from ~20 sources at startup, rotates per-chat (stable hash), tracks per-proxy health, auto-refreshes every N hours. Up to 39k observed in practice (HTTP/SOCKS4/SOCKS5/HTTPS).
- 👮 **Admin channel gate** — `/admin` and `/sessions export` only work inside the configured `TELEGRAM_HOME_CHANNEL` (toggle with `ADMIN_REQUIRE_CHANNEL=false`).
- 📦 **Export to home channel** — `/sessions export` and `/admin export` zip users/sessions/messages/usage/proxies/config and post the zip to your home channel.
- 💾 **Single-file SQLite** — `better-sqlite3` WAL, zero ops. Schema: `users`, `messages`, `usage`, `sessions`, `proxies`.
- 📜 **Pino logging** — pretty in dev, JSON in prod, redact `apiKey` automatically.
- 🧙 **CLI setup wizard** — `npm run setup` walks you through bot token, providers, defaults. No config files to handcraft.
- 🩺 **Doctor** — `npm run doctor` validates everything and pings each provider with a real prompt.
- 💰 **Cost & quota** — `/usage` shows per-day and per-model spend; `QUOTA_DAILY_TOKENS` caps a user's daily tokens and `/quota <userId> <n>` overrides one user without a restart.
- ⏹ **Stop & regenerate** — every streaming reply has a ⏹ button (keeps the partial text); ↻ regenerates from the stored prompt. Editing your own message regenerates it too.
- 🧵 **Reply chains** — reply to an old message and the turns around it come back into context. Forum topics are separate conversations.
- 🧠 **Personality** — `/soul set <markdown>` writes a personality file that becomes the base system prompt. Per-user, versionable, see [docs/personality.md](docs/personality.md).
- 📌 **Pin & search** — `/pin` keeps a turn in every prompt; `/search <text>` is FTS5 across your whole history and pins.
- 🔑 **Bring-your-own-key** — `/key set <provider> <key>` bills a user's turns to their own account, with their own fallback chain (`/key chain`).
- 🌐 **Inline mode** — `@botname <prompt>` answers from any chat. Multi-language UI: `/lang en|id|es|ru|ja`.
- 📤 **Outbound webhooks** — `WEBHOOK_SUBSCRIBERS` fires signed events on quota hits, agent turns, and more.
- 🔁 **Fallback chain** — `FALLBACK_CHAIN=provider:model,...` steps down on hard failure, retries once on transient. A stream that already produced text never switches models.
- 🩺 **Webhook + health + watchdog** — `WEBHOOK_URL` switches off polling; `GET /health` returns 200/503; the watchdog flags a silent process. `SIGHUP` reloads config without dropping connections.
- 🔒 **Secret redaction + DLQ** — credential-shaped strings are masked before any log, reply, or webhook; a turn that fails every fallback lands in the dead-letter queue for replay.
- 🧩 **MCP client** — `MCP_SERVERS` turns every MCP server on npm into agent tools. Stdio and HTTP transports.
- 👶 **Subagent delegation** — `delegate_task` runs an independent subtask in its own context window and returns only the summary (max depth 2, read-only by default).
- 💾 **Long-term memory** — `remember`/`recall` durable facts, `record_lesson` a failed approach + the fix, `record_decision` the why-not log, `scratchpad_*` working state out of the context window.
- 🔐 **RBAC** — three tiers: chat access (`TELEGRAM_ALLOWED_USERS`), tool access (`TELEGRAM_TOOL_USERS`), operators (`TELEGRAM_ADMIN_USERS`). Dangerous tools need a one-tap approval unless the user is trusted.
- ↩️ **`/undo`** — every mutating tool snapshots first; one command restores the last change in this user's workspace. Overwritten files go back, created files are removed.
- 📎 **Document ingestion** — drop a `.zip` or a code file into the chat and it lands in the workspace. Zip-slip entries are refused before extraction; over-8 MB is refused with a reason.
- 🔎 **Code intelligence** — `semantic_code_search` (RAG over the workspace), `code_symbols` (real AST), `dependency_graph` (blast radius of a change), `dead_code_scan`. `sqlite-vec` when installable, pure-JS cosine when not, and the index says which.
- 🎨 **Image generation** — `image_generate` when a provider offers it; says plainly when none does. — drop a `.zip` or a code file into the chat and it lands in the workspace. Zip-slip entries are refused before extraction; over-8 MB is refused with a reason.
- 🔍 **Observability** — `trace_export` a full turn trace, `cost_report` the spend breakdown. Per-user workspace isolation for every tool that touches disk.

See [docs/features.md](docs/features.md) for the full reference.

## Quick start (no root)

```bash
git clone https://github.com/TheyanzXD/opencode-telegram-gateway.git
cd opencode-telegram-gateway
npm ci                # ~80 packages, no sudo, no global state
cp .env.example .env  # then put your bot token in .env
npm run doctor        # validate config + ping each provider
npm start             # launch the bot
```

You only need two things: a **Telegram bot token** (from [@BotFather](https://t.me/BotFather)) and **one API key** for the provider you picked as `DEFAULT_PROVIDER`. `providers.yaml` ships with public providers — OpenRouter and Groq both have free tiers that need only an email to sign up.

### Optional: headless browser (agent tools)

The agent's browser tools (`browser_navigate`, `browser_snapshot`, …) need
**Camoufox** — anti-detect Firefox. On a datacenter IP, plain headless Chromium
is hard-blocked (Google → `/sorry`, Brave → captcha); Camoufox spoofs a real
Windows/Firefox fingerprint (`navigator.webdriver` false, matching UA/plugins/
WebGL), which is what gets past the browser-side checks.

```bash
npx camou install
```

That is the whole setup. `src/bootstrap.js` resolves the install from the `camou`
CLI's own registry at startup — no manual env, no patched library.

The browser is then driven by the model: `/agent "find …"` calls
`browser_navigate`, `browser_snapshot` (`@eN` refs), `browser_click`, etc.

### Optional: authenticated proxies

```bash
echo 'user:pass@1.2.3.4:1081' >> premium-proxy-list.txt   # socks5, one per line
# .env
PROXY_PREMIUM_FILE=/absolute/path/to/premium-proxy-list.txt
```

Premium entries are seeded ahead of the public lists, so per-chat rotation prefers them. The file is gitignored — never commit credentials.

`better-sqlite3` builds natively but `npm ci` handles it via prebuilt binaries for the common Node versions — no `apt`, no `sudo`, no system packages.

## Skills

`skills/` holds markdown knowledge the bot injects only when a turn matches it.
Each is a directory with a `SKILL.md` frontmatter (`name`, `description` ≤ 60
chars, `when` patterns). Four ship with the repo:

- **agent-tools** — the 58-tool catalog with blast radius
- **camoufox-antidetect** — browser blocks, known walls, session rules
- **context-budget** — where the tokens go and how the cache stays warm
- **telegram-markdown** — MarkdownV2 escaping rules

Add your own: `mkdir skills/<name>`, write a `SKILL.md`, restart. A skill that
fails validation is skipped with a warning, never fatal.

## CLI

```
opencode-gateway setup            Interactive wizard
opencode-gateway start            Run the bot (default)
opencode-gateway doctor           Validate config + ping providers
opencode-gateway models [name]    List all providers × models
opencode-gateway tui              Live config editor
opencode-gateway proxy            Show pool stats
opencode-gateway proxy refresh    Fetch up to PROXY_TARGET (default 10000)
opencode-gateway proxy sweep      Liveness-check 200 random proxies
opencode-gateway proxy prune      Remove long-dead entries (fails >= 20)
opencode-gateway proxy check <host>:<port> [scheme]   Single-proxy liveness
```

## Bot commands

### Anyone
```
/start               Current model + active session
/help                Full command reference
/model [p/m]         Switch model  (e.g. /model openai/gpt-4o)
/model list <p>      Live model list from the provider itself
/model add <p/m>     Register a new model (admin) — e.g. /model add groq/new-model 128000
/models              List every registered model
/agent <task>         Tool-calling agent — shell, files, browser, web search
                       code tools: execute_python, execute_node, multi_edit,
                       ast_edit, grep, glob
                       browser tools: browser_navigate, browser_snapshot
                       (@eN refs), browser_click, browser_type, browser_read,
                       browser_search — see docs/agent.md
                       tunneling: tunnel_open <port> — your local server gets
                       a clickable URL
/abort                Cancel the running /agent in this chat
/todo                 The agent's task list
/tools                List every tool the agent can call
/yolo on|off          Auto-approve dangerous tools (skip the keyboard)
/estop                Emergency stop — cancel everything now
/temperature <0-2>   Set temperature
/system <prompt>     Set system prompt
/reset               Clear history of active session
/history             Show last 10 messages
/cwd [path]          Show or set agent working directory
/tools               List agent tools
/gitconfig [token]   Link GitHub account (token stored per-user)
/stats [days]        Usage, tool counts, memory chunks
/about               Bot info + stats
/usage               Your token spend (24h / 7d / all time, by model)
/soul [set|append|clear]  Personality file — becomes the base prompt
/key set <p> <k> [url] [models]  Use your own API key
/key chain <p:m,...>      Your own fallback chain
/lang <code>         Bot UI language: en id es ru ja
/pin [note]          Pin the replied message into every prompt
/search <text>       Full-text search across your history
/export              Download the conversation (.md + .json)
```

### Sessions (`/sessions …`)
```
/sessions list                   Show your saved sessions
/sessions new <name>             Create + activate
/sessions resume <name>          Activate (history switches scope)
/sessions rename <old> <new>     Rename
/sessions delete <name>          Remove session (messages kept as orphan history)
/sessions export [name]          ZIP history → home channel
/sessions active                 Show current
```

### Admin (`/admin …`) — channel-only
```
/admin panel                     Stats overview
/admin providers                 List providers + models
/admin users                     Recent users
/admin ban <user_id>             Ban
/admin unban <user_id>           Unban
/admin broadcast <text>          Send to all non-banned users
/admin default <provider>/<model>  Set default model
/admin export [user_id]         ZIP everything → home channel (filtered if user_id given)
```

Admin commands only execute inside `TELEGRAM_HOME_CHANNEL`. Outside, the bot politely refuses.

## Config

### `.env`

```env
TELEGRAM_BOT_TOKEN=1234:abcdef...
TELEGRAM_ALLOWED_USERS=111,222
TELEGRAM_ADMIN_USERS=111
TELEGRAM_HOME_CHANNEL=-1001234567890

# Ship defaults point at openrouter + a free model.
# Any provider in providers.yaml works here.
DEFAULT_PROVIDER=openrouter
DEFAULT_MODEL=deepseek/deepseek-chat-v3-0324:free
DEFAULT_TEMPERATURE=0.7
DEFAULT_MAX_TOKENS=4096
SYSTEM_PROMPT=You are a helpful assistant.

DB_PATH=./data/gateway.db
LOG_LEVEL=info
LOG_FORMAT=pretty
REQUEST_TIMEOUT_MS=120000

VISION_PROVIDER=
VISION_MODEL=
HISTORY_LIMIT=20
MAX_INPUT_CHARS=8000
STREAMING=true

PROXY_ENABLED=true
PROXY_TARGET=10000
PROXY_PER_CHAT=true
PROXY_REFRESH_HOURS=6

ADMIN_REQUIRE_CHANNEL=true
```

### `providers.yaml`

```yaml
providers:
  - name: openrouter
    base_url: https://openrouter.ai/api/v1
    auth_mode: header              # Bearer
    key_env: OPENROUTER_API_KEY
    models:
      deepseek/deepseek-chat-v3-0324:free: { context: 64000 }
      anthropic/claude-3.5-sonnet: { context: 200000, vision: true }

  - name: groq
    base_url: https://api.groq.com/openai/v1
    auth_mode: header
    key_env: GROQ_API_KEY
    models:
      llama-3.3-70b-versatile: { context: 128000 }

  - name: ollama
    base_url: http://localhost:11434/v1
    auth_mode: none
    models:
      llama3.2: { context: 128000 }
```

#### Auth modes

| mode        | Header / param sent                            |
|-------------|------------------------------------------------|
| `header`    | `Authorization: Bearer <KEY>`                  |
| `xheader`   | `x-api-key: <KEY>`                             |
| `query`     | `?key=<KEY>` appended to base URL              |
| `body`      | `api_key: <KEY>` merged into JSON body         |
| `none`      | no auth (local servers, public endpoints)      |

## Architecture

```
┌──────────────────┐    ┌────────────────┐    ┌─────────────────┐
│ Telegram (grammy)│───▶│  bot/*         │───▶│ providers/client│
│                  │    │  middleware,   │    │ + proxy/pool    │
│  /sessions,      │    │  commands,     │    │ (rotates per    │
│  /admin, /model, │    │  handlers      │    │  chat hash)     │
└──────────────────┘    └────────┬───────┘    └────────┬────────┘
                                │                     │
                          ┌─────▼──────┐      ┌───────▼────────┐
                          │ db.js      │      │ LLM provider   │
                          │ (sqlite    │      │ (OpenAI-compat)│
                          │  users,    │      └────────────────┘
                          │  messages, │
                          │  sessions, │      ┌─────────────────┐
                          │  proxies,  │◀─────│ proxy/fetcher   │
                          │  usage)    │      │ 20+ public      │
                          └────────────┘      │ list sources    │
                                             └─────────────────┘
```

**Per-chat rotation:** `hash(chatId) % pool_size` → same proxy per chat. Failed proxies are demoted (`fails++`) and dropped from the rotation at `fails >= 5`. Periodic `sweep` checks 200 random entries against `httpbin.org/ip`.

**Sessions:** Each `messages` row stores a nullable `session_id`. `/sessions new` creates a session and sets it active (deactivating any previous one). `/sessions resume` flips the active flag. `/sessions delete` orphans its messages (kept in DB) and removes the session row. `/sessions export` zips messages + Markdown render of every conversation and posts the zip to the home channel.

**Admin gate:** `authMiddleware` sets `ctx.session.isAdminChannel = (chat.id == TELEGRAM_HOME_CHANNEL)` (configurable via `ADMIN_REQUIRE_CHANNEL`). `/admin` and `/sessions export` both check this flag.

## Security & privacy

- API keys live in `.env`, never in chat. The setup wizard masks passwords at input.
- Pino log redacts any field named `apiKey` automatically.
- Admin commands require being physically inside the configured channel (DM refused).
- Proxies are public, free, and used only for outbound LLM API calls. The bot does NOT route user traffic through them.
- GitHub PATs from `/gitconfig` are stored **plain text** in the bot's per-user tenant SQLite file (`data/tenants/<user_id>.db`) for v1 convenience. Anyone with read access to the tenant directory can read every user's token. Do not expose `data/tenants/` beyond the bot's user account. (Encryption with `BOT_SECRET` is on the roadmap; see ponytails in [`AGENTS.md`](AGENTS.md).)
- MCP servers are subprocess children (stdio) or remote (HTTP). Subprocess servers can do anything the bot's user account can do on the host. Only configure MCP servers you trust.

## MCP (Model Context Protocol)

`mcp.json.example` ships with two sample servers. The bot launches them, asks each for `tools/list`, and unions their tools with the hardcoded set when sending the `tools[]` payload to the model. Tool names get a `mcp__<server>__<tool>` prefix to avoid collisions.

```json
{
  "servers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "github-mcp":  { "url": "http://localhost:3001/mcp" }
  }
}
```

See [`AGENTS.md`](AGENTS.md) for the full explanation, transport details, and 100+ community MCP servers.

## Webhook mode

Set `WEBHOOK_ENABLED=true` plus `WEBHOOK_DOMAIN=https://your.host` and the bot switches to webhook delivery (default). Leave `WEBHOOK_DOMAIN` empty for polling. Set `WEBHOOK_SECRET` to enforce a header token.

## Per-user storage

Each Telegram user gets their own SQLite file at `data/tenants/<user_id>.db` containing messages, sessions, tool audit, long-term memory, and prefs. The global DB keeps user identity, proxies, and usage rollups. On first run after upgrade, legacy `users` config columns are auto-copied into per-user `prefs`.

## Docs
- [`AGENTS.md`](AGENTS.md) — operator handbook: deploy, config locations, proxy troubleshooting
- [`SOUL.md`](SOUL.md) — what the bot is, and its boundaries
- [`prompts/default.md`](prompts/default.md) — the default system prompt, annotated. Live version: `SYSTEM_PROMPT` in `.env`
- [`docs/telegram-markdown.md`](docs/telegram-markdown.md) — the formatting gotchas that eat replies
- [`docs/memory-skills-context.md`](docs/memory-skills-context.md) — how memory works here, and how to extend it
- [`docs/browser.md`](docs/browser.md) — the browser as agent tools: Camoufox, `@eN` refs, engine fallback
- [`docs/searching-and-execution.md`](docs/searching-and-execution.md) — finding anything, and what can run shell commands

## Test

```
node --test tests/*.test.js
```
10 tests cover config loading, Zod provider validation, Zod rejection of malformed input, zod → OpenAI JSON Schema conversion, sandbox path-escape rejection, bash_exec denial, read_file line capping, per-user DB isolation, memory FTS5 roundtrip, MCP stdio JSON-RPC roundtrip.

## See also

- [`AGENTS.md`](AGENTS.md) — full agent-harness reference: tools, rich-Telegram UX, `/gitconfig`, env vars, ponytails.

## License

MIT.

- Code intelligence: RAG search, AST symbols, dependency graph, dead code, image generation
- `/gitpull` — one-command self-update + auto-restart
- `/memory` — durable memory surface
- oh-my-pi tooling, recoded native: read_pro (files/archives/SQLite/PDF), read_summary, ast_grep structural search, stateful REPL, checkpoint/rewind, context_notes, think, security_scan, GitHub ops, TTS