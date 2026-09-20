// language: JavaScript (Node 20+ ESM), file: src/agent/awareness.js
// The architecture brief. The model gets tools as a JSON schema list; nothing
// in that list tells it *where it is* or *what those tools mean together*.
// Without this, "can you browse my files?" is answered from generic training
// data — the model defaults to "I cannot access files," because that is true
// of every chatbot it was trained to be.
//
// Everything here is computed, never hardcoded. If the deploy changes — a
// different host, a disabled browser, no workspace — the brief changes with
// it, so the model is never told a capability it does not have.
//
// Placement: this becomes the second system message, below the soul (the
// personality outranks it) and above the runtime context line. It is stable
// across turns, so it sits inside the cached prefix and costs once.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sessionActive } from '../browser/camoufox.js';
import { createDefaultRegistry } from './registry.js';

const _cache = { at: 0, ttl: 30_000, body: null };

/**
 * The brief. Cheap to compute, cached for 30s — it goes into every prompt, so
 * it must never cost a disk walk per turn.
 *
 * @param {object} opts
 * @param {string} opts.workspace   the user's workspace root, or null
 * @param {number} [opts.chatId]    chat id, for browser session detection
 */
export function architectureBrief({ workspace = null, chatId = null } = {}) {
  const now = Date.now();
  if (_cache.body && now - _cache.at < _cache.ttl) {
    return _cache.body.replace('{WORKSPACE}', workspace || '(unset)');
  }

  const parts = [];

  parts.push('## Where you run');
  parts.push(
    [
      `You are not a stateless chatbot. You are an agent process running on a real machine — ${hostLine()}.`,
      `You have a tool-calling loop: you decide an action, a tool runs it on this host, the result comes back, and you continue. Saying "I cannot access files" is factually wrong here, and it wastes the user's turn.`,
      'When a task needs files, code, a shell, or a browser, call the tool. Do not narrate what you *would* do — do it, then report the result.',
    ].join('\n'),
  );

  parts.push('## What you can reach');
  parts.push(reachability(workspace, chatId));

  parts.push('## How to use the tools');
  parts.push(toolStrategy());

  parts.push('## Boundaries');
  parts.push(boundaries());

  const body = parts.join('\n\n');
  _cache.body = body;
  _cache.at = now;
  return body.replace('{WORKSPACE}', workspace || '(unset)');
}

// ------------------------------------------------------------------ pieces

function hostLine() {
  const bits = [os.hostname(), `${os.platform()}/${os.arch()}`, `node ${process.version}`];
  if (os.cpus()?.[0]?.model) bits.push(os.cpus()[0].model.trim());
  return bits.join(' · ');
}

function reachability(workspace, chatId) {
  const lines = [];

  if (workspace) {
    const count = countFiles(workspace);
    lines.push(
      `- The workspace at \`${workspace}\`${count ? ` (${count} files)` : ''} is a real directory on this host. \`read_file\`, \`glob\`, \`grep\` see it. It is *this user's* — no other user's workspace exists for you.`,
    );
  }

  // The browser is a capability, not a promise: the binary may be absent on a
  // fresh clone. Say what is true right now.
  if (browserAvailable()) {
    const live = chatId != null && safeSessionActive(chatId);
    lines.push(
      `- A web browser (anti-detect Firefox, Camoufox) is installed. \`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_read\` drive a real page. Session${live ? ' is live for this chat' : ' starts on first navigate'}. Logins persist via \`browser_auth\`.`,
    );
  } else {
    lines.push(
      '- The browser tools are listed but the Camoufox binary is not installed here — they will fail. Fetch a URL with `fetch_url` or `web_search` instead, and tell the user `npx camou install` is needed for browsing.',
    );
  }

  lines.push(
    `- A shell: \`execute_bash\` runs real commands on this host. Python: \`execute_python\` (up to 600s). Long jobs: \`job_start\` detaches them so they outlive the tool call — check back with \`job_output\`.`,
    `- You can give the user a clickable URL for a local server with \`tunnel_open\` (VS Code-style port forwarding). Use it when you start a dev server, notebook, or anything visual.`,
    `- Memory persists across sessions: \`remember\` a durable fact, \`recall\` it later. A failed approach and its fix go in \`record_lesson\`. \`ask_user\` stops for a human answer when the decision is theirs to make.`,
  );

  return lines.join('\n');
}

function toolStrategy() {
  const r = createDefaultRegistry();
  const names = r.names();
  const dangerous = r.list().filter((t) => t.isDangerous || typeof t.requiresApproval === 'function');

  return [
    `You have ${names.length} tools. The ones that change state (${dangerous.length}: ${dangerous.slice(0, 8).map((t) => `\`${t.name}\``).join(', ')}${dangerous.length > 8 ? ', …' : ''}) pause for a one-tap human approval — that is by design, not an error. If a user has approved a class of action, continue; if denied, stop and ask what they wanted instead.`,
    'Order of cost: read before write, `glob`/`grep` before reading files blind, `browser_read` before `browser_snapshot` (snapshot is the compressed map, read pulls the text). Use `multi_edit` for several changes to one file — it is atomic, all-or-nothing.',
    'Anything that runs longer than a few seconds is a `job_start`, never a blocking call. Report progress by reading the job output, not by promising it will work.',
    'When you do not know a fact about this machine, `sysinfo` and `list_dir` answer it. Do not guess the OS, the memory, or the file layout — ask the tools.',
  ].join('\n');
}

function boundaries() {
  return [
    'You cannot see the user\'s screen, their phone storage, or files outside this host. When they mean a file on their own device, ask them to paste the content or send it as an attachment — and say plainly that the workspace is on your side, not theirs.',
    'The workspace is per-user. Another user\'s files are not accessible to you, by design — do not try to escape it.',
    'You do not have the user\'s credentials for third-party sites. If a login is needed, either they provide it once and `browser_auth` persists it, or you find a public route.',
    'If a tool fails, read the error and try a different approach. The failure message is data, not a stop sign — unless it is an approval denial; then stop.',
  ].join('\n');
}

// ------------------------------------------------------------------ probes

function browserAvailable() {
  const dir = process.env.CAMOUFOX_INSTALL_DIR || '';
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'camoufox-bin')) || fs.existsSync(dir);
  } catch {
    return false;
  }
}

function safeSessionActive(chatId) {
  try { return sessionActive(chatId); } catch { return false; }
}

function countFiles(dir) {
  // Bounded: this runs per turn. A deep tree is not counted precisely, it is
  // estimated, because the exact number is not what the model needs.
  let n = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (n > 400) break;
      if (e.isDirectory()) n += 50; // estimate, not a walk
      else n++;
    }
  } catch {}
  return n;
}
