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

There is no vector store and no embeddings. Cross-session memory, skills, and
context compression do exist — see [`docs/memory-skills-context.md`](docs/memory-skills-context.md)
for the real design now, not the sketch in that file's earlier drafts.

## Command execution

`/agent` can run shell commands — that is the point of agent mode, and it is
gated behind `AGENT_ENABLED=true` plus a per-call approval (see
[`docs/agent.md`](docs/agent.md)). Outside agent mode the bot still does not
shell out. `npm run doctor`, `npm run proxy`, and `npm run setup` are *operator*
CLI tools you run in a terminal on the host — the bot does not expose them over
Telegram.

The closest thing to host mutation from chat, outside `/agent`, is `/model add`
(writes `providers.yaml`) and `/admin broadcast`. Both are admin-gated and both
touch only project files.

## RBAC, undo, and documents

**RBAC** (`src/agent/rbac.js`) is three tiers, and the tier decides what the
approval gate does:

| env | tier | can |
| --- | ---- | --- |
| `TELEGRAM_ALLOWED_USERS` | user | chat with the bot |
| `TELEGRAM_TOOL_USERS` | trusted | file/terminal tools, dangerous tools without the approval keyboard |
| `TELEGRAM_ADMIN_USERS` | admin | the above + settings + clearing other users' sessions |

Both tool tiers blank (default): every dangerous tool shows the inline keyboard,
operator-only tools (`set_quota`, `clear_sessions`) are refused. The check feeds
the existing gate in `engine.js` — it does not duplicate the approval flow.

**`/undo`** (`src/agent/snapshot.js`). `write_file` and `edit_file` call
`snapshot()` before they write, so the ring holds the pre-change hash and
`stashOriginal()` holds the bytes. `/undo` pops the ring and either restores
(stash exists) or deletes (the entry's hash is null — the file was created by
the last edit). Ring is per-user, capped 20, and refuses anything outside the
workspace. If the stash rotated out, it says "no longer recoverable" — it never
deletes the current file to look busy.

**Documents** (`src/bot/handlers/document.js`). `message:document` extracts a
zip into `workspace/<id>/<name>/` or saves a code/text file as-is, then replies
with what landed. Zip-slip is validated by name *before* the system `unzip`
runs — `isSafeName` resolves against a synthetic base, because
`path.resolve('/', '../../x')` clamps to root and reads as safe. Over 8 MB is
refused with the reason being the context window, not disk.

## Browser

There is no `/browse` command. The browser is agent tools — the model calls
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_read`, `browser_search` inside a `/agent` turn, the same shape as
Hermes Agent. See [`docs/browser.md`](docs/browser.md) for the full tool list,
the `@eN` ref system, and why Camoufox instead of Chromium.

`browser_click` and `browser_type` are approval-gated: they mutate state on a
real remote site. Read-only tools are not.

One Camoufox session per chat, held in a module map. If a `/agent` turn crashes
without closing it, the session lingers until the next `browser_close` or a
process restart — it does not leak into other chats.

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

## Feature surface (post-expansion)

The bot grew past relay + agent. This is the map so you do not grep for it.

**Commands** — `/usage`, `/quota` (admin), `/key`, `/lang`, `/soul`, `/pin`,
`/search`, `/export`, `/todo`, plus the existing set. Full reference:
`docs/features.md`.

**Agent tools** — 58 of them now. The catalog with blast radius:
`skills/agent/SKILL.md` (it is a skill so the model can look it up too).

**Port forwarding.** `src/agent/tools/live-share.js` is VS Code's forward-a-port
for a bot. Two transports: `local` (the user is on this machine — Termux, a dev
box — so the URL is `http://127.0.0.1:PORT` and nothing is spawned) and `relay`
(a remote host — a TCP forwarder is spawned, and every URL carries a 128-bit
secret path token so an open port is not a reachable service). The relay is raw
TCP, not HTTP-aware, which is what keeps websockets and HMR alive. A request
without the token is 401'd before the first byte reaches the private service.
`no_token` is refused in relay mode. The tool probes the port first, so the
failure message says "start the server" instead of the user seeing a refused
connection. `/todo` surfaces the todo tools without asking the agent.

**Asking the user.** `src/agent/tools/ask-user.js` parks a deferred promise and
resolves it from a Telegram callback or a typed reply. It reuses approvals.js
for id creation and lookup but keeps its own answer map, because the value is a
string, not a boolean. A 30-minute TTL means an unattended run does not hang.

**New subsystems and their entry points**

```
src/agent/workspace.js        per-user workspace isolation (bash + fs)
src/agent/awareness.js        the architecture brief — computed, never hardcoded
src/agent/personality.js      soul.md loader
src/agent/subagent-runner.js  delegated subtask execution
src/mcp/client.js             MCP stdio + HTTP client
src/providers/fallback.js     model fallback chain + degradation report
src/providers/keys.js         BYO keys, secret redaction, dead letter queue
src/bot/features/threads.js   reply chains, regenerate, stop, expiry, export
src/bot/features/inline.js    inline mode, forum topics, edit detection
src/bot/features/i18n.js      UI strings (en/id/es/ru/ja)
src/bot/features/webhooks.js  outbound events, signed, retried
src/bot/features/pinned.js    /pin + FTS5 history search
src/bot/health.js             webhook mode, /health, watchdog, SIGHUP reload
src/bot/commands/usage.js     /usage + /quota
src/bot/commands/account.js   /lang + /key
src/bot/commands/soul.js      /soul
src/bot/commands/search.js    /pin + /search
src/agent/observability/      trace store, collector, export, pricing
src/agent/store-kv.js         the agent's own sqlite handle (lt_memory, lessons,
                             decisions, scratchpad, todos) — kept off db.js on purpose
src/agent/tools/live-share.js  port forwarding (tunnel_open/list/close)
src/agent/tools/ask-user.js    ask_user: blocks for a human answer
src/agent/tools/opencode-parity.js  grep, glob, todowrite, todoread
src/bot/commands/todo.js      /todo
```

**Two databases.** `db.js` owns chat (users, messages, sessions, usage,
proxies). `store-kv.js` owns agent state (long-term memory, lessons,
decisions, scratchpad, quota overrides, DLQ, pins). Separate handles mean a
bad agent migration cannot take the chat tables down with it.

**Approval gating.** The engine checks `isDangerous` **or**
`requiresApproval(args)` — the second one is a per-call hook, so a tool can be
conditionally dangerous (`browser_console` is safe to read but its `evaluate`
runs arbitrary JS in the page). Gated: `browser_click`, `browser_type`, `multi_edit`,
`ast_edit`, `write_file`, `edit_file`, `execute_bash`, `git`, `compile_run`
are `isDangerous`. The guardian pre-screens; clearly-safe ones skip the
keyboard, anything unsure still asks. `/yolo` disables the gate entirely and
`/estop` kills the loop.

**SIGHUP, not restart.** `kill -HUP <pid>` clears the provider and config
caches. Use it for providers.yaml and .env changes — no connection drops.
`SIGUSR2` logs a state snapshot.

**Known limits**
- Google search is IP-blocked (`/sorry`) on datacenter ranges. DDG HTML is
  the default engine. This is an egress problem, not a fingerprint one —
  see `skills/camoufox-antidetect/SKILL.md`.
- `execute_node` is synchronous by construction (`node:vm` has no event loop
  in the sandbox). Async code belongs in `execute_bash` or `job_start`.
- MCP client speaks `tools` only — no `resources`, no `prompts`, no sampling.
