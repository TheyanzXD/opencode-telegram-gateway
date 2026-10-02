// language: JavaScript (Node 20+ ESM), file: src/agent/tools/repl.js
// Stateful REPL — the oh-my-pi idea that survives best without a PTY.
//
// omp keeps a real shell process alive per session (pi-shell, a vendored bash).
// We cannot ship that. What we CAN keep alive is a language runtime: a Python
// or Node process held open across turns, its variables intact, receiving the
// next snippet on stdin. That is the useful part — "what is in this variable
// now?" should not require re-running the whole script.
//
// The process is per-chat, idle-killed, and the prompt marker is how we know
// the snippet finished (there is no EOF to wait for on an open stdin).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const IDLE_MS = 10 * 60 * 1000;  // a REPL nobody has touched for 10 minutes dies
const MAX_OUT = 8000;
const RUNTIME = {
  python: { bin: () => process.env.PYTHON_BIN || 'python3', args: ['-i', '-q'], marker: '>>>' },
  node: { bin: () => process.env.NODE_BIN || process.execPath, args: ['-i', '--experimental-repl-await'], marker: '>' },
};

const sessions = new Map(); // chatId -> { proc, lang, lastSeen, buf, waiters }

function touch(s) { s.lastSeen = Date.now(); }

function ensure(chatId, lang, userId) {
  const key = `${chatId}:${lang}`;
  let s = sessions.get(key);
  if (s?.proc?.exitCode != null) { try { s.proc.kill(); } catch {} s = undefined; }
  if (s) { touch(s); return s; }

  const rt = RUNTIME[lang];
  const root = path.resolve(config.agent.workspace, String(userId ?? chatId));
  const proc = spawn(rt.bin(), rt.args, {
    cwd: root,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    windowsHide: true,
  });
  s = { proc, lang, lastSeen: Date.now(), buf: '', waiters: [] };
  sessions.set(key, s);

  const onData = (d) => {
    s.buf += String(d);
    // flush to whoever is waiting when the prompt marker shows
    if (s.buf.includes(rt.marker) || s.buf.length > MAX_OUT * 2) flush(s, rt);
  };
  // the marker may already be sitting in the buffer from startup
  process.nextTick(() => { if (s.buf.includes(rt.marker) && s.waiters.length) flush(s, rt); });
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', () => { s.proc = null; flush(s, rt); sessions.delete(key); });
  proc.on('error', (err) => { logger.warn({ err: err.message, lang }, 'repl spawn failed'); s.proc = null; });

  // the interactive prompt is the synchronization signal
  if (lang === 'python') proc.stdin.write('import sys; sys.ps1 = ">>> "\n');
  return s;
}

function flush(s, rt) {
  if (!s.waiters.length) return;
  // cut at the prompt marker — what is after it is the next turn's preamble
  const idx = s.buf.lastIndexOf(rt.marker);
  const out = idx >= 0 ? s.buf.slice(0, idx) : s.buf;
  s.buf = idx >= 0 ? s.buf.slice(idx + rt.marker.length) : '';
  const w = s.waiters.shift();
  if (w) w(out.trim().slice(0, MAX_OUT));
}

/** Kill a session after it has been idle long enough. */
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.lastSeen < IDLE_MS) continue;
    try { s.proc?.kill('SIGKILL'); } catch {}
    sessions.delete(k);
  }
}, 60_000).unref?.();

export const replTools = [
  {
    name: 'repl',
    description: 'A stateful Python or Node REPL: variables survive between calls, so you can build up a computation, inspect a value, then continue. Use for exploration and one-off checks; use execute_python/execute_node for a self-contained script.',
    isDangerous: true,
    requiresApproval: (a) => !!(a && a.restart),
    parameters: {
      type: 'object',
      properties: {
        lang: { type: 'string', enum: ['python', 'node'], description: 'Which runtime' },
        code: { type: 'string', description: 'The snippet to evaluate in the live session' },
        restart: { type: 'boolean', description: 'Kill and restart the session (loses all state)' },
      },
      required: ['lang'],
      additionalProperties: false,
    },
    async execute({ lang, code, restart }, ctx = {}) {
      if (!RUNTIME[lang]) return `⚠️ unknown runtime: ${lang}`;
      const chatId = ctx.chatId ?? ctx.userId;
      const key = `${chatId}:${lang}`;

      if (restart) {
        const s = sessions.get(key);
        if (s) { try { s.proc?.kill('SIGKILL'); } catch {} sessions.delete(key); }
        return `✅ ${lang} session restarted — state cleared.`;
      }
      if (!code || !code.trim()) {
        const alive = sessions.get(key)?.proc != null;
        return alive ? `${lang} session is live. Send a snippet.` : `No ${lang} session yet. Send a snippet to start one.`;
      }

      const s = ensure(chatId, lang, ctx.userId);
      if (!s.proc) return `⚠️ could not start ${lang}: the runtime is not installed on this host.`;

      const rt = RUNTIME[lang];
      const out = await new Promise((resolve) => {
        s.waiters.push(resolve);
        try { s.proc.stdin.write(code + '\n'); } catch (err) { resolve(`⚠️ write failed: ${err.message}`); }
        // a snippet that blocks forever must not hang the turn
        setTimeout(() => {
          const i = s.waiters.indexOf(resolve);
          if (i >= 0) { s.waiters.splice(i, 1); resolve('⚠️ no reply within 20s — the snippet is blocking (an input(), a server loop). Use job_start for long-running code.'); }
        }, 20_000);
      });

      touch(s);
      if (!out.trim()) return `${lang} — no output (statement executed). State is kept.`;
      return out;
    },
  },
];
