# AGENTS.md

Reference for AI agents working on this repository. Keep edits scoped to the layout below; everything else is handled by the patterns already in place.

## Overview

A Telegram bot that talks to any OpenAI-compatible LLM provider and runs an agent loop with file, bash, git, web, memory, GitHub, and MCP tools. Per-user state is isolated in `data/tenants/<user_id>.db`; the global DB at `config.dbPath` keeps only user identity, proxies, and usage rollup.

## Layout

```
bin/opencode-gateway.js          CLI dispatch (setup | doctor | tui | models | proxy | start)
src/
  index.js                       process boot + shutdown wiring
  config.js                      env loader + config tree
  db.js                          global DB (users, proxies, usage, _meta)
  tenant.js                      opens data/tenants/<user_id>.db on demand
  tenant_messages.js             messages / sessions / tool_audit / prefs on tenant DB
  memory.js                      FTS5 long-term memory (BM25)
  conversation.js                 system + history → OpenAI messages
  format.js                      markdown / split helpers
  logger.js                      pino instance
  providers/
    client.js                    chat + streamChatCompletion (yields {content, tool_calls, finish_reason})
    store.js                     providers.yaml load/validate (zod)
  proxy/
    fetcher.js pool.js sources.js  public proxy pool
  agent/
    sandbox.js                   safeResolve / assertInCwd (path sandbox)
    tools.js                     static tool registry (name + zod schema + run)
    github.js                    undici GitHub REST client (no SDK)
    web_search.js                DuckDuckGo HTML + IA fallback
    web_browse.js                HTML to clean Markdown + link discovery (cheerio)
    xerj.js                      XERJ daemon & client integration (search, def, index)
    zodJsonSchema.js              zod → OpenAI function.parameters (no new dep)
    loop.js                      runAgent(): streaming + tool loop + audit + send-as-doc
    approval.js                  inline approval promise map (auto-deny)
  mcp/
    client.js                    JSON-RPC 2.0 client (stdio + http)
    index.js                      registry loader + toolsForUser / runToolCall
  bot/
    index.js                     createBot / run (polling or webhook)
    middleware.js                auth + admin-channel gate + soft throttle
    handlers/
      message.js                 onText/onPhoto/onDocument + per-chat serialize → runAgent
      callback.js                tool:allow* / tool:deny* / tool:sendfile:* / gh:* / stats:*
    commands/                    slash handlers (user, admin, sessions, cwd, tools, gitconfig, stats)
  cli/                           non-bot subcommands
tests/
  agent.test.js  config.test.js  tenant.test.js
data/                            runtime (gitignored): gateway.db + tenants/<id>.db
mcp.json.example                 sample MCP server config
```

## Conventions

- ES modules only. No CommonJS. `import` always, no `require`.
- New deps require an inline patch of their own: justify in the PR, never for what one should set up.
- Reuse before add: prefer stdlib + `undici` (already in) + `better-sqlite3` (already in) + `zod` (already in) before adding packages.
- zod schemas live next to the function they describe. `schemaToJsonSchema()` in `agent/zodJsonSchema.js` converts to OpenAI function.parameters — extend that adapter, not the call sites.
- Streaming yields are structured `{ content, tool_calls, finish_reason }`. Tool-call deltas must be merged by `index` (see `mergeToolCallDelta`).
- Per-user state must not use the global DB. Use `tenantDb(userId)` from `src/tenant.js`.
- All path resolution against the user's cwd goes through `safeResolve()`; never `path.resolve()` direct.
- Anything that may emit `tool_call_id` is part of the agent turn loop, not a slash handler.

## Tests

```
node --test tests/*.test.js
```

Ten tests total. Add tests for: pure helpers, the agent loop with a mocked stream, MCP stdio roundtrip, tenant isolation, FTS5 roundtrip. Skip Telegram-only behaviour (send-as-document, callbacks) and any code path that requires network.

## Adding a tool

1. Write the zod schema and `run(args, ctx)` in `src/agent/tools.js`. Each `run` receives `{ user, chatId, cwd, askApproval? }`.
2. Append to the `tools` array at the bottom of the same file. Done — `runAgent()` will pick it up.
3. If it requires per-call approval, call `await ctx.askApproval({ tool, args })` before the side effect.
4. If it writes state, also persist to tenant DB: `auditTool(userId, { tool_name, args, ok, output, duration_ms })`.
5. Tests: one smoke test that `runToolCall` returns `{ ok, output }` or `{ ok: false, error }`.

## Adding an MCP server

1. Drop the server config into `mcp.json` (not committed — gitignored).
2. Restart. `loadMcpRegistry()` logs `[name] mcp server connected` on success.
4. Tool names become `mcp__<server>__<tool>` in the LLM's view.

## Adding a slash command

1. Implement `<verb>Command(ctx)` in `src/bot/commands/<name>.js`. Use `parse_mode: 'Markdown'` and inline keyboards for menus.
2. Register in `src/bot/index.js` near the other `bot.command(...)` calls.
3. Update the help block in `src/bot/commands/user.js`.
4. If the command has callbacks, extend `src/bot/handlers/callback.js` and add a `callback_query:data` route.

## Per-user storage

Each user has `data/tenants/<user_id>.db` with: `prefs`, `sessions`, `messages`, `tool_audit`, `memory_chunks`, `memory_fts`. Read/write goes through `tenantDb(userId)` (cached). `listTenants()` for admin export. `dropTenant(userId)` to wipe.

A one-shot `migrateLegacyPrefs()` runs on startup; it copies old `users.{provider,model,...}` columns into per-user `prefs` once, sets `_meta.legacy_prefs_v1`, and never repeats.

## Webhook mode

Set `WEBHOOK_ENABLED=true` + `WEBHOOK_DOMAIN=https://host` + `WEBHOOK_PATH` + optional `WEBHOOK_SECRET`. `bot/index.js` calls `setWebhook` then `bot.start({ webhook })`. Leave blank → default is polling.

## MCP (concise)

JSON-RPC 2.0. Stdio transport spawns the command, reads newline-delimited JSON from stdout. HTTP transport POSTs JSON. Methods used: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `notifications/initialized`. See `src/mcp/client.js`.

## Security & privacy

- Provider API keys: `.env` only. `pino` redacts `apiKey`.
- `/gitconfig` PATs: plain text in `prefs.gh_token`. Anyone with read on `data/tenants/` can read every user's token. Encryption-at-rest: ponytail.
- bash_exec and write tools: require inline approval via `askApproval`. There is no docker sandbox; approval is the only gate.
- MCP stdio servers: subprocess children. Their capabilities = bot user's capabilities. Only configure trusted servers.
- Telegram admin commands only run inside `TELEGRAM_HOME_CHANNEL` (toggle `ADMIN_REQUIRE_CHANNEL=false`).

## Ponytails (deliberately deferred)

| Item | Add when |
|---|---|
| Token encryption-at-rest (`BOT_SECRET` AES-GCM) | multi-user or untrusted deploy |
| Symlink target check in `safeResolve` | `/var → /home` escape becomes a concern |
| Cross-session tool replay | models need prior tool messages in history |
| Parallel tool execution | latency > 1s matters |
| `sendDocument` for `read_file` when >50 KB | implemented; tune threshold |
| Embeddings for `memory` (BM25 → cosine) | corpus > ~1k chunks |
| PDF parsing (`pdfjs-dist`) | users start sending PDFs |
| MCP HTTP SSE streaming | server returns event-stream |
| MCP sampling (server → LLM back) | MCP server asks for a completion |
| Webhook self-signed cert | behind non-public TLS proxy |
| Per-user tool quotas / cost caps | production multi-user |
| Per-server per-tenant MCP enable UI | bots grow to ~10+ users |

## Verification checklist

- `node --test tests/*.test.js` → 15/15 green.
- `node bin/opencode-gateway.js doctor` → no fatal (401 expected if API key invalid).
- `node src/bot/index.js` (or `npm start`) → logs `bot online`, `mcp server connected` (if configured), `database ready`.
- Manual Telegram: `/stats`, `/cwd`, `/tools`, drop a `.txt`, `read /etc/hostname` (cwd-sandboxed).