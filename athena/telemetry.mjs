// telemetry.mjs -- structured error telemetry (append-only, never throws)
// Replaces silent .catch(() => {}) blocks with observable error entries.
import { appendFile } from 'node:fs/promises';
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
