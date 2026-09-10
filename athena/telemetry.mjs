// telemetry.mjs -- structured error telemetry (append-only, never throws)
// Replaces silent .catch(() => {}) blocks with observable error entries.
import { appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

const ERRORS_FILE = join(PATHS.memDir, 'errors.jsonl');

// Log a structured error entry. Safe to call from catch -- never throws.
export function logError(context, error, meta = {}) {
  const entry = {
    ts:      new Date().toISOString(),
    context,
    message: error?.message || String(error),
    code:    error?.code ?? error?.status,
    meta,
  };
  appendFile(ERRORS_FILE, JSON.stringify(entry) + '\n').catch(() => {});
}

// Returns the last `n` logged errors as human-readable lines, newest last.
// Never throws -- a missing or unreadable file just means nothing's been
// recorded yet, not a crash for whoever's asking (e.g. the /errors command).
export function recentErrors(n = 15) {
  let raw;
  try { raw = readFileSync(ERRORS_FILE, 'utf8'); }
  catch { return '(no errors recorded)'; }
  const lines = raw.trim().split('\n').filter(Boolean).slice(-n);
  if (!lines.length) return '(no errors recorded)';
  return lines.map(l => {
    try {
      const e = JSON.parse(l);
      const where = e.meta && Object.keys(e.meta).length ? ' ' + JSON.stringify(e.meta) : '';
      return `${e.ts}  [${e.context}]  ${e.message}${where}`;
    } catch { return l; }
  }).join('\n');
}
