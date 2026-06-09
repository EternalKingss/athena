// memory_gc.mjs -- Background memory garbage collector
// Runs post-session (every 5th session) to deduplicate, resolve contradictions,
// and decay stale instincts. Never blocks -- all ops are best-effort.
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';
import { logError } from './telemetry.mjs';

// Avoid circular import with memory.mjs by duplicating the tiny entry reader.
const DELIM = '\n\x15\n';
function readEntries(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  return raw ? raw.split(DELIM).map(e => e.trim()).filter(Boolean) : [];
}

// ---- Word-overlap similarity (Jaccard) ----
function wordSet(text) {
  return new Set(
    (text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccard(a, b) {
  const sa = wordSet(a), sb = wordSet(b);
  if (!sa.size || !sb.size) return 0;
  let intersect = 0;
  for (const w of sa) { if (sb.has(w)) intersect++; }
  return intersect / (sa.size + sb.size - intersect);
}

// ---- Pass 1: deduplication ----
// Entries with Jaccard > 0.7 to an existing entry are merged (keep the longer one).
function deduplicateEntries(entries) {
  const kept = [];
  for (const entry of entries) {
    const dupIdx = kept.findIndex(k => jaccard(k, entry) > 0.7);
    if (dupIdx >= 0) {
      kept[dupIdx] = kept[dupIdx].length >= entry.length ? kept[dupIdx] : entry;
    } else {
      kept.push(entry);
    }
  }
  return kept;
}

// ---- Pass 2: contradiction detection (instincts only) ----
// Finds pairs where one says "avoid X" and another says "use X" on the same topic.
const NEG_PATTERNS = /\b(avoid|don't|never|stop|no longer|do not)\b/i;
const POS_PATTERNS = /\b(use|always|prefer|must|should|do)\b/i;

function detectContradictions(entries) {
  const keep = new Array(entries.length).fill(true);
  for (let i = 0; i < entries.length; i++) {
    if (!keep[i]) continue;
    const iNeg = NEG_PATTERNS.test(entries[i]);
    const iPos = POS_PATTERNS.test(entries[i]);
    if (!iNeg && !iPos) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (!keep[j]) continue;
      if (jaccard(entries[i], entries[j]) < 0.25) continue;
      const jNeg = NEG_PATTERNS.test(entries[j]);
      const jPos = POS_PATTERNS.test(entries[j]);
      if (!((iNeg && jPos) || (iPos && jNeg))) continue;
      // Contradiction found -- keep the higher-confidence entry
      const confI = parseInt((entries[i].match(/\[conf:(\d+)\]/) || [, '0'])[1], 10);
      const confJ = parseInt((entries[j].match(/\[conf:(\d+)\]/) || [, '0'])[1], 10);
      if (confI >= confJ) keep[j] = false;
      else                keep[i] = false;
    }
  }
  return entries.filter((_, i) => keep[i]);
}

// ---- Pass 3: relevance decay ----
// Removes instinct entries with low confidence and no reinforcement signal.
function decayStaleInstincts(entries) {
  return entries.filter(entry => {
    const confM = entry.match(/\[conf:(\d+)\]/);
    const seenM = entry.match(/\[seen:(\d+)\]/);
    const conf  = confM ? parseInt(confM[1], 10) : 100;
    const seen  = seenM ? parseInt(seenM[1], 10) : 10;
    return conf >= 30 || seen >= 2;
  });
}

// ---- Run GC on a single memory file ----
async function gcFile(filePath, passes) {
  if (!existsSync(filePath)) return { original: 0, final: 0 };
  const original = readEntries(filePath);
  if (original.length < 4) return { original: original.length, final: original.length };

  let entries = [...original];
  for (const pass of passes) entries = pass(entries);

  if (entries.length < original.length) {
    await writeFile(filePath, entries.join(DELIM));
  }
  return { original: original.length, final: entries.length };
}

// ---- Read / write GC state ----
function readGcState() {
  try {
    if (existsSync(PATHS.gcState)) return JSON.parse(readFileSync(PATHS.gcState, 'utf8'));
  } catch {}
  return { sessionCount: 0, lastRun: null };
}

async function writeGcState(state) {
  try { await writeFile(PATHS.gcState, JSON.stringify(state, null, 2)); } catch {}
}

// ---- Main entry point ----
// Called by memory.mjs saveAndSummarize. Runs every 5th session.
export async function runMemoryGC() {
  try {
    const gcState = readGcState();
    gcState.sessionCount = (gcState.sessionCount || 0) + 1;

    if (gcState.sessionCount < 5) {
      await writeGcState(gcState);
      return;
    }

    gcState.sessionCount = 0;
    gcState.lastRun = new Date().toISOString();
    await writeGcState(gcState);

    const results = {
      athena:    await gcFile(PATHS.agentMem,  [deduplicateEntries]),
      user:      await gcFile(PATHS.userMem,   [deduplicateEntries]),
      instincts: await gcFile(PATHS.instincts, [deduplicateEntries, detectContradictions, decayStaleInstincts]),
    };

    const pruned = Object.values(results).reduce((s, r) => s + (r.original - r.final), 0);
    if (pruned > 0) {
      const summary = '[memory_gc] Pruned ' + pruned + ' entries: ' +
        Object.entries(results).map(([k, v]) => k + ': ' + v.original + '->' + v.final).join(', ');
      await appendFile(join(PATHS.memDir, 'gc_log.txt'), summary + '\n').catch(() => {});
    }
  } catch (e) {
    logError('memory_gc', e);
  }
}
