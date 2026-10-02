// language: JavaScript (Node 20+ ESM), file: src/agent/tools/security-scan.js
// Static security review of the user's code — the oh-my-pi security_scan idea
// without the cloud coordination layer.
//
// What omp does: a multi-phase pipeline with preflight, cloud scans, and
// validation of findings. That is a product, not a tool. The part that helps
// an agent today is the first half: look at the code, find the patterns that
// mean a vulnerability, report them with file:line and a fix suggestion.
//
// These rules are the ones a reviewer reaches for first — injection, hardcoded
// secrets, path traversal, weak crypto, command construction from input. They
// are patterns, not proof; the tool says so in every result.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.php', '.rb', '.sh', '.sql', '.yaml', '.yml', '.json', '.env']);
const SKIP = new Set(['node_modules', '.git', 'dist', '.undo', '.checkpoints', 'vendor', '__pycache__']);

const RULES = [
  {
    id: 'INJ-001', sev: 'high', lang: ['js', 'py'],
    name: 'Unsanitized string into a shell command',
    pattern: /(?:child_process\.exec|execSync|spawnSync|spawn|os\.system|subprocess\.(?:run|call|Popen)|\bexec\b)\s*\(?\s*(?:`[^`]*\$\{|`[^`]*\+|['"][^'"]*['"]?\s*\+|\$\{|[a-zA-Z_$][\w$]*\s*\+|[a-zA-Z_$][\w$]*\s*%)/,
    fix: 'pass an argument array and never interpolate input into the command string — shell metacharacters in input become a command',
  },
  {
    id: 'INJ-002', sev: 'high', lang: ['js', 'py', 'php'],
    name: 'String-concatenated SQL',
    pattern: /(?:query|execute|raw|cursor\.execute)\s*\(\s*(?:[`'"]|f"|f'|[a-zA-Z_$][\w$]*\s*\+)/,
    fix: 'use a parameterized query — the placeholder, not the string, carries the value',
  },
  {
    id: 'SEC-001', sev: 'high', lang: ['all'],
    name: 'Hardcoded secret',
    pattern: /\b(?:api[_-]?key|apikey|secret|password|passwd|token|auth)\b\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    fix: 'move it to an env var or a secret store — a hardcoded secret is in the git history forever',
  },
  {
    id: 'PATH-001', sev: 'medium', lang: ['js', 'py'],
    name: 'Unvalidated path traversal',
    pattern: /(?:readFile|readFileSync|open\(|fs\.read|File\.open)\s*\(\s*(?:`|\$\{|.*\.\.\/|.*req\.|.*params\.|.*request\.)/,
    fix: 'resolve the input and confirm it stays inside the intended root before opening it',
  },
  {
    id: 'CRYPTO-001', sev: 'medium', lang: ['js', 'py'],
    name: 'Weak hash or cipher',
    pattern: /\b(?:md5|sha1|MD5|SHA1|createHash\s*\(\s*['"]sha1|DES\b|ECB\b)\b/,
    fix: 'sha-256 or stronger; AEAD (aes-256-gcm / chacha20-poly1305) for encryption — md5/sha1 are broken for anything security-relevant',
  },
  {
    id: 'SEC-002', sev: 'medium', lang: ['js', 'py', 'go'],
    name: 'Verification disabled',
    pattern: /(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|ssl\s*:\s*\{[^}]*reject\s*:\s*false)/,
    fix: 'keep TLS verification on and supply the CA bundle instead — turning it off defeats the encryption in transit',
  },
  {
    id: 'SEC-003', sev: 'low', lang: ['js'],
    name: 'eval with non-literal input',
    pattern: /\beval\s*\(\s*(?!['"])(?![a-z]+\s*\.\s*exports)/,
    fix: 'avoid eval entirely; if it is JSON, JSON.parse — eval runs arbitrary code with the file\'s privileges',
  },
  {
    id: 'NET-001', sev: 'medium', lang: ['js', 'py', 'php'],
    name: 'Plaintext protocol over a secret path',
    pattern: /(?:https?\.get|fetch|axios|requests\.get|urlopen|curl)\s*\(\s*['"`]?http:/,
    fix: 'https for anything authenticated or personal — a request over http leaks the token and the body to anyone on the path',
  },
  {
    id: 'INJ-003', sev: 'medium', lang: ['js', 'ts'],
    name: 'dangerouslySetInnerHTML from a variable',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\{\s*(?!['"])/,
    fix: 'sanitize with a whitelist (DOMPurify) or render as text — raw HTML from data is an XSS vector',
  },
];

function langOf(file) {
  const ext = path.extname(file).toLowerCase();
  const map = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.jsx': 'js', '.tsx': 'js',
    '.py': 'py', '.go': 'go', '.rs': 'go', '.java': 'go', '.c': 'go', '.h': 'go', '.cpp': 'go',
    '.php': 'php', '.rb': 'py', '.sh': 'py', '.sql': 'sql' };
  return map[ext] || 'all';
}

export const securityScanTools = [
  {
    name: 'security_scan',
    description: 'Static security review of the workspace or one directory: injection, hardcoded secrets, path traversal, weak crypto, disabled TLS verification, eval. Reports file:line with a fix suggestion per finding. Patterns, not proof — verify each hit before acting.',
    isDangerous: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory or file to scan (default: the workspace root)' },
        max_findings: { type: 'integer', description: 'Report cap (default 40)' },
      },
      additionalProperties: false,
    },
    async execute({ path: rel, max_findings = 40 }, ctx = {}) {
      const root = path.resolve(config.agent.workspace, String(ctx.userId ?? ctx.chatId));
      const target = rel ? path.resolve(root, rel) : root;
      if (target !== root && !target.startsWith(root + path.sep)) return '⚠️ outside the workspace';
      if (!fs.existsSync(target)) return `⚠️ no such path: ${rel}`;

      const findings = [];
      let scanned = 0;

      const scanFile = (abs) => {
        if (findings.length > max_findings + 20) return;
        const lang = langOf(abs);
        let src;
        try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
        if (src.length > 512 * 1024) return;
        scanned++;
        const lines = src.split('\n');
        for (const rule of RULES) {
          if (!rule.lang.includes('all') && !rule.lang.includes(lang)) continue;
          lines.forEach((line, i) => {
            if (findings.length > max_findings + 20) return;
            if (rule.pattern.test(line)) {
              findings.push({ ...rule, file: path.relative(root, abs), line: i + 1, text: line.trim().slice(0, 140) });
            }
          });
        }
      };

      const walk = (d) => {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (findings.length > max_findings + 20) return;
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
          if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
          scanFile(p);
        }
      };

      if (fs.statSync(target).isDirectory()) walk(target); else scanFile(target);

      if (!scanned) return 'Nothing scannable found (no code files).';
      const shown = findings.slice(0, max_findings);
      const sev = (s) => (s === 'high' ? '🔴' : s === 'medium' ? '🟠' : '🟡');

      const head = [
        `Security scan: ${scanned} file(s) scanned, ${findings.length} finding(s).`,
        findings.length > max_findings ? `\n…[${findings.length - max_findings} more not shown — narrow the path]` : '',
      ].join('');
      if (!findings.length) return `${head}\n\nNo known-vulnerable patterns matched. This is not a clean bill of health — it is the absence of these specific patterns.`;

      const bySev = { high: 0, medium: 0, low: 0 };
      findings.forEach((f) => bySev[f.sev]++);
      return [
        head,
        `**${bySev.high} high · ${bySev.medium} medium · ${bySev.low} low**`,
        '',
        ...shown.map((f) => `${sev(f.sev)} \`${f.file}:${f.line}\` **${f.name}** (${f.id})\n  \`${f.text}\`\n  _fix: ${f.fix}_`),
      ].join('\n');
    },
  },
];
