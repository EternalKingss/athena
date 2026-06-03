// machines.mjs — Machine fingerprinting and cross-session intelligence (Pillars 6 + 10)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

const MACHINES_DIR = join(PATHS.memDir, 'machines');

function machineId() {
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
}

function fingerprintPath() {
  return join(MACHINES_DIR, machineId() + '.json');
}

export async function saveFingerprint(caps) {
  const snapshot = {
    hostname:   hostname(),
    machineId:  machineId(),
    capturedAt: new Date().toISOString(),
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

  return {
    isReturn: true,
    lastSeen: prev.capturedAt,
    report:   diff
      ? `Back on ${hostname()} (last seen ${ago}). Changes since last visit:\n${diff}`
      : `Back on ${hostname()} (last seen ${ago}). No significant changes detected.`,
  };
}
