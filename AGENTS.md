# AGENTS.md — Operator Handbook

Everything an operator (human or AI) needs to run, extend, and fix this
bot. Read this before touching config.

## Where everything lives

```
opencode-telegram-gateway/
├── .env                  # YOUR secrets — token, API keys (gitignored)
├── providers.yaml        # endpoints + registered models
├── data/gateway.db       # SQLite: users, messages, sessions, proxies (gitignored)
├── src/
│   ├── config.js         # every env var is read here — single source of truth
│   ├── db.js             # schema + all queries
│   ├── logger.js         # pino, redacts apiKey
│   ├── providers/
│   │   ├── store.js      # load/parse/save providers.yaml, addModel()
│   │   └── client.js     # HTTP: chatCompletion, streamChatCompletion, listModels
│   ├── proxy/
│   │   ├── sources.js    # the public proxy list URLs
│   │   ├── fetcher.js    # refresh(), loadPremiumFile(), parseAuthLine()
│   │   └── pool.js       # dispatcherForProxy(), verifyProxy(), sweepDead()
│   ├── bot/
│   │   ├── index.js      # wiring + startup
│   │   ├── middleware.js # auth, session flags
│   │   ├── commands/     # user.js, admin.js, sessions.js
│   │   └── handlers/     # message.js — streaming replies
│   └── cli/              # setup, doctor, models, tui, proxy
├── SOUL.md               # what the bot *is* (behavior spec)
├── AGENTS.md             # this file
└── docs/                 # topic guides
```

**To change any setting:** edit `.env`, restart. `config.js` is the only
file that reads environment variables — do not read them anywhere else.

## Deploy from scratch

```bash
git clone https://github.com/TheyanzXD/opencode-telegram-gateway.git
cd opencode-telegram-gateway
cp .env.example .env
# edit .env: set TELEGRAM_BOT_TOKEN + one API key
npm ci
npm run doctor    # validates config, pings each provider
npm start
```

Requirements: Node ≥ 18 (≥ 20 recommended). `better-sqlite3` ships
prebuilt binaries; no native toolchain needed on common platforms.

## Providers & models

Register a provider in `providers.yaml`:

```yaml
providers:
  - name: myprovider
    base_url: https://api.example.com/v1
    auth_mode: header        # header|xheader|query|body|none
    key_env: MY_KEY          # env var name; value goes in .env
    models:
      gpt-4o-mini: { context: 128000, vision: true }
```

Then add models at runtime (admin only):

```
/model list myprovider              # live /v1/models from the provider
/model add myprovider/gpt-4o-mini   # register it
/model add myprovider/big-model 200000 vision
/model myprovider/gpt-4o-mini       # switch to it
```

`/model add` writes to `providers.yaml` on disk and clears the in-memory
cache, so the new model is live immediately — no restart.

## Proxy pool

Two kinds of proxies in one pool:

1. **Public** — ~20 free list sources, fetched at startup, auto-refreshed
   every `PROXY_REFRESH_HOURS` (6h default). Zero guarantee any of them
   work; `sweepDead` demotes the dead ones.
2. **Premium/authenticated** — a local file you supply:

   ```bash
   # .env
   PROXY_PREMIUM_FILE=/path/to/premium-proxy-list.txt
   ```

   Format: `user:pass@ip:port` per line, socks5 assumed. The file is
   **gitignored** — never commit credentials.

Each chat gets one proxy via `hash(chatId) % pool`, so the same chat
always uses the same proxy until it dies (fails ≥ 5), then it falls back
to any healthy one. If the pool is entirely empty the bot connects
directly.

**Turn the whole thing off:** `PROXY_ENABLED=false` in `.env`.

### When proxies misbehave

Symptom: `stream error: fetch failed` on every message, but `bot online`
looks healthy. Almost always the proxy the chat hashed to is dead.

- `npm run proxy` — pool stats
- `node bin/opencode-gateway.js proxy sweep` — liveness-check 200 random
- `PROXY_ENABLED=false` — bypass entirely while you investigate

The liveness probe hits `https://httpbin.org/ip` through the proxy. A
proxy that answers with a non-SOCKS byte (e.g. an HTTP `502` from a dead
upstream) produces `Invalid auth sub-negotiation version: 5` in undici —
that message means *the proxy is broken or the credentials are wrong*,
not that undici is buggy. Verified by raw socket handshake against a
live server: the server sent `\x05\x02key not found in keystore`.

## Telegram Markdown (the gotcha field)

This is where most rendering breaks. Read `docs/telegram-markdown.md`
for the full reference; the critical rules:

- Bot API v1 `Markdown` mode: `*bold*`, `_italic_`, `` `code` ``,
  ``` ```pre``` ```, `[text](url)`. **Underscores inside words break
  it** — `some_model_name` parses as italic and the API rejects the
  whole message.
- Model IDs contain `/` and often `:` (e.g.
  `deepseek/deepseek-chat-v3-0324:free`). Slash is fine; `:` inside
  `[link](url)` breaks it.
- Any unbalanced `*_``[` in the model's output → 400 Bad Request →
  the reply silently vanishes. `sendReply` retries the chunk without
  parse mode.
- Hard limits: 4096 chars/message, 64 buttons/row-ish, 100 rows.
  `splitLong()` handles the first one.

## Memory, skills, context

**This bot has none.** It is stateless per-message except SQLite:

- `HISTORY_LIMIT` (default 20) — how many previous turns get resent with
  each message. That is the entire "memory". Bump it for continuity,
  lower it to cut cost.
- `/sessions new|resume|delete` — separate histories per topic. Each
  message row carries a `session_id`.
- `/reset` — wipe the active session's history.

There is no vector store, no embeddings, no skill loader, no
context-summarizer. If you need long-term recall, add it: `db.js` is
where a `memories` table would go, and `conversation.js` is where you
would inject it into the message array. The bot will not do this for
you.

## Command execution

**The bot cannot run shell commands.** It has no `child_process`
import anywhere in `src/`. `npm run doctor`, `npm run proxy`, and
`npm run setup` are *operator* CLI tools you run in a terminal on the
host — the bot does not expose them over Telegram.

The closest thing to host mutation from chat is `/model add` (writes
`providers.yaml`) and `/admin broadcast`. Both are admin-gated and both
touch only project files.

## Searching / finding things

```bash
# any setting
grep -n 'SOME_VAR' src/config.js

# a command's behavior
grep -rn 'modelCommand' src/bot/commands/

# what a proxy error means
grep -rn 'sub-negotiation' node_modules/undici/lib/

# schema
node -e "const db=require('better-sqlite3')('./data/gateway.db'); console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table'\").all())"
```

See `docs/` for the deep dives.
