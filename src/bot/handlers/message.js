import { config } from '../../config.js';
import { chatCompletion, streamChatCompletion, modelSupportsVision } from '../../providers/client.js';
import { memoryBlock, autoLearn } from '../../agent/memory.js';
import { selectSkills, skillBlock, loadSkills } from '../../agent/skills.js';
import { ensureUser, persistTurn, currentSessionId, loadHistory } from '../../conversation.js';
import { buildStableMessages, runtimeContext } from '../../agent/context.js';
import { recordUsage } from '../../db.js';
import { remainingQuota } from '../commands/usage.js';
import {
  replyContext, rememberAnswer, regenKeyboard, stopKeyboard,
  abortControllerFor, releaseAbortController,
} from '../features/threads.js';
import { logger } from '../../logger.js';
import { splitLong, toTelegramMarkdown } from '../../format.js';
import { answerByText } from '../../agent/tools/ask-user.js';

const PLACEHOLDER = '…';

function downloadFile(ctx, fileId) {
  return ctx.api.getFile(fileId).then((f) => `https://api.telegram.org/file/bot${config.telegram.token}/${f.file_path}`);
}

async function collectMedia(ctx) {
  const out = [];
  if (ctx.message?.photo) {
    const biggest = ctx.message.photo.at(-1);
    out.push({ type: 'image_url', image_url: { url: await downloadFile(ctx, biggest.file_id) } });
  }
  if (ctx.message?.document?.mime_type?.startsWith('image/')) {
    out.push({ type: 'image_url', image_url: { url: await downloadFile(ctx, ctx.message.document.file_id) } });
  }
  return out;
}

async function sendReply(ctx, text, parseMode = 'Markdown', replyMarkup = undefined) {
  for (const part of splitLong(text)) {
    try {
      await ctx.reply(part, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch {
      await ctx.reply(part);
    }
  }
}

export async function onText(ctx) {
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return; // commands handled elsewhere
  // If the agent asked a question and the user typed instead of tapping a
  // button, this is the answer. Consume it and stay out of the normal path.
  if (answerByText(ctx.chat?.id ?? ctx.from?.id, text)) return;
  if (text.length > config.maxInputChars) {
    return ctx.reply(`⚠️ Message too long (${text.length}/${config.maxInputChars}).`);
  }
  await handlePrompt(ctx, text, []);
}

export async function onPhoto(ctx) {
  const caption = ctx.message.caption || '';
  if (caption.length > config.maxInputChars) {
    return ctx.reply('⚠️ Caption too long.');
  }
  const media = await collectMedia(ctx);
  await handlePrompt(ctx, caption || 'Describe the image.', media);
}

export async function onDocument(ctx) {
  const cap = ctx.message.caption || '';
  const media = await collectMedia(ctx);
  if (!media.length) return ctx.reply('Only image documents are supported.');
  await handlePrompt(ctx, cap || 'Describe the image.', media);
}

async function handlePrompt(ctx, userText, media) {
  const tgUser = ctx.from;
  const user = ensureUser(tgUser);
  const chatId = ctx.chat.id;
  const sessionId = currentSessionId(user.user_id);

  const left = remainingQuota(user.user_id);
  if (left != null && left <= 0) {
    return ctx.reply('⛔ Daily token quota reached. Resets at 00:00 UTC. Ask the operator to raise it: /quota');
  }

  if (media.length) {
    const hasVision = config.vision.provider && config.vision.model;
    if (!hasVision && !modelSupportsVision(user.provider, user.model)) {
      return ctx.reply('⚠️ Current model does not support vision. Set VISION_PROVIDER/VISION_MODEL in .env.');
    }
  }

  const provider = media.length && config.vision.provider ? config.vision.provider : user.provider;
  const model = media.length && config.vision.model ? config.vision.model : user.model;

  const messages = await buildStableMessages(user, userText, {
    history: await loadHistory(user.user_id, sessionId),
    runtimeContext: runtimeContext({ sessionName: sessionId, workspace: process.cwd() }),
  });

  // Skills + memory are injected BELOW the cached prefix, as their own system
  // messages. Changing them does not invalidate the prompt cache.
  const skills = selectSkills(userText);
  const skillText = skillBlock(skills);
  if (skillText) messages.splice(1, 0, { role: 'system', content: skillText });

  const memText = memoryBlock(user.user_id);
  if (memText) messages.splice(1, 0, { role: 'system', content: memText });

  // Pinned turns: load-bearing instructions the user marked to keep.
  const pinText = ctx.session?.pinnedBlock;
  if (pinText) messages.splice(1, 0, { role: 'system', content: pinText });

  // A reply to an older message carries the turns around it as context.
  const ctxMsgs = ctx.threads?.replyContext(sessionId);
  if (ctxMsgs?.length) {
    messages.splice(messages.length - 1, 0,
      { role: 'system', content: 'Context the user replied to (continue from here):' },
      ...ctxMsgs,
    );
  }

  autoLearn(user.user_id, userText, '');
  if (media.length) {
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        ...media,
      ],
    };
  }

  if (config.streaming) {
    const replyMsg = await ctx.reply(PLACEHOLDER, { reply_markup: stopKeyboard() });
    const ac = abortControllerFor(chatId);
    rememberAnswer(chatId, replyMsg.message_id, userText, media);
    return streamReply(ctx, replyMsg, { provider, model, messages, user, chatId, sessionId, signal: ac.signal })
      .finally(() => releaseAbortController(chatId));
  } else {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    try {
      const { content, usage } = await chatCompletion({
        provider, model, messages, chatId,
        temperature: user.temperature ?? config.defaults.temperature,
        maxTokens: config.defaults.maxTokens,
      });
      persistTurn(user.user_id, userText, content, usage, sessionId);
      recordUsage({ user_id: user.user_id, provider, model, usage });
      rememberAnswer(chatId, ctx.message?.message_id, userText, media);
      await sendReply(ctx, toTelegramMarkdown(content) || '(empty)', undefined, regenKeyboard(ctx.message?.message_id));
    } catch (err) {
      logger.error({ err: err.message }, 'chat error');
      await ctx.reply(`❌ ${err.message}`);
    }
  }
}

async function streamReply(ctx, replyMsg, { provider, model, messages, user, chatId, sessionId, signal }) {
  const { withEmptyResponseGuard } = await import('../../agent/guards.js');
  let buf = '';
  let lastEdit = 0;
  const flush = async (text) => {
    await ctx.api.editMessageText(
      ctx.chat.id,
      replyMsg.message_id,
      toTelegramMarkdown(text) || '(no response)',
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  };
  try {
    await withEmptyResponseGuard({
      signal: signal || null,
      openStream: () => streamChatCompletion({
        provider, model, messages, chatId,
        temperature: user.temperature ?? config.defaults.temperature,
        maxTokens: config.defaults.maxTokens,
      }),
      onChunk: (acc) => {
        buf = acc;
        const now = Date.now();
        if (now - lastEdit > 700 || buf.length > 3800) {
          lastEdit = now;
          ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, buf.slice(0, 4000) || PLACEHOLDER).catch(() => {});
        }
      },
      onDone: async (final) => {
        persistTurn(user.user_id, messages[messages.length - 1].content, final, null, sessionId);
        recordUsage({ user_id: user.user_id, provider, model, usage: null });
        await flush(final);
      },
      onFail: async (message) => {
        logger.error({ message }, 'empty response guard failed');
        await ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, `⚠️ ${message}`.slice(0, 4000)).catch(() => {});
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      await flush(buf || '(stopped)');
      return;
    }
    logger.error({ err: err.message }, 'stream error');
    await ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, `❌ ${err.message}`.slice(0, 4000)).catch(() => {});
  }
}
