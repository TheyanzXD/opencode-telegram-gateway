// language: JavaScript (Node 18+ ESM), file: src/agent/tools/ask-user.js
// ask_user — the one tool the bot was missing. Everything else runs without
// waiting; this one stops and waits for a human answer in chat.
//
// Reuses the approval machinery (approvals.js) because the mechanics are
// identical: park a deferred promise in a Map, resolve it from a Telegram
// inline-keyboard callback. The difference is only the shape of the answer —
// a choice, or free text.

import { z } from 'zod';
import { createApproval, resolveApproval, getApproval } from '../approvals.js';

// Deferred question answers. Keyed by approval id, resolved from the bot side
// by resolveAnswer(). Separate from approvals.js because the value is a string,
// not a boolean.
const _answers = new Map();
import { logger } from '../../logger.js';

const TTL_MS = 30 * 60 * 1000; // a question older than 30 min is stale

const choiceSchema = z.object({
  question: z.string().min(1).max(2000),
  choices: z.array(z.string().min(1).max(100)).min(2).max(6).optional(),
  allow_text: z.boolean().optional().describe('Also accept a typed reply (default true when no choices)'),
  placeholder: z.string().max(200).optional().describe('Hint shown under the question'),
});

export const askUserTool = {
  name: 'ask_user',
  description:
    'Ask the user a question and wait for the answer. Prefer this over guessing when a decision is theirs to make — style, scope, which option, whether to proceed. Returns their answer as text. Free-text answers come as typed; choices come as the chosen label. Read-only to the system — it blocks on a human.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'What to ask. One question, self-contained.' },
      choices: {
        type: 'array',
        description: 'Two to six options. Presented as buttons. Omit for a free-text question.',
        items: { type: 'string' },
      },
      allow_text: { type: 'boolean', description: 'Also accept a typed reply (default true when no choices)' },
      placeholder: { type: 'string', description: 'Hint shown under the question' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  schema: choiceSchema,
  requiresApproval() {
    // Blocking on a human is not a dangerous operation, but it must never run
    // unattended: a subagent with no human present would hang until the TTL.
    return true;
  },
  async execute({ question, choices, allow_text, placeholder }, ctx = {}) {
    const userId = String(ctx.userId ?? ctx.chatId ?? '0');
    const isChoice = Array.isArray(choices) && choices.length >= 2;
    const acceptText = allow_text ?? !isChoice;

    const approval = createApproval(userId, 'ask_user', { question, choices });
    const bot = ctx.bot;
    if (!bot) return '⚠️ no bot handle in context — cannot ask';

    const buttons = isChoice
      ? chunk(choices, 2).map((row) =>
          row.map((label, i) => ({
            text: label,
            // encode the index so the answer round-trips without parsing free text
            callback_data: `answer:${approval.id}:${choices.indexOf(label)}`,
          }))
        )
      : [];

    if (acceptText) {
      buttons.push([{ text: '⌨️ Type an answer', callback_data: `answer:${approval.id}:text` }]);
    }

    const text =
      `❓ *Question*\n\n${question}` +
      (placeholder ? `\n\n_${placeholder}_` : '') +
      (acceptText && isChoice ? '\n\n_Tap a button, or type a reply._' : '');

    try {
      await bot.telegram.sendMessage(ctx.chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'ask_user: send failed');
      return '⚠️ could not reach the user — proceed with your best judgment';
    }

    // Park until the bot side resolves it, or the TTL fires.
    const answer = await new Promise((resolve) => {
      _answers.set(approval.id, resolve);
      setTimeout(() => { if (_answers.has(approval.id)) { _answers.delete(approval.id); resolve('__timeout__'); } }, TTL_MS).unref?.();
    });

    if (answer === '__timeout__') {
      return '⏱ no answer within 30 minutes — proceed with your best judgment and say what you assumed.';
    }
    if (answer === '__denied__') {
      return '🚫 the user declined to answer — do not ask again this turn.';
    }
    return answer;
  },
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Called from the bot side: a button tap answers the question.
// Called from the bot side: a button tap or a typed reply answers the question.
export function resolveAnswer(approvalId, answer) {
  const resolve = _answers.get(approvalId);
  if (!resolve) return false;
  _answers.delete(approvalId);
  resolve(String(answer ?? ''));
  return true;
}

// Called from the bot side: a typed reply answers the most recent open
// question in that chat.
export function answerByText(chatId, text) {
  for (const [id] of _answers) {
    const a = getApproval(id);
    if (a && String(a.userId) === String(chatId)) return resolveAnswer(id, text);
  }
  return false;
}

// Called from the bot side: the user tapped a choice button.
export async function answerCallback(ctx) {
  const [, id, pick] = (ctx.callbackQuery?.data || '').split(':');
  const a = getApproval(id);

  if (!a || a.tool !== 'ask_user') return true; // not ours; let the next handler try

  // 'text' means the user wants to type — the answer arrives via onText.
  if (pick === 'text') {
    await ctx.answerCallbackQuery('Type your answer in chat');
    return true;
  }

  const choices = a.args?.choices || [];
  const idx = Number(pick);
  const label = Number.isInteger(idx) ? choices[idx] : null;

  if (!label) return true; // stale or malformed — leave it alone
  if (!resolveAnswer(id, label)) return true;

  await ctx.answerCallbackQuery(`✓ ${label}`);
  await ctx
    .editMessageText(`❓ *${a.args.question}*\n\n**${label}**`, { parse_mode: 'Markdown', reply_markup: undefined })
    .catch(() => {});
  return true;
}
