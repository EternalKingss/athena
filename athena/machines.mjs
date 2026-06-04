// machines.mjs — Machine fingerprinting and cross-session intelligence (Pillars 6 + 10)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { hostname, cpus, totalmem, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

const MACHINES_DIR = join(PATHS.memDir, 'machines');

// Hardware fingerprint — stable across Linux/Windows dual-boot on the same physical machine.
// Uses CPU model + core count + total RAM + first non-loopback MAC address.
// Hostname is intentionally excluded because it differs per OS.
function machineId() {
  const cpu   = cpus()[0]?.model?.trim() || 'unknown-cpu';
  const cores = String(cpus().length);
  const ram   = String(Math.round(totalmem() / (1024 ** 3)));   // GB, rounded

  // First non-loopback, non-internal MAC address
  let mac = 'no-mac';
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac;
        break;
      }
    }
    if (mac !== 'no-mac') break;
  }

  const raw = `${cpu}|${cores}|${ram}GB|${mac}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function fingerprintPath() {
  return join(MACHINES_DIR, machineId() + '.json');
}

export async function saveFingerprint(caps) {
  // Load existing snapshot so we can accumulate hostnames seen on this hardware.
  const existing = loadFingerprint();
  const seenHostnames = new Set(existing?.seenHostnames || []);
  seenHostnames.add(hostname());

  const snapshot = {
    machineId:     machineId(),
    seenHostnames: [...seenHostnames],   // e.g. ["DESKTOP-ABC", "mint-laptop"]
    lastHostname:  hostname(),
    capturedAt:    new Date().toISOString(),
    caps,
  };
  try {
    await mkdir(MACHINES_DIR, { recursive: true });
    await writeFile(fingerprintPath(), JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.warn(`[machines] fingerprint save failed: ${e.message}`);
  }
  return snapshot;
}

export function loadFingerprint() {
  const fp = fingerprintPath();
  if (!existsSync(fp)) return null;
  try { return JSON.parse(readFileSync(fp, 'utf8')); }
  catch { return null; }
}

function listDiff(prev = [], curr = []) {
  const ps = new Set(prev);
  const cs = new Set(curr);
  return {
    added:   curr.filter(x => !ps.has(x)),
    removed: prev.filter(x => !cs.has(x)),
  };
}

function formatDiff(label, diff) {
  const lines = [];
  if (diff.added.length)   lines.push(`  + ${label}: ${diff.added.join(', ')}`);
  if (diff.removed.length) lines.push(`  − ${label}: ${diff.removed.join(', ')}`);
  return lines;
}

export function diffFingerprints(prevCaps, currCaps) {
  if (!prevCaps) return '';
  const lines = [];

  const listFields = [
    ['langs',      'Languages'],
    ['compilers',  'Compilers'],
    ['pkgMgrs',    'Package managers'],
    ['containers', 'Containers'],
    ['databases',  'Databases'],
    ['browsers',   'Browsers'],
    ['ides',       'IDEs'],
    ['devops',     'DevOps tools'],
    ['utils',      'Utilities'],
    ['security',   'Security tools'],
    ['gpus',       'GPUs'],
    ['mcp',        'MCP servers'],
  ];

  for (const [key, label] of listFields) {
    const d = listDiff(prevCaps[key], currCaps?.[key]);
    lines.push(...formatDiff(label, d));
  }

  const ps = prevCaps.system || {};
  const cs = currCaps?.system || {};
  if (ps.ramTotal && cs.ramTotal && ps.ramTotal !== cs.ramTotal)
    lines.push(`  ~ RAM: ${ps.ramTotal} → ${cs.ramTotal}`);
  if (ps.cpuCores && cs.cpuCores && ps.cpuCores !== cs.cpuCores)
    lines.push(`  ~ CPU cores: ${ps.cpuCores} → ${cs.cpuCores}`);

  return lines.join('\n');
}

function formatTimeAgo(iso) {
  const ms   = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs  = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export async function checkMachineReturn(currentCaps) {
  const prev = loadFingerprint();

  if (!prev) {
    return {
      isReturn: false,
      lastSeen: null,
      report:   `First visit on this machine (${hostname()}).`,
    };
  }

  const diff = diffFingerprints(prev.caps, currentCaps);
  const ago  = formatTimeAgo(prev.capturedAt);

  // If this OS hostname differs from the last recorded one, note the OS switch.
  const switchNote = prev.lastHostname && prev.lastHostname !== hostname()
    ? ` (was on "${prev.lastHostname}", now on "${hostname()}" — same hardware)`
    : '';

  return {
    isReturn: true,
    lastSeen: prev.capturedAt,
    report:   diff
      ? `Back on this machine${switchNote} (last seen ${ago}). Changes since last visit:\n${diff}`
      : `Back on this machine${switchNote} (last seen ${ago}). No significant changes detected.`,
  };
}
