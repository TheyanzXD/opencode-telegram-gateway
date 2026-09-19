# Searching & Command Execution

## The bot cannot run commands

There is no `child_process` import anywhere in `src/`. The bot never
shells out. Every "command" in chat is a handler that answers with text:

| Chat command | What it actually does |
|---|---|
| `/model add p/m` | writes `providers.yaml` (admin only) |
| `/model list p` | HTTP GET to the provider's `/v1/models` |
| `/admin broadcast` | sends N Telegram messages |
| `/admin export` | zips `data/` → home channel |
| `/sessions export` | zips one history → home channel |

Nothing else touches the host. Even those only read/write project files.

## CLI tools are operator-only

Run these in a terminal on the host, never through chat:

```
npm run setup     # interactive wizard — creates .env + providers.yaml
npm run doctor    # validates config, pings every provider
npm run models    # lists providers × models
node bin/opencode-gateway.js proxy            # pool stats
node bin/opencode-gateway.js proxy refresh    # fetch proxies
node bin/opencode-gateway.js proxy sweep      # liveness-check 200
node bin/opencode-gateway.js proxy prune      # drop fails >= 20
node bin/opencode-gateway.js tui              # live config editor
```

`doctor` is the one to run first on any new deploy — it exercises the
same HTTP path the bot uses and reports per-provider status, so "works
locally, fails in bot" collapses to a config difference.

## Searching the codebase

**Find a setting:**
```bash
grep -n 'PROXY_' src/config.js
```
`config.js` is the single place env vars are read. If a setting is not
there, it is not a setting.

**Trace a chat command to its code:**
```bash
grep -rn 'export async function modelCommand' src/bot/commands/
```
Every bot command is `XxxCommand(ctx)` in `src/bot/commands/user.js`
(user-facing), `admin.js` (admin), or `sessions.js`. They are wired in
`src/bot/index.js` with `bot.command('x', xCommand)`.

**What happens to a message:**
```
bot/index.js          registers handlers
  → middleware.js     auth, session flags
  → handlers/message.js   handlePrompt → streamReply
    → providers/client.js streamChatCompletion → streamChunks
      → proxy/pool.js     dispatcherForProxy → ProxyAgent
```

**Inspect the database:**
```bash
# schema
node -e "const db=require('better-sqlite3')('./data/gateway.db'); \
  console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table'\").all())"

# last 20 messages
node -e "const db=require('better-sqlite3')('./data/gateway.db'); \
  console.log(db.prepare('SELECT role, substr(content,1,60) FROM messages ORDER BY id DESC LIMIT 20').all())"

# proxy pool health
node -e "const db=require('better-sqlite3')('./data/gateway.db'); \
  console.log(db.prepare('SELECT fails, count(*) n FROM proxies GROUP BY fails').all())"
```
No need for a client app — `sqlite3` CLI or node one-liners do it.

**Read a provider error:**
```bash
# full HTTP body is in the thrown message
grep 'HTTP ' data/../logs 2>/dev/null || npm run doctor
```

## When the bot is silent

Order to check, fastest to slowest:

1. **`npm start` output** — `bot online` printed? Polling alive?
2. **`.env` token + allowlist** — `TELEGRAM_ALLOWED_USERS` must contain
   your numeric ID. Bot ignores you entirely otherwise (no error).
3. **API key for the chosen provider** — `/model` shows current, then
   `npm run doctor` pings it. `HTTP 401` = bad key. `HTTP 402`/`429`
   = no credit or rate-limited.
4. **Proxy pool** — `stream error: fetch failed` with `bot online`
   healthy means the proxy died. `PROXY_ENABLED=false`, retry.
5. **Provider URL** — `HTTP 404` or `non-JSON response` means
   `base_url` in `providers.yaml` is wrong for that endpoint.
6. **Telegram Markdown** — 400 on send means malformed formatting; see
   `docs/telegram-markdown.md`. The fallback retry should still deliver
   plain text, so this only shows in logs.

## Logs

Pino, `LOG_FORMAT=json|pretty` in `.env`. API keys are redacted
automatically (`redact: ['apiKey', '*.apiKey']` in `src/logger.js`).
`LOG_FILE=/path/app.log` to persist; otherwise stdout.
