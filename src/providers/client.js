import { Agent, ProxyAgent, fetch } from 'undici';
import { config } from '../config.js';
import { getProvider, getModel } from './store.js';
import { logger } from '../logger.js';
import { getChatProxy, dispatcherForProxy, markOk, markFail } from '../proxy/pool.js';

let directAgent = null;
function getDirectAgent() {
  if (!directAgent) directAgent = new Agent({ connect: { timeout: 15_000 }, bodyTimeout: config.http.timeoutMs, headersTimeout: 60_000 });
  return directAgent;
}

function dispatcherForRequest(chatId) {
  if (!config.proxy.enabled) return { dispatcher: getDirectAgent(), proxyId: null };
  const p = getChatProxy(chatId || 0);
  if (!p) return { dispatcher: getDirectAgent(), proxyId: null };
  return { dispatcher: dispatcherForProxy(p), proxyId: p.id };
}

async function tracked(url, opts, proxyId) {
  try {
    const res = await fetch(url, opts);
    if (proxyId != null) markOk(proxyId);
    return res;
  } catch (err) {
    if (proxyId != null) markFail(proxyId);
    throw err;
  }
}

function buildAuth(provider, body) {
  const key = provider.api_key || '';
  switch (provider.auth_mode) {
    case 'header':
      return { headers: { Authorization: `Bearer ${key}` }, body };
    case 'xheader':
      return { headers: { 'x-api-key': key }, body };
    case 'query': {
      const sep = provider.base_url.includes('?') ? '&' : '?';
      return { headers: {}, url: `${provider.base_url}${sep}key=${encodeURIComponent(key)}`, body };
    }
    case 'body':
      return { headers: {}, body: { ...body, api_key: key } };
    case 'none':
    default:
      return { headers: {}, body };
  }
}

async function requestJson(providerName, endpoint, body, signal, chatId) {
  const provider = getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  const url = provider.base_url.replace(/\/+$/, '') + endpoint;
  const auth = buildAuth(provider, body);
  const finalUrl = auth.url || url;
  const { dispatcher, proxyId } = dispatcherForRequest(chatId);
  const res = await tracked(finalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.headers },
    body: JSON.stringify(auth.body),
    signal,
    dispatcher,
  }, proxyId);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[${providerName}] HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`[${providerName}] non-JSON response: ${text.slice(0, 400)}`);
  }
}

async function* streamChunks(providerName, body, signal, chatId) {
  const provider = getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  const url = provider.base_url.replace(/\/+$/, '') + '/chat/completions';
  const auth = buildAuth(provider, { ...body, stream: true });
  const finalUrl = auth.url || url;
  const { dispatcher, proxyId } = dispatcherForRequest(chatId);
  let res;
  try {
    res = await fetch(finalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...auth.headers },
      body: JSON.stringify(auth.body),
      signal,
      dispatcher,
    });
    if (proxyId != null) markOk(proxyId);
  } catch (err) {
    if (proxyId != null) markFail(proxyId);
    throw err;
  }
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`[${providerName}] HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.text ?? '';
        if (delta) yield delta;
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

export async function chatCompletion(args) {
  const body = {
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    max_tokens: args.maxTokens,
  };
  const t0 = Date.now();
  const data = await requestJson(args.provider, '/chat/completions', body, args.signal, args.chatId);
  const ms = Date.now() - t0;
  const content = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage || null;
  logger.debug({ provider: args.provider, model: args.model, ms, usage }, 'chat complete');
  return { content, usage, raw: data };
}

export async function streamChatCompletion(args) {
  return streamChunks(args.provider, {
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    max_tokens: args.maxTokens,
  }, args.signal, args.chatId);
}

export async function listModels(providerName, chatId) {
  const provider = getProvider(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  const url = provider.base_url.replace(/\/+$/, '') + '/models';
  const auth = buildAuth(provider, {});
  const finalUrl = auth.url || url;
  const { dispatcher, proxyId } = dispatcherForRequest(chatId);
  const res = await tracked(finalUrl, { headers: { ...auth.headers }, dispatcher }, proxyId);
  if (!res.ok) throw new Error(`[${providerName}] /models HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

export function modelSupportsVision(providerName, model) {
  const meta = getModel(providerName, model);
  return Boolean(meta?.vision);
}
