// paths.mjs — all filesystem paths and startup dir creation
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const PATHS = {
  env:      join(ROOT, 'config', '.env'),
  memDir:   join(ROOT, 'data', 'memory'),
  agentMem: join(ROOT, 'data', 'memory', 'athena.md'),
  userMem:  join(ROOT, 'data', 'memory', 'user.md'),
  summary:  join(ROOT, 'data', 'memory', 'summary.md'),
  sessDir:  join(ROOT, 'data', 'sessions'),
  skills:   join(ROOT, 'skills'),
};

// Ensure required dirs exist at startup
mkdirSync(PATHS.sessDir, { recursive: true });
mkdirSync(PATHS.memDir,  { recursive: true });
mkdirSync(PATHS.skills,  { recursive: true });
