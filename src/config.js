import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

function loadDotenv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const txt = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotenv();

function bool(v, dflt = false) {
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, dflt) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : dflt;
}

function csv(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  root: ROOT,
  envFile: ENV_FILE,
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'gateway.db'),
  log: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'pretty',
    file: process.env.LOG_FILE || null,
  },
  http: {
    timeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 120_000),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    allowed: csv(process.env.TELEGRAM_ALLOWED_USERS),
    admins: csv(process.env.TELEGRAM_ADMIN_USERS),
    // The tier below admin: these ids run dangerous tools without an approval
    // keyboard. Empty (default) = everyone is asked. See src/agent/rbac.js.
    toolUsers: csv(process.env.TELEGRAM_TOOL_USERS),
    homeChannel: process.env.TELEGRAM_HOME_CHANNEL || null,
  },
  defaults: {
    provider: process.env.DEFAULT_PROVIDER || 'openai',
    model: process.env.DEFAULT_MODEL || 'gpt-4o-mini',
    temperature: Number(process.env.DEFAULT_TEMPERATURE ?? 0.7),
    maxTokens: int(process.env.DEFAULT_MAX_TOKENS, 4096),
    systemPrompt: process.env.SYSTEM_PROMPT || 'You are a helpful assistant.',
  },
  vision: {
    provider: process.env.VISION_PROVIDER || '',
    model: process.env.VISION_MODEL || '',
  },
  historyLimit: int(process.env.HISTORY_LIMIT, 20),
  maxInputChars: int(process.env.MAX_INPUT_CHARS, 8000),
  streaming: bool(process.env.STREAMING, true),
  // agent: tool-calling loop, HITL approvals
  agent: {
    enabled: bool(process.env.AGENT_ENABLED, false),
    workspace: path.resolve(process.env.AGENT_WORKSPACE || path.join(ROOT, 'workspace')),
    maxTurns: int(process.env.AGENT_MAX_TURNS, 20),
    bashTimeoutMs: int(process.env.BASH_TIMEOUT_MS, 30_000),
    approveTimeoutMs: int(process.env.AGENT_APPROVE_TIMEOUT_MS, 10 * 60 * 1000),
    debounceMs: int(process.env.AGENT_DEBOUNCE_MS, 1500),
    rateLimitPerMinute: int(process.env.RATE_LIMIT_PER_MINUTE, 30),
    // tools the agent may never call, even with approval
    blockedTools: csv(process.env.AGENT_BLOCKED_TOOLS),
    // guardian LLM: a cheap second model pre-screens dangerous calls.
    // Clearly-safe ones run without a keyboard; unsure → still asks.
    // Must be a DIFFERENT (cheaper) model than the agent's.
    guardianProvider: process.env.GUARDIAN_PROVIDER || '',
    guardianModel: process.env.GUARDIAN_MODEL || '',
    // skills live in ./skills by default; SKILLS_DIR moves them elsewhere
    skillRoot: process.env.SKILLS_DIR || path.join(ROOT, 'skills'),
    // session expiry: history older than this is forgotten (default 30d)
    sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
    // DLQ + secret redaction are always on; these only tune the noise level
    redactEnvInOutput: bool(process.env.REDACT_ENV, true),
  },
  // model fallback chain — a provider going down should not take the bot down
  fallback: {
    chain: process.env.FALLBACK_CHAIN || '',
  },
  // webhook + watchdog. silentMinutes: if no traffic for this long the
  // health endpoint reports 503 so an external probe restarts the process
  watchdog: {
    silentMinutes: int(process.env.WATCHDOG_SILENT_MINUTES, 30),
  },
  plugins: {
    enabled: bool(process.env.PLUGINS_ENABLED, true),
    dir: process.env.PLUGINS_DIR || path.join(ROOT, 'plugins'),
  },
  proxy: {
    // Off by default: the pool is opt-in. Cloning and running the bot must
    // not start fetching ten thousand open proxies.
    enabled: bool(process.env.PROXY_ENABLED, false),
    target: int(process.env.PROXY_TARGET, 10_000),
    rotatePerChat: bool(process.env.PROXY_PER_CHAT, true),
    refreshHours: int(process.env.PROXY_REFRESH_HOURS, 6),
    // optional local file of authenticated proxies (user:pass@ip:port)
    premiumFile: process.env.PROXY_PREMIUM_FILE || '',
  },
  admin: {
    requireChannel: bool(process.env.ADMIN_REQUIRE_CHANNEL, true),
    channelId: process.env.TELEGRAM_HOME_CHANNEL || '',
  },
  export: {
    homeChannel: process.env.TELEGRAM_HOME_CHANNEL || '',
  },
};

export function isAdmin(userId) {
  return config.telegram.admins.includes(String(userId));
}
export function isAllowed(userId) {
  return config.telegram.allowed.length === 0 || config.telegram.allowed.includes(String(userId));
}
export function isAdminChannel(chatId) {
  if (!config.admin.requireChannel) return true;
  if (!config.admin.channelId) return true;
  return String(chatId) === String(config.admin.channelId);
}

export function assertValid() {
  const errs = [];
  if (!config.telegram.token) errs.push('TELEGRAM_BOT_TOKEN is empty in .env');
  return errs;
}
