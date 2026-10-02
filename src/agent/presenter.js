// language: JavaScript (Node 20+ ESM), file: src/agent/presenter.js
// Buffers engine events and edits one Telegram message on a debounce.
// Telegram allows ~1 edit/sec per message; the engine emits far faster than that.
// Coalesces: tokens append, tool logs stack, approval replaces the body with a keyboard.
//
// Hardening (v2): flush() is serialized by an async mutex. Before, a token
// arriving mid-flush started a SECOND editMessageText before the first finished
// — two overlapping edits on one message race to the same message_id and
// Telegram answers the loser with 429 or a mangled render. A retry_after in
// the error now parks the schedule until Telegram's own window says it is safe.

import { toTelegramMarkdown, splitLong } from '../format.js';
import { resolveApproval } from './approvals.js';
import { logger } from '../logger.js';

const MAX_MSG = 4000;        // Telegram hard cap is 4096; leave room for escaping
const TOOL_LOG_CAP = 12;     // keep the last N tool lines in the live view
const TRUNC = '…';

export class TelegramPresenter {
  /**
   * @param {object} opts
   * @param {import('telegraf').Telegraf} opts.bot
   * @param {number} opts.chatId
   * @param {number} opts.debounceMs
   * @param {AbortController} [opts.abortCtl]
   */
  constructor({ bot, chatId, debounceMs = 1500, abortCtl }) {
    // grammY passes `ctx.api`; telegraf passes `bot.telegram`. Normalise both
    // to a single handle with grammY's sendMessage/editMessageText signatures.
    // grammY api: sendMessage(chatId, text, other), editMessageText(chatId, mid, text, other)
    // telegraf  : telegram.sendMessage(chatId, text, other), telegram.editMessageText(chatId, mid, inline, text, other)
    this.telegramStyle = !!(bot && bot.telegram && typeof bot.telegram.sendMessage === 'function');
    this.api = this.telegramStyle ? bot.telegram : bot;
    this.bot = bot;
    this.chatId = chatId;
    this.debounceMs = debounceMs;
    this.abortCtl = abortCtl;
    this.text = '';
    this.toolLog = [];
    this.messageId = null;
    this.timer = null;
    this.dirty = false;
    this.done = false;
    this.lastEdit = 0;
    // async-mutex state — flush() is re-entrant safe now
    this.isFlushing = false;
    this.pendingFlush = false;
    this.lastSentBody = ''; // smart-diff baseline
    // epoch ms; while Date.now() < this, Telegram told us to wait
    this.backoffUntil = 0;
    // typing heartbeat: sendChatAction every 4.5 s while work is in flight
    this.typingTimer = null;
  }

  /**
   * A typing action every 4.5 s while the model or a tool is working. Without
   * it the chat shows nothing during a long tool turn and the user assumes the
   * bot died. Telegram clears the indicator after ~5 s, so re-send before that.
   */
  startTypingHeartbeat() {
    this.stopTypingHeartbeat();
    const beat = async () => {
      try { await this.api.sendChatAction(this.chatId, 'typing'); }
      catch { /* a failed indicator must not kill the turn */ }
    };
    beat();
    this.typingTimer = setInterval(beat, 4500);
    this.typingTimer.unref?.();
  }

  stopTypingHeartbeat() {
    if (this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = null; }
  }

  /** Send the initial placeholder and remember its id for later edits. */
  async init(initial = '…') {
    const sent = await this.api.sendMessage(this.chatId, initial);
    this.messageId = sent.message_id;
    return this.messageId;
  }

  /** Called by the engine for every event. Cheap — the real work is scheduled. */
  push(evt) {
    switch (evt.type) {
      case 'token':
        this.text += evt.text;
        this.dirty = true;
        break;
      case 'toolStart':
        this.toolLog.push(`▶ ${evt.tool}`);
        if (this.toolLog.length > TOOL_LOG_CAP) this.toolLog.shift();
        this.dirty = true;
        break;
      case 'commentary':
        // interim assistant text between tool rounds (Hermes Commentary)
        this.toolLog.push(`· ${String(evt.text || '').trim().slice(0, 100)}`);
        if (this.toolLog.length > TOOL_LOG_CAP) this.toolLog.shift();
        this.dirty = true;
        break;
      case 'toolEnd': {
        const last = this.toolLog[this.toolLog.length - 1];
        const oneLine = String(evt.output || evt.content || '').split('\n').filter(Boolean)[0] || '';
        if (last && last.startsWith(`▶ ${evt.tool}`)) {
          this.toolLog[this.toolLog.length - 1] =
            `${evt.denied ? '⛔' : evt.isError ? '⚠️' : '✔'} ${evt.tool} — ${oneLine.slice(0, 120)}`;
        }
        this.dirty = true;
        break;
      }
      case 'approvalRequired':
        this.dirty = true;
        break;
      case 'done':
        this.done = true;
        this.dirty = true;
        break;
      case 'error':
        this.text += `\n\n❌ ${evt.message}`;
        this.done = true;
        this.dirty = true;
        break;
    }
    this.schedule();
  }

  schedule(delay = null) {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastEdit;
    const base = delay !== null ? delay : this.done ? 0 : this.adaptiveDebounce(elapsed);
    const wait = Math.max(0, base - elapsed);
    this.timer = setTimeout(() => this.flush(), wait);
    // unref so a hung edit never blocks process exit
    this.timer.unref?.();
  }

  /**
   * Adaptive debounce: fast at first (the reply feels instant), then slower as
   * the turn drags on. A 15 s answer edited every 750 ms would burn 20 edits
   * for one message; the same turn at 1800 ms uses 8 and never hits the limit.
   * @param {number} elapsed ms since the last edit
   */
  adaptiveDebounce(elapsed) {
    if (elapsed < 2_000) return 750;
    if (elapsed < 5_000) return 1_200;
    return 1_800;
  }

  render() {
    const head = this.toolLog.length ? this.toolLog.join('\n') + '\n\n' : '';
    return (head + this.text).slice(0, MAX_MSG);
  }

  async flush() {
    this.timer = null;

    // Mutex: a flush already in flight must not race a second edit on the same
    // message_id. The late token is queued and runs when this one lands.
    if (this.isFlushing) {
      this.pendingFlush = true;
      return;
    }

    if (!this.dirty || this.messageId == null) return;

    // Telegram told us to wait: honor it instead of re-queueing a 429 loop.
    if (Date.now() < this.backoffUntil) {
      this.schedule(this.backoffUntil - Date.now() + 100);
      return;
    }

    this.isFlushing = true;

    // Smart diff: a tiny delta mid-stream is not worth an API call. Telegram
    // would show the same visible text, and the edit costs against the
    // per-message rate limit. Wait for the next interval instead.
    const body = this.render();
    if (!this.done && this.lastSentBody && body.length - this.lastSentBody.length < 12) {
      this.isFlushing = false;
      this.dirty = true;
      this.schedule(this.debounceMs);
      return;
    }

    this.dirty = false;
    this.lastSentBody = body;
    try {
      const text = this.done ? toTelegramMarkdown(body) || TRUNC : body;
      const opts = this.done ? { parse_mode: 'Markdown' } : {};
      if (this.telegramStyle) {
        await this.api.editMessageText(this.chatId, this.messageId, undefined, text, opts);
      } else {
        await this.api.editMessageText(this.chatId, this.messageId, text, opts);
      }
      this.lastEdit = Date.now();
    } catch (err) {
      const msg = String(err?.message || '');
      // 429: Telegram says when we may edit again — park the schedule and keep
      // the buffer, so the retry lands instead of being dropped.
      const m = msg.match(/retry after (\d+)/i);
      if (m) {
        const sec = parseInt(m[1], 10) || 3;
        this.backoffUntil = Date.now() + sec * 1000;
        this.dirty = true;
        this.schedule(sec * 1000 + 100);
        logger.warn({ sec }, 'edit throttled by Telegram; backing off');
      } else if (!/not modified/i.test(msg)) {
        logger.debug({ err: msg }, 'edit failed');
      }
    } finally {
      this.isFlushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        this.schedule(this.debounceMs);
      }
    }
  }

  /** Send the inline keyboard for a pending dangerous tool. */
  async sendApproval(approvalId, tool, args) {
    const preview = JSON.stringify(args, null, 2).slice(0, 1200);
    return this.api.sendMessage(
      this.chatId,
      `🔐 *Approval required*\n\nTool: \`${tool}\`\n\`\`\`\n${preview}\n\`\`\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Izinkan', callback_data: `approve:${approvalId}` },
            { text: '❌ Tolak', callback_data: `deny:${approvalId}` },
          ]],
        },
      },
    );
  }

  async finalize() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopTypingHeartbeat();
    this.done = true;
    await this.flush();
  }

  async sendFinal(text) {
    // text may exceed one message — split and send the overflow as new messages
    const parts = splitLong(toTelegramMarkdown(text) || TRUNC);
    for (let i = 1; i < parts.length; i++) {
      await this.api.sendMessage(this.chatId, parts[i], { parse_mode: 'Markdown' }).catch(() => {});
    }
    if (parts.length > 1) {
      // first part already rendered into the tracked message
      this.text = parts[0];
      this.dirty = true;
      await this.flush();
    }
  }
}
