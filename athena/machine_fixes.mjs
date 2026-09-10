// machine_fixes.mjs -- per-machine learned remediations
//
// Why this exists: remediate.mjs holds nine generic playbooks (firewall, ssh, updates...).
// Generic playbooks solve generic problems -- and generic problems are exactly the ones a
// system report already reveals. The problems worth an agent are the specific ones: "the
// USB wifi dongle on THIS hub doesn't enumerate on cold boot." Nothing in a static table
// can express that, because it isn't true of any machine but this one.
//
// A fix here is a triple, not a script:
//   detect  -- a command whose output proves the symptom is present
//   steps   -- what to do about it
//   verify  -- a command whose output proves it worked
// Without detect and verify a "fix" is just a stored guess. With them, a fix can be
// re-checked on a later boot, its confidence adjusted, and retired when it stops helping.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PATHS } from './paths.mjs';
import { stableMachineId } from './machines.mjs';
import { logError } from './telemetry.mjs';
import { libraryForPlatform, getLibraryFix } from './fix_library.mjs';

const execAsync = promisify(exec);

function fixesPath(id) {
  const dir = join(PATHS.memDir, 'machines');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, (id || stableMachineId()) + '.fixes.json');
}

function load(id) {
  const p = fixesPath(id);
  if (!existsSync(p)) return { version: 1, fixes: [] };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { version: j.version || 1, fixes: Array.isArray(j.fixes) ? j.fixes : [] };
  } catch { return { version: 1, fixes: [] }; }
}

async function save(store, id) {
  await writeFile(fixesPath(id), JSON.stringify(store, null, 2)).catch(e => logError('machineFixes.save', e));
}

export function listFixes(id) { return load(id).fixes; }

export function getFix(fixId, id) {
  const learned = load(id).fixes.find(f => f.id === fixId);
  if (learned) return learned;
  const lib = getLibraryFix(fixId);
  return lib ? { ...lib, source: 'library', status: 'library', confidence: null } : null;
}

// Every fix available here: the preloaded library for this platform, plus anything learned
// on this machine. Learned entries shadow library entries of the same id and carry the
// confidence this machine has actually earned for them.
export function allFixes(id) {
  const learned = load(id).fixes;
  const learnedIds = new Set(learned.map(f => f.id));
  const lib = libraryForPlatform()
    .filter(f => !learnedIds.has(f.id))
    .map(f => ({ ...f, source: 'library', status: 'library', confidence: null, appliedCount: 0 }));
  return [...learned.map(f => ({ ...f, source: f.source || 'learned' })), ...lib];
}

// ---- Recording ----
// A fix starts UNPROVEN. It earns confidence only by its verify command passing after its
// steps run -- never by being written down confidently.
export async function recordFix({ title, symptom, detect, steps, verify, explain, tags }, id) {
  if (!title || !Array.isArray(steps) || !steps.length) {
    return { ok: false, message: 'a fix needs a title and at least one step' };
  }
  if (!verify) {
    return { ok: false, message: 'a fix needs a verify command -- without it there is no way to know it worked, and it is only a stored guess' };
  }
  const store = load(id);
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const existing = store.fixes.find(f => f.id === slug);
  const entry = {
    id: slug,
    title,
    symptom: symptom || '',
    detect: detect || null,
    steps,
    verify,
    explain: explain || '',
    tags: tags || [],
    status: existing?.status || 'unproven',
    confidence: existing?.confidence ?? 0,
    appliedCount: existing?.appliedCount || 0,
    successCount: existing?.successCount || 0,
    failureCount: existing?.failureCount || 0,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastApplied: existing?.lastApplied || null,
    lastResult: existing?.lastResult || null,
  };
  store.fixes = [...store.fixes.filter(f => f.id !== slug), entry];
  await save(store, id);
  return { ok: true, id: slug, message: `recorded fix "${slug}" (status: ${entry.status})` };
}

export async function forgetFix(fixId, id) {
  const store = load(id);
  const before = store.fixes.length;
  store.fixes = store.fixes.filter(f => f.id !== fixId);
  if (store.fixes.length === before) return { ok: false, message: `no fix "${fixId}" on this machine` };
  await save(store, id);
  return { ok: true, message: `forgot fix "${fixId}"` };
}

// ---- Running a command and judging it ----
async function run(cmd, timeout = 30000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout });
    return { ok: true, out: ((stdout || '') + (stderr || '')).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || e.message || '').trim() };
  }
}

// A check is { cmd, expect } where expect is a regex source string. Absent expect means
// "non-empty output and a zero exit".
async function evaluate(check) {
  if (!check || !check.cmd) return { matched: null, out: '', reason: 'no check defined' };
  const r = await run(check.cmd);
  if (!check.expect) return { matched: r.ok && Boolean(r.out), out: r.out, reason: r.ok ? 'ran' : 'non-zero exit' };
  let re;
  try { re = new RegExp(check.expect, 'i'); } catch { return { matched: null, out: r.out, reason: 'bad expect pattern' }; }
  return { matched: re.test(r.out), out: r.out, reason: 'pattern ' + (re.test(r.out) ? 'matched' : 'did not match') };
}

// ---- Detection: which stored fixes apply to this machine RIGHT NOW ----
export async function detectApplicable(id) {
  const fixes = allFixes(id);
  const results = [];
  for (const f of fixes) {
    if (!f.detect) { results.push({ ...f, applicable: null, evidence: 'no detect command' }); continue; }
    const d = await evaluate(f.detect);
    results.push({ ...f, applicable: d.matched, evidence: d.out.slice(0, 300), reason: d.reason });
  }
  return results;
}

// ---- Applying ----
// Runs detect (skip if the symptom is absent), then steps, then verify. Confidence moves
// only on the verify result.
export async function applyFix(fixId, { force = false, dryRun = false } = {}, id) {
  const store = load(id);
  let fix = store.fixes.find(f => f.id === fixId);
  let fromLibrary = false;
  if (!fix) {
    const lib = getLibraryFix(fixId);
    if (!lib) return { ok: false, message: `no fix "${fixId}" -- not in the library and not learned on this machine` };
    // Materialise the library entry into this machine's store so its outcomes are tracked
    // here rather than being thrown away.
    fix = {
      ...lib, source: 'library', status: 'unproven', confidence: 0,
      appliedCount: 0, successCount: 0, failureCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      lastApplied: null, lastResult: null,
    };
    store.fixes.push(fix);
    fromLibrary = true;
  }
  const stepTimeout = Number(fix.timeoutMs) || 60000;

  const lines = [`Fix: ${fix.title}`, fix.explain ? `  ${fix.explain}` : '', ''].filter(Boolean);

  if (fix.detect && !force) {
    const d = await evaluate(fix.detect);
    lines.push(`Detect: ${fix.detect.cmd}`);
    lines.push(`  ${d.reason} -- ${d.out.slice(0, 200) || '(no output)'}`);
    if (d.matched === false) {
      lines.push('', 'Symptom not present. Nothing to do (pass force:true to run anyway).');
      return { ok: true, applied: false, message: lines.join('\n') };
    }
    lines.push('');
  }

  if (dryRun) {
    lines.push('Would run:');
    fix.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    lines.push('', `Then verify with: ${fix.verify.cmd}`);
    return { ok: true, applied: false, message: lines.join('\n') };
  }

  if (fromLibrary) lines.push('(from the built-in fix library -- first time applied on this machine)', '');
  if (fix.needsAdmin)   lines.push('NOTE: needs an elevated shell; it will fail without one.');
  if (fix.needsReboot)  lines.push('NOTE: takes effect only after a reboot.');
  if (fix.needsNetwork) lines.push('NOTE: needs internet.');
  lines.push('Steps:');
  for (const step of fix.steps) {
    const r = await run(step, stepTimeout);
    lines.push(`  ${r.ok ? 'ok  ' : 'FAIL'} ${step}`);
    if (r.out) lines.push(`       ${r.out.slice(0, 200)}`);
  }

  const v = await evaluate(fix.verify);
  lines.push('', `Verify: ${fix.verify.cmd}`, `  ${v.reason} -- ${v.out.slice(0, 200) || '(no output)'}`);

  fix.appliedCount++;
  fix.lastApplied = new Date().toISOString();
  if (v.matched === true) {
    fix.successCount++;
    fix.confidence = Math.min(100, fix.confidence + 25);
    fix.status = fix.confidence >= 50 ? 'proven' : 'unproven';
    fix.lastResult = 'verified';
    lines.push('', `VERIFIED. confidence ${fix.confidence}/100 (${fix.successCount} of ${fix.appliedCount} applications verified)`);
  } else if (v.matched === false) {
    fix.failureCount++;
    fix.confidence = Math.max(0, fix.confidence - 30);
    fix.status = fix.confidence <= 0 ? 'retired' : fix.status;
    fix.lastResult = 'failed-verify';
    lines.push('', `DID NOT VERIFY. confidence ${fix.confidence}/100${fix.status === 'retired' ? ' -- retired, it is not solving this' : ''}`);
  } else {
    fix.lastResult = 'inconclusive';
    lines.push('', 'Verify was inconclusive -- confidence unchanged.');
  }
  fix.updatedAt = new Date().toISOString();
  await save(store, id);
  return { ok: true, applied: true, verified: v.matched === true, message: lines.join('\n') };
}

// ---- Apply several, in a deliberate order ----
// Low risk first, so the cheap reversible things are tried before anything that restarts a
// service or needs a reboot. Stops at the first fix that fails to verify: if a remediation
// did not do what it claimed, continuing to run more of them is how a small problem becomes
// a support call.
const RISK_ORDER = { low: 0, medium: 1, high: 2 };

export async function applyFixes(ids, { dryRun = false, force = false } = {}, machine) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return { ok: false, message: 'no fix ids given' };

  const resolved = list.map(id => ({ id, fix: getFix(id, machine) }));
  const missing  = resolved.filter(r => !r.fix).map(r => r.id);
  const found    = resolved.filter(r => r.fix)
    .sort((a, b) => (RISK_ORDER[a.fix.risk] ?? 1) - (RISK_ORDER[b.fix.risk] ?? 1));

  const out = [];
  if (missing.length) out.push('Unknown fix id(s): ' + missing.join(', '), '');
  out.push(`Applying ${found.length} fix(es), lowest risk first:`,
           ...found.map((r, i) => `  ${i + 1}. ${r.id}  [${r.fix.risk || '?'} risk]  ${r.fix.title}`), '');

  let applied = 0, verified = 0, stopped = null;
  for (const r of found) {
    const res = await applyFix(r.id, { dryRun, force }, machine);
    out.push('─'.repeat(60), res.message);
    if (res.applied) applied++;
    if (res.verified) verified++;
    if (res.applied && res.verified === false) { stopped = r.id; break; }
  }

  out.push('─'.repeat(60));
  out.push(`${applied} applied, ${verified} verified.`);
  if (stopped) out.push(`STOPPED after "${stopped}" failed verification -- the remaining fixes were not run. Investigate before continuing.`);
  return { ok: true, message: out.join('\n') };
}

// ---- Report ----
export function formatFixes(fixes) {
  if (!fixes.length) return 'No machine-specific fixes recorded for this machine yet.';
  const icon = s => s === 'proven' ? '*' : s === 'retired' ? 'x' : s === 'library' ? '-' : '?';
  const lines = ['Available fixes (* proven here, ? unproven, - built-in library, x retired):', ''];
  for (const f of fixes) {
    const conf = f.confidence == null ? 'not yet applied here' : `confidence ${f.confidence}/100`;
    lines.push(`  ${icon(f.status)} ${f.id}  [${f.status}, ${conf}${f.risk ? ', ' + f.risk + ' risk' : ''}]`);
    lines.push(`      ${f.title}`);
    if (f.symptom) lines.push(`      symptom: ${f.symptom}`);
    if (f.applicable === true)  lines.push(`      APPLIES NOW: ${String(f.evidence || '').slice(0, 120)}`);
    if (f.applicable === false) lines.push(`      not currently applicable`);
    if (f.appliedCount) lines.push(`      applied ${f.appliedCount}x, verified ${f.successCount}x, failed ${f.failureCount}x`);
    lines.push('');
  }
  return lines.join('\n');
}
