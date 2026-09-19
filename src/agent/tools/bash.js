// language: JavaScript (Node 18+ ESM), file: src/agent/tools/bash.js
// Tool: run a shell command locally, sandboxed to the workspace, capped output.
// Destructive by default — the engine pauses for a Telegram approval before this runs.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const schema = z.object({
  command: z.string().min(1, 'command is required').max(4096),
  // optional: run in a subdirectory of the workspace
  cwd: z.string().optional(),
});

const BANNED = [
  // Not a security boundary — a speed bump. The approval gate is the real control,
  // and the allowlist is the boundary around that. Listed here so a fat-fingered
  // paste cannot reach something the operator would rather it didn't.
  /\brm\s+-rf\s+\/(\s|$)/,            // rm -rf /  (root wipe)
  /:\(\)\s*\{\s*:\|:&\s*\};\s*:/,      // fork bomb
  /\bmkfs(\.\w+)?\s+\/dev\//,          // format a device
  /\bshred\s+\/dev\//,
  /\bdd\s+.*of=\/dev\//,
  /\b(reboot|halt|shutdown)\b/,
];

const MAX_OUTPUT = 512 * 1024; // 512 KB cap — bigger payloads blow the message window

export const bashTool = {
  name: 'execute_bash',
  description: 'Run a shell command on the server. Returns stdout and stderr. Use for builds, git, file inspection, process checks.',
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
  async execute({ command, cwd }) {
    for (const re of BANNED) if (re.test(command)) {
      return { stdout: '', stderr: `refused: command matches a blocked pattern (${re.source})`, code: 126 };
    }

    const root = config.agent?.workspace || process.cwd();
    const workdir = cwd ? path.resolve(root, cwd) : root;
    if (!workdir.startsWith(root)) {
      return { stdout: '', stderr: `refused: cwd escapes the workspace (${root})`, code: 126 };
    }

    logger.info({ cmd: command.slice(0, 200), cwd: workdir }, 'bash exec');

    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: workdir,
        shell: '/bin/sh',
        timeout: config.agent.bashTimeoutMs,
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      const capped = () => stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT;

      child.stdout.on('data', (d) => { if (!capped()) stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (!capped()) stderr += d.toString('utf8'); });

      const finish = (code, err) => {
        const out = stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + '\n…[truncated]' : stdout;
        const err_ = (stderr || (err ? err.message : '')).slice(0, MAX_OUTPUT);
        resolve({ stdout: out, stderr: err_, code: code ?? (err ? 1 : 0) });
      };

      child.on('close', (code) => finish(code));
      child.on('error', (err) => finish(1, err));
    });
  },
};
