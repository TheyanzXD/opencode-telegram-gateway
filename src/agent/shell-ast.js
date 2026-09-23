// language: JavaScript (Node 20+ ESM), file: src/agent/shell-ast.js
// Structure-level shell command validation.
//
// A banned-regex list is fragile by construction: `curl … | sh`, base64-piped
// shells, and $IFS-splits all evade string matching. This inspects the command's
// structure — the parse when one is available, a stream tokenizer when it is not —
// so a rewrite cannot hide, because the shape itself is what is checked.
//
// Acorn is a JS parser, not a shell parser. Most valid shell is unparseable as
// JS, and refusing everything acorn cannot read would make the tool unusable.
// So: a successful parse gets the deep node walk; everything else falls back to
// a tokenizer that splits on the shell operators (| ; && || newline) and checks
// each segment. Both paths apply the same policy.

import { parse } from 'acorn';

const DESTRUCTIVE_BINARIES = new Set([
  'mkfs', 'dd', 'fdisk', 'reboot', 'shutdown', 'iptables', 'cryptsetup',
  'halt', 'poweroff', 'init', 'systemctl', 'journalctl', 'crontab',
]);

const NET_FETCHERS = new Set(['curl', 'wget', 'fetch', 'nc', 'ncat', 'socat']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish']);
const ROOT_PATHS = new Set(['/', '/*', '.', '~', '$HOME', '*']);

export function validateShellCommand(command) {
  const errors = [];
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, errors: ['empty command'] };
  }

  // Try the deep path first. A shell pipeline is not JS, but the token shapes
  // are close enough that a JS parser still finds command names, operators and
  // string literals — and when it does read it, it reads it exactly.
  let ast = null;
  try {
    ast = parse(command, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    // Not JS-shaped. That is expected for real shell — fall through to the
    // tokenizer. Refusing here would block every legitimate command.
    ast = null;
  }

  const checked = [];

  if (ast) {
    const checkNode = (node) => {
      if (!node || typeof node.type !== 'string') return;

      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const name = nodeName(node.callee);
        if (name) {
          checked.push(name);
          if (DESTRUCTIVE_BINARIES.has(name)) {
            errors.push(`destructive binary: ${name}`);
          }
          if (NET_FETCHERS.has(name) && hasShellArgument(node.arguments)) {
            errors.push(`${name} piped to a shell: remote code execution risk`);
          }
          if (name === 'rm' && hasRootArgument(node.arguments)) {
            errors.push('rm targets the root of the filesystem');
          }
        }
      }

      if (node.type === 'TaggedTemplateExpression') {
        const name = nodeName(node.tag);
        if (name && SHELLS.has(name)) {
          errors.push(`shell invocation via template literal: ${name}`);
        }
      }

      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(checkNode);
        else if (child && typeof child.type === 'string') checkNode(child);
      }
    };

    ast.body?.forEach(checkNode);

    // A pipe acorn happens to read (e.g. `curl x | sh` looks like `curl(x | sh)`)
    // is caught above by the hasShellArgument check. The rest is shell-shaped.
    if (errors.length) {
      return { ok: false, errors, checked };
    }
  }

  // Tokenizer fallback — the real shell path. Split on shell operators so each
  // segment is a single simple command, then inspect its words.
  const segments = command
    .split(/\||;|&&|\|\||\n|\r/)
    .map((s) => s.trim())
    .filter(Boolean);

  const words = (seg) =>
    seg
      // $IFS is the classic split evasion: `sh` becomes `$IFS'sh'`
      .replace(/\$\{?IFS\}?/g, ' ')
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(Boolean);

  for (let i = 0; i < segments.length; i++) {
    const w = words(segments[i]);
    if (!w.length) continue;
    const bin = w[0].replace(/^.+\//, '');
    checked.push(bin);

    if (DESTRUCTIVE_BINARIES.has(bin)) {
      errors.push(`destructive binary: ${bin}`);
    }
    if (bin === 'rm' && w.some((a) => ROOT_PATHS.has(a))) {
      errors.push('rm targets the root of the filesystem');
    }

    // curl … | sh — fetch a remote script and hand it to a shell. Detect by
    // looking at the NEXT segment, since the pipe is what we split on.
    if (NET_FETCHERS.has(bin) && i + 1 < segments.length) {
      const next = words(segments[i + 1]);
      if (next.length && SHELLS.has(next[0])) {
        errors.push(`${bin} piped to ${next[0]}: remote code execution risk`);
      }
    }
  }

  return { ok: errors.length === 0, errors, checked };
}

function nodeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    // mkfs.ext4 /dev/sda reads as a member; the object name is the binary
    return callee.object?.name || callee.property?.name || null;
  }
  return null;
}

function hasShellArgument(args) {
  return (args || []).some((a) => a?.type === 'Identifier' && SHELLS.has(a.name));
}

function hasRootArgument(args) {
  return (args || []).some((a) => {
    if (!a) return false;
    if (a.type === 'Literal' && ROOT_PATHS.has(String(a.value))) return true;
    if (a.type === 'Identifier' && ROOT_PATHS.has(a.name)) return true;
    return false;
  });
}
