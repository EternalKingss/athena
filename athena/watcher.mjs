// watcher.mjs -- Proactive engine (Phase 12)
// Polling loop with condition evaluators, tier-aware dispatch, and per-condition cooldowns.
// Start via startWatcher(emit); stop via stopWatcher().
// Each condition fires an event to the main emit channel.

import { exec } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isActive } from './core.mjs';
import { PATHS } from './paths.mjs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ---- Condition registry ----
const CONDITIONS = [

  // -- Disk fill rate -------------------------------------------------------
  {
    id:          'disk_low',
    desc:        'Disk space critically low',
    tier:        1,
    intervalMs:  5 * 60 * 1000,
    cooldownMs:  30 * 60 * 1000,
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
        if (prev !== null && prev - freeGB > 2)
          return `Disk filling fast: dropped ${(prev - freeGB).toFixed(1)} GB since last check (now ${freeGB} GB free)`;
      } catch {}
      return null;
    },
  },

  // -- Kernel-Power 41 (Windows) -------------------------------------------
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
        if (this._lastEventTime !== null && t <= this._lastEventTime) return null;
        this._lastEventTime = t;
        const ago = Math.round((Date.now() - t) / 60000);
        return `New Kernel-Power 41 event detected (${ago}m ago) -- unexpected shutdown/reboot. Run machine_health_trend or remediate "crash".`;
      } catch {}
      return null;
    },
  },

  // -- Temperature spike (Linux/Mac) ---------------------------------------
  {
    id:          'temp_high',
    desc:        'CPU temperature critically high',
    tier:        1,
    intervalMs:  3 * 60 * 1000,
    cooldownMs:  10 * 60 * 1000,
    async check() {
      if (isWin) return null;
      try {
        let tempC = null;
        if (!isMac) {
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
        } else {
          try {
            const { stdout } = await execAsync("sudo powermetrics --samplers smc -n 1 2>/dev/null | awk '/CPU die/{print $NF; exit}'", { timeout: 5000 });
            const m = stdout.match(/([\d.]+)/);
            if (m) tempC = parseFloat(m[1]);
          } catch {}
        }
        if (tempC === null) return null;
        if (tempC >= 90) return `CPU temperature critical: ${tempC.toFixed(0)}C -- risk of thermal shutdown`;
        if (tempC >= 80) return `CPU temperature high: ${tempC.toFixed(0)}C -- check cooling`;
      } catch {}
      return null;
    },
  },

  // -- Network interface change --------------------------------------------
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

  // -- RAM pressure --------------------------------------------------------
  {
    id:          'ram_pressure',
    desc:        'Available RAM critically low',
    tier:        1,
    intervalMs:  3 * 60 * 1000,
    cooldownMs:  15 * 60 * 1000,
    _prevFreeMB: null,
    async check() {
      try {
        let freeMB = null;
        if (isWin) {
          const { stdout } = await execAsync(
            `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"`,
            { timeout: 6000 }
          );
          const kb = parseInt(stdout.trim(), 10);
          if (!isNaN(kb)) freeMB = kb / 1024;
        } else if (isMac) {
          const { stdout } = await execAsync("vm_stat 2>/dev/null | awk '/Pages free/{print $3}'", { timeout: 4000 });
          const pages = parseInt(stdout.trim(), 10);
          if (!isNaN(pages)) freeMB = (pages * 4096) / (1024 * 1024);
        } else {
          const { stdout } = await execAsync("awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null", { timeout: 3000 });
          const kb = parseInt(stdout.trim(), 10);
          if (!isNaN(kb)) freeMB = kb / 1024;
        }
        if (freeMB === null || freeMB < 0) return null;
        const prev = this._prevFreeMB;
        this._prevFreeMB = freeMB;
        if (freeMB < 300) return `RAM critically low: ${Math.round(freeMB)} MB free -- risk of OOM`;
        if (freeMB < 500) return `RAM low: ${Math.round(freeMB)} MB free`;
        if (prev !== null && prev - freeMB > 1000)
          return `RAM dropping fast: lost ${Math.round(prev - freeMB)} MB since last check (now ${Math.round(freeMB)} MB free)`;
      } catch {}
      return null;
    },
  },

  // -- CPU spike -----------------------------------------------------------
  {
    id:          'cpu_spike',
    desc:        'CPU utilisation critically high',
    tier:        0,
    intervalMs:  5 * 60 * 1000,
    cooldownMs:  10 * 60 * 1000,
    _prevHigh:   false,
    async check() {
      try {
        let pct = null;
        if (isWin) {
          const { stdout } = await execAsync(
            `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average"`,
            { timeout: 8000 }
          );
          pct = parseFloat(stdout.trim());
        } else if (isMac) {
          const { stdout } = await execAsync(
            "top -l 2 -s 1 -n 0 2>/dev/null | grep 'CPU usage' | tail -1",
            { timeout: 6000 }
          );
          const m = stdout.match(/(\d+\.\d+)%\s+user/);
          const m2 = stdout.match(/(\d+\.\d+)%\s+sys/);
          if (m && m2) pct = parseFloat(m[1]) + parseFloat(m2[1]);
        } else {
          const { stdout } = await execAsync(
            "top -bn2 -d1 2>/dev/null | grep 'Cpu(s)' | tail -1 | awk -F',' '{gsub(/%.*id/,\"\"); for(i=1;i<=NF;i++) if($i~/id/) { gsub(/ /,\"\",$i); print 100-$i; exit }}'",
            { timeout: 8000 }
          );
          pct = parseFloat(stdout.trim());
        }
        if (isNaN(pct)) return null;
        const wasHigh = this._prevHigh;
        this._prevHigh = pct >= 95;
        // Only alert on 2 consecutive high readings to avoid transient spikes
        if (wasHigh && pct >= 95) return `CPU spike: ${Math.round(pct)}% utilisation for 2+ consecutive checks`;
      } catch {}
      return null;
    },
  },

  // -- Battery drain -------------------------------------------------------
  {
    id:          'battery_drain',
    desc:        'Battery critically low or draining fast',
    tier:        1,
    intervalMs:  3 * 60 * 1000,
    cooldownMs:  20 * 60 * 1000,
    _prevPct:    null,
    _prevTs:     null,
    async check() {
      try {
        let pct = null, charging = false;
        if (isWin) {
          const { stdout } = await execAsync(
            `powershell -NoProfile -NonInteractive -Command "$b = Get-WmiObject Win32_Battery; if ($b) { Write-Output ($b.EstimatedChargeRemaining.ToString() + ' ' + $b.BatteryStatus.ToString()) }"`,
            { timeout: 6000 }
          );
          const parts = stdout.trim().split(/\s+/);
          pct = parseInt(parts[0], 10);
          charging = parts[1] === '2';
        } else if (isMac) {
          const { stdout } = await execAsync("pmset -g batt 2>/dev/null | grep -Eo '[0-9]+%' | head -1", { timeout: 4000 });
          pct = parseInt(stdout.trim(), 10);
          const { stdout: s2 } = await execAsync("pmset -g batt 2>/dev/null | grep -o 'charging\\|AC'", { timeout: 3000 });
          charging = /charging|AC/i.test(s2);
        } else {
          try {
            const { stdout } = await execAsync("cat /sys/class/power_supply/BAT0/capacity 2>/dev/null || cat /sys/class/power_supply/BAT1/capacity 2>/dev/null", { timeout: 3000 });
            pct = parseInt(stdout.trim(), 10);
            const { stdout: s2 } = await execAsync("cat /sys/class/power_supply/BAT0/status 2>/dev/null || cat /sys/class/power_supply/BAT1/status 2>/dev/null", { timeout: 3000 });
            charging = /charging/i.test(s2);
          } catch { return null; }
        }
        if (isNaN(pct) || pct < 0 || pct > 100) return null;
        if (charging) { this._prevPct = null; this._prevTs = null; return null; }
        const now = Date.now();
        const prev = this._prevPct, prevTs = this._prevTs;
        this._prevPct = pct;
        this._prevTs  = now;
        if (pct < 5) return `Battery critically low: ${pct}% -- save work now`;
        if (pct < 10) return `Battery low: ${pct}% remaining`;
        if (prev !== null && prevTs !== null) {
          const elapsed = (now - prevTs) / 60000;
          const drainPer3min = ((prev - pct) / elapsed) * 3;
          if (drainPer3min > 5) return `Battery draining fast: ${drainPer3min.toFixed(1)}%/3min at ${pct}%`;
        }
      } catch {}
      return null;
    },
  },

  // -- SSH login failures --------------------------------------------------
  {
    id:          'login_failures',
    desc:        'Multiple SSH authentication failures detected',
    tier:        1,
    intervalMs:  5 * 60 * 1000,
    cooldownMs:  30 * 60 * 1000,
    async check() {
      if (isWin) return null; // Windows uses event log -- requires elevated; skip
      try {
        let count = 0;
        if (isMac) {
          const { stdout } = await execAsync(
            "log show --last 5m --predicate 'eventMessage contains \"Failed password\"' 2>/dev/null | wc -l",
            { timeout: 6000 }
          );
          count = parseInt(stdout.trim(), 10);
        } else {
          const { stdout } = await execAsync(
            "journalctl -u sshd --since '5 minutes ago' 2>/dev/null | grep -c 'Failed password' || grep -c 'Failed password' /var/log/auth.log 2>/dev/null | tail -1 || echo 0",
            { timeout: 5000 }
          );
          count = parseInt(stdout.trim().split('\n').pop(), 10);
        }
        if (!isNaN(count) && count >= 5) return `SSH brute-force detected: ${count} failed login attempts in last 5 minutes`;
      } catch {}
      return null;
    },
  },

  // -- Pending reboot required ---------------------------------------------
  {
    id:          'pending_reboot',
    desc:        'System requires a reboot to complete updates',
    tier:        0,
    intervalMs:  24 * 60 * 60 * 1000,  // check daily
    cooldownMs:  24 * 60 * 60 * 1000,
    async check() {
      try {
        if (isWin) {
          const { stdout } = await execAsync(
            `powershell -NoProfile -NonInteractive -Command "if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { 'yes' } else { 'no' }"`,
            { timeout: 6000 }
          );
          if (stdout.trim() === 'yes') return 'Windows Update: reboot required to complete pending updates';
        } else if (!isMac) {
          const { stdout } = await execAsync("test -f /var/run/reboot-required && cat /var/run/reboot-required-pkgs 2>/dev/null || echo ''", { timeout: 3000 });
          if (stdout !== undefined) {
            try {
              const { stdout: s } = await execAsync("test -f /var/run/reboot-required && echo yes || echo no", { timeout: 3000 });
              if (s.trim() === 'yes') return 'System update: reboot required (/var/run/reboot-required exists)';
            } catch {}
          }
        }
      } catch {}
      return null;
    },
  },

];

// ---- Watcher state ----
const _timers  = new Map();
const _lastFire = new Map();

let _emit  = null;
let _active = false;

// Phase 16b: pending alerts queued when main agent is mid-turn
const _pendingAlerts = [];

// Alert correlation: avoid storm when two related conditions fire together
const _alertHistory = [];
const CORRELATED_PAIRS = new Map([
  ['cpu_spike',    'ram_pressure'],
  ['ram_pressure', 'cpu_spike'],
]);
const CORRELATION_WINDOW_MS = 5 * 60 * 1000;

function shouldCorrelate(condId) {
  const partner = CORRELATED_PAIRS.get(condId);
  if (!partner) return false;
  const now = Date.now();
  return _alertHistory.some(h => h.condId === partner && now - h.ts < CORRELATION_WINDOW_MS);
}

function recordAlertHistory(condId) {
  _alertHistory.push({ condId, ts: Date.now() });
  if (_alertHistory.length > 50) _alertHistory.shift();
}

// Checkpoint current task state to disk for recovery after critical alert.
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
        const now  = Date.now();
        const last = _lastFire.get(cond.id) || 0;
        if (now - last < cond.cooldownMs) return;

        const msg = await cond.check();
        if (!msg) return;

        _lastFire.set(cond.id, now);
        recordAlertHistory(cond.id);

        // Merge correlated alerts into a single event to avoid alert storms
        if (shouldCorrelate(cond.id)) {
          const partner = CORRELATED_PAIRS.get(cond.id);
          const existing = (isActive() ? _pendingAlerts : []).find(a => a.condId === partner);
          if (existing) {
            existing.message += ' | ' + msg;
            return;
          }
        }

        const alert = { type: 'watcher_alert', condId: cond.id, desc: cond.desc, tier: cond.tier, message: msg };
        if (isActive()) {
          _pendingAlerts.push(alert);
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
