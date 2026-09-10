// local_llm.mjs -- L3 optional local LLM lifecycle manager (llama-server subprocess)
// LLM readiness is optional state, never required state.
// Non-blocking: caller fires startLocalLLM() and continues immediately.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import { PATHS } from './paths.mjs';
import { LOCAL_LLM_PORT, LOCAL_GPU_LAYERS, LOCAL_NO_MMAP, LOCAL_MODEL_PREF } from './config.mjs';

let _proc         = null;
let _localModelId = null;

// llama-server defaults to allow-all CORS with no key. It binds loopback, but that still
// leaves any page in the browser able to drive it. One generated key per run closes it.
const _apiKey = randomBytes(24).toString('hex');
export function localApiKey() { return _apiKey; }
// api.mjs reads this without importing local_llm, which would create a cycle
// (local_llm -> config -> ... and api -> config).
globalThis.__athenaLocalKey = _apiKey;

// ---- Scan runtime/models/ for every .gguf ----
export function detectLocalModels() {
  if (!existsSync(PATHS.modelsDir)) return [];
  try {
    return readdirSync(PATHS.modelsDir)
      .filter(f => f.toLowerCase().endsWith('.gguf'))
      .map(f => {
        const p = join(PATHS.modelsDir, f);
        let sizeMB = 0;
        try { sizeMB = Math.round(statSync(p).size / (1024 * 1024)); } catch {}
        return { file: f, path: p, id: modelIdFromPath(p), sizeMB };
      })
      .sort((a, b) => a.sizeMB - b.sizeMB);   // smallest first
  } catch { return []; }
}

// The one to load unless told otherwise. LOCAL_MODEL in .env wins (substring match, so
// "qwen" is enough); otherwise the smallest, because the light model is the right default
// for quick things and the heavy one is a deliberate choice.
export function preferredLocalModel() {
  const all = detectLocalModels();
  if (!all.length) return null;
  const want = String(LOCAL_MODEL_PREF || '').trim().toLowerCase();
  if (want) {
    const hit = all.find(m => m.id.toLowerCase().includes(want) || m.file.toLowerCase().includes(want));
    if (hit) return hit;
  }
  return all[0];
}

// Back-compat: callers that just want "a model path".
export function detectLocalModel() {
  const m = preferredLocalModel();
  return m ? m.path : null;
}

// ---- Derive canonical local model ID from filename ----
export function getLocalModelName() { return _localModelId || 'local-model'; }

function modelIdFromPath(p) {
  return 'local-' + basename(p).replace(/\.gguf$/i, '').toLowerCase().replace(/[\s_.]+/g, '-');
}

// ---- Poll /health until ready or timeout ----
function waitForHealth(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url   = 'http://127.0.0.1:' + port + '/health';
    const start = Date.now();
    const poll  = async () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('llama-server did not become ready within ' + (timeoutMs / 1000) + 's'));
      }
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return resolve();
      } catch {}
      setTimeout(poll, 1000);
    };
    poll();
  });
}

// ---- Check if a llama-server is already running on the port ----
export async function isLocalLLMRunning() {
  try {
    const r = await fetch('http://127.0.0.1:' + LOCAL_LLM_PORT + '/health', { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

// ---- Start llama-server subprocess (non-blocking -- caller does not await) ----
// Returns a Promise that resolves when /health responds.
// NEVER rejects -- all errors are emitted as system messages.
export async function startLocalLLM(port, emit, wanted) {
  // `wanted` may be a model id, a filename fragment, or a full path.
  let chosen = null;
  if (wanted) {
    const w = String(wanted).toLowerCase();
    chosen = detectLocalModels().find(m =>
      m.path.toLowerCase() === w || m.id.toLowerCase() === w ||
      m.id.toLowerCase().includes(w) || m.file.toLowerCase().includes(w)) || null;
    if (!chosen) {
      emit({ type: 'system', text: 'No local model matching "' + wanted + '" -- have: ' + detectLocalModels().map(m => m.id).join(', ') });
      return;
    }
  } else {
    chosen = preferredLocalModel();
  }
  if (!chosen) {
    emit({ type: 'system', text: 'No .gguf model found in runtime/models/ -- local LLM unavailable' });
    return;
  }
  const modelPath = chosen.path;

  // One llama-server serves one model. If a different one is loaded, replace it.
  if (await isLocalLLMRunning()) {
    if (_localModelId === chosen.id) {
      emit({ type: 'system', text: 'Local LLM already running (' + chosen.id + ') -- reusing' });
      return;
    }
    emit({ type: 'system', text: 'Switching local model: ' + (_localModelId || '?') + ' -> ' + chosen.id });
    await stopLocalLLM();
    await new Promise(r => setTimeout(r, 1200));
  }

  _localModelId = chosen.id;

  if (!existsSync(PATHS.llamaServer)) {
    emit({ type: 'system', text: 'llama-server binary not found at ' + PATHS.llamaServer + ' -- run runtime/get-offline.sh' });
    return;
  }

  const threads = Math.max(1, cpus().length - 1);

  // LOCAL_GPU_LAYERS: 0 = force CPU, a small number = pin that many, anything >= 90 or
  // unset = let llama.cpp fit to whatever the device actually has free. Pinning 99 on an
  // integrated GPU is how the KV cache allocation fails.
  const gpuPref = (LOCAL_GPU_LAYERS === null || LOCAL_GPU_LAYERS >= 90) ? null : LOCAL_GPU_LAYERS;

  // Progressively cheaper configurations. First that reaches /health wins.
  const ladder = [
    { ctx: 8192, gpu: gpuPref, label: gpuPref === null ? 'auto GPU fit, 8k ctx' : gpuPref + ' GPU layers, 8k ctx' },
    { ctx: 8192, gpu: 0,       label: 'CPU only, 8k ctx' },
    { ctx: 4096, gpu: 0,       label: 'CPU only, 4k ctx' },
  ];

  const buildArgs = cfg => {
    const a = [
      '--model',    modelPath,
      '--port',     String(port),
      '--host',     '127.0.0.1',
      // --jinja applies the model's own chat template from the GGUF and enables native
      // OpenAI-style tool_calls. Without it the local model can talk but cannot call a
      // tool, which makes L3 useless as an agent fallback.
      '--jinja',
      '--api-key',  _apiKey,
      '--ctx-size', String(cfg.ctx),
      '--n-predict', '2048',
      '--parallel',  '1',
      '--threads',  String(threads),
    ];
    if (LOCAL_NO_MMAP) a.push('--no-mmap'); // needed on FAT32 USB drives; off on NTFS SSDs
    if (cfg.gpu !== null && cfg.gpu !== undefined) a.push('--n-gpu-layers', String(cfg.gpu));
    return a;
  };

  for (let i = 0; i < ladder.length; i++) {
    const cfg = ladder[i];
    const started = await tryStart(buildArgs(cfg), port, emit, cfg.label, i === ladder.length - 1, cfg.ctx);
    if (started) return;
    if (i < ladder.length - 1) emit({ type: 'system', text: 'Local LLM: ' + cfg.label + ' did not start -- trying a lighter configuration' });
  }
  return;
}

// One startup attempt. Resolves true if /health came up, false to let the ladder continue.
async function tryStart(args, port, emit, label, isLast, ctxSize) {

  const logStream = createWriteStream(PATHS.llamaLog, { flags: 'a' });
  let exited = false;

  try {
    _proc = spawn(PATHS.llamaServer, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = e.code === 'EACCES'
      ? 'llama-server permission denied -- run: chmod +x ' + PATHS.llamaServer
      : 'Failed to spawn llama-server: ' + e.message;
    if (isLast) emit({ type: 'system', text: msg });
    return false;
  }

  _proc.stdout.pipe(logStream);
  _proc.stderr.pipe(logStream);

  _proc.on('close', code => {
    exited = true;
    if (code !== 0 && code !== null && isLast) {
      emit({ type: 'system', text: 'llama-server exited (code ' + code + ') -- check data/llm_server.log' });
    }
    _proc = null;
    globalThis.__athenaLocalCtxSize = null;
  });

  _proc.on('error', e => {
    exited = true;
    if (isLast) {
      const msg = e.code === 'EACCES'
        ? 'llama-server permission denied -- run: chmod +x ' + PATHS.llamaServer
        : 'llama-server error: ' + e.message;
      emit({ type: 'system', text: msg });
    }
    _proc = null;
    globalThis.__athenaLocalCtxSize = null;
  });

  try {
    await waitForHealth(port, 90000); // 90s -- USB 2.0 drives are slow
    if (exited) return false;
    emit({ type: 'system', text: 'Local LLM ready (' + _localModelId + ', ' + label + ') -- intelligence upgraded to L3' });
    // Published so tokens.mjs's compression budget tracks whichever config the
    // startup ladder actually landed on (8192 vs a degraded 4096), instead of
    // guessing. This is what was missing when the ladder degraded silently.
    globalThis.__athenaLocalCtxSize = ctxSize;
    return true;
  } catch (e) {
    if (_proc) { try { _proc.kill('SIGKILL'); } catch {} _proc = null; }
    globalThis.__athenaLocalCtxSize = null;
    if (isLast && !exited) emit({ type: 'system', text: 'Local LLM failed to become ready: ' + e.message + ' -- check data/llm_server.log' });
    return false;
  }
}

// ---- Switch to another local model ----
// Loading different weights means restarting the server; there is no in-place swap.
export async function switchLocalModel(wanted, port, emit) {
  const all = detectLocalModels();
  const w = String(wanted || '').toLowerCase();
  const hit = all.find(m => m.id.toLowerCase() === w || m.id.toLowerCase().includes(w) || m.file.toLowerCase().includes(w));
  if (!hit) {
    emit({ type: 'system', text: 'No local model matching "' + wanted + '". Available: ' + all.map(m => m.id + ' (' + m.sizeMB + 'MB)').join(', ') });
    return null;
  }
  await startLocalLLM(port, emit, hit.path);
  return hit.id;
}

// ---- Graceful shutdown ----
export async function stopLocalLLM() {
  if (!_proc) return;
  _proc.kill('SIGTERM');
  await new Promise(r => {
    const t = setTimeout(() => { _proc?.kill('SIGKILL'); r(); }, 3000);
    _proc.once('close', () => { clearTimeout(t); r(); });
  });
  _proc = null;
  globalThis.__athenaLocalCtxSize = null;
}

// Read-only accessor -- mirrors the localApiKey() pattern above so callers
// don't have to know this is a globalThis convention.
export function getLocalContextSize() { return globalThis.__athenaLocalCtxSize ?? null; }

// ---- Which local model id should an ad-hoc caller target? ----
// Shared by tools.mjs's delegate_to_local tool (Claude handing a subtask to a
// local model) and task_router.mjs (routing a whole turn to a local model before Claude
// is ever invoked). Prefers whichever model is already loaded, if any --
// reusing a live server is instant, restarting one is a ~seconds-to-90s
// ladder -- and only falls back to the configured/default preference when
// nothing is running yet. Callers still go through api.mjs's own
// ensureLocalUp() (triggered automatically on first request) to actually get
// the server up on that model; this only decides which id to ask for.
export async function pickLocalModelId() {
  if (!detectLocalModels().length) return null;
  try {
    if (await isLocalLLMRunning()) {
      const running = getLocalModelName();
      if (running && running !== 'local-model') return running;
    }
  } catch {}
  return preferredLocalModel()?.id || null;
}
