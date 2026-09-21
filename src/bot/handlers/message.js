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
import { architectureBrief } from '../../agent/awareness.js';
import { chatWithTools } from '../../agent/chat-tools.js';
import { TelegramPresenter } from '../../agent/presenter.js';
import { createDefaultRegistry } from '../../agent/registry.js';

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

  // Tools are on in plain chat, not just /agent. The model must know it sits
  // on a real host with a tool loop, or it answers "I cannot access files" —
  // which is wrong here. The brief teaches it; the notice tells it when to
  // reach for a tool vs. answer straight.
  const brief = {
    role: 'system',
    content: architectureBrief({ workspace: process.cwd(), chatId: ctx.chat?.id }),
  };
  const notice = {
    role: 'system',
    content: 'You have tool-calling enabled in this conversation and may use tools to act on this host: read and edit files, run commands and scripts, search the web or browse. When a task benefits from a tool, call it and report the real result — do not claim you cannot act. Only tools that change state ask for approval.',
  };
  // Below soul/skills/memory, above the last user message.
  messages.push({ role: 'system', content: brief.content });
  messages.push({ role: 'system', content: notice.content });

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
    const presenter = new TelegramPresenter({ bot: ctx.api, chatId: ctx.chat.id, debounceMs: 700 });
    const sent = await presenter.init('🧠 thinking…');
    const ac = abortControllerFor(chatId);
    rememberAnswer(chatId, sent, userText, media);
    return streamReply(ctx, { message_id: sent }, { provider, model, messages, user, chatId, sessionId, signal: ac.signal, presenter })
      .finally(() => releaseAbortController(chatId));
  } else {
    // Non-streaming still shows live tool progress through a presenter.
    const presenter = new TelegramPresenter({ bot: ctx.api, chatId: ctx.chat.id, debounceMs: 700 });
    const sent = await presenter.init('🧠 thinking…').catch(() => null);
    try {
      const { content } = await chatWithTools({
        provider, model, messages, chatId, userId: user.user_id,
        temperature: user.temperature ?? config.defaults.temperature,
        maxTokens: config.defaults.maxTokens,
        onApproval: (id, tool, args) => presenter.sendApproval(id, tool, args),
        onEvent: (evt) => presenter.push(evt),
      });
      presenter.done = true;
      presenter.push({ type: 'token', text: content });
      await presenter.finalize().catch(() => {});
      persistTurn(user.user_id, userText, content, null, sessionId);
      recordUsage({ user_id: user.user_id, provider, model, usage: null });
      rememberAnswer(chatId, ctx.message?.message_id, userText, media);
    } catch (err) {
      presenter.push({ type: 'error', message: err.message });
      presenter.done = true;
      await presenter.finalize().catch(() => {});
      logger.error({ err: err.message }, 'chat error');
      await ctx.reply(`❌ ${err.message}`);
    }
  }
}

async function streamReply(ctx, replyMsg, { provider, model, messages, user, chatId, sessionId, signal, presenter }) {
  // Approvals render through the presenter (its own inline keyboard), so the
  // tap flows through the same approve:/deny: handler as /agent.
  let buf = '';
  const flush = async (text) => {
    await ctx.api.editMessageText(
      ctx.chat.id,
      replyMsg.message_id,
      toTelegramMarkdown(text) || '(no response)',
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  };
  try {
    const { content } = await chatWithTools({
      provider, model, messages, chatId, userId: user.user_id,
      temperature: user.temperature ?? config.defaults.temperature,
      maxTokens: config.defaults.maxTokens,
      onApproval: (id, tool, args) => presenter.sendApproval(id, tool, args),
      onEvent: (evt) => presenter.push(evt),
      stream: (args) => streamChatCompletion(args),
    });
    presenter.done = true;
    presenter.push({ type: 'token', text: content });
    await presenter.finalize();
    buf = content;
    await flush(content || '(no response)');
    persistTurn(user.user_id, messages[messages.length - 1].content, content, null, sessionId);
    recordUsage({ user_id: user.user_id, provider, model, usage: null });
  } catch (err) {
    presenter.push({ type: 'error', message: err.message });
    presenter.done = true;
    await presenter.finalize().catch(() => {});
    if (err?.name === 'AbortError' || signal?.aborted) {
      await flush(buf || '(stopped)');
      return;
    }
    logger.error({ err: err.message }, 'stream error');
    await ctx.api.editMessageText(ctx.chat.id, replyMsg.message_id, `❌ ${err.message}`.slice(0, 4000)).catch(() => {});
  }
}
