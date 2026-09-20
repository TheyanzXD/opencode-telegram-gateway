// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-keyboard.js
// browser_keyboard — key presses, with a focus model the snapshot cannot give.
//
// browser_type fills one field and stops there. Real flows need more: Tab
// between fields, Escape out of a modal, ArrowDown through a combobox, Enter on
// a highlighted item, Ctrl+V into an editor that eats synthetic input. This
// tool is that remainder, and it is dangerous for the same reason browser_type
// is — an Enter in a focused submit button posts the form.
//
// The focus list (@fN) exists because "the element that has focus" is not in
// the clickable-element snapshot, and the model cannot type @eN into a
// keyboard tool — keyboard input is not aimed at a locator, it goes to
// whatever the page focused. So the tool can focus first, then press, and
// report what ended up focused.

import { z } from 'zod';
import { logger } from '../../logger.js';
import {
  resolveAdvancedRef,
  setRefList,
  resolvePageAndTarget,
  truncate,
  tidy,
} from './browser-refs.js';

// Playwright accepts these; anything else is a typo we should refuse rather
// than pass to the browser as a literal character.
const KEYS = new Set([
  'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function parseKeys(spec) {
  // "Control+v" → ['Control', 'v']; "Enter" → ['Enter']
  const raw = String(spec).trim();
  if (!raw) return { err: 'keys is required' };
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 4) return { err: 'too many keys in one chord (max 4)' };
  const out = [];
  for (const p of parts) {
    const p1 = p.charAt(0).toUpperCase() + p.slice(1);
    if (KEYS.has(p1)) { out.push(p1); continue; }
    if (MODIFIERS.has(p1)) { out.push(p1); continue; }
    if (p === 'Ctrl') { out.push('Control'); continue; }
    if (p === 'Cmd' || p === 'Super') { out.push('Meta'); continue; }
    if (p === 'Option') { out.push('Alt'); continue; }
    if (p.length === 1) { out.push(p); continue; }
    return { err: `unknown key: ${p}` };
  }
  // a chord of only modifiers presses nothing
  if (out.length && out.every((k) => MODIFIERS.has(k))) {
    return { err: 'a key chord needs at least one non-modifier key' };
  }
  return { keys: out };
}

// ------------------------------------------------------------------ the tool

const keyboardSchema = z.object({
  keys: z.string().min(1).max(40).refine((v) => !parseKeys(v).err, (v) => ({
    message: parseKeys(v).err || 'invalid keys',
  })),
  target: z.string().min(1).optional(),
  count: z.number().int().positive().max(20).optional(),
  delay_ms: z.number().int().positive().max(2000).optional(),
});

/**
 * @param {object} args
 * @param {string} args.keys        key or chord, "+" separated: "Control+v"
 * @param {string} [args.target]    optional @fN ref or selector to focus first
 * @param {number} [args.count]     repeat the press (default 1)
 * @param {number} [args.delay_ms]  delay between repeats (default 120)
 */
export const browserKeyboard = {
  name: 'browser_keyboard',
  description:
    'Press keys or a key chord in the browser page: Tab to move between fields, Escape to close a modal, Enter to submit, arrows to pick from a dropdown, Control+v to paste, Control+a then Delete to clear a field. Optionally focus an element first (an @fN ref from this tool, or a selector). This sends real input to the page and can submit forms — prefer browser_type for filling one field.',
  isDangerous: true, // keystrokes reach whatever the page has focused: Enter can submit
  parameters: {
    type: 'object',
    properties: {
      keys: {
        type: 'string',
        description: 'A key ("Enter", "Tab", "Escape", "ArrowDown") or a chord joined with "+": "Control+v", "Shift+Tab", "Control+a". Single characters are typed literally.',
      },
      target: {
        type: 'string',
        description: 'Optional: an @fN ref from a previous browser_keyboard call, or a Playwright selector, to focus before pressing.',
      },
      count: { type: 'number', description: 'Repeat the press this many times (default 1, max 20)' },
      delay_ms: { type: 'number', description: 'Milliseconds between repeats (default 120)' },
    },
    required: ['keys'],
    additionalProperties: false,
  },
  schema: keyboardSchema,
  async execute({ keys, target, count, delay_ms }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const parsed = parseKeys(keys);
    if (parsed.err) return `⚠️ ${parsed.err}`;

    const n = count ?? 1;
    const delay = delay_ms ?? 120;

    const r = await resolvePageAndTarget(chatId, 'focus', target);
    if (r.err) return `⚠️ ${r.err}`;
    const { page, sel } = r;

    try {
      if (target) {
        const loc = page.locator(sel).first();
        await loc.focus({ timeout: 10_000 });
      }
      for (let i = 0; i < n; i++) {
        if (i) await page.waitForTimeout(Math.min(delay, 500));
        await page.keyboard.press(parsed.keys.join('+'), { delay: 40 });
      }
    } catch (err) {
      return `⚠️ keyboard failed: ${err.message}`;
    }
    await page.waitForTimeout(400);

    // Report what ended up focused — Tab chains and combobox arrows change this,
    // and the model needs to know which field the next keypress will hit.
    const focused = await describeFocus(page).catch(() => null);
    if (focused && focused.length) {
      const labelled = setRefList(chatId, 'focus', focused);
      const lines = labelled.slice(0, 12).map(
        (e) => `${e.tag}${e.name ? ` "${e.name}"` : ''}${e.value ? ` [${e.value}]` : ''} @${e.ref}`
      );
      logger.info({ chatId, keys: parsed.keys.join('+'), n }, 'browser_keyboard');
      return `✅ pressed ${parsed.keys.join('+')}${n > 1 ? ` ×${n}` : ''}${target ? ` after focusing ${target}` : ''}\n\nFocused now:\n${lines.join('\n')}`;
    }
    return `✅ pressed ${parsed.keys.join('+')}${n > 1 ? ` ×${n}` : ''}${target ? ` after focusing ${target}` : ''}`;
  },
};

/**
 * Read the focused element straight from the DOM. Kept here rather than in the
 * snapshot module because a keyboard tool's whole job is to move the focus, so
 * the list it produces is a byproduct of the press, not of a page walk.
 */
async function describeFocus(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return [];
    const tag = (a.tagName || '').toLowerCase();
    const id = a.id || '';
    const name = (
      a.getAttribute('aria-label') || a.getAttribute('placeholder')
      || a.getAttribute('title') || a.innerText || a.textContent || ''
    ).trim().replace(/\s+/g, ' ').slice(0, 60);
    const value = a.value !== undefined && tag !== 'button' ? String(a.value).slice(0, 40) : '';
    const sel = id ? `#${id}` : name ? `${tag}[aria-label="${name.replace(/"/g, '')}"]` : tag;
    return [{ tag, name, value, sel }];
  });
}
