// config.mjs -- env loading and all runtime constants
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
export const MODEL            = CFG.DEFAULT_MODEL     || 'claude-opus-5';
export const BASE             = CFG.OPENAI_BASE_URL   || 'https://api.openai.com/v1';
export const AUTO             = (CFG.AUTO_APPROVE     || 'false').toLowerCase() === 'true';
export const NAME             = CFG.AGENT_NAME        || 'Athena';
export const BRAVE_KEY        = CFG.BRAVE_API_KEY     || process.env.BRAVE_API_KEY     || '';
export const ANTHROPIC_KEY    = CFG.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
export const ANTHROPIC_BASE   = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';

// Mutable active model -- changed by /model command and UI selector
export const state = { activeModel: MODEL };

export const CURATED_MODELS = [
  { label: 'Claude', models: [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ]},
];

// ---- Persist the user's model choice across restarts ----
const MODEL_CHOICE_PATH = join(PATHS.memDir, 'model_choice.json');

// 'local-model' is what getLocalModelName() returns before any weights are loaded. It is
// a placeholder, never a real model, and persisting it made it the head of every failover
// chain -- so every turn began by dialling a local server that does not exist, failed
// twice, and then answered from whatever local model was next. Cloud was never reached.
export const PLACEHOLDER_MODEL = 'local-model';

export function isKnownModel(m) {
  if (typeof m !== 'string') return false;
  if (m === PLACEHOLDER_MODEL) return false;
  if (m.startsWith('local-')) {
    const group = CURATED_MODELS.find(g => g.label === 'Local');
    // Before registration has run there is nothing to check against, so allow it;
    // once a Local group exists it is the authority.
    return group ? group.models.includes(m) : true;
  }
  return CURATED_MODELS.some(g => (g.models || []).includes(m));
}

// Restore last explicit choice (ignored if the model no longer exists)
try {
  const saved = JSON.parse(readFileSync(MODEL_CHOICE_PATH, 'utf8'));
  if (isKnownModel(saved.model)) state.activeModel = saved.model;
} catch {}

// Call from /model command and UI selector -- NOT from auto-failover
export function saveModelChoice(model) {
  if (!isKnownModel(model)) return;
  try {
    writeFileSync(MODEL_CHOICE_PATH, JSON.stringify({ model, at: new Date().toISOString() }));
  } catch {}
}

export const MEM_CHAR_LIMIT = 8000;

// Exported so athena.mjs can decide how to handle missing keys
export const _hasKey = API_KEY || ANTHROPIC_KEY;

export const LOCAL_LLM_PORT = Number(CFG.LOCAL_LLM_PORT) || 17860;

// Module 2 (browser) -- port the HTTP polling relay listens on. Same
// override convention as LOCAL_LLM_PORT: env var if set, else a fixed
// default. The Manifest V3 extension is hardcoded to poll this port on
// localhost, so changing it requires updating the extension too.
export const BROWSER_RELAY_PORT = Number(CFG.BROWSER_RELAY_PORT) || 17861;

// Which local model to load by default. A substring is enough ("qwen", "3b", "llama").
// Empty = use the smallest available, on the theory that the light one is the everyday
// choice and the heavy one is deliberate.
export const LOCAL_MODEL_PREF = (CFG.LOCAL_MODEL || '').trim();

// net_triage.mjs -- set NET_TRIAGE=off to stop Athena repairing the network on her own
// when the cloud model is unreachable. On by default.
export const NET_TRIAGE = !/^(off|false|0|no)$/i.test(String(CFG.NET_TRIAGE || '').trim());

// api.mjs -- how long a cloud model may go silent (no response headers, or no new stream
// data) before the request is abandoned and the next model is tried. Local models get 5x,
// since a CPU-bound llama.cpp can take minutes to process a long prompt.
export const API_STALL_MS = Math.max(15000, Number(CFG.API_STALL_MS) || 120000);

// modules/google.mjs (Module 3, phase 2) -- Gmail + Calendar via one OAuth app/refresh token.
// Minted once with google_oauth_setup.mjs (repo root); scopes are read + compose (never send)
// for Gmail, read + create/update for Calendar -- see docs/MODULE3_PLAN.md Section 1. All three
// empty just means the module reports itself unhealthy, same as any other missing-config case.
export const GOOGLE_CLIENT_ID     = (CFG.GOOGLE_CLIENT_ID     || '').trim();
export const GOOGLE_CLIENT_SECRET = (CFG.GOOGLE_CLIENT_SECRET || '').trim();
export const GOOGLE_REFRESH_TOKEN = (CFG.GOOGLE_REFRESH_TOKEN || '').trim();

// Off by default. Every boot used to call api.ipify.org and put the resulting public IP
// into the system prompt -- so it was sent to the model provider on every turn and
// written into session and audit files. For a drive-resident agent that advertises
// offline-first operation, that should be a deliberate choice.
export const PUBLIC_IP_LOOKUP = (CFG.PUBLIC_IP_LOOKUP || 'false').toLowerCase() === 'true';

// The proactive watcher was fully written and never started. On by default now (that was
// clearly the intent), but it polls the machine on timers, so it needs an off switch.
export const WATCHER_ENABLED = (CFG.WATCHER || 'true').toLowerCase() === 'true';

// AUTO_APPROVE skips the approval gate for everything reversible. A short list of
// irreversible operations still stops and asks even then -- see IRREVERSIBLE in tools.mjs.
// Set AUTO_APPROVE_ALL=true to remove that last stop as well.
export const AUTO_ALL = (CFG.AUTO_APPROVE_ALL || 'false').toLowerCase() === 'true';

// GPU layers to offload in llama-server (0 = pure CPU, safe everywhere).
// Set per-drive in .env: SSD machine with a GPU can afford 20+, HDD/portable stays 0.
// null means "let llama.cpp fit to whatever the device has free" -- the right default on
// an integrated GPU, where a pinned layer count is what blows the KV cache allocation.
// A number pins that many layers; 0 forces CPU.
export const LOCAL_GPU_LAYERS = (() => {
  const raw = String(CFG.LOCAL_GPU_LAYERS ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
})();

// Memory-map model weights instead of loading fully into RAM.
// Default OFF (--no-mmap) for FAT32/USB safety; set LOCAL_NO_MMAP=false on NTFS SSDs.
export const LOCAL_NO_MMAP = (CFG.LOCAL_NO_MMAP || 'true').toLowerCase() === 'true';

export function isOfflineMode() { return !API_KEY && !ANTHROPIC_KEY; }

// True whenever the model actually about to answer is a local one -- whether because
// there's no cloud key at all (isOfflineMode()) or because the user explicitly chose a
// local-* model while a cloud key is still configured. Use this (OR'd with isOfflineMode())
// anywhere the choice is "condensed local-tuned prompt vs full cloud prompt" -- see
// offlineSystemPrompt() in personality.mjs.
export function isLocalModelActive() { return typeof state.activeModel === 'string' && state.activeModel.startsWith('local-'); }

export function registerLocalModel(modelId) {
  registerLocalModels([modelId]);
}

// Register every local model so the picker and /model can see all of them, not just
// whichever one happened to load.
// Registration is the moment the Local group becomes the authority on which local ids
// exist. Anything the boot-time restore let through on the bootstrap branch has to be
// re-checked here, or a stale id survives for the whole session.
function revalidateActiveModel() {
  if (isKnownModel(state.activeModel)) return;
  const fallback = CURATED_MODELS.flatMap(g => g.models || []).find(m => !m.startsWith('local-')) || MODEL;
  console.warn('[config] active model "' + state.activeModel + '" is not a real model -- falling back to ' + fallback);
  state.activeModel = fallback;
  try { if (existsSync(MODEL_CHOICE_PATH)) unlinkSync(MODEL_CHOICE_PATH); } catch {}
}

export function registerLocalModels(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  const existing = CURATED_MODELS.findIndex(g => g.label === 'Local');
  if (existing >= 0) CURATED_MODELS.splice(existing, 1);
  if (list.length) CURATED_MODELS.unshift({ label: 'Local', models: list });
  revalidateActiveModel();
}
