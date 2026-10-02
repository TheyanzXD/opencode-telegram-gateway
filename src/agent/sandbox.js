import path from 'node:path';

export class SandboxError extends Error {
  constructor(msg) { super(msg); this.name = 'SandboxError'; }
}

// Resolve `target` against `cwd` and assert it stays inside cwd.
// Absolute paths must already be inside cwd — escaping via .. is blocked.
// ponytail: symlink target check via fs.realpath — add when /var -> /home escapes matter.
export function safeResolve(cwd, target) {
  if (!cwd) cwd = process.cwd();
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  assertInCwd(abs, cwd);
  return abs;
}

export function assertInCwd(abs, cwd) {
  if (!cwd) cwd = process.cwd();
  if (abs === cwd) return;
  if (abs.startsWith(cwd + path.sep)) return;
  throw new SandboxError(`path escapes cwd: ${abs} not in ${cwd}`);
}

export function defaultCwdFor(user, config) {
  return user.cwd || config.agent.defaultCwd || process.cwd();
}