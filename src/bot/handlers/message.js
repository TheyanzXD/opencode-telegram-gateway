import { config } from '../../config.js';
import { chatCompletion, modelSupportsVision } from '../../providers/client.js';
import { ensureUser, buildMessages, persistTurn, currentSessionId } from '../../conversation.js';
import { recordUsage } from '../../db.js';
import { remainingQuota } from '../commands/usage.js';
import {
  replyContext, rememberAnswer, regenKeyboard, stopKeyboard,
  abortControllerFor, releaseAbortController,
} from '../features/threads.js';
import { logger } from '../../logger.js';
import { runAgent } from '../../agent/loop.js';

const PLACEHOLDER = '…';

const inflight = new Map(); // chatId -> Promise
function serialize(chatId, fn) {
  const prev = inflight.get(chatId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  inflight.set(chatId, next);
  return next;
}

function downloadFile(ctx, fileId) {
  return ctx.api.getFile(fileId).then((f) => `https://api.telegram.org/file/bot${config.telegram.token}/${f.file_path}`);
}

async function downloadToBuffer(ctx, fileId) {
  const url = await downloadFile(ctx, fileId);
  const { fetch } = await import('undici');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
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

const TEXT_EXTS = new Set(['txt','md','markdown','json','yaml','yml','csv','tsv','log',
  'js','jsx','ts','tsx','mjs','cjs','py','rb','rs','go','java','kt','swift','c','cc','cpp','h','hpp',
  'cs','php','sh','bash','zsh','fish','ps1','lua','pl','r','dart','vue','svelte','html','css','scss',
  'less','xml','toml','ini','cfg','conf','gradle','dockerfile']);
function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
function isTextUpload(mime, filename) {
  if (mime && (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml')) return true;
  return TEXT_EXTS.has(extOf(filename));
}

async function readUploadedText(ctx, doc) {
  if (doc.file_size && doc.file_size > config.agent.maxUploadBytes) {
    throw new Error(`file too large (${doc.file_size} > ${config.agent.maxUploadBytes})`);
  }
  const buf = await downloadToBuffer(ctx, doc.file_id);
  return buf.toString('utf8');
}

export async function onText(ctx) {
  const chatId = ctx.chat.id;
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return; // commands handled elsewhere
  // If the agent asked a question and the user typed instead of tapping a
  // button, this is the answer. Consume it and stay out of the normal path.
  if (answerByText(ctx.chat?.id ?? ctx.from?.id, text)) return;
  if (text.length > config.maxInputChars) {
    return ctx.reply(`⚠️ Message too long (${text.length}/${config.maxInputChars}).`);
  }
  return serialize(chatId, () => handlePrompt(ctx, text, []));
}

export async function onPhoto(ctx) {
  const chatId = ctx.chat.id;
  const caption = ctx.message.caption || '';
  if (caption.length > config.maxInputChars) {
    return ctx.reply('⚠️ Caption too long.');
  }
  const media = await collectMedia(ctx);
  return serialize(chatId, () => handlePrompt(ctx, caption || 'Describe the image.', media));
}

export async function onDocument(ctx) {
  const chatId = ctx.chat.id;
  const cap = ctx.message.caption || '';
  const doc = ctx.message.document;
  // Image → vision path
  const imgMedia = await collectMedia(ctx);
  if (imgMedia.length) return serialize(chatId, () => handlePrompt(ctx, cap || 'Describe the image.', imgMedia));
  // Text → upload path
  if (doc && isTextUpload(doc.mime_type, doc.file_name)) {
    try {
      const text = await readUploadedText(ctx, doc);
      const prompt = `Uploaded file: \`${doc.file_name}\` (${doc.file_size ?? text.length} bytes)\n\n\`\`\`\n${text.slice(0, 60_000)}\n\`\`\`${text.length > 60_000 ? '\n…(truncated)' : ''}\n\n${cap || 'Process this file.'}`;
      return serialize(chatId, () => handlePrompt(ctx, prompt, []));
    } catch (err) {
      return ctx.reply(`❌ Upload failed: ${err.message}`);
    }
  }
  // Unsupported binary
  return ctx.reply(`📎 Only text/code files supported in v1 (no PDF/binary). PDF parsing: ponytail. See /tools.`);
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

  if (config.streaming && config.agent.enabled) {
    const replyMsg = await ctx.reply(PLACEHOLDER);
    return runAgent({
      ctx, user, chatId, sessionId,
      initialMessages: messages,
      replyMsgId: replyMsg.message_id,
      persistAgentOk: ({ content }) => {
        // record user turn + assistant turn for the *final* reply.
        try { persistTurn(user.user_id, userText, content, null, sessionId); }
        catch (err) { logger.warn({ err: err.message }, 'persist turn failed'); }
        recordUsage({ user_id: user.user_id, provider, model, usage: null });
      },
    });
  }

  // Non-streaming / agent-disabled fallback (single-shot chat).
  await ctx.api.sendChatAction(ctx.chat.id, 'typing');
  try {
    const { content, usage } = await chatCompletion({
      provider, model, messages, chatId,
      temperature: user.temperature ?? config.defaults.temperature,
      maxTokens: config.defaults.maxTokens,
      onApproval: (id, tool, args) => presenter.sendApproval(id, tool, args),
      onEvent: (evt) => presenter.push(evt),
      stream: (args) => streamChatCompletion(args),
    });
    persistTurn(user.user_id, userText, content, usage, sessionId);
    recordUsage({ user_id: user.user_id, provider, model, usage });
    await ctx.reply(content || '(empty)');
  } catch (err) {
    logger.error({ err: err.message }, 'chat error');
    await ctx.reply(`❌ ${err.message}`);
  }
}