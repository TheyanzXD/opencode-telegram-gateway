// language: JavaScript (Node 18+ ESM), file: src/bot/commands/agent.js
// /agent <prompt> — runs the tool-calling ReAct loop for this chat.
// /abort       — cancels the running loop for this chat.
// /tools       — lists the tools the agent may call.
// approve/deny — inline-keyboard callbacks resolving a parked approval.
//
// One AbortController + one in-flight engine per chat. Abort is cooperative:
// the loop checks the signal between turns.

import { config } from '../../config.js';
import { ensureUser, persistTurn, currentSessionId } from '../../conversation.js';
import { workspaceFor } from '../../agent/workspace.js';
import { architectureBrief } from '../../agent/awareness.js';
import { logger } from '../../logger.js';
import { AgentEngine } from '../../agent/engine.js';
import { TelegramPresenter } from '../../agent/presenter.js';
import { createDefaultRegistry } from '../../agent/registry.js';
import { pluginsLoader } from '../../plugins/state.js';
import { resolveApproval, rejectAllForUser } from '../../agent/approvals.js';
import { rememberTrace } from './debug.js';

/** In-flight runs keyed by chat id. */
const runs = new Map();

export function isAgentRun(chatId) {
  return runs.has(String(chatId));
}

// The agent's messages differ from a plain chat: the system prompt carries an
// architecture brief so the model knows it runs on a real host with real tools.
// Without it, "can you browse files?" gets the generic chatbot answer — no.
function buildAgentMessages(user, currentTurn, sessionId, chatId) {
  const sys = { role: 'system', content: user.system_prompt || config.defaults.systemPrompt };
  const ws = workspaceFor(user.user_id);
  const brief = {
    role: 'system',
    content: architectureBrief({ workspace: ws, chatId }),
  };
  const history = getHistory(user.user_id, config.historyLimit, sessionId).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  return [sys, brief, ...history, { role: 'user', content: currentTurn }];
}

export async function agentCommand(ctx) {
  if (!config.agent.enabled) {
    return ctx.reply('⚠️ Agent mode is off. Set `AGENT_ENABLED=true` in .env.', { parse_mode: 'Markdown' });
  }
  const prompt = (ctx.match || '').trim();
  if (!prompt) {
    return ctx.reply('Usage: `/agent <task>`\nExample: `/agent list the files in the workspace`', { parse_mode: 'Markdown' });
  }
  return runAgent(ctx, prompt);
}

export async function abortCommand(ctx) {
  const run = runs.get(String(ctx.chat.id));
  if (!run) return ctx.reply('No agent run in this chat.');
  run.abortCtl.abort();
  rejectAllForUser(ctx.from.id);
  return ctx.reply('⏹ Aborted.');
}

export async function toolsCommand(ctx) {
  const reg = createDefaultRegistry();
  const lines = reg.list().map((t) => `${t.isDangerous ? '🔐' : '🛠'} \`${t.name}\` — ${t.description}`);
  return ctx.reply(lines.join('\n').slice(0, 4000), { parse_mode: 'Markdown' });
}

export async function approvalCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  const approved = data.startsWith('approve:');
  const [, id] = data.split(':');
  const ok = resolveApproval(id, approved);
  await ctx.answerCallbackQuery(ok ? (approved ? 'Approved ✅' : 'Denied ❌') : 'Expired or unknown');
  if (ok) {
    await ctx
      .editMessageText(`${approved ? '✅ Approved' : '❌ Denied'} — the agent continues.`, { reply_markup: undefined })
      .catch(() => {});
  }
  return ok;
}

async function runAgent(ctx, prompt) {
  const key = String(ctx.chat.id);
  if (runs.has(key)) return ctx.reply('⏳ An agent run is already in progress here. Use /abort first.');

  const user = ensureUser(ctx.from);
  const sessionId = currentSessionId(user.user_id);
  const abortCtl = new AbortController();
  const chatId = ctx.chat.id;

  const presenter = new TelegramPresenter({
    bot: ctx.api,
    chatId,
    debounceMs: config.agent.debounceMs,
  });

  const engine = new AgentEngine({
    provider: user.provider,
    model: user.model,
    maxTurns: config.agent.maxTurns,
    temperature: user.temperature ?? config.defaults.temperature,
    maxTokens: config.defaults.maxTokens,
    onEvent: (evt) => {
      presenter.push(evt);
      if (evt.type === 'approvalRequired') {
        // The engine already parked the deferred promise under evt.id.
        // Rendering the keyboard is the bot's job; resolving is the callback's.
        presenter.sendApproval(evt.id, evt.tool, evt.args).catch((e) =>
          logger.warn({ err: e.message }, 'approval keyboard failed'),
        );
      }
    },
  });

  // plugin tools ride alongside the built-ins
  const loader = pluginsLoader();
  if (loader) for (const tool of loader.tools()) engine.registry.register(tool);

  runs.set(key, { engine, abortCtl, presenter });
  rememberTrace(ctx.chat.id, engine.tracer);

  try {
    await presenter.init('🧠 thinking…');
    const messages = buildAgentMessages(user, prompt, sessionId, ctx.chat.id);
    const final = await engine.run({
      messages,
      chatId,
      userId: user.user_id,
      signal: abortCtl.signal,
    });
    persistTurn(user.user_id, prompt, final, null, sessionId);
  } catch (err) {
    logger.error({ err: err.message }, 'agent run failed');
    presenter.push({ type: 'error', message: err.message });
  } finally {
    runs.delete(key);
    await presenter.finalize().catch(() => {});
  }
}
