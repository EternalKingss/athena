// watcher.mjs -- Proactive engine (Phase 12)
// Polling loop with condition evaluators, tier-aware dispatch, and per-condition cooldowns.
// Start via startWatcher(emit); stop via stopWatcher().
// Each condition fires an event to the main emit channel -- the UI or CLI
// can surface it as a notification, action_taken, or approval_request.

import { exec } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isActive } from './core.mjs';
import { PATHS } from './paths.mjs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';

// ---- Condition registry ----
// Each condition: { id, desc, tier, intervalMs, cooldownMs, check() → null | string }
// check() returns null if all clear, or a string message if the condition fires.

const CONDITIONS = [

  // ── Disk fill rate ─────────────────────────────────────────────────────────
  {
    id:          'disk_low',
    desc:        'Disk space critically low',
    tier:        1,
    intervalMs:  5 * 60 * 1000,   // check every 5 min
    cooldownMs:  30 * 60 * 1000,  // don't repeat for 30 min
    _prevFree:   null,
    async check() {
      try {
        let freeGB = null;
        if (isWin) {
          const { stdout } = await execAsync(
            `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 AND DeviceID=\\"C:\\"' | ForEach-Object { [math]::Round($_.FreeSpace/1GB,1) }"`,
            { timeout: 6000 }
          );
          freeGB = parseFloat(stdout.trim());
        } else {
          const { stdout } = await execAsync("df -BG / | awk 'NR==2{print $4}'", { timeout: 4000 });
          freeGB = parseFloat(stdout.trim());
        }
        if (isNaN(freeGB)) return null;

        const prev = this._prevFree;
        this._prevFree = freeGB;

        if (freeGB < 5) return `Disk critically low: ${freeGB} GB free on ${isWin ? 'C:' : '/'}`;
        if (freeGB < 15) return `Disk low: ${freeGB} GB free on ${isWin ? 'C:' : '/'}`;
        // Rapid fill detection: lost > 2 GB since last check
        if (prev !== null && prev - freeGB > 2)
          return `Disk filling fast: dropped ${(prev - freeGB).toFixed(1)} GB since last check (now ${freeGB} GB free)`;
      } catch {}
      return null;
    },
  },

  // ── Kernel-Power 41 (Windows) ──────────────────────────────────────────────
  {
    id:          'kp41',
    desc:        'New Kernel-Power 41 crash event detected',
    tier:        1,
    intervalMs:  10 * 60 * 1000,
    cooldownMs:  60 * 60 * 1000,
    _lastEventTime: null,
    async check() {
      if (!isWin) return null;
      try {
        const { stdout } = await execAsync(
          `powershell -NoProfile -NonInteractive -Command "Get-WinEvent -FilterHashtable @{LogName='System';Id=41} -MaxEvents 1 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TimeCreated | Get-Date -Format 'o'"`,
          { timeout: 8000 }
        );
        const ts = stdout.trim();
        if (!ts) return null;
        const t = new Date(ts).getTime();
        if (isNaN(t)) return null;
        // Only fire if this event is newer than the last one we saw
        if (this._lastEventTime !== null && t <= this._lastEventTime) return null;
        this._lastEventTime = t;
        const ago = Math.round((Date.now() - t) / 60000);
        return `New Kernel-Power 41 event detected (${ago}m ago) -- unexpected shutdown/reboot. Run machine_health_trend or remediate "crash".`;
      } catch {}
      return null;
    },
  },

  // ── Temperature spike (Linux) ──────────────────────────────────────────────
  {
    id:          'temp_high',
    desc:        'CPU temperature critically high',
    tier:        1,
    intervalMs:  3 * 60 * 1000,
    cooldownMs:  10 * 60 * 1000,
    async check() {
      if (isWin) return null;
      try {
        // Try sensors first, fall back to thermal zones
        let tempC = null;
        try {
          const { stdout } = await execAsync("sensors 2>/dev/null | awk '/Core 0|Tdie|Package/{print $NF; exit}'", { timeout: 4000 });
          const m = stdout.match(/([\d.]+)/);
          if (m) tempC = parseFloat(m[1]);
        } catch {}
        if (tempC === null) {
          try {
            const { stdout } = await execAsync("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null", { timeout: 2000 });
            const raw = parseInt(stdout.trim(), 10);
            if (!isNaN(raw)) tempC = raw / 1000;
          } catch {}
        }
        if (tempC === null) return null;
        if (tempC >= 90) return `CPU temperature critical: ${tempC.toFixed(0)}°C -- risk of thermal shutdown`;
        if (tempC >= 80) return `CPU temperature high: ${tempC.toFixed(0)}°C -- check cooling`;
      } catch {}
      return null;
    },
  },

  // ── Network interface change ───────────────────────────────────────────────
  {
    id:          'net_change',
    desc:        'Network interface appeared or disappeared',
    tier:        0,
    intervalMs:  2 * 60 * 1000,
    cooldownMs:  5 * 60 * 1000,
    _prevIfaces: null,
    async check() {
      try {
        const cmd = isWin
          ? `powershell -NoProfile -NonInteractive -Command "Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name | Sort-Object"`
          : `ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | sort`;
        const { stdout } = await execAsync(cmd, { timeout: 5000 });
        const current = stdout.trim();
        if (this._prevIfaces === null) { this._prevIfaces = current; return null; }
        if (current === this._prevIfaces) return null;
        const prev = this._prevIfaces;
        this._prevIfaces = current;
        const prevSet = new Set(prev.split('\n').map(s => s.trim()).filter(Boolean));
        const currSet = new Set(current.split('\n').map(s => s.trim()).filter(Boolean));
        const added   = [...currSet].filter(x => !prevSet.has(x));
        const removed = [...prevSet].filter(x => !currSet.has(x));
        const parts = [];
        if (added.length)   parts.push(`added: ${added.join(', ')}`);
        if (removed.length) parts.push(`removed: ${removed.join(', ')}`);
        if (parts.length)   return `Network change detected -- ${parts.join('; ')}`;
      } catch {}
      return null;
    },
  },
];

// ---- Watcher state ----
const _timers  = new Map();   // conditionId → setInterval handle
const _lastFire = new Map();  // conditionId → timestamp of last fire

let _emit  = null;
let _active = false;

// Phase 16b: pending alerts queued when main agent is mid-turn
const _pendingAlerts = [];

// Checkpoint current task state to disk so a thermal/critical alert
// can resume after the hardware issue resolves.
async function checkpointTaskState(condId, message) {
  try {
    const { SESSION_TODOS } = await import('./core.mjs').catch(() => ({ SESSION_TODOS: [] }));
    const state = { checkpointAt: new Date().toISOString(), triggeredBy: condId, message, todos: SESSION_TODOS || [] };
    await writeFile(join(PATHS.memDir, 'task_state.json'), JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

// Drain pending alerts -- called by core.mjs after each turn completes.
export function drainPendingAlerts(emit) {
  while (_pendingAlerts.length) {
    const alert = _pendingAlerts.shift();
    (emit || _emit)?.({ ...alert });
  }
}

// ---- Start / stop ----
export function startWatcher(emit) {
  if (_active) return;
  _active = true;
  _emit   = emit;

  for (const cond of CONDITIONS) {
    const handle = setInterval(async () => {
      if (!_active) return;
      try {
        const now = Date.now();
        const last = _lastFire.get(cond.id) || 0;
        if (now - last < cond.cooldownMs) return;   // still in cooldown

        const msg = await cond.check();
        if (!msg) return;

        _lastFire.set(cond.id, now);
        const alert = { type: 'watcher_alert', condId: cond.id, desc: cond.desc, tier: cond.tier, message: msg };
        if (isActive()) {
          // Agent is mid-turn -- queue the alert to fire at the next safe boundary
          _pendingAlerts.push(alert);
          // Checkpoint for high-severity conditions (thermal/crash)
          if (cond.id === 'temp_high' || cond.id === 'kp41') checkpointTaskState(cond.id, msg).catch(() => {});
        } else {
          emit(alert);
        }
      } catch { /* non-fatal */ }
    }, cond.intervalMs);

    _timers.set(cond.id, handle);
  }

  emit({ type: 'system', text: `Watcher active -- monitoring ${CONDITIONS.length} conditions` });
}

export function stopWatcher() {
  _active = false;
  for (const handle of _timers.values()) clearInterval(handle);
  _timers.clear();
}

export function watcherStatus() {
  return {
    active:     _active,
    conditions: CONDITIONS.map(c => ({
      id:        c.id,
      desc:      c.desc,
      tier:      c.tier,
      intervalMs: c.intervalMs,
      cooldownMs: c.cooldownMs,
      lastFire:  _lastFire.get(c.id) || null,
    })),
  };
}
