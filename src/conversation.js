import { addMessage, getHistory, getUser, upsertUser, getActiveSession } from './db.js';
import { config } from './config.js';

function systemPromptFor(user) {
  return user.system_prompt || config.defaults.systemPrompt;
}

export function buildMessages(user, currentTurn, sessionId) {
  const sys = { role: 'system', content: systemPromptFor(user) };
  const history = getHistory(user.user_id, config.historyLimit, sessionId).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  return [sys, ...history, { role: 'user', content: currentTurn }];
}

export function systemPromptForExport(user) {
  return systemPromptFor(user);
}

export function loadHistory(userId, sessionId) {
  return getHistory(userId, config.historyLimit, sessionId).map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

export function persistTurn(user_id, userText, assistantText, usage, sessionId) {
  addMessage(user_id, 'user', userText, null, sessionId);
  addMessage(user_id, 'assistant', assistantText, usage?.completion_tokens ?? null, sessionId);
}

export function ensureUser(tgUser) {
  return upsertUser({
    user_id: tgUser.id,
    username: tgUser.username,
    first_name: tgUser.first_name,
    last_name: tgUser.last_name,
  });
}

export function currentSessionId(user_id) {
  return getActiveSession(user_id)?.id ?? null;
}
