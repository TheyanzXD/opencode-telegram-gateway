# MCP — Model Context Protocol

[MCP](https://modelcontextprotocol.io) is the open standard for tool servers.
Connecting one client means every MCP server on npm becomes a set of tools
this bot's agent can call — no per-integration wrapper to write.

## Configuring

`MCP_SERVERS` is a JSON array in `.env`. Each entry becomes a set of agent
tools, named `<server>__<tool>`.

**Stdio** (a local process):

```json
[
  {"name": "fs", "command": "npx", "args": ["@modelcontextprotocol/server-filesystem", "."]},
  {"name": "memory", "command": "npx", "args": ["@modelcontextprotocol/server-memory"]}
]
```

**HTTP** (a remote server):

```json
[
  {"name": "remote", "url": "https://mcp.example.com/sse", "headers": {"Authorization": "Bearer ..."}}
]
```

## Well-known servers

| Package | What it gives the agent |
| --- | --- |
| `@modelcontextprotocol/server-filesystem` | Read/write files in a directory |
| `@modelcontextprotocol/server-memory` | A persistent knowledge graph |
| `@modelcontextprotocol/server-github` | Repos, issues, PRs (needs `GITHUB_PERSONAL_ACCESS_TOKEN`) |
| `@modelcontextprotocol/server-postgres` | Read-only SQL against a database |
| `@modelcontextprotocol/server-puppeteer` | Browser automation |

Shop the full list: <https://github.com/modelcontextprotocol/servers>

## Behavior

- **Isolation.** Each server connects independently. One that fails to
  initialize — bad path, missing token, timeout — is logged and skipped; the
  rest still load. A broken server never blocks the agent.
- **Handshake timeout.** 15 seconds. A server that does not answer
  `initialize` in that window is not usable and is dropped.
- **Read-only by default?** No. MCP tools appear with whatever permissions
  the server declares. Treat them as you would any `dangerous` agent tool —
  the approval gate still applies when the registry marks them.
- **Lifetime.** Servers stay connected for the process lifetime and are
  cleaned up on exit.

## Limitations

The client speaks JSON-RPC 2.0 over stdio and streamable-HTTP. It does not
implement the SSE transport's older `notifications/` stream, the
`resources`/`prompts` capability families (only `tools`), or sampling — the
agent does not delegate model calls to an MCP server.

A server that crashes mid-session drops its tools until the process restarts.
The agent sees a clear error, not a hang.
