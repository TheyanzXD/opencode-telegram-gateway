# Agent mode — tool-calling ReAct loop with human-in-the-loop approvals

`AGENT_ENABLED=true` turns the gateway from a chat relay into a coding agent. The
model can call tools (shell, filesystem, web search) in a loop, and anything
destructive pauses for a Telegram approval before it runs.

Every run is traced: provider calls, tool calls, approvals, and errors land in a
timeline readable with `/debug`. Provider failures are classified — network,
timeout, auth, rate limit, missing module — and the retryable ones are retried
in-place (up to 2 per turn, honoring `Retry-After` on a 429) so a flaky proxy
cannot kill a long task.

## Enable

```bash
# .env
AGENT_ENABLED=true
# optional:
AGENT_WORKSPACE=./workspace          # sandbox root, created on start
AGENT_MAX_TURNS=20                    # hard cap on tool rounds per task
BASH_TIMEOUT_MS=30000                 # per-command kill timer
AGENT_DEBOUNCE_MS=1500                # progress edit interval
AGENT_BLOCKED_TOOLS=                  # csv: names the agent may never call
```

Nothing in `workspace/` is tracked by git. That is the point — it is the scratch
directory the agent reads and writes.

## Commands

| Command | What it does |
|---|---|
| `/agent <task>` | Run the tool loop on a prompt. Streams progress into one message. |
| `/abort` | Cancel the running loop for this chat. Also denies any pending approval. |
| `/tools` | List the tools the agent may call. |
| `/yolo on\|off` | Auto-approve every dangerous call for this user. No keyboard, no second chance. |
| `/estop` | Emergency stop: cancel every running turn, deny every pending approval. |

A second message while a turn is running does not race the first — it takes a
turn lease, queues behind it, and runs against the now-complete history. A
stale lease (the previous turn crashed without releasing) is reclaimed after
5 minutes. `/abort` and `/estop` release leases immediately.

## The tools

- `execute_bash` — one shell command, sandboxed to the workspace, 30s timeout,
  512 KB output cap. **Dangerous.** Refuses a small blocklist (`rm -rf /`, fork
  bombs, `mkfs`, `dd of=/dev/`, reboot/halt) even with approval.
- `write_file` — create or overwrite. **Dangerous.**
- `edit_file` — string replace; refuses ambiguous matches unless `replace_all`.
  **Dangerous.**
- `read_file` — numbered lines, optional `start_line`/`end_line`.
- `list_dir` — directory listing.
- `web_search` — DuckDuckGo HTML, no API key needed.
- `fetch_url` — raw text or JSON from a URL, capped at 20 KB.
- `browser_navigate` — open a URL in the anti-detect browser (Camoufox).
  Returns the title and the first lines of text. Read-only.
- `browser_snapshot` — list every clickable element on the current page as
  stable `@eN` refs. **This is the step before any click or type.** Read-only.
- `browser_read` — full text of the page, or of one element (`@eN` or
  selector). Read-only.
- `browser_click` — click an element. **Dangerous** — it performs a real action
  on a remote site (submit, buy, delete, post).
- `browser_type` — fill a form field, optionally press Enter. **Dangerous.**
- `browser_search` — web search through the anti-detect browser, with engine
  fallback (DuckDuckGo HTML → Lite → Brave). Read-only.
- `browser_close` — close the session for this chat, free the browser.

One browser session per chat: `browser_navigate` on chat A never touches chat
B's page. The session lives until `browser_close`, until the process restarts,
or until a stale lease is reclaimed.

Refs are page-scoped and rebuilt on every `browser_snapshot`. A ref from before
a click or a navigation is stale — the tool says so instead of clicking
whatever now sits at that index.

Every path is resolved against the workspace and rejected if it escapes. `..`
traversal out of the sandbox does not reach the filesystem.

## Approvals

When the model calls a tool flagged `isDangerous`, the engine parks the call on
a deferred promise and the bot sends an inline keyboard:

```
🔐 Approval required

Tool: execute_bash
{ "command": "rm build/" }

[✅ Izinkan]  [❌ Tolak]
```

Execution resumes from exactly that point when a button is pressed. Deny is not
fatal — the tool result `⛔ denied by user` goes back to the model and the loop
continues, usually with the model picking a safer path or explaining what it
wanted.

An unanswered approval expires after 10 minutes and counts as a deny. `/abort`
resolves every pending approval for that user as denied.

The `approve:` / `deny:` callback prefix is matched by regex on
`callback_query`, so the buttons cannot collide with other handlers.

### Yolo and the denial breaker

`/yolo on` auto-approves every dangerous call — it skips the keyboard entirely.
It is a real privilege escalation for a user who has decided they trust the
loop; `/yolo off` restores approvals.

The **denial breaker** is the opposite case. A user who denies three approvals
in a row is tired of being asked: further dangerous calls in that run are
auto-denied without a keyboard, and the model gets `⛔ denied (approval
fatigue)` so it can pick a different path. Any approval resets the streak.

### The guardian LLM

`GUARDIAN_PROVIDER` + `GUARDIAN_MODEL` (both optional) enable a second, cheap
model that pre-screens each dangerous call. Clearly-safe and reversible calls
run without a keyboard; anything risky or uncertain still asks.

- It runs on a **separate model from the agent's** — a judge that costs the same
  as the work is a second copy of the task, not a judge.
- It can only lower friction on calls the user would have approved anyway. It
  cannot authorize what the blocklist refuses: `rm -rf /`, `mkfs`, `dd of=/dev/`,
  fork bombs, `curl|sh` are rejected before the guardian even runs.
- A dead guardian fails closed — `null` verdict means ask. An unreachable judge
  never becomes an open gate.

```bash
# .env
GUARDIAN_PROVIDER=cheap        # must differ from the agent's provider
GUARDIAN_MODEL=gpt-4o-mini     # cheap, 8 tokens of output
```

## The progress message

One message is created at the start and edited in place. Telegram allows roughly
one edit per second per message; the engine fires events far faster than that,
so the presenter debounces to `AGENT_DEBOUNCE_MS` (1.5s default). Tool lines
stack at the top, tokens append below, and the final edit applies Telegram
Markdown escaping once at the end. Only the final text is Markdown-parsed —
parsing a half-streamed fence would break on every intermediate state.

## Rate limits and failure modes

- **429 on editMessageText** — caught and swallowed, except the "message is not
  modified" case, which is expected when two debounce cycles produce identical
  text.
- **max turns** — the loop throws at `AGENT_MAX_TURNS`. The error is pushed as
  an event and rendered into the same message; nothing is left mid-run.
- **abort** — cooperative. Checked between turns and before each provider call.
  An in-flight HTTP request is not killed mid-flight; the loop stops on the next
  check.
- **tool throws** — never. `registry.execute` catches and returns the error as
  tool_result content, so one bad call cannot kill a task.

## Security notes

The agent runs commands on the host as the bot's process user. The workspace
sandbox stops path traversal; it does not stop a command that reaches out over
the network or writes through a pipe. The approval gate is the actual control —
that is why `execute_bash`, `write_file`, and `edit_file` are the ones parked.

If the bot is open to users beyond the operator, keep `AGENT_ENABLED=false` or
gate `/agent` behind the admin allowlist. The tools are a real shell on a real
machine; treat the approval button as the last line, not the first.
