// language: JavaScript (Node 18+ ESM), file: src/agent/presenter.js
// Buffers engine events and edits one Telegram message on a debounce.
// Telegram allows ~1 edit/sec per message; the engine emits far faster than that.
// Coalesces: tokens append, tool logs stack, approval replaces the body with a keyboard.

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
  }

  /** Send the initial placeholder and remember its id for later edits. */
  async init(initial = '…') {
    const sent = await this.bot.telegram.sendMessage(this.chatId, initial);
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
      case 'toolEnd': {
        const last = this.toolLog[this.toolLog.length - 1];
        const oneLine = String(evt.output).split('\n').filter(Boolean)[0] || '';
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

  schedule() {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastEdit;
    const wait = this.done ? 0 : Math.max(0, this.debounceMs - elapsed);
    this.timer = setTimeout(() => this.flush(), wait);
    // unref so a hung edit never blocks process exit
    this.timer.unref?.();
  }

  render() {
    const head = this.toolLog.length ? this.toolLog.join('\n') + '\n\n' : '';
    return (head + this.text).slice(0, MAX_MSG);
  }

  async flush() {
    this.timer = null;
    if (!this.dirty || this.messageId == null) return;
    this.dirty = false;
    this.lastEdit = Date.now();
    const body = this.render();
    try {
      await this.bot.telegram.editMessageText(
        this.chatId,
        this.messageId,
        undefined,
        this.done ? toTelegramMarkdown(body) || TRUNC : body,
        this.done ? { parse_mode: 'Markdown' } : {},
      );
    } catch (err) {
      // "message is not modified" fires when the debounce fires twice with the same body
      if (!/not modified/i.test(err.message)) logger.debug({ err: err.message }, 'edit failed');
    }
  }

  /** Send the inline keyboard for a pending dangerous tool. */
  async sendApproval(approvalId, tool, args) {
    const preview = JSON.stringify(args, null, 2).slice(0, 1200);
    return this.bot.telegram.sendMessage(
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
    this.done = true;
    await this.flush();
  }

  async sendFinal(text) {
    // text may exceed one message — split and send the overflow as new messages
    const parts = splitLong(toTelegramMarkdown(text) || TRUNC);
    for (let i = 1; i < parts.length; i++) {
      await this.bot.telegram.sendMessage(this.chatId, parts[i], { parse_mode: 'Markdown' }).catch(() => {});
    }
    if (parts.length > 1) {
      // first part already rendered into the tracked message
      this.text = parts[0];
      this.dirty = true;
      await this.flush();
    }
  }
}
