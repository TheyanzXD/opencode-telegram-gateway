// language: JavaScript (Node 20+ ESM), file: src/agent/tools/media.js
// Image generation and media output.
//
// The spec asks for image generation; the honest design is: call the model
// provider's images/generations endpoint when one is configured, and always
// say clearly when no provider offers it. A generation that fails returns the
// error — never a placeholder image pretending to be a result.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { requestJson } from '../../providers/client.js';
import { getProvider, providerNames } from '../../providers/store.js';

const MAX_STORE = 40;

/** A provider+model pair that serves image generation, if any. */
function imageProvider() {
  const fromEnv = process.env.IMAGE_PROVIDER && process.env.IMAGE_MODEL
    ? { name: process.env.IMAGE_PROVIDER, model: process.env.IMAGE_MODEL }
    : null;
  if (fromEnv && getProvider(fromEnv.name)) return fromEnv;
  for (const name of providerNames()) {
    const p = getProvider(name);
    if (p?.image_model) return { name, model: p.image_model };
  }
  return null;
}

export const mediaTools = [
  {
    name: 'image_generate',
    description: 'Generate an image from a text prompt and send it to the user. Requires an image-capable provider (IMAGE_PROVIDER/IMAGE_MODEL env, or an image_model entry in providers.yaml). Returns the local path on success.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw' },
        size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792', '512x512', '256x256'], description: 'Output size (provider may ignore)' },
        n: { type: 'integer', description: 'How many images (1-4; provider may cap at 1)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async execute({ prompt, size = '1024x1024', n = 1 }, ctx = {}) {
      const prov = imageProvider();
      if (!prov) {
        return 'No image-capable provider is configured. Set IMAGE_PROVIDER and IMAGE_MODEL in .env (e.g. openai / dall-e-3), or add an `image_model` entry to a provider in providers.yaml. I can still describe the image in text.';
      }
      const count = Math.max(1, Math.min(4, n | 0));
      const out = [];
      try {
        const data = await requestJson(prov.name, '/images/generations', {
          model: prov.model,
          prompt: prompt.slice(0, 1800),
          n: count,
          size,
          response_format: 'b64_json',
        }, undefined, ctx.chatId);
        const items = data.data || [];
        if (!items.length) return 'The image provider returned no images.';
        for (const item of items) {
          const target = storePath(ctx.userId ?? ctx.chatId, 'png');
          if (item.b64_json) {
            fs.writeFileSync(target, Buffer.from(item.b64_json, 'base64'));
          } else if (item.url) {
            // Some providers only return a URL; fetch it and keep a local copy.
            const res = await fetch(item.url);
            if (!res.ok) { out.push(`⚠️ provider gave a URL I could not fetch (${res.status})`); continue; }
            fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
          } else {
            out.push('⚠️ provider returned an image with neither b64_json nor url');
            continue;
          }
          out.push(`✅ ${path.relative(config.root, target)}`);
        }
        rotateOld(ctx.userId ?? ctx.chatId);
        return out.join('\n');
      } catch (err) {
        logger.warn({ err: String(err.message).slice(0, 140), provider: prov.name }, 'image generation failed');
        return `⚠️ image generation failed: ${err.message}`;
      }
    },
  },
];

function storePath(userId, ext) {
  const dir = path.resolve(config.root, 'data', 'media', String(userId ?? 0));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
}

/** Keep the media dir from growing without bound. */
function rotateOld(userId) {
  try {
    const dir = path.resolve(config.root, 'data', 'media', String(userId ?? 0));
    const files = fs.readdirSync(dir)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(MAX_STORE)) fs.unlink(path.join(dir, x.f), () => {});
  } catch {}
}
