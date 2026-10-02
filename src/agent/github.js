// Tiny GitHub REST client. No SDK — uses undici fetch already in deps.
// Auth via personal access token (fine-grained or classic).

import { fetch } from 'undici';

const API = 'https://api.github.com';

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'opencode-telegram-gateway',
  };
}

async function gh(path, token, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...authHeaders(token), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text.slice(0, 400) }; }
  if (!res.ok) {
    const msg = body?.message || `HTTP ${res.status}`;
    const err = new Error(`github: ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getViewer(token) {
  return gh('/user', token);
}

export async function listRepos(token, { per_page = 10, page = 1, sort = 'updated' } = {}) {
  const params = new URLSearchParams({ per_page: String(per_page), page: String(page), sort });
  return gh(`/user/repos?${params}`, token);
}

export async function getRepo(token, owner, name) {
  return gh(`/repos/${owner}/${name}`, token);
}

export async function listGists(token, { per_page = 10, page = 1 } = {}) {
  const params = new URLSearchParams({ per_page: String(per_page), page: String(page) });
  return gh(`/gists?${params}`, token);
}

export async function createGist(token, { description = '', files }) {
  if (!files || typeof files !== 'object') throw new Error('files object required');
  return gh('/gists', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, public: false, files }),
  });
}

export function tokenLooksValid(t) {
  return typeof t === 'string' && /^(gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t);
}