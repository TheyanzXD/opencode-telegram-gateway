---
name: agent-tools
description: Names and purpose of every agent tool. Load to list tools.
when: agent|tools|tool list|what can you do
version: 1.0
---

The agent has 66 tools. Grouped by what they do; read-only ones do not need
approval, mutating ones do.

**Shell & execution**
- `execute_bash` — a shell in your workspace, blocked patterns refused
- `execute_python` — python3, output capped
- `execute_node` — `node:vm` sandbox, synchronous, no fs/child_process
- `job_start` / `job_status` / `job_output` / `job_kill` — long-running work
  that outlives the 30s tool budget
- `git` — git in the workspace, refuses force/reset --hard/clean -fx
- `sysinfo` — host, runtime, memory, load

**Files**
- `read_file` / `write_file` / `edit_file` / `list_dir`
- `multi_edit` — N edits to one file, atomic: all land or none do
- `diff_review` / `diff_reject` — numbered hunks, reject one keep the rest
- `ast_edit` — identifier rename that skips strings and comments
- `run_tests` — auto-detects pytest/jest/go/cargo
- `compile_run` — rustc/go/gcc with line:column errors
- `send_document` — deliver a workspace file to the chat

**Finding things**
- `grep` — regex across the workspace; ripgrep when present, a JS fallback
  when not. `path:line:match` output, capped
- `glob` — files by name pattern, newest first, node_modules excluded

**Memory & knowledge**
- `remember` / `recall` / `forget` — durable facts across /reset and restart
- `record_lesson` / `recall_lesson` — a failed approach and the fix
- `record_decision` — why one path was taken, readable via /why
- `scratchpad_write/read/list/delete` — working state out of the context window

**Browser** (Camoufox, session per chat)
- `browser_navigate` / `browser_snapshot` (@eN refs) / `browser_read`
- `browser_click` / `browser_type` (dangerous)
- `browser_search` / `browser_close`
- `browser_wait` / `browser_scroll` / `browser_keyboard` / `browser_form`
- `browser_extract` / `browser_console` / `browser_screenshot` / `browser_tabs`

**Delegation**
- `delegate_task` — a subagent with its own context window for an independent
  subtask. Read-only tools by default, max depth 2.

**Observability**
- `trace_export` — the full trace of a turn as JSON/Markdown/text
- `cost_report` — spend breakdown per model and per tool

**Port forwarding** (like VS Code)
- `tunnel_open` / `tunnel_list` / `tunnel_close` — give a localhost server a
  URL the user can open. Relay URLs carry a secret path token; an open port is
  not a reachable service

**Talking to the human**
- `ask_user` — stop and wait for an answer. Choice buttons or a typed reply.
  Use it instead of guessing when the decision is theirs
- `code_index` then `semantic_code_search` — find code by meaning instead of
  grepping blind. Index once, reuse. Prefer this over reading three files whole
  when you only need the one function.
- `code_symbols` — the map of what is in a file, before you read it.
- `dependency_graph` — what breaks if you edit this file. Check before a
  refactor, not after.
- `dead_code_scan` — candidates for removal; always verify before deleting. — the session task list, visible as /todo
- the user can drop a `.zip` or code file into the chat; it lands in the
  workspace as real files, so tell them to do that instead of pasting a wall of
  code. `/undo` restores the last change you made in their workspace — offer it
  when a refactor goes sideways.

Choose by blast radius: read first (`read_file`, `list_dir`, `browser_read`),
then act (`multi_edit` over repeated `edit_file`, `job_start` for anything
over a few seconds). Never `rm` in bash when `edit_file` will do.
