// language: JavaScript (Node 20+ ESM), file: src/agent/tools/browser-screenshot.js
// browser_screenshot — a PNG the model can look at, and ANSI art it can read.
//
// browser_snapshot describes a page as roles and names. Layout does not survive
// that translation: which modal covers which button, whether the chart rendered,
// whether the table has a color-coded status column — all of it is gone. This
// tool adds the missing channel by rasterizing the page.
//
// Two outputs, because the bot has two ways to show an image:
//
//   as:"png"   → a PNG written under the workspace, for a vision tool to open
//   as:"ansi"  → the same frame, block-ANSI colored, returned inline as text —
//                a model without vision can still see the layout, and a chat
//                without image support still renders it
//
// The ANSI path matters more than it looks: the agent loop has no image channel
// back to the model, so inline text is the only way a screenshot reaches it at
// all. It is pure-JS — no sharp, no canvas, no native build step.
//
// Read-only: capturing a frame changes nothing on the site. PNGs land under the
// workspace, which the agent's own write_file tool already owns.

import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { config } from '../../config.js';

const ANSI_PX = 4; // one ANSI block per 4×4 source pixels
const ANSI_W = 100; // 100 blocks ≈ a phone-width Telegram message
const ANSI_H = 50;
const MAX_W = 200; // ANSI column cap
const MAX_PNG_W = 4000; // decode guard — a tab capture can be enormous

const shotSchema = z.object({
  as: z.enum(['png', 'ansi', 'both']).optional(),
  width: z.number().int().positive().max(2000).optional(),
  full_page: z.boolean().optional(),
  clip: z.object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  }).optional(),
  selector: z.string().max(300).optional(),
  max_width: z.number().int().positive().max(MAX_W).optional(),
});

/**
 * @param {object} args
 * @param {'png'|'ansi'|'both'} [args.as]  output (default 'png')
 * @param {number} [args.width]  viewport width for the capture (default 1280)
 * @param {boolean} [args.full_page]  capture the whole scrollable page
 * @param {object} [args.clip]  capture a rectangle, in CSS pixels
 * @param {string} [args.selector]  capture one element instead of the page
 * @param {number} [args.max_width]  cap ANSI columns (default 100)
 */
export const browserScreenshot = {
  name: 'browser_screenshot',
  description:
    'Capture the current page as an image. as:"png" (default) saves a PNG under the workspace and returns its path — open it with a vision tool to see the page. as:"ansi" returns the same frame as colored inline text (no image channel needed, works without vision). Use it when browser_snapshot cannot tell you what the page *looks like*: a modal covering a button, a chart that did not render, a color-coded status column, a CAPTCHA. Capture one element with selector, a rectangle with clip, or the whole scrollable page with full_page:true. Read-only — it never touches the site.',
  isDangerous: false, // a raster capture of what is already on screen
  parameters: {
    type: 'object',
    properties: {
      as: { type: 'string', enum: ['png', 'ansi', 'both'], description: 'png (file), ansi (inline colored text), or both (default "png")' },
      width: { type: 'number', description: 'Viewport width in CSS px for the capture (default 1280)' },
      full_page: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport (default false)' },
      clip: { type: 'object', description: 'Capture this rectangle instead: { x, y, width, height } in CSS pixels' },
      selector: { type: 'string', description: 'Capture this element instead of the whole page (Playwright selector)' },
      max_width: { type: 'number', description: 'Cap ANSI output width in terminal columns (default 100)' },
    },
    required: [],
    additionalProperties: false,
  },
  schema: shotSchema,
  async execute({ as, width, full_page, clip, selector, max_width }, ctx = {}) {
    const chatId = ctx.chatId ?? 0;
    const { getPage, sessionActive } = await import('../../browser/camoufox.js');
    if (!sessionActive(chatId)) {
      return '⚠️ no browser session for this chat — call browser_navigate first';
    }
    const page = await getPage(chatId);
    if (!page || page.isClosed?.()) return '⚠️ the browser page is closed — call browser_navigate first';

    const mode = as || 'png';
    let png = null;
    try {
      const shotOpts = {
        type: 'png',
        fullPage: Boolean(full_page),
        clip: clip && !full_page && !selector ? {
          x: Math.max(0, clip.x),
          y: Math.max(0, clip.y),
          width: Math.max(1, clip.width),
          height: Math.max(1, clip.height),
        } : undefined,
      };
      if (selector) {
        png = await page.locator(selector).first().screenshot(shotOpts);
      } else {
        // a capture wider than the block grid makes the ANSI unreadable; the
        // PNG keeps full resolution either way
        const vp = page.viewportSize();
        const targetW = Math.min(Number(width) || vp?.width || 1280, MAX_W * 2);
        if (vp?.width !== targetW) {
          await page.setViewportSize({ width: targetW, height: vp?.height || 800 });
        }
        png = await page.screenshot(shotOpts);
      }
    } catch (err) {
      return `⚠️ screenshot failed: ${err.message}`;
    }
    if (!png || !png.length) return '⚠️ screenshot produced no image';
    logger.info({ chatId, mode, bytes: png.length }, 'browser_screenshot');

    const parts = [];
    if (mode === 'png' || mode === 'both') {
      const p = savePng(chatId, png);
      parts.push(p.error ? `⚠️ ${p.error}` : `📸 PNG saved: ${p.path} (${png.length} bytes)`);
    }
    if (mode === 'ansi' || mode === 'both') {
      const cols = Math.min(Math.max(Number(max_width) || ANSI_W, 20), MAX_W);
      parts.push(pngToAnsi(png, cols, ANSI_H));
    }
    return parts.join('\n\n');
  },
};

// ------------------------------------------------------------------- png

/**
 * PNG → raw RGBA. Handles only what a Playwright capture produces: 8-bit depth,
 * with or without alpha. A full inflate + unfilter, no dependencies.
 *
 * @param {Buffer} buf
 * @returns {{width: number, height: number, rgba: Buffer}|null}
 */
function decodePng(buf) {
  if (buf.length < 33) return null;
  // signature: the only check that catches "this is not a PNG" cheaply
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || width <= 0 || height <= 0) return null;
  if (width > MAX_PNG_W || height > MAX_PNG_W) return null;

  // colorType → channel count. 6 (RGBA) and 2 (RGB) are what screenshots use;
  // 0 and 4 (gray) are covered so an oddly-encoded capture still decodes.
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const bpp = channels;

  // walk the chunk list and concatenate every IDAT; ancillary chunks are skipped
  const chunks = [];
  let off = 33;
  while (off + 8 <= buf.length) {
    const len = view.getUint32(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len; // length + type + data + crc
  }
  if (!chunks.length) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(chunks));
  } catch {
    return null;
  }

  const stride = width * bpp + 1; // +1: each scanline starts with a filter byte
  if (raw.length < stride * height) return null;

  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride); // the line above, zeroed for the first row
  let cur = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const line = raw.subarray(y * stride, (y + 1) * stride);
    const filter = line[0];
    const data = line.subarray(1);

    for (let x = 0; x < data.length; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;        // left
      const b = prev[x];                             // up
      const c = x >= bpp ? prev[x - bpp] : 0;        // up-left
      const v = data[x];
      switch (filter) {
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[x] = (v + paeth(a, b, c)) & 0xff; break;
        default: cur[x] = v; break; // 0 = none, and an unknown type is treated raw
      }
    }

    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      if (channels === 4) {
        rgba[d] = cur[s];
        rgba[d + 1] = cur[s + 1];
        rgba[d + 2] = cur[s + 2];
        rgba[d + 3] = cur[s + 3];
      } else if (channels === 2) {
        // grayscale + alpha: value maps to all three channels
        rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s];
        rgba[d + 3] = cur[s + 1];
      } else if (channels === 3) {
        rgba[d] = cur[s];
        rgba[d + 1] = cur[s + 1];
        rgba[d + 2] = cur[s + 2];
        rgba[d + 3] = 255;
      } else {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s];
        rgba[d + 3] = 255;
      }
    }

    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return { width, height, rgba };
}

/** PNG's predictor — the standard Paeth, from the spec. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ------------------------------------------------------------------ ansi

/**
 * Downsample to a block grid and emit 24-bit-color ANSI. Half-blocks double the
 * vertical resolution at no width cost — the same trick terminal image viewers use.
 */
function pngToAnsi(png, cols, rows) {
  const img = decodePng(png);
  if (!img) return '⚠️ could not decode the captured PNG (unsupported format)';
  const { width, height, rgba } = img;

  const bw = Math.min(cols, Math.ceil(width / ANSI_PX));
  const bh = Math.min(rows, Math.ceil(height / ANSI_PX));

  // one pass, row-major: average ANSI_PX×ANSI_PX source pixels into a block
  const blocks = [];
  for (let by = 0; by < bh; by++) {
    const row = [];
    for (let bx = 0; bx < bw; bx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const y0 = by * ANSI_PX;
      const y1 = Math.min(height, y0 + ANSI_PX);
      const x0 = bx * ANSI_PX;
      const x1 = Math.min(width, x0 + ANSI_PX);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      }
      if (n) row.push([r / n, g / n, b / n]);
    }
    if (row.length) blocks.push(row);
  }
  if (!blocks.length) return '⚠️ the capture had no drawable area';

  const out = [];
  for (let y = 0; y < blocks.length; y += 2) {
    let line = '';
    const top = blocks[y];
    const bot = blocks[y + 1];
    for (let x = 0; x < top.length; x++) {
      const t = top[x];
      const bo = bot ? bot[x] : null;
      if (bo && colDiff(t, bo) > 24) {
        // upper and lower halves differ → two colors in one cell
        line += `\x1b[38;2;${t[0] | 0};${t[1] | 0};${t[2] | 0}m`
          + `\x1b[48;2;${bo[0] | 0};${bo[1] | 0};${bo[2] | 0}m▀`;
      } else {
        line += `\x1b[38;2;${t[0] | 0};${t[1] | 0};${t[2] | 0}m▀`;
      }
    }
    out.push(line + '\x1b[0m');
  }
  return out.join('\n');
}

function colDiff(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/**
 * PNG saved under the workspace, one per chat, overwritten per call — a browser
 * session is one page, so the latest frame is the only interesting one.
 */
function savePng(chatId, png) {
  try {
    const dir = path.join(config.agent.workspace, 'browser');
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `shot-${chatId}.png`);
    writeFileSync(p, png);
    return { path: p };
  } catch (e) {
    return { error: `could not save the PNG: ${e.message}` };
  }
}
