// machines.mjs -- Machine fingerprinting and cross-session intelligence (Pillars 6 + 10 + 11)
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { hostname, cpus, totalmem, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

const MACHINES_DIR = join(PATHS.memDir, 'machines');
const HISTORY_CAP  = 50;

function machineId() {
  const cpu   = cpus()[0]?.model?.trim() || 'unknown-cpu';
  const cores = String(cpus().length);
  const ram   = String(Math.round(totalmem() / (1024 ** 3)));
  let mac = 'no-mac';
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac; break;
      }
    }
    if (mac !== 'no-mac') break;
  }
  const raw = cpu + '|' + cores + '|' + ram + 'GB|' + mac;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function fingerprintPath() {
  return join(MACHINES_DIR, machineId() + '.json');
}

export async function saveFingerprint(caps) {
  const existing = loadFingerprint();
  const seenHostnames = new Set(existing?.seenHostnames || []);
  seenHostnames.add(hostname());
  const history = existing?.history ? [...existing.history] : [];
  if (existing?.current) {
    history.push(existing.current);
    while (history.length > HISTORY_CAP) history.shift();
  }
  const snapshot = {
    uuid:          existing?.uuid || randomUUID(),
    first_seen:    existing?.first_seen || new Date().toISOString(),
    visits:        (existing?.visits || 0) + 1,
    seenHostnames: [...seenHostnames],
    lastHostname:  hostname(),
    capturedAt:    new Date().toISOString(),
    current:       caps,
    history,
    caps,
  };
  try {
    await mkdir(MACHINES_DIR, { recursive: true });
    await writeFile(fingerprintPath(), JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.warn('[machines] fingerprint save failed: ' + e.message);
  }
  return snapshot;
}

export function loadFingerprint() {
  const fp = fingerprintPath();
  if (!existsSync(fp)) return null;
  try {
    const data = JSON.parse(readFileSync(fp, 'utf8'));
    // Migrate old schema (pre-Phase 11) to new schema
    if (data.visits === undefined) data.visits = 1;
    if (!Array.isArray(data.history)) data.history = [];
    if (!data.uuid) data.uuid = data.machineId || machineId();
    if (!data.first_seen) data.first_seen = data.capturedAt || new Date().toISOString();
    if (!data.current && data.caps) data.current = data.caps;
    return data;
  }
  catch { return null; }
}

function listDiff(prev = [], curr = []) {
  const ps = new Set(prev);
  const cs = new Set(curr);
  return { added: curr.filter(x => !ps.has(x)), removed: prev.filter(x => !cs.has(x)) };
}

function formatDiff(label, diff) {
  const lines = [];
  if (diff.added.length)   lines.push('  + ' + label + ': ' + diff.added.join(', '));
  if (diff.removed.length) lines.push('  - ' + label + ': ' + diff.removed.join(', '));
  return lines;
}

export function diffFingerprints(prevCaps, currCaps) {
  if (!prevCaps) return '';
  const lines = [];
  const listFields = [
    ['langs', 'Languages'], ['compilers', 'Compilers'], ['pkgMgrs', 'Package managers'],
    ['containers', 'Containers'], ['databases', 'Databases'], ['browsers', 'Browsers'],
    ['ides', 'IDEs'], ['devops', 'DevOps tools'], ['utils', 'Utilities'],
    ['security', 'Security tools'], ['gpus', 'GPUs'], ['mcp', 'MCP servers'],
  ];
  for (const [key, label] of listFields) {
    const d = listDiff(prevCaps[key], currCaps?.[key]);
    lines.push(...formatDiff(label, d));
  }
  const ps = prevCaps.system || {};
  const cs = currCaps?.system || {};
  if (ps.ramTotal && cs.ramTotal && ps.ramTotal !== cs.ramTotal)
    lines.push('  ~ RAM: ' + ps.ramTotal + ' -> ' + cs.ramTotal);
  if (ps.cpuCores && cs.cpuCores && ps.cpuCores !== cs.cpuCores)
    lines.push('  ~ CPU cores: ' + ps.cpuCores + ' -> ' + cs.cpuCores);
  return lines.join('\n');
}

function formatTimeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60)  return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return mins + 'm ago';
  const hrs  = Math.floor(mins / 60);
  if (hrs  < 24)  return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

export async function checkMachineReturn(currentCaps) {
  const prev = loadFingerprint();
  if (!prev) {
    return { isReturn: false, lastSeen: null, report: 'First visit on this machine (' + hostname() + ').' };
  }
  const diff = diffFingerprints(prev.caps, currentCaps);
  const ago  = formatTimeAgo(prev.capturedAt);
  const switchNote = prev.lastHostname && prev.lastHostname !== hostname()
    ? ' (was on "' + prev.lastHostname + '", now on "' + hostname() + '" -- same hardware)'
    : '';
  return {
    isReturn: true,
    lastSeen: prev.capturedAt,
    report: diff
      ? 'Back on this machine' + switchNote + ' (last seen ' + ago + '). Changes since last visit:' + '\n' + diff
      : 'Back on this machine' + switchNote + ' (last seen ' + ago + '). No significant changes detected.',
  };
}

// Phase 11: machineTrend() -- longitudinal analysis over history snapshots
export function machineTrend(fp) {
  if (!fp) fp = loadFingerprint();
  if (!fp) return { error: 'No fingerprint found for this machine.' };
  const h = fp.history || [];
  if (h.length < 2) {
    return {
      uuid: fp.uuid || null,
      visits: fp.visits || 1,
      first_seen: fp.first_seen || fp.capturedAt,
      snapshots: h.length,
      summary: 'Insufficient history for trend analysis (' + h.length + ' snapshot(s)).',
      trends: {},
    };
  }
  const oldest = new Date(h[0].ts || fp.first_seen).getTime();
  const newest = new Date(h[h.length - 1].ts || fp.capturedAt).getTime();
  const spanDays = Math.max(1, (newest - oldest) / 86400000);
  const visitsPerDay = (h.length / spanDays).toFixed(2);
  const toolChanges = [];
  for (let i = 1; i < h.length; i++) {
    const d = diffFingerprints(h[i - 1], h[i]);
    if (d) toolChanges.push({ at: h[i].ts || '?', changes: d });
  }
  const allTools = new Set();
  const cats = ['langs', 'compilers', 'pkgMgrs', 'containers', 'databases', 'browsers', 'ides', 'devops', 'utils', 'security'];
  for (const snap of h) for (const cat of cats) for (const t of (snap[cat] || [])) allTools.add(t);
  return {
    uuid: fp.uuid || null,
    visits: fp.visits || h.length,
    first_seen: fp.first_seen || h[0]?.ts,
    last_seen: fp.capturedAt,
    snapshots: h.length,
    span_days: spanDays.toFixed(1),
    visits_per_day: visitsPerDay,
    unique_tools_seen: allTools.size,
    recent_changes: toolChanges.slice(-5),
    summary: 'Machine seen ' + (fp.visits || h.length) + ' times over ' + spanDays.toFixed(0) + ' days (' + visitsPerDay + '/day). ' + allTools.size + ' distinct tools observed across history.',
  };
}


// ---- Phase 16e: Runtime state diffing ----
// captureRuntimeState() = what is running right now (distinct from capability fingerprinting).
// Fingerprint = what's installed. Runtime state = what's currently executing.

function safeExec(cmd, timeoutMs) {
  try {
    const { execSync } = require('child_process');
    return execSync(cmd, { timeout: timeoutMs || 8000, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

export async function captureRuntimeState() {
  const isWin = process.platform === 'win32';
  const st = { capturedAt: new Date().toISOString(), platform: process.platform };

  // Process list
  if (isWin) {
    const raw = safeExec('powershell -NoProfile -NonInteractive -Command "Get-Process | Select-Object Name,Id | ForEach-Object { $_.Name + \"(\" + $_.Id + \")\" }"', 10000);
    st.processes = raw.split('\n').filter(Boolean).map(l => l.trim());
  } else {
    const raw = safeExec('ps -eo comm,pid --no-headers 2>/dev/null | head -150', 5000);
    st.processes = raw.split('\n').filter(Boolean).map(l => l.trim());
  }

  // Listening ports
  if (isWin) {
    const raw = safeExec('powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection -State Listen | ForEach-Object { $_.LocalPort } | Sort-Object -Unique"', 8000);
    st.listeningPorts = raw.split('\n').map(l => l.trim()).filter(Boolean);
  } else {
    const raw = safeExec('ss -tlnp 2>/dev/null | awk \'NR>1{print $4}\' | sed \'s/.*://\' | sort -u', 5000);
    st.listeningPorts = raw.split('\n').filter(Boolean);
  }

  // Loaded drivers/modules
  if (isWin) {
    const raw = safeExec('powershell -NoProfile -NonInteractive -Command "Get-WmiObject Win32_SystemDriver | Where-Object State -eq Running | Select-Object -ExpandProperty Name | Sort-Object"', 10000);
    st.drivers = raw.split('\n').map(l => l.trim()).filter(Boolean);
  } else {
    const raw = safeExec('lsmod 2>/dev/null | awk \'NR>1{print $1}\' | sort', 5000);
    st.modules = raw.split('\n').filter(Boolean);
  }

  // Established connection count (canary for unexpected outbound activity)
  if (isWin) {
    const raw = safeExec('powershell -NoProfile -NonInteractive -Command "(Get-NetTCPConnection -State Established).Count"', 5000);
    st.establishedConnections = parseInt(raw, 10) || 0;
  } else {
    const raw = safeExec('ss -tnp state established 2>/dev/null | wc -l', 3000);
    st.establishedConnections = Math.max(0, (parseInt(raw, 10) || 1) - 1);
  }

  return st;
}

export function diffRuntimeState(baseline, current) {
  if (!baseline || !current) return 'Cannot diff: missing state snapshot.';
  const lines = [];

  const bProcs = new Set(baseline.processes || []);
  const cProcs = new Set(current.processes || []);
  const newProcs  = [...cProcs].filter(p => !bProcs.has(p));
  const goneProcs = [...bProcs].filter(p => !cProcs.has(p));
  if (newProcs.length)  lines.push('NEW PROCESSES (' + newProcs.length + '): ' + newProcs.slice(0, 20).join(', '));
  if (goneProcs.length) lines.push('GONE PROCESSES (' + goneProcs.length + '): ' + goneProcs.slice(0, 20).join(', '));

  const bPorts = new Set(baseline.listeningPorts || []);
  const cPorts = new Set(current.listeningPorts || []);
  const newPorts    = [...cPorts].filter(p => !bPorts.has(p));
  const closedPorts = [...bPorts].filter(p => !cPorts.has(p));
  if (newPorts.length)    lines.push('NEW LISTENING PORTS: ' + newPorts.join(', '));
  if (closedPorts.length) lines.push('CLOSED PORTS: ' + closedPorts.join(', '));

  const bDrv = new Set([...(baseline.drivers || []), ...(baseline.modules || [])]);
  const cDrv = new Set([...(current.drivers  || []), ...(current.modules  || [])]);
  const newDrv  = [...cDrv].filter(d => !bDrv.has(d));
  const goneDrv = [...bDrv].filter(d => !cDrv.has(d));
  if (newDrv.length)  lines.push('NEW DRIVERS/MODULES: ' + newDrv.join(', '));
  if (goneDrv.length) lines.push('REMOVED DRIVERS/MODULES: ' + goneDrv.join(', '));

  const delta = (current.establishedConnections || 0) - (baseline.establishedConnections || 0);
  if (Math.abs(delta) > 20) lines.push('CONNECTIONS DELTA: ' + (delta > 0 ? '+' : '') + delta + ' established TCP connections');

  if (!lines.length) return 'No significant runtime changes detected since baseline.';
  return 'RUNTIME DIFF (baseline: ' + baseline.capturedAt + ')' + '\n' + lines.join('\n');
}

const BASELINE_SUFFIX = '_baseline.json';

export async function saveRuntimeBaseline(state) {
  const fp = fingerprintPath().replace('.json', BASELINE_SUFFIX);
  try {
    await mkdir(MACHINES_DIR, { recursive: true });
    await writeFile(fp, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

export function loadRuntimeBaseline() {
  const fp = fingerprintPath().replace('.json', BASELINE_SUFFIX);
  if (!existsSync(fp)) return null;
  try { return JSON.parse(readFileSync(fp, 'utf8')); } catch { return null; }
}
