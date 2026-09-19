# OpenCode Telegram Gateway

A multi-provider OpenAI-compatible **Telegram gateway** with streaming, vision, conversation sessions, a 10k+ free-proxy pool rotated per chat, admin channel-gating, and full SQLite-backed state. Built with Node.js — **no root required**, runs from a plain user account using only Node's built-in tooling (no native package manager steps; no system services; no `sudo`).

## Features

- 🛰 **Multi-provider** — any OpenAI-compatible endpoint. Five auth modes (`header` / `xheader` / `query` / `body` / `none`) cover OpenAI, OpenRouter, Groq, DeepInfra, OpenAI-style clones, local Ollama, and custom gateways.
- 🛡 **Zod-validated** config — malformed `providers.yaml` is rejected at boot, never silently accepted.
- 💬 **Conversation sessions** — `/sessions new|list|resume|delete|rename|export|active`. Each session scopes its own history in SQLite.
- 🖼 **Vision** — image attachments forwarded to vision-capable models automatically; override via `VISION_PROVIDER`/`VISION_MODEL`.
- ⚡ **Streaming** — Telegram edit-in-place as the model types.
- 🌐 **Proxy pool (10k+)** — auto-fetches public proxies from ~20 sources at startup, rotates per-chat (stable hash), tracks per-proxy health, auto-refreshes every N hours. Up to 39k observed in practice (HTTP/SOCKS4/SOCKS5/HTTPS). Authenticated premium proxies (`user:pass@ip:port`) load from a local gitignored file via `PROXY_PREMIUM_FILE`.
- 🖥 **Headless browser** — `/browse` drives real Chromium: open, read, snapshot (`@eN` refs), click, type, screenshot, eval. Same `agent-browser` stack Hermes Agent uses. Optional — degrades to an install hint if absent.
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

### Optional: headless browser

`agent-browser` is a dependency of the repo, so `npm ci` installs it. It does
not bundle Chromium (~150 MB) — the first `/browse` fetches it once, or:

```bash
npm run browser install
```

`/browse open <url>` then works in chat.

### Optional: authenticated proxies

```bash
echo 'user:pass@1.2.3.4:1081' >> premium-proxy-list.txt   # socks5, one per line
# .env
PROXY_PREMIUM_FILE=/absolute/path/to/premium-proxy-list.txt
```

Premium entries are seeded ahead of the public lists, so per-chat rotation prefers them. The file is gitignored — never commit credentials.

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
/model list <p>      Live model list from the provider itself
/model add <p/m>     Register a new model (admin) — e.g. /model add groq/new-model 128000
/models              List every registered model
/browse [...]         Headless browser — see below
/browse open <url>    Open a page, then snapshot/click/type/read it
/temperature <0-2>   Set temperature
/system <prompt>     Set system prompt
/reset               Clear history of active session
/history             Show last 10 messages
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

## Docs
- [`AGENTS.md`](AGENTS.md) — operator handbook: deploy, config locations, proxy troubleshooting
- [`SOUL.md`](SOUL.md) — what the bot is, and its boundaries
- [`docs/telegram-markdown.md`](docs/telegram-markdown.md) — the formatting gotchas that eat replies
- [`docs/memory-skills-context.md`](docs/memory-skills-context.md) — how memory works here, and how to extend it
- [`docs/browser.md`](docs/browser.md) — `/browse`, headless Chromium via agent-browser
- [`docs/searching-and-execution.md`](docs/searching-and-execution.md) — finding anything, and why the bot can't run shell commands

## Test

```bash
node --test tests/
```
3 tests cover config loading, Zod provider validation, and Zod rejection of malformed input.

## License

MIT.
