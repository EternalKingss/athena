// config.mjs — env loading and all runtime constants
import { readFileSync, existsSync } from 'node:fs';
import { PATHS } from './paths.mjs';

function loadEnv(path) {
  const cfg = {};
  if (!existsSync(path)) return cfg;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return cfg;
}

const CFG                     = loadEnv(PATHS.env);
export const API_KEY          = CFG.OPENAI_API_KEY    || process.env.OPENAI_API_KEY    || '';
export const MODEL            = CFG.OPENAI_MODEL      || 'gpt-4o';
export const BASE             = CFG.OPENAI_BASE_URL   || 'https://api.openai.com/v1';
export const AUTO             = (CFG.AUTO_APPROVE     || 'false').toLowerCase() === 'true';
export const NAME             = CFG.AGENT_NAME        || 'Athena';
export const BRAVE_KEY        = CFG.BRAVE_API_KEY     || process.env.BRAVE_API_KEY     || '';
export const NVIDIA_KEY       = CFG.NVIDIA_API_KEY    || process.env.NVIDIA_API_KEY    || '';
export const ANTHROPIC_KEY    = CFG.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
export const NVIDIA_BASE      = 'https://integrate.api.nvidia.com/v1';
export const ANTHROPIC_BASE   = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';

// Mutable active model — changed by /model command and UI selector
export const state = { activeModel: MODEL };

export const CURATED_MODELS = [
  { label: 'OpenAI', models: [
    'gpt-5.5',
    'gpt-5.4-mini',
    'gpt-4o',
    'gpt-4o-mini',
  ]},
  { label: 'Claude', models: [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]},
  { label: 'NVIDIA', models: [
    'nvidia/nemotron-3-super-120b-a12b',
    'deepseek-ai/deepseek-v4-pro',
    'meta/llama-3.3-70b-instruct',
    'qwen/qwen3-235b-a22b',
    'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  ]},
];

export const MEM_CHAR_LIMIT = 2200;

// Warn at startup if no provider has a key configured
const _hasKey = API_KEY || ANTHROPIC_KEY || NVIDIA_KEY;
if (!_hasKey) {
  console.warn('\n[athena] WARNING: No API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or NVIDIA_API_KEY in config/.env\n');
}
