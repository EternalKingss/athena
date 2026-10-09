// Shared on-disk format for memory files (memory.mjs and memory_gc.mjs both read it).
// One definition so the delimiter and parsing can never drift between the two.
import { existsSync, readFileSync } from 'node:fs';

export const DELIM = '\n\x15\n';

export function readEntries(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  return raw ? raw.split(DELIM).map(e => e.trim()).filter(Boolean) : [];
}
