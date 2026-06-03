// audit.mjs — Append-only JSONL audit trail with session replay (Pillar 5)
import { mkdirSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

const AUDIT_DIR = join(PATHS.sessDir, 'audit');
const SENSITIVE  = /password|token|key|secret|auth|credential/i;

function sanitize(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : sanitize(v);
  }
  return out;
}

function todayFile() {
  return join(AUDIT_DIR, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

export async function logAuditEvent(type, data = {}) {
  const entry = { ts: new Date().toISOString(), type, ...sanitize(data) };
  try { await appendFile(todayFile(), JSON.stringify(entry) + '\n'); } catch {}
}

export function replayAudit(date) {
  const d    = date || new Date().toISOString().slice(0, 10);
  const file = join(AUDIT_DIR, `audit-${d}.jsonl`);
  if (!existsSync(file)) return `No audit log for ${d}.`;

  const lines  = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  if (!events.length) return `Audit log for ${d} is empty.`;

  return events.map(e => {
    const time  = e.ts.slice(11, 19);
    const extra = e.tool
      ? ` [${e.tool}]` + (e.args ? ' ' + JSON.stringify(e.args).slice(0, 120) : '')
      : (e.text ? ` ${e.text}` : '');
    return `${time}  ${e.type}${extra}`;
  }).join('\n');
}
