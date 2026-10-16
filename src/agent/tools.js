import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { safeResolve, defaultCwdFor, SandboxError } from './sandbox.js';
import { listRepos, getRepo, createGist } from './github.js';
import { webSearch } from './web_search.js';
import { recall, remember } from '../memory.js';
import { browseWebsite } from './web_browse.js';
import { xerjSearch, xerjDef, xerjAutoindex, xerjStatus, xerjGain } from './xerj.js';

export const readFileSchema = z.object({
  path: z.string().describe('Absolute or cwd-relative file path'),
  start_line: z.number().int().min(1).optional()
    .describe('Starting line number to read (1-indexed)'),
  end_line: z.number().int().min(1).optional()
    .describe('Ending line number to read (inclusive)'),
  max_lines: z.number().int().min(1).max(config.agent.maxFileLines).optional()
    .describe(`Cap on lines returned (default 400, max ${config.agent.maxFileLines})`),
});

export const writeFileSchema = z.object({
  path: z.string().describe('Absolute or cwd-relative file path'),
  content: z.string().describe('Full file contents to write'),
});

export const editFileSchema = z.object({
  path: z.string().describe('Absolute or cwd-relative file path'),
  old_text: z.string().describe('Exact text to find (must be unique unless replace_all)'),
  new_text: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace all occurrences (default false)'),
});

export const bashExecSchema = z.object({
  command: z.string().max(2000).describe('Shell command (sh -c semantics)'),
  timeout_ms: z.number().int().min(1000).max(120000).optional()
    .describe('Timeout in ms (default 30000, max 120000)'),
});

export const githubListReposSchema = z.object({
  per_page: z.number().int().min(1).max(50).optional()
    .describe('Repos per page (default 10, max 50)'),
  page: z.number().int().min(1).optional().describe('Page number (default 1)'),
});

export const githubViewRepoSchema = z.object({
  owner: z.string().describe('Repo owner (user or org)'),
  name: z.string().describe('Repo name'),
});

export const githubCreateGistSchema = z.object({
  description: z.string().max(300).optional().describe('Gist description'),
  filename: z.string().describe('File name inside the gist'),
  content: z.string().describe('File contents'),
  public: z.boolean().optional().describe('Public gist (default false = secret)'),
});

// ---- new: web_search, memory, git ops ----
export const webSearchSchema = z.object({
  query: z.string().min(2).max(300).describe('Search query'),
  k: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
});

export const memoryRecallSchema = z.object({
  query: z.string().describe('What to recall from your long-term memory'),
  k: z.number().int().min(1).max(20).optional().describe('Max chunks (default 5)'),
});

export const memoryRememberSchema = z.object({
  source: z.string().describe('Where this fact came from (e.g. file path, "user")'),
  body: z.string().min(1).max(8000).describe('The fact to remember'),
});

export const gitStatusSchema = z.object({
  path: z.string().optional().describe('Subdir of cwd; defaults to cwd'),
});

export const gitDiffSchema = z.object({
  path: z.string().optional().describe('Subdir of cwd'),
  ref: z.string().optional().describe('Git ref to diff against (default HEAD)'),
  staged: z.boolean().optional().describe('Show staged changes'),
});

export const gitLogSchema = z.object({
  path: z.string().optional().describe('Subdir of cwd'),
  n: z.number().int().min(1).max(200).optional().describe('Number of commits (default 10)'),
  oneline: z.boolean().optional().describe('One-line format'),
});

export const gitCommitSchema = z.object({
  message: z.string().min(1).max(2000).describe('Commit message'),
  add: z.boolean().optional().describe('git add -A before commit (default true)'),
});

export const gitBranchSchema = z.object({
  name: z.string().optional().describe('Branch name'),
  create: z.boolean().optional().describe('Create new branch from current'),
  delete: z.boolean().optional().describe('Delete branch'),
  checkout: z.boolean().optional().describe('Switch to branch (with name)'),
});

export const gitCloneSchema = z.object({
  url: z.string().url().describe('Repo URL to clone'),
  target_dir: z.string().optional().describe('Target dir under cwd (default: name from url)'),
});

export const listDirSchema = z.object({
  path: z.string().optional().describe('Relative path to directory under cwd (default: ".")'),
  recursive: z.boolean().optional().describe('Recurse into subdirectories (max depth 3, default false)'),
  max_entries: z.number().int().min(1).max(300).optional().describe('Max files/folders to return (default 100)'),
});

export const searchFilesSchema = z.object({
  query: z.string().min(1).describe('Text or pattern to search for'),
  path: z.string().optional().describe('Subdir under cwd to search in (default: ".")'),
  regex: z.boolean().optional().describe('Treat query as regex (default false)'),
  case_sensitive: z.boolean().optional().describe('Case-sensitive search (default false)'),
  max_results: z.number().int().min(1).max(100).optional().describe('Max matching lines (default 40)'),
});

export const findFilesSchema = z.object({
  pattern: z.string().min(1).describe('Pattern to match (e.g. "*.js", "config", "test")'),
  path: z.string().optional().describe('Subdir under cwd to search in (default: ".")'),
  max_results: z.number().int().min(1).max(200).optional().describe('Max files to return (default 50)'),
});

export const browseWebsiteSchema = z.object({
  url: z.string().url().describe('The HTTP or HTTPS URL to browse'),
  extract_links: z.boolean().optional().describe('Extract and list outbound links from the page (default false)'),
  selector: z.string().optional().describe('CSS selector to focus on specific element (e.g. "article", "main", "table")'),
  max_chars: z.number().int().min(500).max(50000).optional().describe('Max character length (default 15000)'),
});

export const xerjSearchSchema = z.object({
  query: z.string().min(1).describe('Code symbol, function, concept, or phrase to search in indexed codebases'),
  full: z.number().int().optional().describe('Character budget for passage expansion (optional)'),
});

export const xerjDefSchema = z.object({
  symbol: z.string().min(1).describe('Symbol name (function, class, variable, method) to find definition and signature for'),
});

export const xerjAutoindexSchema = z.object({
  folder: z.string().optional().describe('Folder to index relative to cwd (default: ".")'),
  fresh: z.boolean().optional().describe('Rebuild index from scratch (default false)'),
});

export const xerjStatusSchema = z.object({
  gain: z.boolean().optional().describe('Include token gain and search latency stats (default true)'),
});

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n…(truncated, ${str.length - max} more chars)`;
}

async function readFile(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const abs = safeResolve(cwd, args.path);
  let buf;
  try { buf = await fs.readFile(abs); }
  catch (err) { return { ok: false, error: `read failed: ${err.message}` }; }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const total = lines.length;

  const startLine = args.start_line ?? 1;
  const maxLines = args.max_lines ?? 400;
  const endLine = args.end_line ?? Math.min(startLine + maxLines - 1, total);

  const sliceStart = Math.max(0, startLine - 1);
  const sliceEnd = Math.min(total, endLine);

  let out;
  let tag;
  if (!args.start_line && !args.end_line) {
    const limited = lines.slice(0, maxLines).join('\n');
    out = truncate(limited, config.agent.maxFileBytes);
    tag = lines.length > maxLines ? `…(showing ${maxLines}/${lines.length} lines)` : `(${lines.length} lines)`;
  } else {
    const formatted = [];
    for (let i = sliceStart; i < sliceEnd; i++) {
      formatted.push(`${i + 1} | ${lines[i]}`);
    }
    const limited = formatted.join('\n');
    out = truncate(limited, config.agent.maxFileBytes);
    tag = `(lines ${startLine}-${sliceEnd} of ${total} total)`;
  }
  return { ok: true, output: out + (out.endsWith('\n') ? '' : '\n') + tag, absPath: abs, totalLines: total };
}

async function writeFile(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const abs = safeResolve(cwd, args.path);
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content, 'utf8');
    return { ok: true, output: `wrote ${args.content.length} bytes to ${abs}` };
  } catch (err) {
    return { ok: false, error: `write failed: ${err.message}` };
  }
}

async function editFile(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const abs = safeResolve(cwd, args.path);
  let orig;
  try { orig = await fs.readFile(abs, 'utf8'); }
  catch (err) { return { ok: false, error: `read failed: ${err.message}` }; }
  const replaceAll = args.replace_all === true;

  let target = args.old_text;
  let occurrences = orig.split(target).length - 1;

  if (occurrences === 0 && (target.includes('\r\n') || orig.includes('\r\n'))) {
    const normOrig = orig.replace(/\r\n/g, '\n');
    const normTarget = target.replace(/\r\n/g, '\n');
    if (normOrig.includes(normTarget)) {
      orig = normOrig;
      target = normTarget;
      occurrences = orig.split(target).length - 1;
    }
  }

  if (occurrences === 0) {
    const totalLines = orig.split('\n').length;
    return {
      ok: false,
      error: `old_text not found in ${args.path} (${totalLines} total lines). Check spacing, line numbers with read_file, or provide more surrounding lines.`,
    };
  }
  if (!replaceAll && occurrences > 1) {
    return { ok: false, error: `old_text matches ${occurrences} times; use replace_all=true or narrow the match` };
  }
  const newText = replaceAll ? orig.split(target).join(args.new_text) : orig.replace(target, args.new_text);
  try {
    await fs.writeFile(abs, newText, 'utf8');
    const added = args.new_text.length - target.length;
    return { ok: true, output: `edited ${abs} (${replaceAll ? occurrences : 1} replacement${occurrences === 1 ? '' : 's'}, ${added >= 0 ? '+' : ''}${added} chars)` };
  } catch (err) {
    return { ok: false, error: `write failed: ${err.message}` };
  }
}

// bash_exec — defers to caller (approval flow) via ctx.execBash
async function bashExec(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const timeoutMs = args.timeout_ms ?? config.agent.bashTimeoutMs;
  const approved = await ctx.askApproval({ tool: 'bash_exec', args, cwd });
  if (!approved.allow) return { ok: false, error: approved.reason || 'denied by user' };
  return runBash(args.command, cwd, timeoutMs);
}

export function runBash(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', killed = false;
    const child = spawn('sh', ['-c', command], { cwd, timeout: timeoutMs });
    const t = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs + 1000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, error: `spawn error: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(t);
      const out = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).trim();
      const limited = truncate(out, config.agent.maxBashOutputBytes);
      if (killed) return resolve({ ok: false, error: `killed after ${timeoutMs}ms`, output: limited });
      resolve({ ok: code === 0, output: limited || `(exit ${code}, no output)`, exitCode: code });
    });
  });
}

export const tools = [
  { name: 'read_file',  description: 'Read a UTF-8 text file. Paths are sandboxed to your cwd. Output is capped.', schema: readFileSchema,  run: readFile },
  { name: 'write_file', description: 'Overwrite (or create) a UTF-8 text file. Paths are sandboxed to your cwd.', schema: writeFileSchema, run: writeFile },
  { name: 'edit_file',  description: 'Find unique text in a file and replace it. Use replace_all=true to replace all matches.', schema: editFileSchema,  run: editFile },
  { name: 'bash_exec',  description: 'Run a shell command in your cwd. Requires inline approval before each invocation. Output is capped.', schema: bashExecSchema, run: bashExec },
];

export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}

// ---- github tools (use token saved by /gitconfig) ----

function ghRequired(ctx) {
  const token = ctx.user?.gh_token;
  if (!token) return { ok: false, error: 'no GitHub token saved — user must run /gitconfig <token> first' };
  return { ok: true, token };
}

async function ghListRepos(args, ctx) {
  const auth = ghRequired(ctx);
  if (!auth.ok) return auth;
  try {
    const repos = await listRepos(auth.token, { per_page: args.per_page ?? 10, page: args.page ?? 1, sort: 'updated' });
    if (!repos.length) return { ok: true, output: '(no repos)' };
    const out = repos.map((r, i) =>
      `${i + 1}. ${r.full_name}${r.fork ? ' (fork)' : ''} — ⭐${r.stargazers_count} • ${r.language || '—'} • ${r.private ? 'private' : 'public'}\n   ${r.html_url}${r.description ? '\n   ' + r.description : ''}`
    ).join('\n');
    return { ok: true, output };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function ghViewRepo(args, ctx) {
  const auth = ghRequired(ctx);
  if (!auth.ok) return auth;
  try {
    const r = await getRepo(auth.token, args.owner, args.name);
    const out =
`${r.full_name} ${r.private ? '🔒' : '🌐'}
${r.description || '(no description)'}

⭐ ${r.stargazers_count} • 🍴 ${r.forks_count} • 👀 ${r.subscribers_count}
Default branch: ${r.default_branch}
Language: ${r.language || '—'}
Updated: ${r.updated_at}
URL: ${r.html_url}`;
    return { ok: true, output: out };
  } catch (err) { return { ok: false, error: err.message }; }
}

async function ghCreateGist(args, ctx) {
  const auth = ghRequired(ctx);
  if (!auth.ok) return auth;
  try {
    const g = await createGist(auth.token, {
      description: args.description || '',
      public: Boolean(args.public),
      files: { [args.filename]: { content: args.content } },
    });
    return { ok: true, output: `created gist ${g.id}\n${g.html_url}` };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ---- web search ----
async function webSearchTool(args) {
  try {
    const rs = await webSearch(args.query, args.k ?? 5);
    if (!rs.length) return { ok: true, output: '(no results)' };
    const out = rs.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + r.snippet : ''}`).join('\n');
    return { ok: true, output };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ---- memory ----
function memoryRecallTool(args, ctx) {
  try {
    const hits = recall(ctx.user.user_id, args.query, args.k ?? config.memory.maxRecall);
    if (!hits.length) return { ok: true, output: '(no memory matches)' };
    const out = hits.map((h, i) => `[${i + 1}] (${h.source}, score ${h.score.toFixed(2)})\n${h.body}`).join('\n\n');
    return { ok: true, output };
  } catch (err) { return { ok: false, error: err.message }; }
}
function memoryRememberTool(args, ctx) {
  try {
    const id = remember(ctx.user.user_id, { source: args.source, body: args.body });
    return { ok: true, output: `remembered as chunk #${id}` };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ---- git ops (wrap git CLI; approval required for write ops) ----
function gitArgAbs(args, cwd, defaultName = '.') {
  const target = args.path || defaultName;
  return safeResolve(cwd, target);
}

async function gitStatus(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const p = gitArgAbs(args, cwd);
  const r = await runBash('git status --porcelain=v1 --branch', p, 10_000);
  return { ok: r.ok, output: r.output || '(clean)', error: r.error };
}

async function gitDiff(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const p = gitArgAbs(args, cwd);
  const flags = [args.staged ? '--staged' : '', args.ref || ''].filter(Boolean).join(' ');
  const r = await runBash(`git diff --stat ${flags} && echo --- && git diff ${flags}`, p, 30_000);
  return { ok: r.ok, output: truncate(r.output || '(no diff)', config.agent.maxBashOutputBytes), error: r.error };
}

async function gitLog(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const p = gitArgAbs(args, cwd);
  const oneline = args.oneline ? '--oneline' : '--pretty=format:%h %an %ad %d%n%b%n---%n';
  const path = args.path ? `-- ${args.path}` : '';
  const r = await runBash(`git log -n ${args.n ?? 10} ${path} ${oneline}`, p, 15_000);
  return { ok: r.ok, output: truncate(r.output || '(no commits)', config.agent.maxBashOutputBytes), error: r.error };
}

async function gitCommit(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const approved = await ctx.askApproval({ tool: 'git_commit', args, cwd });
  if (!approved.allow) return { ok: false, error: approved.reason || 'denied' };
  const addPart = args.add === false ? '' : 'git add -A && ';
  const r = await runBash(`${addPart}git commit -m ${shellEscape(args.message)}`, cwd, 30_000);
  return { ok: r.ok, output: r.output || '(no output)', error: r.error };
}

async function gitBranch(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  let cmd;
  if (args.checkout && args.name) cmd = `git checkout ${shellEscape(args.name)}`;
  else if (args.create && args.name) cmd = `git checkout -b ${shellEscape(args.name)}`;
  else if (args.delete && args.name) {
    const approved = await ctx.askApproval({ tool: 'git_branch_delete', args, cwd });
    if (!approved.allow) return { ok: false, error: approved.reason || 'denied' };
    cmd = `git branch -D ${shellEscape(args.name)}`;
  } else if (args.name) cmd = `git branch ${shellEscape(args.name)}`;
  else cmd = 'git branch -vv';
  const r = await runBash(cmd, cwd, 15_000);
  return { ok: r.ok, output: r.output || '(no output)', error: r.error };
}

async function gitClone(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const approved = await ctx.askApproval({ tool: 'git_clone', args, cwd });
  if (!approved.allow) return { ok: false, error: approved.reason || 'denied' };
  const target = args.target_dir ? path.basename(args.target_dir) : '';
  const targetAbs = args.target_dir ? safeResolve(cwd, args.target_dir) : null;
  if (targetAbs) await fs.mkdir(path.dirname(targetAbs), { recursive: true });
  const cmd = `git clone ${shellEscape(args.url)} ${target ? shellEscape(target) : ''}`.trim();
  const r = await runBash(cmd, targetAbs || cwd, 5 * 60_000);
  return { ok: r.ok, output: truncate(r.output || '(no output)', config.agent.maxBashOutputBytes), error: r.error };
}

function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---- Directory and File search tools ----

async function listDir(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const abs = safeResolve(cwd, args.path || '.');
  const maxEntries = args.max_entries ?? 100;
  const recursive = Boolean(args.recursive);

  const results = [];
  async function walk(dir, depth = 0) {
    if (results.length >= maxEntries || depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      results.push(`[error reading ${path.relative(cwd, dir) || '.'}: ${err.message}]`);
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const ent of entries) {
      if (results.length >= maxEntries) break;
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;

      const fullPath = path.join(dir, ent.name);
      const rel = path.relative(cwd, fullPath) || ent.name;

      if (ent.isDirectory()) {
        results.push(`📁 [DIR]  ${rel}/`);
        if (recursive && depth < 3) {
          await walk(fullPath, depth + 1);
        }
      } else {
        try {
          const st = await fs.stat(fullPath);
          const sizeKb = (st.size / 1024).toFixed(1);
          results.push(`📄 [FILE] ${rel} (${sizeKb} KB)`);
        } catch {
          results.push(`📄 [FILE] ${rel}`);
        }
      }
    }
  }

  await walk(abs, 0);
  const out = results.join('\n');
  return {
    ok: true,
    output: out || '(empty directory)',
    entriesCount: results.length,
  };
}

async function searchFiles(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const p = safeResolve(cwd, args.path || '.');
  const flags = [
    '-rnI',
    args.case_sensitive ? '' : '-i',
    args.regex ? '-E' : '-F',
    '--exclude-dir={node_modules,.git,data,dist,coverage}',
  ].filter(Boolean).join(' ');

  const cmd = `grep ${flags} ${shellEscape(args.query)} .`;
  const r = await runBash(cmd, p, 15_000);
  if (!r.ok && r.exitCode === 1) {
    return { ok: true, output: `(no matches for "${args.query}")` };
  }
  if (!r.ok) return { ok: false, error: r.error || r.output };

  const lines = (r.output || '').split('\n').filter(Boolean);
  const maxRes = args.max_results ?? 40;
  const sliced = lines.slice(0, maxRes);
  const tag = lines.length > maxRes ? `\n…(showing ${maxRes}/${lines.length} matches)` : `\n(${lines.length} matches)`;
  return { ok: true, output: sliced.join('\n') + tag, totalMatches: lines.length };
}

async function findFiles(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const p = safeResolve(cwd, args.path || '.');
  const pat = args.pattern.includes('*') ? args.pattern : `*${args.pattern}*`;
  const cmd = `find . -not -path '*/.*' -not -path './node_modules*' -not -path './data*' -name ${shellEscape(pat)} | sort`;
  const r = await runBash(cmd, p, 10_000);
  if (!r.ok) return { ok: false, error: r.error || r.output };
  const lines = (r.output || '').split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''));
  if (!lines.length) return { ok: true, output: `(no files matching "${args.pattern}")` };
  const maxRes = args.max_results ?? 50;
  const sliced = lines.slice(0, maxRes);
  const tag = lines.length > maxRes ? `\n…(showing ${maxRes}/${lines.length} files)` : `\n(${lines.length} files)`;
  return { ok: true, output: sliced.join('\n') + tag, totalFiles: lines.length };
}

async function browseWebsiteTool(args) {
  const r = await browseWebsite(args);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, output: r.output, title: r.title, url: r.url };
}

async function xerjSearchTool(args) {
  const r = await xerjSearch(args.query, { full: args.full });
  return { ok: r.ok, output: r.output || r.error, error: r.ok ? undefined : r.error };
}

async function xerjDefTool(args) {
  const r = await xerjDef(args.symbol);
  return { ok: r.ok, output: r.output || r.error, error: r.ok ? undefined : r.error };
}

async function xerjAutoindexTool(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const folder = args.folder ? safeResolve(cwd, args.folder) : cwd;
  const r = await xerjAutoindex(folder, { fresh: args.fresh });
  return { ok: r.ok, output: r.output || r.error, error: r.ok ? undefined : r.error };
}

async function xerjStatusTool(args) {
  const st = await xerjStatus();
  if (!st.ok) return { ok: false, error: st.error || 'xerj offline' };
  let out = `XERJ Node: ${st.cluster_name} (${st.status})\nURL: ${st.url}\nIndexed Indices: ${st.indices?.length || 0}\n`;
  if (st.indices?.length) {
    out += st.indices.map((idx) => `  - ${idx.index}: ${idx.docs_count} docs (${idx.store_size})`).join('\n');
  }
  if (args.gain !== false) {
    const gain = await xerjGain();
    if (gain.ok && gain.output) {
      out += `\n\n${gain.output}`;
    }
  }
  return { ok: true, output: out };
}

// Register all tools
tools.push(
  { name: 'github_list_repos', description: 'List the current user\'s GitHub repos. Requires /gitconfig token.', schema: githubListReposSchema, run: ghListRepos },
  { name: 'github_view_repo',   description: 'Get details for one GitHub repo (stars, default branch, etc).', schema: githubViewRepoSchema, run: ghViewRepo },
  { name: 'github_create_gist', description: 'Create a GitHub gist. Default secret (private).', schema: githubCreateGistSchema, run: ghCreateGist },
  { name: 'web_search', description: 'Search the public web (DuckDuckGo) and return top results with title/url/snippet.', schema: webSearchSchema, run: webSearchTool },
  { name: 'memory_recall', description: 'Recall long-term memory chunks matching the query (BM25 over FTS5).', schema: memoryRecallSchema, run: memoryRecallTool },
  { name: 'memory_remember', description: 'Save a fact to long-term memory for future recall.', schema: memoryRememberSchema, run: memoryRememberTool },
  { name: 'git_status', description: 'git status of cwd (or given subdir).', schema: gitStatusSchema, run: gitStatus },
  { name: 'git_diff', description: 'git diff of cwd (or given subdir) against HEAD or a ref.', schema: gitDiffSchema, run: gitDiff },
  { name: 'git_log', description: 'git log of cwd (or given subdir).', schema: gitLogSchema, run: gitLog },
  { name: 'git_commit', description: 'git add -A + git commit (requires inline approval).', schema: gitCommitSchema, run: gitCommit },
  { name: 'git_branch', description: 'git branch list/create/delete/checkout.', schema: gitBranchSchema, run: gitBranch },
  { name: 'git_clone', description: 'git clone a URL into cwd (requires approval).', schema: gitCloneSchema, run: gitClone },
  { name: 'list_dir', description: 'List files and directories in your cwd or given path with sizes and types.', schema: listDirSchema, run: listDir },
  { name: 'search_files', description: 'Search for text or regex pattern across workspace files (grep). Returns path:line matches.', schema: searchFilesSchema, run: searchFiles },
  { name: 'find_files', description: 'Find files matching a name or wildcard pattern (e.g. "*.js", "config").', schema: findFilesSchema, run: findFiles },
  { name: 'browse_website', description: 'Browse a website URL and extract clean Markdown content, tables, and optional outbound links.', schema: browseWebsiteSchema, run: browseWebsiteTool },
  { name: 'xerj_search', description: 'Token-efficient code and passage search across indexed codebases using XERJ (2.7x-40x token reduction).', schema: xerjSearchSchema, run: xerjSearchTool },
  { name: 'xerj_def', description: 'Go-to-definition lookup for code symbols (functions, classes, methods) with signature and file:line citations.', schema: xerjDefSchema, run: xerjDefTool },
  { name: 'xerj_autoindex', description: 'Zero-config autoindexing of a folder or repository into XERJ search engine.', schema: xerjAutoindexSchema, run: xerjAutoindexTool },
  { name: 'xerj_status', description: 'Check XERJ search cluster health, indexed documents count, and measured token savings gain.', schema: xerjStatusSchema, run: xerjStatusTool },
);