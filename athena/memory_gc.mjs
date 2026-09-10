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

// This pass used to delete correct instincts. Three real failures on a live store:
//
//   "Encode complex PowerShell scripts as -EncodedCommand to AVOID quote hell"
//   "AUTO_APPROVE=true -- NEVER ask for shell command approval"
//   "NEVER write working files to D:\ATHENA -- USE %TEMP%"
//
// none of which contradicted anything. The old rule fired on the mere presence of a
// negative word plus 25% word overlap with any other entry. Worse, the third contains
// both a negative and a positive because it is one coherent rule -- "not X, do Y" --
// so it registered as BOTH sides of a contradiction and competed against everything.
//
// Three conditions now, all required: an entry that states both a negative and a
// positive is a single rule and is never a candidate; the pair must sit in the same
// domain; and they must actually be talking about the same thing, which 25% overlap
// does not establish.
const CONTRADICTION_MIN_OVERLAP = 0.5;

function detectContradictions(entries) {
  const keep = new Array(entries.length).fill(true);
  for (let i = 0; i < entries.length; i++) {
    if (!keep[i]) continue;
    const iNeg = NEG_PATTERNS.test(entries[i]);
    const iPos = POS_PATTERNS.test(entries[i]);
    // "do not X, do Y instead" is one instruction, not two competing ones.
    if (iNeg && iPos) continue;
    if (!iNeg && !iPos) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (!keep[j]) continue;
      const jNeg = NEG_PATTERNS.test(entries[j]);
      const jPos = POS_PATTERNS.test(entries[j]);
      if (jNeg && jPos) continue;
      if (!((iNeg && jPos) || (iPos && jNeg))) continue;
      if (domainOf(entries[i]) !== domainOf(entries[j])) continue;
      if (jaccard(entries[i], entries[j]) < CONTRADICTION_MIN_OVERLAP) continue;
      // A real contradiction -- keep the higher-confidence entry.
      const confI = parseInt((entries[i].match(/\[conf:(\d+)\]/) || [, '0'])[1], 10);
      const confJ = parseInt((entries[j].match(/\[conf:(\d+)\]/) || [, '0'])[1], 10);
      if (confI >= confJ) keep[j] = false;
      else                keep[i] = false;
    }
  }
  return entries.filter((_, i) => keep[i]);
}

// ---- Pass 2b: factual conflict (instincts only) ----
// detectContradictions above only fires when BOTH entries carry a prescriptive
// marker, so it can only see "never use X" vs "always use X". The store also holds
// declarative claims -- "Machine: <specs>" -- and two of those can conflict without
// either containing avoid/never/use/always. Those pairs were skipped before they were
// ever compared, which is how two different machine profiles sat at conf:85 together,
// both loaded into the system prompt on every turn.
//
// A conflicting fact is NOT deleted here. It is demoted and marked, so the change is
// visible for at least one GC cycle and decay removes it later. Silently dropping a
// remembered fact is the wrong failure mode for a store nobody reads directly.
const FACT_SUBJECT = /^\s*(?:\[[^\]]*\]\s*)*([A-Za-z][A-Za-z ]{2,28}?)\s*[:\-]/;

// "Machine:" and "Current machine profile:" are the same subject. Comparing the
// normalised strings for equality missed that, so the two conflicting hardware
// profiles were never compared. Compare token sets and require a shared noun.
const SUBJECT_STOPWORDS = new Set(['current', 'the', 'my', 'this', 'a', 'an', 'on', 'in', 'profile', 'info', 'details']);

function subjectTokens(entry) {
  const m = entry.match(FACT_SUBJECT);
  if (!m) return null;
  const toks = m[1].toLowerCase().split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !SUBJECT_STOPWORDS.has(t));
  return toks.length ? new Set(toks) : null;
}

function subjectsMatch(a, b) {
  if (!a || !b) return false;
  for (const t of a) { if (b.has(t)) return true; }
  return false;
}

function subjectOf(entry) {
  const s = subjectTokens(entry);
  return s ? [...s].join(' ') : null;
}

function domainOf(entry) {
  const m = entry.match(/\[domain:([^\]]+)\]/);
  return m ? m[1].toLowerCase() : null;
}

function tsOf(entry) {
  const m = entry.match(/\[at:([^\]]+)\]/);
  const t = m ? Date.parse(m[1]) : NaN;
  return isFinite(t) ? t : null;
}

function detectFactualConflicts(entries) {
  const out = [...entries];
  for (let i = 0; i < out.length; i++) {
    const si = subjectTokens(out[i]);
    if (!si || out[i].includes('[superseded]')) continue;
    // Prescriptive entries are pass 2's job, not this one.
    if (NEG_PATTERNS.test(out[i]) || POS_PATTERNS.test(out[i])) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].includes('[superseded]')) continue;
      if (NEG_PATTERNS.test(out[j]) || POS_PATTERNS.test(out[j])) continue;
      if (!subjectsMatch(si, subjectTokens(out[j]))) continue;
      if (domainOf(out[i]) !== domainOf(out[j])) continue;
      // Same subject, same domain, both declarative, and materially different text.
      if (jaccard(out[i], out[j]) > 0.7) continue;   // near-identical is dedupe's job

      // "Newer wins" is wrong here, and the live store proved it: the NEWER of the two
      // machine profiles described a completely different computer. Recency tracks when
      // a fact was written, not which machine it was true of.
      //
      // If both entries name a machine, the one matching this machine wins outright.
      // If they do not, there is no sound basis to pick -- so flag both and let a human
      // resolve it rather than deleting a fact on a coin flip.
      const mi = (out[i].match(/\[machine:([^\]]+)\]/) || [])[1] || null;
      const mj = (out[j].match(/\[machine:([^\]]+)\]/) || [])[1] || null;
      const here = globalThis.__athenaMachineId || null;

      if (here && mi && mj && mi !== mj) {
        if (mi === here && mj !== here) out[j] = demote(out[j]);
        else if (mj === here && mi !== here) out[i] = demote(out[i]);
      } else {
        out[i] = flagConflict(out[i]);
        out[j] = flagConflict(out[j]);
      }
    }
  }
  return out;
}

// Marks an entry as disputed without changing its confidence or removing it. Surfaced
// in the GC summary so the conflict is visible instead of resolved by guesswork.
function flagConflict(entry) {
  return entry.includes('[conflict]') ? entry : entry.replace(/^(\s*)/, '$1[conflict] ');
}

function demote(entry) {
  const withMark = entry.includes('[superseded]') ? entry : entry.replace(/^(\s*)/, '$1[superseded] ');
  return withMark.replace(/\[conf:(\d+)\]/, (_, c) => '[conf:' + Math.min(25, parseInt(c, 10)) + ']');
}

// ---- Pass 3: relevance decay ----
// Removes instinct entries with low confidence and no reinforcement signal.
function decayStaleInstincts(entries) {
  return entries.filter(entry => {
    const confM = entry.match(/\[conf:(\d+)\]/);
    const seenM = entry.match(/\[seen:(\d+)\]/);
    const conf  = confM ? parseInt(confM[1], 10) : 100;
    const seen  = seenM ? parseInt(seenM[1], 10) : 10;
    // This was `conf >= 30 || seen >= 2`. Every entry in the store sits well above
    // conf 30, so the first clause was always true and this pass could never remove
    // anything -- the retirement mechanism existed and was unreachable. Both
    // conditions must now fail for an entry to go, so a genuinely stale, low-confidence
    // instinct retires while a well-established one is untouched.
    if (conf < 30 && seen < 2) return false;
    // Anything demoted by factual conflict and still not reinforced goes on this pass.
    if (entry.includes('[superseded]') && conf <= 25) return false;
    return true;
  });
}

// ---- Run GC on a single memory file ----
async function gcFile(filePath, passes) {
  if (!existsSync(filePath)) return { original: 0, final: 0 };
  const original = readEntries(filePath);
  if (original.length < 4) return { original: original.length, final: original.length };

  // Nothing carried a timestamp, so there was no way to tell an old fact from a new
  // one. Stamp on first sight; from then on the store has an age signal.
  const stamped = original.map(e =>
    /\[at:/.test(e) ? e : e.replace(/^(\s*(?:\[[^\]]*\]\s*)*)/, (m) => m + '[at:' + new Date().toISOString() + '] ')
  );

  let entries = [...stamped];
  for (const pass of passes) entries = pass(entries);

  // Demotion and stamping change content without changing the count, and the old
  // condition only wrote when entries were removed -- so those edits were computed
  // and thrown away.
  const before = original.join(DELIM);
  const after  = entries.join(DELIM);
  if (after !== before) await writeFile(filePath, after);
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
      instincts: await gcFile(PATHS.instincts, [deduplicateEntries, detectContradictions, detectFactualConflicts, decayStaleInstincts]),
    };

    // A flagged conflict removes nothing, so the pruned count would not mention it.
    try {
      const disputed = readEntries(PATHS.instincts).filter(e => e.includes('[conflict]'));
      if (disputed.length) {
        await appendFile(PATHS.agentMem,
          '\n\x15\n[memory_gc] ' + disputed.length + ' instinct(s) assert conflicting facts and could not be ' +
          'resolved automatically. Review with /instincts:\n' +
          disputed.map(e => '  - ' + e.replace(/\s+/g, ' ').slice(0, 160)).join('\n'));
      }
    } catch {}

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
