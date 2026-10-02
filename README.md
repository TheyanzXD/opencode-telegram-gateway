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

`better-sqlite3` builds natively but `npm ci` handles it via prebuilt binaries for the common Node versions — no `apt`, no `sudo`, no system packages.

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
/models              List every model
/temperature <0-2>   Set temperature
/system <prompt>     Set system prompt
/reset               Clear history of active session
/history             Show last 10 messages
/cwd [path]          Show or set agent working directory
/tools               List agent tools
/gitconfig [token]   Link GitHub account (token stored per-user)
/stats [days]        Usage, tool counts, memory chunks
/about               Bot info + stats
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

## Test

```
node --test tests/*.test.js
```
10 tests cover config loading, Zod provider validation, Zod rejection of malformed input, zod → OpenAI JSON Schema conversion, sandbox path-escape rejection, bash_exec denial, read_file line capping, per-user DB isolation, memory FTS5 roundtrip, MCP stdio JSON-RPC roundtrip.

## See also

- [`AGENTS.md`](AGENTS.md) — full agent-harness reference: tools, rich-Telegram UX, `/gitconfig`, env vars, ponytails.

## License

MIT.
