// machines.mjs -- Machine fingerprinting and cross-session intelligence (Pillars 6 + 10 + 11)
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { hostname, cpus, totalmem, networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

const MACHINES_DIR = join(PATHS.memDir, 'machines');
const HISTORY_CAP  = 50;

// ---- Legacy identity: CPU + cores + RAM + first non-internal MAC ----
// Kept only so an existing fingerprint file can be found and migrated. Do not use it for
// anything new: the MAC component makes it unstable exactly when the network is broken,
// which is exactly when we most need Athena to know where it is.
function legacyMachineId() {
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

// ---- Stable identity: hardware that exists whether or not the network came up ----
let _stableId = null;
function hardwareSerial() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      if (m) return 'winguid:' + m[1];
    } else if (process.platform === 'darwin') {
      const out = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null',
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const m = out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return 'macuuid:' + m[1];
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(f)) {
          const v = readFileSync(f, 'utf8').trim();
          if (v) return 'machineid:' + v;
        }
      }
      if (existsSync('/sys/class/dmi/id/product_uuid')) {
        const v = readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
        if (v) return 'dmi:' + v;
      }
    }
  } catch { /* fall through -- no hardware id available */ }
  return null;
}

// loadInstincts() runs while building the system prompt and cannot await. Publish the
// id once so that path can scope instincts to this machine without going async.
export function publishMachineId() {
  try { globalThis.__athenaMachineId = stableMachineId(); } catch {}
  return globalThis.__athenaMachineId || null;
}

export function stableMachineId() {
  if (_stableId) return _stableId;
  const cpu   = cpus()[0]?.model?.trim() || 'unknown-cpu';
  const cores = String(cpus().length);
  const ram   = String(Math.round(totalmem() / (1024 ** 3)));
  const hw    = hardwareSerial();
  // Fall back to the legacy scheme only when no hardware id exists at all. Better an
  // unstable id than none, but say so in the value so it is debuggable.
  const raw = hw ? (cpu + '|' + cores + '|' + ram + 'GB|' + hw)
                 : (cpu + '|' + cores + '|' + ram + 'GB|nohw|' + legacyMachineId());
  _stableId = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return _stableId;
}

function machineId() { return stableMachineId(); }

// One-time migration: if this machine has no fingerprint under its stable id but does have
// one under the legacy MAC-derived id, adopt it rather than starting from nothing.
let _migrated = false;
function fingerprintPath() {
  const stable = join(MACHINES_DIR, machineId() + '.json');
  if (!_migrated) {
    _migrated = true;
    try {
      if (!existsSync(stable)) {
        const legacy = join(MACHINES_DIR, legacyMachineId() + '.json');
        if (existsSync(legacy)) {
          mkdirSync(MACHINES_DIR, { recursive: true });
          writeFileSync(stable, readFileSync(legacy));
          console.warn('[machines] migrated fingerprint from legacy id to stable id');
        }
      }
    } catch { /* migration is best-effort */ }
  }
  return stable;
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

// A quoted -Command string does not survive the trip through the shell: the escaped
// inner quotes in the process query collapsed and PowerShell parsed
//   $_.Name + ( + $_.Id + )
// which is a syntax error, so captureRuntimeState() recorded ZERO processes and the
// process half of every runtime diff was silently empty. -EncodedCommand takes UTF-16LE
// base64, so nothing has to survive two layers of quoting. control_engine.mjs already
// does it this way.
const PS = s => 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '
  + Buffer.from(s, 'utf16le').toString('base64');

function safeExec(cmd, timeoutMs) {
  try {
    // execSync inherits stderr by default, so PowerShell's CLIXML progress records were
    // printed straight into the user's terminal on every capture. The data only ever came
    // from stdout; stderr here is noise.
    return execSync(cmd, {
      timeout: timeoutMs || 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

export async function captureRuntimeState() {
  const isWin = process.platform === 'win32';
  const st = { capturedAt: new Date().toISOString(), platform: process.platform };

  // Process list
  if (isWin) {
    const raw = safeExec(PS('Get-Process | ForEach-Object { $_.Name + "(" + $_.Id + ")" }'), 10000);
    st.processes = raw.split('\n').filter(Boolean).map(l => l.trim());
  } else {
    const raw = safeExec('ps -eo comm,pid --no-headers 2>/dev/null | head -150', 5000);
    st.processes = raw.split('\n').filter(Boolean).map(l => l.trim());
  }

  // Listening ports
  if (isWin) {
    const raw = safeExec(PS('Get-NetTCPConnection -State Listen | ForEach-Object { $_.LocalPort } | Sort-Object -Unique'), 8000);
    st.listeningPorts = raw.split('\n').map(l => l.trim()).filter(Boolean);
  } else {
    const raw = safeExec('ss -tlnp 2>/dev/null | awk \'NR>1{print $4}\' | sed \'s/.*://\' | sort -u', 5000);
    st.listeningPorts = raw.split('\n').filter(Boolean);
  }

  // Loaded drivers/modules
  if (isWin) {
    const raw = safeExec(PS('Get-CimInstance Win32_SystemDriver | Where-Object { $_.State -eq "Running" } | Select-Object -ExpandProperty Name | Sort-Object'), 10000);
    st.drivers = raw.split('\n').map(l => l.trim()).filter(Boolean);
  } else {
    const raw = safeExec('lsmod 2>/dev/null | awk \'NR>1{print $1}\' | sort', 5000);
    st.modules = raw.split('\n').filter(Boolean);
  }

  // Established connection count (canary for unexpected outbound activity)
  if (isWin) {
    const raw = safeExec(PS('(Get-NetTCPConnection -State Established | Measure-Object).Count'), 5000);
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
