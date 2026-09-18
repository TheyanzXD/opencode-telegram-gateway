import { config } from '../../config.js';
import { chatCompletion, streamChatCompletion, modelSupportsVision } from '../../providers/client.js';
import { ensureUser, buildMessages, persistTurn, currentSessionId } from '../../conversation.js';
import { recordUsage } from '../../db.js';
import { logger } from '../../logger.js';
import { splitLong, toTelegramMarkdown } from '../../format.js';

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

async function sendReply(ctx, text, parseMode = 'Markdown') {
  for (const part of splitLong(text)) {
    try {
      await ctx.reply(part, parseMode ? { parse_mode: parseMode } : {});
    } catch {
      await ctx.reply(part);
    }
  }
}

export async function onText(ctx) {
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return; // commands handled elsewhere
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

  if (media.length) {
    const hasVision = config.vision.provider && config.vision.model;
    if (!hasVision && !modelSupportsVision(user.provider, user.model)) {
      return ctx.reply('⚠️ Current model does not support vision. Set VISION_PROVIDER/VISION_MODEL in .env.');
    }
  }

  const provider = media.length && config.vision.provider ? config.vision.provider : user.provider;
  const model = media.length && config.vision.model ? config.vision.model : user.model;

  const messages = buildMessages(user, userText, sessionId);
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
    const replyMsg = await ctx.reply(PLACEHOLDER);
    return streamReply(ctx, replyMsg, { provider, model, messages, user, chatId, sessionId });
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
      await sendReply(ctx, toTelegramMarkdown(content) || '(empty)');
    } catch (err) {
      logger.error({ err: err.message }, 'chat error');
      await ctx.reply(`❌ ${err.message}`);
    }
  }
}

async function streamReply(ctx, replyMsg, { provider, model, messages, user, chatId, sessionId }) {
  let buf = '';
  let lastEdit = 0;
  try {
    const stream = streamChatCompletion({
      provider, model, messages, chatId,
      temperature: user.temperature ?? config.defaults.temperature,
      maxTokens: config.defaults.maxTokens,
    });
    for await (const delta of stream) {
      buf += delta;
      const now = Date.now();
      if (now - lastEdit > 700 || buf.length > 3800) {
        lastEdit = now;
        await ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, buf.slice(0, 4000) || PLACEHOLDER).catch(() => {});
      }
    }
    persistTurn(user.user_id, messages[messages.length - 1].content, buf, null, sessionId);
    recordUsage({ user_id: user.user_id, provider, model, usage: null });
    await ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, toTelegramMarkdown(buf) || '(empty)').catch(() => {});
  } catch (err) {
    logger.error({ err: err.message }, 'stream error');
    await ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, `❌ ${err.message}`).catch(() => {});
  }
}
