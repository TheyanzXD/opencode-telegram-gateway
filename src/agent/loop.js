import { config } from '../config.js';
import { logger } from '../logger.js';
import { streamChatCompletion, chatCompletion } from '../providers/client.js';
import { findTool, tools } from './tools.js';
import { toolsToDefs } from './zodJsonSchema.js';
import { requestApproval } from './approval.js';
import { defaultCwdFor } from './sandbox.js';
import { addMessage, auditTool } from '../db.js';
import { toolsForUser, runToolCall, getRegistry } from '../mcp/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';

function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  const fire = () => {
    last = Date.now();
    timer = null;
    const args = pending; pending = null;
    fn(...args);
  };
  return (...args) => {
    pending = args;
    const now = Date.now();
    const dt = now - last;
    if (dt >= ms) { if (timer) { clearTimeout(timer); timer = null; } fire(); return; }
    if (!timer) timer = setTimeout(fire, ms - dt);
  };
}

function mergeToolCallDelta(acc, tcs) {
  if (!Array.isArray(tcs)) return;
  for (const tc of tcs) {
    if (!acc[tc.index]) {
      acc[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    }
    const dst = acc[tc.index];
    if (tc.id) dst.id = tc.id;
    if (tc.type) dst.type = tc.type;
    if (tc.function?.name) dst.function.name += tc.function.name;
    if (typeof tc.function?.arguments === 'string') dst.function.arguments += tc.function.arguments;
  }
}

function safeParseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

export async function runAgent({ ctx, user, chatId, sessionId, initialMessages, replyMsgId, persistAgentOk }) {
  const messages = initialMessages.map((m) => ({ ...m }));
  const cwd = defaultCwdFor(user, config);
  let lastEdit = 0;
  const edit = throttle(async (text, opts) => {
    try { await ctx.api.editMessageText(chatId, replyMsgId, text, opts || {}); }
    catch { /* ignore throttled or unchanged */ }
  }, 700);

  await edit('💭 *thinking…*', { parse_mode: 'Markdown' });

  for (let iter = 0; iter < config.agent.maxToolIterations; iter++) {
    // Build tools list each iteration so MCP servers that come online mid-session appear.
    const baseDefs = toolsToDefs(tools);
    const toolDefs = await toolsForUser(user, baseDefs);
    const accumulated = { content: '', tool_calls: [], finish_reason: null };
    let buf = '';

    try {
      const stream = streamChatCompletion({
        provider: user.provider,
        model: user.model,
        messages,
        chatId,
        temperature: user.temperature ?? config.defaults.temperature,
        maxTokens: config.defaults.maxTokens,
        tools: toolDefs,
        tool_choice: 'auto',
      });
      for await (const delta of stream) {
        if (delta.content) {
          accumulated.content += delta.content;
          buf = accumulated.content;
        }
        if (delta.tool_calls) mergeToolCallDelta(accumulated.tool_calls, delta.tool_calls);
        if (delta.finish_reason) accumulated.finish_reason = delta.finish_reason;
        if (buf && buf.length > 3800) buf = buf.slice(0, 3800) + '…';
      }
    } catch (err) {
      logger.error({ err: err.message }, 'agent stream error');
      await ctx.api.editMessageText(chatId, replyMsgId, `❌ ${err.message}`).catch(() => {});
      return;
    }

    const hasToolCalls = accumulated.tool_calls.some((tc) => tc.function.name);
    if (!hasToolCalls || accumulated.finish_reason !== 'tool_calls') {
      const final = accumulated.content || '(empty)';
      if (persistAgentOk) persistAgentOk({ content: final });
      await ctx.api.editMessageText(chatId, replyMsgId, final.slice(0, 4000) || '(empty)').catch(() => {});
      return;
    }

    messages.push({
      role: 'assistant',
      content: accumulated.content || null,
      tool_calls: accumulated.tool_calls.filter((tc) => tc.function.name),
    });

    for (const tc of accumulated.tool_calls) {
      if (!tc.function.name) continue;
      const args = safeParseArgs(tc.function.arguments);
      await edit(`🔧 \`${tc.function.name}\` …`, { parse_mode: 'Markdown' });

      const started = Date.now();
      let result;
      try {
        if (tc.function.name === 'bash_exec' || tc.function.name === 'git_commit' || tc.function.name === 'git_clone'
            || (tc.function.name === 'git_branch' && findTool('git_branch') /* only delete path approves */)) {
          // For bash/git writes, the tool itself calls askApproval. Just route.
          result = await runToolCall(tc.function.name, args, {
            user, chatId, cwd,
            askApproval: ({ tool, args }) => requestApproval(ctx, { tool, args }),
          });
        } else {
          result = await runToolCall(tc.function.name, args, { user, chatId, cwd });
        }
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      const dur = Date.now() - started;
      try { auditTool(user.user_id, { tool_name: tc.function.name, args, ok: result.ok, output: (result.output || result.error || '').slice(0, 4000), duration_ms: dur }); }
      catch (err) { logger.warn({ err: err.message }, 'audit log failed'); }

      const summary = result.ok
        ? `✓ ${tc.function.name} ${(result.output || '').split('\n')[0].slice(0, 80)}`
        : `✗ ${tc.function.name}: ${result.error}`;
      await edit(`🔧 *${tc.function.name}* — ${result.ok ? 'ok' : 'failed'}\n${summary}`, { parse_mode: 'Markdown' });

      const toolContent = result.ok ? (result.output || '(ok)') : `error: ${result.error}`;
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: toolContent });
      try {
        addMessage(user.user_id, 'tool', toolContent, null, sessionId, { tool_call_id: tc.id, tool_name: tc.function.name });
      } catch (err) {
        logger.warn({ err: err.message }, 'persist tool message failed');
      }

      // Send-as-document suggestion for read_file when output is big
      if (tc.function.name === 'read_file' && result.ok && args.path) {
        const sendAbs = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
        try {
          const st = await fs.stat(sendAbs);
          if (st.size > 50_000) {
            await ctx.api.editMessageText(chatId, replyMsgId, `🔧 *read_file* — ${st.size} bytes. Send as Telegram document?`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[
                { text: '📄 Send as file', callback_data: `tool:sendfile:${user.user_id}:${Buffer.from(sendAbs).toString('base64')}` },
                { text: 'Skip', callback_data: 'tool:sendfile:skip' },
              ]] },
            }).catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }
  }

  await ctx.api.editMessageText(chatId, replyMsgId, '⚠️ stopped: too many tool iterations').catch(() => {});
}