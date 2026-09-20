// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-forms.js
// browser_form — read a whole form in one shot, and fill it in one shot.
//
// browser_type fills one field per call. A login or a checkout is six fields;
// six round trips to the model costs six turns of latency and six chances for
// a stale ref, and the model never sees the *shape* of the form — which fields
// are required, which are checkboxes, which select has which options — until
// it has already filled half of them wrong.
//
// So this tool does two things:
//
//   browser_form({ read: true })      → the form's fields as @fN refs, with
//                                        types, required flags, and option lists
//   browser_form({ values: {...} })   → fill every named field in one call
//
// Field names come from name/id/placeholder/aria-label, normalized. The fill is
// one atomic locator pass: field values are validated against what the form
// actually contains before anything is typed, so a mismatch reports itself
// instead of leaving a half-filled form behind for the model to debug.
//
// Dangerous, like browser_type: it types into a real remote form. It does not
// submit by itself — that stays on browser_click / browser_keyboard, behind its
// own approval.

import { z } from 'zod';
import { logger } from '../../logger.js';
import { setRefList, truncate, tidy } from './browser-refs.js';

const MAX_FIELDS = 40;
const MAX_VALUE = 4000;

// ------------------------------------------------------------------- read

/**
 * Walk a form (or the whole document when the page has one) and return one
 * entry per input. Runs inside the page, so it sees what the user would see —
 * including fields JS added after load.
 */
async function readForm(page, selector) {
  return page.evaluate(
    (sel) => {
      const root = sel ? document.querySelector(sel) : null;
      const scope = root || document.body;
      if (!scope) return { error: 'scope element not found' };

      // A <form> is the common case; a div-based form is the common headache.
      // Scope to the form when asked, otherwise take every field in the scope.
      const fields = [...scope.querySelectorAll('input,textarea,select')];
      if (!fields.length) return { error: 'no form fields found on this page' };

      const out = [];
      const seen = new Set();
      for (const el of fields) {
        const tag = el.tagName.toLowerCase();
        const type = (el.type || tag).toLowerCase();
        // submit/image buttons are not fillable; file inputs cannot be typed into
        if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') continue;
        if (type === 'file') {
          out.push({
            key: nameOf(el), tag, type, label: labelOf(el),
            required: el.required || el.getAttribute('aria-required') === 'true',
            disabled: el.disabled, readonly: el.readOnly,
            sel: selectorOf(el),
            note: 'file input — browser_form cannot upload files; use browser_click on it and ask the user',
          });
          continue;
        }
        if (seen.has(selectorOf(el))) continue;
        seen.add(selectorOf(el));
        const entry = {
          key: nameOf(el),
          tag,
          type,
          label: labelOf(el),
          required: el.required || el.getAttribute('aria-required') === 'true',
          disabled: el.disabled,
          readonly: el.readOnly,
          value: el.value ?? '',
          placeholder: el.getAttribute('placeholder') || '',
          sel: selectorOf(el),
        };
        if (tag === 'select') {
          entry.options = [...el.options].map((o) => ({
            value: o.value,
            label: (o.text || o.value || '').trim().slice(0, 50),
            selected: o.selected,
          }));
        }
        if (type === 'checkbox' || type === 'radio') {
          entry.checked = el.checked;
        }
        out.push(entry);
      }
      return { fields: out.slice(0, 40) };

      // --- helpers (in-page, so no closures over Node objects) ---
      function nameOf(e) {
        return (e.name || e.id || e.getAttribute('aria-label')
          || e.getAttribute('placeholder') || e.getAttribute('data-testid') || '').trim();
      }
      function selectorOf(e) {
        if (e.id) return `#${e.id}`;
        if (e.name) return `${e.tagName.toLowerCase()}[name="${e.name}"]`;
        const al = e.getAttribute('aria-label');
        if (al) return `${e.tagName.toLowerCase()}[aria-label="${al}"]`;
        return null;
      }
      function labelFor(id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        return l ? (l.innerText || l.textContent || '').trim() : '';
      }
      function labelOf(e) {
        if (e.id && labelFor(e.id)) return labelFor(e.id);
        const wrap = e.closest('label');
        if (wrap) return (wrap.innerText || wrap.textContent || '').trim();
        const al = e.getAttribute('aria-label');
        if (al) return al.trim();
        const cap = e.getAttribute('aria-labelledby');
        if (cap) return (document.getElementById(cap)?.textContent || '').trim();
        const ph = e.getAttribute('placeholder');
        return ph ? ph.trim() : '';
      }
    },
    selector || null
  );
}

// ------------------------------------------------------------------ fill

/**
 * Fill by matching the field key the model supplied against the field keys the
 * page actually has. Returns a per-field report — the model needs to see which
 * of its values landed and which did not match anything.
 */
async function fillForm(page, selector, values) {
  const fields = await readForm(page, selector);
  if (fields.error) return fields;

  const report = [];
  const fillable = fields.fields.filter((f) => !f.disabled && !f.readonly && f.sel);
  const byKey = new Map();
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
  for (const f of fillable) {
    if (!f.key) continue;
    const keys = new Set([norm(f.key)]);
    if (f.label) keys.add(norm(f.label));
    if (f.placeholder) keys.add(norm(f.placeholder));
    for (const k of keys) {
      if (!byKey.has(k)) byKey.set(k, f);
    }
  }

  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = norm(rawKey);
    const field = byKey.get(key);
    if (!field) {
      report.push(`⚠️ no field matches "${rawKey}"`);
      continue;
    }
    const loc = page.locator(field.sel).first();
    try {
      if (field.type === 'checkbox') {
        const want = Boolean(rawValue);
        const have = await loc.isChecked({ timeout: 4000 }).catch(() => field.checked);
        if (want !== have) await loc.setChecked(want, { timeout: 8000 });
        report.push(`✅ ${rawKey}: ${want ? 'checked' : 'unchecked'}`);
      } else if (field.type === 'radio') {
        await loc.setChecked(true, { timeout: 8000 });
        report.push(`✅ ${rawKey}: selected`);
      } else if (field.tag === 'select') {
        // match by visible label first, then by value — the model sees labels
        const opt = (field.options || []).find((o) => norm(o.label) === key) // no-op placeholder
          || (field.options || []).find(
            (o) => norm(o.label) === norm(String(rawValue)) || norm(o.value) === norm(String(rawValue))
          );
        const val = opt ? opt.value : String(rawValue);
        await loc.selectOption(val, { timeout: 8000 });
        report.push(`✅ ${rawKey}: selected "${String(rawValue).slice(0, 40)}"`);
      } else {
        const text = String(rawValue ?? '').slice(0, MAX_VALUE);
        await loc.fill(text, { timeout: 8000 });
        report.push(`✅ ${rawKey}: set to ${text.length} char(s)`);
      }
    } catch (err) {
      report.push(`⚠️ ${rawKey}: fill failed — ${err.message}`);
    }
  }

  // flag the required fields the model did not supply — the form will reject it
  const supplied = new Set(Object.keys(values).map(norm));
  const missing = fillable.filter(
    (f) => f.required && f.type !== 'checkbox' && f.type !== 'radio' && !supplied.has(norm(f.key))
  );
  const summary = { filled: report.length, report };
  if (missing.length) summary.missingRequired = missing.map((f) => f.key || f.label);
  return summary;
}

// ------------------------------------------------------------------ the tool

const formSchema = z.object({
  selector: z.string().min(1).max(300).optional(),
  read: z.boolean().optional(),
  values: z.record(z.string(), z.string().or(z.boolean()).or(z.number())).optional(),
});

/**
 * @param {object} args
 * @param {string} [args.selector]  scope to one form/container (default: whole page)
 * @param {boolean} [args.read]     return the field list instead of filling
 * @param {object}  [args.values]   { fieldKey: value } — checkbox/radio take booleans
 */
export const browserForm = {
  name: 'browser_form',
  description:
    'Read or fill an entire form in one call. With read:true, lists every field as @fN refs — label, type, whether it is required, current value, and a select\'s options — so the whole form is visible before anything is typed. With values:{...}, fills every named field at once (keys match the field name/id/label/placeholder, case- and separator-insensitive; checkboxes and radios take true/false; selects take the visible option label or its value). Does not submit — use browser_click or browser_keyboard for that.',
  isDangerous: true, // it types into a real remote form, possibly with credentials
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'Optional Playwright selector scoping to one form or container. Default: the whole page (use it when the page has two forms).',
      },
      read: { type: 'boolean', description: 'Return the field list instead of filling (default false)' },
      values: {
        type: 'object',
        description: 'Map of field key → value to fill. Keys match name/id/aria-label/placeholder. Booleans for checkbox/radio, label or value for select.',
        additionalProperties: { type: ['string', 'boolean', 'number'] },
      },
    },
    required: [],
    additionalProperties: false,
  },
  schema: formSchema,
  async execute({ selector, read, values }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await import('../../browser/camoufox.js');
    if (!sessionActive(chatId)) {
      return '⚠️ no browser session for this chat — call browser_navigate first';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    if (read || !values) {
      logger.info({ chatId, read: true }, 'browser_form read');
      const r = await readForm(page, selector).catch((e) => ({ error: e.message }));
      if (r.error) return `⚠️ ${r.error}`;
      const labelled = setRefList(chatId, 'focus', r.fields.map((f) => ({ sel: f.sel })));
      const lines = r.fields.map((f, i) => {
        const flags = [
          f.required ? 'required' : '',
          f.disabled ? 'disabled' : '',
          f.readonly ? 'readonly' : '',
          f.type === 'file' ? 'file' : '',
        ].filter(Boolean).join(' ');
        const bits = [`@f${i}`, f.key || f.label || '(unnamed)', f.type];
        if (f.value && f.type !== 'file') bits.push(`current="${String(f.value).slice(0, 30)}"`);
        if (f.options) bits.push(`options: ${f.options.map((o) => `${o.label}${o.selected ? '*' : ''}`).slice(0, 8).join(' | ')}`);
        if (f.type === 'checkbox' || f.type === 'radio') bits.push(f.checked ? 'checked' : 'unchecked');
        return `${bits.join(' — ')}${flags ? ` [${flags}]` : ''}${f.note ? `\n    ${f.note}` : ''}`;
      });
      return `✅ ${r.fields.length} field(s):\n${truncate(lines.join('\n'), 6000)}`;
    }

    if (!Object.keys(values).length) return '⚠️ values is empty — nothing to fill';
    logger.info({ chatId, n: Object.keys(values).length }, 'browser_form fill');
    const r = await fillForm(page, selector, values).catch((e) => ({ error: e.message }));
    if (r.error) return `⚠️ ${r.error}`;
    const out = tidy(r.report.join('\n'));
    const tail = r.missingRequired?.length
      ? `\n\n⚠️ required field(s) not supplied: ${r.missingRequired.join(', ')}`
      : '';
    return `${out}${tail}`;
  },
};
