// language: JavaScript (Node 20+ ESM), file: src/debugger/error-analyzer.js
// Turns a raw error into a diagnosis the agent can act on. Classifies by shape,
// not by message text, so an unknown provider's phrasing still lands right.

export const ERROR_KINDS = {
  NETWORK: 'network',           // DNS/connection/reset — usually transient or proxy-dead
  TIMEOUT: 'timeout',           // request exceeded the budget
  AUTH: 'auth',                 // 401/403 — key wrong, expired, or insufficient scope
  RATE_LIMIT: 'rate_limit',     // 429 — back off or rotate proxy
  NOT_FOUND: 'not_found',       // 404 — model or endpoint doesn't exist
  SERVER: 'server',             // 5xx — provider's problem
  SYNTAX: 'syntax',             // JS SyntaxError in our own code — self-heal target
  MODULE: 'module',             // ERR_MODULE_NOT_FOUND — missing dependency/import
  PERMISSION: 'permission',     // EACCES/EPERM — filesystem permissions
  ENOENT: 'enoent',             // file missing
  TOOL: 'tool',                 // a tool returned isError
  ABORT: 'abort',               // user hit /abort
  UNKNOWN: 'unknown',
};

const HINTS = {
  [ERROR_KINDS.NETWORK]: 'The request never reached the provider. If PROXY_ENABLED is on the proxy may be dead — try PROXY_ENABLED=false, or check /admin proxystats.',
  [ERROR_KINDS.TIMEOUT]: 'The provider took too long. Raise REQUEST_TIMEOUT_MS, or retry — this is usually transient.',
  [ERROR_KINDS.AUTH]: 'The key was rejected. Check the key_env for this provider in providers.yaml and that the variable is set in .env.',
  [ERROR_KINDS.RATE_LIMIT]: 'Rate limited. Wait, lower the request rate, or rotate the proxy (proxies are per-chat in this gateway).',
  [ERROR_KINDS.NOT_FOUND]: 'The model or endpoint does not exist at this provider. Run /model list <provider> to see what is actually offered.',
  [ERROR_KINDS.SERVER]: 'Provider-side failure. Retry after a moment; if it persists the provider is down.',
  [ERROR_KINDS.SYNTAX]: 'A source file has a syntax error. This is self-healable: read the file at the reported line, fix it, and restart.',
  [ERROR_KINDS.MODULE]: 'A module could not be resolved. Run npm install, or check the import path — a typo here is the usual cause.',
  [ERROR_KINDS.PERMISSION]: 'The process user lacks permission for this path. Check ownership and the workspace root.',
  [ERROR_KINDS.ENOENT]: 'The path does not exist. List the directory first to see what is actually there.',
  [ERROR_KINDS.TOOL]: 'The tool reported a failure. Its output is in context — read it and adjust.',
  [ERROR_KINDS.ABORT]: 'Cancelled by the user.',
  [ERROR_KINDS.UNKNOWN]: 'No classification matched. The raw message is the only signal.',
};

const HTTP_BY_KIND = {
  400: ERROR_KINDS.UNKNOWN,
  401: ERROR_KINDS.AUTH,
  403: ERROR_KINDS.AUTH,
  404: ERROR_KINDS.NOT_FOUND,
  408: ERROR_KINDS.TIMEOUT,
  429: ERROR_KINDS.RATE_LIMIT,
  500: ERROR_KINDS.SERVER,
  502: ERROR_KINDS.NETWORK,
  503: ERROR_KINDS.SERVER,
  504: ERROR_KINDS.TIMEOUT,
};

/**
 * Extract an HTTP status from anything: a bare number, an "HTTP 401: …" string,
 * or an Error carrying it. Providers wrap differently, so be permissive.
 */
export function extractStatus(err) {
  if (typeof err === 'number') return err;
  const e = err instanceof Error ? err : new Error(String(err ?? ''));
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  const m = /HTTP\s+(\d{3})/.exec(e.message);
  return m ? Number(m[1]) : null;
}

export function classify(err) {
  const e = err instanceof Error ? err : new Error(String(err ?? ''));
  const msg = e.message || '';
  const code = e.code || '';
  const status = extractStatus(e);

  if (e.name === 'SyntaxError' || e instanceof SyntaxError) return ERROR_KINDS.SYNTAX;
  if (code === 'ERR_MODULE_NOT_FOUND' || /cannot find module|does not provide an export named/i.test(msg)) {
    return ERROR_KINDS.MODULE;
  }
  if (code === 'EACCES' || code === 'EPERM') return ERROR_KINDS.PERMISSION;
  if (code === 'ENOENT') return ERROR_KINDS.ENOENT;
  if (e.name === 'AbortError' || /aborted/i.test(msg)) return ERROR_KINDS.ABORT;
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return ERROR_KINDS.TIMEOUT;
  if (
    code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' || /fetch failed|getaddrinfo|socket hang up|network/i.test(msg)
  ) {
    return ERROR_KINDS.NETWORK;
  }
  if (status && HTTP_BY_KIND[status]) return HTTP_BY_KIND[status];
  if (status && status >= 500) return ERROR_KINDS.SERVER;
  if (status && status >= 400) return ERROR_KINDS.UNKNOWN;
  if (/unauthorized|forbidden|invalid api key|invalid_api_key/i.test(msg)) return ERROR_KINDS.AUTH;
  if (/rate limit|too many requests/i.test(msg)) return ERROR_KINDS.RATE_LIMIT;
  if (/not found/i.test(msg)) return ERROR_KINDS.NOT_FOUND;
  return ERROR_KINDS.UNKNOWN;
}

export function analyze(err, ctx = {}) {
  const kind = classify(err);
  const e = err instanceof Error ? err : new Error(String(err ?? ''));
  const status = extractStatus(e);
  return {
    kind,
    message: e.message,
    status,
    stack: e.stack?.split('\n').slice(0, 6).join('\n') || null,
    hint: HINTS[kind] || HINTS[ERROR_KINDS.UNKNOWN],
    /** True when the agent itself can fix it — a syntax error in our source,
     * a missing module, a wrong path. False for provider-side failures. */
    selfHealable: kind === ERROR_KINDS.SYNTAX || kind === ERROR_KINDS.MODULE ||
      kind === ERROR_KINDS.ENOENT || kind === ERROR_KINDS.PERMISSION,
    retryable: kind === ERROR_KINDS.NETWORK || kind === ERROR_KINDS.TIMEOUT ||
      kind === ERROR_KINDS.SERVER || kind === ERROR_KINDS.RATE_LIMIT,
    ...ctx,
  };
}
