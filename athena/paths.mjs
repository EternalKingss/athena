// paths.mjs -- all filesystem paths and startup dir creation
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const _ARCH = (() => {
  const p = process.platform, a = process.arch;
  if (p === 'win32')  return a === 'arm64' ? 'win-arm64'   : 'win-x64';
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64'   : 'mac-x64';
  return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
})();
const RUNTIME = join(ROOT, 'runtime', _ARCH);
const isWin   = process.platform === 'win32';

export const PATHS = {
  env:      join(ROOT, 'config', '.env'),
  memDir:   join(ROOT, 'data', 'memory'),
  agentMem: join(ROOT, 'data', 'memory', 'athena.md'),
  userMem:  join(ROOT, 'data', 'memory', 'user.md'),
  summary:  join(ROOT, 'data', 'memory', 'summary.md'),
  instincts:   join(ROOT, 'data', 'memory', 'instincts.md'),
  prohibited:  join(ROOT, 'data', 'memory', 'prohibited_patterns.md'),
  sessDir:  join(ROOT, 'data', 'sessions'),
  skills:   join(ROOT, 'skills'),
  tools:    join(ROOT, 'tools'),

  // Portable runtimes bundled on the drive
  runtime:    RUNTIME,
  python:     isWin ? join(RUNTIME, 'python', 'python.exe')     : join(RUNTIME, 'python', 'bin', 'python3'),
  pythonBin:  isWin ? join(RUNTIME, 'python')                   : join(RUNTIME, 'python', 'bin'),
  pythonPkg:  isWin ? join(RUNTIME, 'python', 'Scripts')        : join(RUNTIME, 'python', 'bin'),
  lokiPy:     join(ROOT, 'tools', 'loki', 'loki.py'),
};

// Ensure required dirs exist at startup -- soft-fail on read-only drives
for (const d of [PATHS.sessDir, PATHS.memDir, PATHS.skills, PATHS.tools]) {
  try { mkdirSync(d, { recursive: true }); } catch { /* read-only mount -- continue */ }
}
