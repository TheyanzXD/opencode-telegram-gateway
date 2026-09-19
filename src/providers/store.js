import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

const PROVIDERS_FILE = path.join(config.root, 'providers.yaml');

const AuthMode = z.enum(['header', 'xheader', 'query', 'body', 'none']);

const ModelEntry = z.object({
  context: z.number().int().positive().optional(),
  vision: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const Provider = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  auth_mode: AuthMode.default('header'),
  key_env: z.string().optional(),
  api_key: z.string().optional(),
  models: z.record(z.string(), ModelEntry).default({}),
});

const ProvidersFile = z.object({
  providers: z.array(Provider).min(1, 'providers.yaml must have at least one provider'),
});

let cache = null;

export function loadProviders(fileOverride) {
  if (cache && !fileOverride) return cache;
  const candidates = [
    fileOverride,
    PROVIDERS_FILE,
    path.join(config.root, 'providers.yaml.example'),
  ].filter(Boolean);
  let file = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      file = p;
      break;
    }
  }
  if (!file) {
    throw new Error(`No providers.yaml found. Run \`npm run setup\`.`);
  }
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  const parsed = ProvidersFile.parse(raw);
  // Resolve keys
  for (const p of parsed.providers) {
    if (p.auth_mode === 'none') {
      p.api_key = '';
    } else if (p.key_env) {
      p.api_key = process.env[p.key_env] || '';
    }
    if (p.auth_mode !== 'none' && !p.api_key) {
      logger.warn({ provider: p.name, key_env: p.key_env }, 'provider has no key resolved from env');
    }
  }
  if (!fileOverride) cache = parsed.providers;
  return parsed.providers;
}

export function getProvider(name) {
  return loadProviders().find((p) => p.name === name) || null;
}

export function getModel(providerName, modelId) {
  const p = getProvider(providerName);
  if (!p) return null;
  return p.models[modelId] || null;
}

export function providerNames() {
  return loadProviders().map((p) => p.name);
}

export function modelList(providerName) {
  const p = getProvider(providerName);
  return p ? Object.entries(p.models).map(([id, meta]) => ({ id, ...meta })) : [];
}

export function allModels() {
  return loadProviders().flatMap((p) =>
    Object.entries(p.models).map(([id, meta]) => ({
      provider: p.name,
      id,
      ...meta,
    }))
  );
}

export function reloadProviders() {
  cache = null;
  return loadProviders();
}

export function saveProviders(providers) {
  const parsed = ProvidersFile.parse({ providers });
  fs.writeFileSync(PROVIDERS_FILE, YAML.stringify(parsed));
  cache = null;
}

// Adds a model to a provider in providers.yaml (admins only). Existing
// models are untouched; metadata defaults to the conservative case.
export function addModel(providerName, modelId, meta = {}) {
  const providers = loadProviders();
  const p = providers.find((x) => x.name === providerName);
  if (!p) throw new Error(`Unknown provider: ${providerName}`);
  if (p.models[modelId]) throw new Error(`${providerName}/${modelId} already exists`);
  p.models[modelId] = {
    context: Number(meta.context) > 0 ? Number(meta.context) : undefined,
    vision: meta.vision === true || meta.vision === 'true' ? true : undefined,
  };
  Object.keys(p.models[modelId]).forEach((k) => p.models[modelId][k] === undefined && delete p.models[modelId][k]);
  saveProviders(providers);
  return true;
}
