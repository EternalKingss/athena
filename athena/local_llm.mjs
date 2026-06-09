// local_llm.mjs -- L3 optional local LLM lifecycle manager (llama-server subprocess)
// LLM readiness is optional state, never required state.
// Non-blocking: caller fires startLocalLLM() and continues immediately.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import { PATHS } from './paths.mjs';
import { LOCAL_LLM_PORT } from './config.mjs';

let _proc         = null;
let _localModelId = null;

// ---- Scan runtime/models/ for .gguf files ----
export function detectLocalModel() {
  if (!existsSync(PATHS.modelsDir)) return null;
  try {
    const files = readdirSync(PATHS.modelsDir)
      .filter(f => f.toLowerCase().endsWith('.gguf'))
      .sort();
    return files.length ? join(PATHS.modelsDir, files[0]) : null;
  } catch { return null; }
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
export async function startLocalLLM(port, emit) {
  const modelPath = detectLocalModel();
  if (!modelPath) {
    emit({ type: 'system', text: 'No .gguf model found in runtime/models/ -- local LLM unavailable' });
    return;
  }

  _localModelId = modelIdFromPath(modelPath);

  // Reuse if already running (e.g. second Athena instance)
  if (await isLocalLLMRunning()) {
    emit({ type: 'system', text: 'Local LLM already running on port ' + port + ' -- reusing' });
    return;
  }

  if (!existsSync(PATHS.llamaServer)) {
    emit({ type: 'system', text: 'llama-server binary not found at ' + PATHS.llamaServer + ' -- run runtime/get-offline.sh' });
    return;
  }

  const threads = Math.max(1, cpus().length - 1);
  const args = [
    '--model',    modelPath,
    '--port',     String(port),
    '--host',     '127.0.0.1',
    '--ctx-size', '8192',
    '--n-predict', '2048',
    '--threads',  String(threads),
    '--no-mmap',  // critical for FAT32 USB drives
  ];

  const logStream = createWriteStream(PATHS.llamaLog, { flags: 'a' });
  let exited = false;

  try {
    _proc = spawn(PATHS.llamaServer, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = e.code === 'EACCES'
      ? 'llama-server permission denied -- run: chmod +x ' + PATHS.llamaServer
      : 'Failed to spawn llama-server: ' + e.message;
    emit({ type: 'system', text: msg });
    return;
  }

  _proc.stdout.pipe(logStream);
  _proc.stderr.pipe(logStream);

  _proc.on('close', code => {
    exited = true;
    if (code !== 0 && code !== null) {
      emit({ type: 'system', text: 'llama-server exited (code ' + code + ') -- check data/llm_server.log' });
    }
    _proc = null;
  });

  _proc.on('error', e => {
    exited = true;
    const msg = e.code === 'EACCES'
      ? 'llama-server permission denied -- run: chmod +x ' + PATHS.llamaServer
      : 'llama-server error: ' + e.message;
    emit({ type: 'system', text: msg });
    _proc = null;
  });

  try {
    await waitForHealth(port, 90000); // 90s -- USB 2.0 drives are slow
    if (!exited) emit({ type: 'system', text: 'Local LLM ready (' + _localModelId + ') -- intelligence upgraded to L3' });
  } catch (e) {
    if (!exited) emit({ type: 'system', text: 'Local LLM failed to become ready: ' + e.message + ' -- check data/llm_server.log' });
  }
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
}
