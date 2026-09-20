// language: JavaScript (Node 20+ ESM), file: src/bot/features/inline.js
// Inline mode: answer prompts from any chat without switching to the bot.
//
// Telegram's inline query hands us text and expects results back within a few
// seconds. A full chat round-trip is too slow, so we do one non-streaming
// completion and return it as a single message result the user can send.

import { chatCompletion } from '../../providers/client.js';
import { buildStableMessages } from '../../agent/context.js';
import { runtimeContext } from '../../agent/context.js';
import { ensureUser, currentSessionId, loadHistory } from '../../conversation.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { toTelegramMarkdown } from '../../format.js';
import { redact } from '../../providers/keys.js';

const INLINE_TIMEOUT_MS = Number(process.env.INLINE_TIMEOUT_MS || 12_000);
const MAX_INLINE_LEN = 400;

export async function onInlineQuery(ctx) {
  const q = (ctx.inlineQuery?.query || '').trim();
  if (!q) {
    // No text yet: offer the examples so the empty state is not a dead end.
    return ctx.answerInlineQuery([
      {
        type: 'article',
        id: 'hint',
        title: 'Type a prompt…',
        description: 'e.g. “translate to english: apa kabar”',
        input_message_content: { message_text: '_(empty)_', parse_mode: 'Markdown' },
      },
    ], { cache_time: 0 });
  }

  const tgUser = ctx.from;
  const user = ensureUser(tgUser);
  const sessionId = currentSessionId(user.user_id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INLINE_TIMEOUT_MS);

  try {
    const messages = await buildStableMessages(user, q, {
      history: await loadHistory(user.user_id, sessionId),
      runtimeContext: runtimeContext({ sessionName: sessionId }),
    });

    const { content } = await chatCompletion({
      provider: user.provider, model: user.model, messages,
      chatId: ctx.from.id,
      temperature: user.temperature ?? config.defaults.temperature,
      maxTokens: config.defaults.maxTokens,
    });

    const body = toTelegramMarkdown(redact(content || '(no answer)')).slice(0, MAX_INLINE_LEN * 4);
    const preview = body.replace(/[*_`#>|]/g, '').slice(0, 80) || 'Answer';

    await ctx.answerInlineQuery([{
      type: 'article',
      id: 'ans',
      title: preview.slice(0, 60),
      description: 'Send this answer',
      input_message_content: {
        message_text: body,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
    }], { cache_time: 0 });
  } catch (err) {
    logger.warn({ err: err.message }, 'inline query failed');
    await ctx.answerInlineQuery([{
      type: 'article',
      id: 'err',
      title: '⚠️ Could not answer',
      description: String(err.message).slice(0, 100),
      input_message_content: { message_text: `⚠️ Inline query failed: ${String(err.message).slice(0, 200)}` },
    }], { cache_time: 0 });
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- forum topics

/**
 * Group chats with forum topics enabled deliver each topic as its own
 * message_thread_id. Treat each topic as its own conversation: a reply in
 * topic 12 must not see the history of topic 7.
 *
 * @returns a stable conversation key, or null when this is not a topic.
 */
export function topicKey(ctx) {
  const tid = ctx.message?.message_thread_id ?? ctx.update?.message?.message_thread_id;
  if (!tid) return null;
  return String(tid);
}

/**
 * A scoped session id for a topic. Falls back to the normal session when the
 * chat has no topics, so nothing changes for existing DM users.
 */
export function sessionForTopic(baseSessionId, ctx) {
  const tk = topicKey(ctx);
  return tk ? `${baseSessionId}#topic${tk}` : baseSessionId;
}

// --------------------------------------------------------------- edit detection

/** Map of user message id → {prompt, media, answerText} for edit detection. */
const _editedBase = new Map();

export function rememberTurn(messageId, prompt, media, answerText) {
  if (!messageId) return;
  _editedBase.set(messageId, { prompt, media, answerText });
  if (_editedBase.size > 300) _editedBase.delete(_editedBase.keys().next().value);
}

export function previousTurnFor(messageId) {
  return _editedBase.get(messageId) || null;
}

export async function onEditedMessage(ctx) {
  // A user fixed a typo in their original prompt. Re-run with the new text and
  // the previous answer as a reference, so the bot regenerates instead of
  // answering from scratch.
  const text = ctx.editedMessage?.text || '';
  if (!text || text.startsWith('/')) return;
  const prev = previousTurnFor(ctx.editedMessage.message_id);
  const media = await collectEditedMedia(ctx);

  const { handlePrompt } = await import('../handlers/message.js');
  await handlePrompt(ctx, text, media, { editedFrom: prev?.answerText });
}

async function collectEditedMedia(ctx) {
  const out = [];
  if (ctx.editedMessage?.photo) {
    const biggest = ctx.editedMessage.photo.at(-1);
    out.push({ type: 'image_url', image_url: { url: await download(ctx, biggest.file_id) } });
  }
  return out;
}

function download(ctx, fileId) {
  return ctx.api.getFile(fileId).then((f) => `https://api.telegram.org/file/bot${config.telegram.token}/${f.file_path}`);
}
