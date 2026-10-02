import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const pending = new Map(); // id -> { resolve, timer, toolName }

export async function requestApproval(ctx, { tool, args }) {
  const id = randomUUID().slice(0, 8);
  const summary =
    tool === 'bash_exec'
      ? `\`bash_exec\`\n\`\`\`\n${args.command.slice(0, 800)}\n\`\`\``
      : `${tool} ${JSON.stringify(args).slice(0, 600)}`;
  const reply = await ctx.reply(
    `🔧 *pending approval*\n${summary}\n\nApprove to run, deny to cancel.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Allow', callback_data: `tool:allow:${id}` },
          { text: '❌ Deny',  callback_data: `tool:deny:${id}` },
        ]],
      },
    }
  );
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        ctx.api.editMessageReplyMarkup(reply.chat.id, reply.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        resolve({ allow: false, reason: 'approval timed out' });
      }
    }, config.agent.approvalTtlMs);
    pending.set(id, {
      resolve: (allow) => {
        clearTimeout(timer);
        pending.delete(id);
        ctx.api.editMessageReplyMarkup(reply.chat.id, reply.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        resolve({ allow, reason: allow ? 'ok' : 'denied by user' });
      },
      toolName: tool,
      chatId: reply.chat.id,
      messageId: reply.message_id,
    });
  });
}

export function resolveApproval(id, allow) {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve(Boolean(allow));
  return true;
}

export function pendingCount() {
  return pending.size;
}