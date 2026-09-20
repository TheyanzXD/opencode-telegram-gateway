// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-advanced.js
// The advanced browser tool set.
//
// The base tools in browser.js drive the page: navigate, snapshot, click, type,
// read. This set covers everything between and around those steps — the parts
// of a real browsing session the base set cannot express:
//
//   browser_wait      until something actually happens, instead of a fixed sleep
//   browser_scroll    reach below the fold; lazy content is not in the DOM yet
//   browser_keyboard  Tab, Escape, arrows, chords — input the page has focused
//   browser_form      a whole form read in one call, or filled in one call
//   browser_extract   tables, lists, links, embedded JSON — structure, not prose
//   browser_console   the page's errors, and a JS eval for live DOM state
//   browser_screenshot what the page looks like, as PNG and as inline ANSI
//   browser_tabs      more than one page at once, and iframes snapshot can't see
//
// Refs. The base set's @eN is a flat list of clickable nodes. These tools need
// references to things that are not clickable — scroll landmarks, focus targets,
// form fields — so each family carries its own prefix, all resolved through the
// same per-chat map in browser-refs.js:
//
//   @fN  focus/form fields    from browser_keyboard and browser_form
//   @sN  scroll landmarks     from browser_scroll
//   @oN  select options       from browser_form's option lists
//   @wN  window/tab handles   from browser_tabs
//
// Every tool returns a string, and a failure is a string starting with ⚠️ — the
// registry never sees a throw. Read-only tools are not dangerous; the ones that
// send input to a real remote site are, and go through the approval gate.
//
// camoufox.js owns the session; these tools only borrow its page. Nothing here
// modifies it.

import { browserWait } from './browser-wait.js';
import { browserScroll } from './browser-scroll.js';
import { browserKeyboard } from './browser-keyboard.js';
import { browserForm } from './browser-forms.js';
import { browserExtract } from './browser-extract.js';
import { browserConsole } from './browser-console.js';
import { browserScreenshot } from './browser-screenshot.js';
import { browserTabs } from './browser-tabs.js';

export const browserAdvancedTools = [
  browserWait,
  browserScroll,
  browserKeyboard,
  browserForm,
  browserExtract,
  browserConsole,
  browserScreenshot,
  browserTabs,
];

export { browserWait, browserScroll, browserKeyboard, browserForm,
  browserExtract, browserConsole, browserScreenshot, browserTabs };
export { clearAdvancedRefs } from './browser-refs.js';
