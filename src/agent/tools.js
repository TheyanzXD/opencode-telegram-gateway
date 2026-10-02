import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { safeResolve, defaultCwdFor, SandboxError } from './sandbox.js';
import { listRepos, getRepo, createGist } from './github.js';
import { webSearch } from './web_search.js';
import { recall, remember } from '../memory.js';

export const readFileSchema = z.object({
  path: z.string().describe('Absolute or cwd-relative file path'),
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

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n…(truncated, ${str.length - max} more chars)`;
}

async function readFile(args, ctx) {
  const cwd = defaultCwdFor(ctx.user, config);
  const abs = safeResolve(cwd, args.path);
  const maxLines = args.max_lines ?? 400;
  let buf;
  try { buf = await fs.readFile(abs); }
  catch (err) { return { ok: false, error: `read failed: ${err.message}` }; }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const limited = lines.slice(0, maxLines).join('\n');
  const out = truncate(limited, config.agent.maxFileBytes);
  const tag = lines.length > maxLines ? `…(showing ${maxLines}/${lines.length} lines)` : `(${lines.length} lines)`;
  return { ok: true, output: out + (out.endsWith('\n') ? '' : '\n') + tag, absPath: abs, totalLines: lines.length };
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
  const occurrences = orig.split(args.old_text).length - 1;
  if (occurrences === 0) return { ok: false, error: 'old_text not found' };
  if (!replaceAll && occurrences > 1) return { ok: false, error: `old_text matches ${occurrences} times; use replace_all=true or narrow the match` };
  const newText = replaceAll ? orig.split(args.old_text).join(args.new_text) : orig.replace(args.old_text, args.new_text);
  try {
    await fs.writeFile(abs, newText, 'utf8');
    const added = args.new_text.length - args.old_text.length;
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
);