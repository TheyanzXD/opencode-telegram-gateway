// language: JavaScript (Node 20+ ESM), file: src/agent/tools/bash.js
// Tool: run a shell command locally, sandboxed to the workspace, capped output.
// Destructive by default — the engine pauses for a Telegram approval before this runs.
//
// Hardening (v2):
// - Env whitelist: only PATH/LANG/LC_ALL/TERM/HOME/TMPDIR reach the subprocess.
//   `env: { ...process.env }` leaked BOT_TOKEN and every provider key to any
//   command the model ran (or was tricked into running).
// - Canonical path jail: realpathSync + path.relative, not startsWith —
//   "workspace-sensitive" must not pass a check for root "workspace".
// - Output redaction: a token or key that reaches stdout/stderr is masked
//   before it is shown to the model or echoed into the chat.
// - Sandbox engine: AGENT_SANDBOX_ENGINE=bwrap runs under Bubblewrap with a
//   read-only /usr and a PID namespace; 'process' (default) keeps the env +
//   path jail. bwrap is probed at boot, so the setting degrades to 'process'
//   when the binary is missing instead of breaking every command.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { workspaceFor } from '../workspace.js';
import { validateShellCommand } from '../shell-ast.js';

const schema = z.object({
  command: z.string().min(1, 'command is required').max(4096),
  // optional: run in a subdirectory of the workspace
  cwd: z.string().optional(),
});

// Speed bump, not a security boundary — the approval gate is the real control,
// and the env/path jail is the boundary around that. Listed here so a
// fat-fingered paste cannot reach something the operator would rather it didn't.
const BANNED_PATTERNS = [
  /\brm\s+-rf\s+([/.~]|\$HOME)\b/,   // rm -rf /, ~, $HOME
  /:\(\)\s*\{\s*:\|:&\s*\};\s*:/,    // fork bomb
  /\bmkfs(\.\w+)?\s+\/dev\//,        // format a device
  /\bshred\s+\/dev\//,
  /\bdd\s+.*of=\/dev\//,
  /\b(reboot|halt|poweroff|shutdown)\b/,
  /\bcurl\b.*\|\s*(ba)?sh\b/,        // pipe-to-shell
  /\bwget\b.*\|\s*(ba)?sh\b/,
  /\b(iptables|cryptsetup|fdisk)\b/,
];

const MAX_OUTPUT = 512 * 1024; // 512 KB cap — bigger payloads blow the message window

// Secrets that must never be echoed into the chat or back to the model.
const REDACTIONS = [
  [/\d{8,10}:[A-Za-z0-9_-]{35}/g, '[REDACTED_TELEGRAM_TOKEN]'],
  [/sk-ant-[A-Za-z0-9_-]{32,}/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/sk-[A-Za-z0-9]{32,}/g, '[REDACTED_OPENAI_KEY]'],
  [/AIza[0-9A-Za-z-_]{35}/g, '[REDACTED_GEMINI_KEY]'],
  [/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // Bearer/Authorization headers and generic rfc1738 userinfo user:pass@host
  [/(?:authorization|proxy-authorization)\s*:\s*\S+/gi, '[REDACTED_AUTH_HEADER]'],
  [/[A-Za-z0-9._%+-]+:[A-Za-z0-9._~!$&'()*+,;=-]+@[^\s"'\\]+/g, '[REDACTED_CREDENTIALS]'],
];

function sanitizeOutput(rawText) {
  if (!rawText) return '';
  let s = String(rawText);
  for (const [re, mask] of REDACTIONS) s = s.replace(re, mask);
  return s;
}

/**
 * Resolve the cwd against the workspace root using CANONICAL paths.
 * `startsWith` accepted /root/workspace-evil for root /root/workspace —
 * realpath resolves symlinks and the relative check cannot be prefix-fooled.
 */
function resolveSafeWorkspace(root, requestedCwd) {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const target = requestedCwd ? path.resolve(canonicalRoot, requestedCwd) : canonicalRoot;

  if (!fs.existsSync(target)) {
    throw new Error(`cwd does not exist: ${requestedCwd}`);
  }

  const canonicalTarget = fs.realpathSync(target);
  const rel = path.relative(canonicalRoot, canonicalTarget);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refused: cwd escapes the workspace (${root})`);
  }

  return canonicalTarget;
}

/** True once bwrap is confirmed on PATH — probed lazily, cached. */
let _bwrapAvailable = null;
function bwrapAvailable() {
  if (_bwrapAvailable !== null) return _bwrapAvailable;
  try {
    const r = spawnSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 3000 });
    _bwrapAvailable = r.error == null && r.status === 0;
  } catch {
    _bwrapAvailable = false;
  }
  logger.info({ bwrap: _bwrapAvailable }, 'sandbox engine probe');
  return _bwrapAvailable;
}

/**
 * Build a bwrap argv that mounts the system dirs read-only, exposes only the
 * workspace read-write, and unshares the PID namespace. Network is kept —
 * fetch/git/curl are legitimate tool uses; the env + path jail are the
 * credential boundary, not the net namespace.
 */
function bwrapArgs(workdir) {
  const ro = (p) => ['--ro-bind', p, p];
  return [
    '--unshare-pid',
    '--die-with-parent',
    '--proc', '/proc',
    ...ro('/usr'), ...ro('/bin'),
    // /lib and /lib64 are symlinks to /usr/lib on modern distros; bind the real
    // targets so a broken symlink chain does not kill the dynamic loader
    ...(fs.existsSync('/lib') ? ro('/lib') : []),
    ...(fs.existsSync('/lib64') ? ro('/lib64') : []),
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/ca-certificates', '/etc/ca-certificates',
    '--bind', workdir, workdir,
    '--chdir', workdir,
    '--setenv', 'TMPDIR', path.join(workdir, '.tmp'),
    // /dev/null and /dev/urandom are needed by git, curl and node itself
    '--dev-bind', '/dev/null', '/dev/null',
    '--dev-bind', '/dev/urandom', '/dev/urandom',
    '/bin/sh', '-c',
  ];
}

export const bashTool = {
  name: 'execute_bash',
  description: 'Run a shell command on the server, sandboxed to the workspace. Returns stdout and stderr. Use for builds, git, file inspection, process checks.',
  isDangerous: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      cwd: { type: 'string', description: 'Optional subdirectory of the workspace to run in' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  schema,
  async execute({ command, cwd }, ctx = {}) {
    // AST validation first: the regex list catches the blunt patterns, the
    // parser catches rewrites and obfuscation that string matching misses.
    const ast = validateShellCommand(command);
    if (!ast.ok) {
      return { stdout: '', stderr: `refused: ${ast.errors.join('; ')}`, code: 126 };
    }

    for (const re of BANNED_PATTERNS) if (re.test(command)) {
      return { stdout: '', stderr: `refused: command matches a blocked pattern (${re.source})`, code: 126 };
    }

    const root = workspaceFor(ctx.userId ?? ctx.chatId);
    let workdir;
    try {
      workdir = resolveSafeWorkspace(root, cwd);
    } catch (err) {
      return { stdout: '', stderr: err.message, code: 126 };
    }

    // Isolated env — full secret removal. Only what the tool needs to resolve
    // binaries and render locale reaches the child.
    const secureEnv = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TERM: 'xterm-256color',
      HOME: workdir,
      TMPDIR: path.join(workdir, '.tmp'),
      // present so libraries do not fall back to a debug/trace mode; never a secret
      NODE_ENV: 'production',
    };

    fs.mkdirSync(secureEnv.TMPDIR, { recursive: true });

    // Sandbox selection: explicit engine choice, degraded to 'process' when
    // bwrap is selected but unavailable — a missing binary must not make every
    // tool call fail; the env+path jail still holds.
    const engine = String(config.agent?.sandboxEngine || 'process').toLowerCase();
    const useBwrap = engine === 'bwrap' && bwrapAvailable();
    if (engine === 'bwrap' && !useBwrap) {
      logger.warn('AGENT_SANDBOX_ENGINE=bwrap but bwrap is not installed — falling back to process isolation (env+path jail still active)');
    }

    logger.info({ cmd: command.slice(0, 200), cwd: workdir, sandbox: useBwrap ? 'bwrap' : 'process' }, 'bash exec');

    return new Promise((resolve) => {
      let child;
      const timeoutMs = ctx.timeoutMs || config.agent.bashTimeoutMs;
      // detached + kill(-pid) on timeout: spawn's own `timeout` sends SIGTERM to
      // sh only, and `sh -c 'sleep 10'` leaves an orphaned sleep holding the
      // pipes open — the promise then resolves when the sleep finishes anyway,
      // which is not a timeout at all. Killing the process group closes both.
      if (useBwrap) {
        const argv = [...bwrapArgs(workdir), command];
        child = spawn('bwrap', argv, { cwd: workdir, maxBuffer: MAX_OUTPUT, env: secureEnv, detached: true });
      } else {
        child = spawn('/bin/sh', ['-c', command], { cwd: workdir, maxBuffer: MAX_OUTPUT, env: secureEnv, detached: true });
      }

      let timedOut = false;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
          }, timeoutMs)
        : null;
      if (timer) timer.unref();

      let stdout = '';
      let stderr = '';
      const capped = () => stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT;

      child.stdout.on('data', (d) => { if (!capped()) stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (!capped()) stderr += d.toString('utf8'); });

      const finish = (code, err) => {
        if (timer) clearTimeout(timer);
        let cleanOut = sanitizeOutput(stdout);
        let cleanErr = sanitizeOutput(stderr || (err ? err.message : ''));
        if (timedOut) cleanErr = `command timed out after ${timeoutMs}ms`;

        if (cleanOut.length > MAX_OUTPUT) {
          cleanOut = cleanOut.slice(0, MAX_OUTPUT) + '\n…[output truncated at 512 KB]';
        }
        if (cleanErr.length > MAX_OUTPUT) {
          cleanErr = cleanErr.slice(0, MAX_OUTPUT) + '\n…[stderr truncated]';
        }

        resolve({
          stdout: cleanOut,
          stderr: cleanErr,
          // a group-kill reports null, not a nonzero exit — that is a timeout,
          // not a success
          code: timedOut ? 124 : (code ?? (err ? 1 : 0)),
        });
      };

      child.on('close', (code) => finish(code));
      child.on('error', (err) => finish(1, err));
    });
  },
};
