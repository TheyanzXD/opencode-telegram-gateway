// language: JavaScript (Node 20+ ESM), file: src/agent/tools/github-ops.js
// The oh-my-pi github tool: repo, PR, issues, code search, Actions run-watch —
// without requiring the gh CLI to be installed.
//
// omp shells out to `gh` and caches its results. We do it over the GitHub REST
// API instead, because a phone VPS does not have gh and authenticating through
// a browser is not possible there. The token comes from GITHUB_TOKEN in .env
// or the user's own stored key; without a token the public read paths still
// work (rate-limited).

import { logger } from '../../logger.js';
import { config } from '../../config.js';

const API = 'https://api.github.com';
const PER_PAGE = 30;

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || config.github?.token || '';
}

function authHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'opencode-telegram-gateway' };
  const t = token();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function apiGet(p, userId) {
  const url = p.startsWith('http') ? p : API + p;
  try {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 403 || res.status === 429) {
      return { error: `rate limited${token() ? '' : ' — no GITHUB_TOKEN set, authenticated limits are much higher'}` };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const link = res.headers.get('link') || '';
    return { data: await res.json(), link };
  } catch (err) {
    logger.warn({ err: String(err.message).slice(0, 120), p }, 'github api failed');
    return { error: err.message };
  }
}

function parseRepo(s) {
  // "owner/name", "https://github.com/owner/name", or a full git URL
  const m = s.match(/github\.com[/:]([^/]+)\/([^/.]+)|^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return m[1] ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : { owner: m[3], repo: m[4].replace(/\.git$/, '') };
}

export const githubTools = [
  {
    name: 'github',
    description: 'GitHub ops without the gh CLI: repo info, issues, PRs, code search, and Actions run status. Actions: "runs <owner/repo>", "log <owner/repo> <run-id>". Search: "code <query> in <owner/repo>", "issues <owner/repo> [query]", "pr <owner/repo> <number>". Set GITHUB_TOKEN in .env for the authenticated limits.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of: repo, issues, issue, pr, prs, code, runs, log, commits, commit' },
        repo: { type: 'string', description: 'owner/repo or a github URL' },
        number: { type: 'integer', description: 'issue or PR number' },
        query: { type: 'string', description: 'Search text (code search uses query + optional "in owner/repo")' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute({ action, repo, number, query }, ctx = {}) {
      const r = repo ? parseRepo(repo) : null;
      if (repo && !r) return `⚠️ cannot parse "${repo}" as owner/repo`;

      const fail = (e) => `⚠️ ${e}`;

      switch (action) {
        case 'repo': {
          if (!r) return fail('repo required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}`, ctx.userId);
          if (d.error) return fail(d.error);
          const x = d.data;
          return [
            `**${x.full_name}** ${x.private ? '(private)' : ''} ⭐${x.stargazers_count} ⑂${x.forks_count}`,
            `${x.description || '_no description_'}`,
            `Language: ${x.language || '—'} · License: ${x.license?.name || '—'} · Default branch: ${x.default_branch}`,
            `Updated ${new Date(x.updated_at).toLocaleDateString()} · ${x.open_issues_count} open issue(s)`,
            x.homepage ? `Homepage: ${x.homepage}` : '',
          ].filter(Boolean).join('\n');
        }

        case 'issues': {
          if (!r) return fail('repo required');
          const q = query ? `+${encodeURIComponent(query)}+in:title,body` : '';
          const d = await apiGet(`/search/issues?q=repo:${r.owner}/${r.repo}+is:issue+state:open${q}&per_page=${PER_PAGE}`, ctx.userId);
          if (d.error) return fail(d.error);
          const items = d.data.items || [];
          if (!items.length) return 'No open issues match.';
          return `**${d.data.total_count} open issue(s)** — showing ${items.length}:\n\n` +
            items.map((i) => `- [#${i.number}](${i.html_url}) ${i.title}`).join('\n');
        }

        case 'issue': {
          if (!r || !number) return fail('repo and number required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}/issues/${number}`, ctx.userId);
          if (d.error) return fail(d.error);
          const i = d.data;
          return `**#${i.number} — ${i.title}**\n${i.state} · by ${i.user?.login} · ${i.comments} comment(s)\n\n${(i.body || '_no body_').slice(0, 2000)}`;
        }

        case 'prs': {
          if (!r) return fail('repo required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}/pulls?state=open&per_page=${PER_PAGE}`, ctx.userId);
          if (d.error) return fail(d.error);
          if (!d.data.length) return 'No open PRs.';
          return `**${d.data.length} open PR(s):**\n\n` +
            d.data.map((p) => `- [#${p.number}](${p.html_url}) ${p.title} — ${p.user?.login}${p.draft ? ' (draft)' : ''}`).join('\n');
        }

        case 'pr': {
          if (!r || !number) return fail('repo and number required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}/pulls/${number}`, ctx.userId);
          if (d.error) return fail(d.error);
          const p = d.data;
          return `**#${p.number} — ${p.title}**\n${p.state}${p.merged ? '/merged' : ''} · ${p.head.ref} → ${p.base.ref} · +${p.additions} −${p.deletions}\n\n${(p.body || '_no body_').slice(0, 2000)}`;
        }

        case 'code': {
          if (!query) return fail('query required');
          // "query in owner/repo" narrows to a repo
          const m = query.match(/^(.*?)\s+in\s+([^\s]+\/[^\s]+)$/);
          const q = m ? m[1] : query;
          const scope = m ? `+repo:${m[2]}` : '';
          const d = await apiGet(`/search/code?q=${encodeURIComponent(q)}${scope}&per_page=${PER_PAGE}`, ctx.userId);
          if (d.error) return fail(d.error);
          const items = d.data.items || [];
          if (!items.length) return 'No code matches.';
          return `**${d.data.total_count} match(es)** — showing ${items.length}:\n\n` +
            items.map((c) => `- [\`${c.repository.full_name}/${c.path}\`](${c.html_url})`).join('\n');
        }

        case 'runs': {
          if (!r) return fail('repo required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}/actions/runs?per_page=10`, ctx.userId);
          if (d.error) return fail(d.error);
          const runs = d.data.workflow_runs || [];
          if (!runs.length) return 'No workflow runs.';
          return runs.map((x) =>
            `- ${x.conclusion === 'success' ? '✅' : x.conclusion === 'failure' ? '❌' : '🔄'} [#${x.run_number}](${x.html_url}) ${x.name} — ${x.conclusion || x.status} · ${x.head_branch}`).join('\n');
        }

        case 'log': {
          if (!r || !number) return fail('repo and run number required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}/actions/runs/${number}/logs`, ctx.userId);
          if (d.error) return fail(d.error);
          return `_Logs for run ${number} are a zip download; the API does not serve them as text. Fetch the artifacts endpoint, or open the run page._`;
        }

        case 'commits': {
          if (!r) return fail('repo required');
          const d = await apiGet(`/repos/${r.owner}/${r.repo}/commits?per_page=10`, ctx.userId);
          if (d.error) return fail(d.error);
          return d.data.map((c) =>
            `- \`${(c.sha || '').slice(0, 7)}\` ${c.commit?.message?.split('\n')[0]} — ${c.commit?.author?.name}`).join('\n');
        }

        default:
          return fail(`unknown action: ${action}. Try repo, issues, issue, pr, prs, code, runs, commits.`);
      }
    },
  },
];
