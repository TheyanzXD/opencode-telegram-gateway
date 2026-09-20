// language: JavaScript (Node 20+ ESM), file: src/agent/tools/voice.js
// Text-to-speech — the oh-my-pi tts tool, minus the Rust audio crates.
//
// omp routes through pi-voice (Opus codecs, WebRTC). We do not need that: the
// bot is Telegram, and Telegram plays an .ogg/.mp3 natively as a voice note.
// The useful part is the provider surface: xAI Grok Voice, DeepInfra Kokoro,
// or any OpenAI-compatible /audio/speech endpoint.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { requestJson } from '../../providers/client.js';
import { getProvider, providerNames } from '../../providers/store.js';

const XAI_VOICES = ['ara', 'eve', 'leo', 'rex', 'sal'];
const MAX_CHARS = 15000;

export const voiceTools = [
  {
    name: 'tts',
    description: 'Speak text aloud as a voice note. Voices: eve (default), ara, leo, rex, sal (xAI), or any voice the configured provider accepts. Requires a TTS provider — set TTS_PROVIDER and TTS_MODEL, or an audio_model entry in providers.yaml.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say' },
        voice: { type: 'string', description: 'Voice id (default: eve)' },
        format: { type: 'string', enum: ['mp3', 'wav', 'ogg'], description: 'Container (default mp3)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text, voice = 'eve', format = 'mp3' }, ctx = {}) {
      if (!text.trim()) return '⚠️ nothing to say';
      if (text.length > MAX_CHARS) return `⚠️ ${text.length} chars — over the ${MAX_CHARS} cap. Split it.`;

      const prov = ttsProvider();
      if (!prov) {
        return 'No TTS provider configured. Set TTS_PROVIDER and TTS_MODEL in .env (e.g. TTS_PROVIDER=xai, TTS_MODEL=grok-2-voice), or add an `audio_model` entry to a provider in providers.yaml.';
      }

      try {
        const data = await requestJson(prov.name, '/audio/speech', {
          model: prov.model,
          input: text,
          voice,
          response_format: format,
        }, undefined, ctx.chatId);

        // Providers either hand back b64_json, or a URL to fetch.
        let buf;
        if (data.audio) buf = Buffer.from(data.audio, 'base64');
        else if (data.b64_json) buf = Buffer.from(data.b64_json, 'base64');
        else if (data.data) buf = Buffer.from(data.data, 'base64');
        else if (data.url) {
          const res = await fetch(data.url);
          if (!res.ok) return `⚠️ provider gave a URL I could not fetch (${res.status})`;
          buf = Buffer.from(await res.arrayBuffer());
        }
        if (!buf) return '⚠️ the TTS provider returned neither audio nor a URL.';

        const dir = path.resolve(config.root, 'data', 'media', String(ctx.userId ?? ctx.chatId ?? 0));
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, `tts-${Date.now()}.${format}`);
        fs.writeFileSync(target, buf);
        return `✅ ${path.relative(config.root, target)}`;
      } catch (err) {
        logger.warn({ err: String(err.message).slice(0, 140), provider: prov.name }, 'tts failed');
        return `⚠️ tts failed: ${err.message}`;
      }
    },
  },
];

function ttsProvider() {
  const fromEnv = process.env.TTS_PROVIDER && process.env.TTS_MODEL
    ? { name: process.env.TTS_PROVIDER, model: process.env.TTS_MODEL }
    : null;
  if (fromEnv && getProvider(fromEnv.name)) return fromEnv;
  for (const name of providerNames()) {
    const p = getProvider(name);
    if (p?.audio_model) return { name, model: p.audio_model };
  }
  return null;
}


