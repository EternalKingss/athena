// triage.mjs — Boot intelligence: health checks wired to detected security tools (Pillars 1 + 9)
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCachedCapabilities } from './capabilities.mjs';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function probe(cmd, label) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 8000 });
    return stdout.trim();
  } catch (e) {
    if (label && process.env.DEBUG) console.debug(`[triage:${label}] ${e.code || e.message}`);
    return '';
  }
}

function hasTool(sec, name) {
  return sec.some(s => s.toLowerCase().includes(name));
}

export async function runBootTriage() {
  const caps = getCachedCapabilities();
  const sec  = (caps?.security || []).map(s => s.toLowerCase());
  const checks = [];

  // ---- Firewall ----
  let fwStatus = 'unknown';
  if (isWin) {
    const out = await probe('netsh advfirewall show allprofiles state 2>nul', 'firewall');
    fwStatus = /\bON\b/i.test(out) ? 'enabled' : 'disabled';
  } else if (isMac) {
    const out = await probe('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null', 'firewall');
    fwStatus = /enabled/i.test(out) ? 'enabled' : 'disabled';
  } else if (hasTool(sec, 'ufw')) {
    // ufw status requires root — use systemctl or /etc/ufw/ufw.conf as rootless fallback
    const svcOut = await probe('systemctl is-active ufw 2>/dev/null', 'firewall-ufw-svc');
    if (/^active/.test(svcOut.trim())) {
      fwStatus = 'active';
    } else {
      // Try reading the config directly (no root needed)
      const confOut = await probe('grep -i "^ENABLED=" /etc/ufw/ufw.conf 2>/dev/null', 'firewall-ufw-conf');
      fwStatus = /=yes/i.test(confOut) ? 'active' : 'inactive';
    }
  } else if (hasTool(sec, 'iptables') || hasTool(sec, 'nftables') || hasTool(sec, 'firewalld')) {
    fwStatus = 'configured';
  } else {
    fwStatus = 'none detected';
  }
  const fwOk = ['enabled', 'active', 'configured'].includes(fwStatus);
  checks.push({ name: 'Firewall', status: fwOk ? 'ok' : 'warn', detail: fwStatus });

  // ---- Disk space ----
  const disks = caps?.system?.disks || [];
  for (const d of disks) {
    // df -h outputs G/Gi on Linux/Mac; wmic computes GB on Windows — match all forms
    const freeM  = d.match(/(\d+\.?\d*)\s*G[iB]*\s+free/i);
    const totalM = d.match(/(\d+\.?\d*)\s*G[iB]*\s+total/i) || d.match(/:\s*(\d+\.?\d*)\s*G[iB]*\s*\(/i);
    const label  = (d.split(':')[0] || 'Disk').trim();
    if (freeM && totalM) {
      const freeGB  = parseFloat(freeM[1]);
      const totalGB = parseFloat(totalM[1]);
      const pct     = totalGB > 0 ? freeGB / totalGB * 100 : 100;
      checks.push({
        name:   `Disk (${label})`,
        status: pct < 10 ? 'critical' : pct < 20 ? 'warn' : 'ok',
        detail: `${freeGB.toFixed(1)} GB free (${pct.toFixed(0)}%)`,
      });
    } else {
      checks.push({ name: `Disk (${label})`, status: 'ok', detail: d });
    }
  }

  // ---- fail2ban (Linux only) ----
  if (!isWin && !isMac && hasTool(sec, 'fail2ban')) {
    const out     = await probe('fail2ban-client status 2>/dev/null | head -3', 'fail2ban');
    const running = /jail list|number of jail/i.test(out);
    checks.push({ name: 'fail2ban', status: running ? 'ok' : 'warn', detail: running ? 'running' : 'installed but not running' });
  }

  // ---- ClamAV ----
  if (hasTool(sec, 'clamscan') || hasTool(sec, 'clamd')) {
    const out   = await probe('clamscan --version 2>/dev/null | head -1', 'clamav');
    const year  = new Date().getFullYear();
    const fresh = out.includes(String(year)) || out.includes(String(year - 1));
    checks.push({
      name:   'ClamAV',
      status: fresh ? 'ok' : 'warn',
      detail: out ? out.slice(0, 80) : 'installed',
    });
  }

  // ---- SSH exposure ----
  if (!isWin) {
    // Linux: ss with netstat fallback. Mac: lsof or netstat (different output format — uses .22 not :22)
    const sshCmd = isMac
      ? "lsof -nP -iTCP:22 -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -3 || netstat -an 2>/dev/null | grep -E '\\.22\\s.*LISTEN' | head -3"
      : "ss -tlnp 2>/dev/null | grep -E ':22\\s|:22$' | head -3 || netstat -tlnp 2>/dev/null | grep ':22' | head -3";
    const out = await probe(sshCmd, 'ssh');
    if (out) {
      checks.push({ name: 'SSH', status: 'warn', detail: 'Port 22 listening — verify key-based auth is enforced' });
    }
  }

  // ---- Pending system updates ----
  if (!isWin && !isMac) {
    // Linux (apt)
    const aptOut = await probe('apt list --upgradable 2>/dev/null | tail -n +2 | wc -l', 'updates');
    if (aptOut) {
      const pending = parseInt(aptOut, 10) || 0;
      checks.push({
        name:   'System updates',
        status: pending > 0 ? 'warn' : 'ok',
        detail: pending > 0 ? `${pending} packages can be upgraded` : 'Up to date',
      });
    }
  }

  if (isMac) {
    // macOS software updates + brew outdated
    const swOut = await probe("softwareupdate -l 2>/dev/null | grep -c '\\*' || echo 0", 'updates-mac-sw');
    const brewOut = await probe('brew outdated 2>/dev/null | wc -l | tr -d " "', 'updates-mac-brew');
    const swPending  = Math.max(0, parseInt(swOut,  10) || 0);
    const brewPending = Math.max(0, parseInt(brewOut, 10) || 0);
    const total = swPending + brewPending;
    const parts = [swPending > 0 ? `${swPending} macOS update(s)` : '', brewPending > 0 ? `${brewPending} brew package(s)` : ''].filter(Boolean);
    checks.push({
      name:   'System updates',
      status: total > 0 ? 'warn' : 'ok',
      detail: total > 0 ? parts.join(', ') + ' available' : 'Up to date',
    });
  }

  if (isWin) {
    // Windows pending updates via PowerShell COM (no install needed)
    const wuOut = await probe(
      'powershell -NoProfile -Command "(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search(\'IsInstalled=0\').Updates.Count" 2>nul',
      'updates-win'
    );
    const pending = parseInt(wuOut, 10);
    if (!isNaN(pending)) {
      checks.push({
        name:   'System updates',
        status: pending > 0 ? 'warn' : 'ok',
        detail: pending > 0 ? `${pending} Windows updates pending` : 'Up to date',
      });
    }
  }

  // ---- Security tools inventory (info only) ----
  const useful = sec.filter(s =>
    ['nmap', 'lynis', 'clamscan', 'fail2ban', 'ufw', 'iptables', 'nftables', 'tshark', 'tcpdump', 'masscan'].some(k => s.includes(k))
  );
  if (useful.length) {
    checks.push({ name: 'Security tools', status: 'info', detail: `Available: ${useful.join(', ')}` });
  }

  // ---- Summary ----
  const critical = checks.filter(c => c.status === 'critical');
  const warns    = checks.filter(c => c.status === 'warn');
  const okCount  = checks.filter(c => c.status === 'ok').length;

  let summary;
  if (critical.length) {
    summary = `CRITICAL: ${critical.map(c => c.name).join(', ')} require immediate attention.`;
  } else if (warns.length) {
    summary = `${warns.length} warning(s): ${warns.map(c => c.name).join(', ')}.`;
  } else {
    summary = `All ${okCount} checks passed. Machine looks healthy.`;
  }

  return { summary, checks };
}

const STATUS_ICON = { ok: '✓', warn: '⚠', critical: '✗', info: 'ℹ', unknown: '?' };

export function formatTriageReport(triage) {
  const lines = [`Boot Triage — ${new Date().toLocaleString()}`, ''];
  for (const c of triage.checks) {
    lines.push(`  ${STATUS_ICON[c.status] || '?'} ${c.name}: ${c.detail}`);
  }
  lines.push('', `Summary: ${triage.summary}`);
  return lines.join('\n');
}
