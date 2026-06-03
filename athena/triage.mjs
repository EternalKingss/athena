// triage.mjs — Boot intelligence: health checks wired to detected security tools (Pillars 1 + 9)
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCachedCapabilities } from './capabilities.mjs';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function probe(cmd) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 8000 });
    return stdout.trim();
  } catch { return ''; }
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
    const out = await probe('netsh advfirewall show allprofiles state 2>nul');
    fwStatus = /\bON\b/i.test(out) ? 'enabled' : 'disabled';
  } else if (isMac) {
    const out = await probe('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null');
    fwStatus = /enabled/i.test(out) ? 'enabled' : 'disabled';
  } else if (hasTool(sec, 'ufw')) {
    const out = await probe('ufw status 2>/dev/null | head -1');
    fwStatus = /active/i.test(out) ? 'active' : 'inactive';
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
    const freeM  = d.match(/(\d+\.?\d*)\s*GB\s+free/i);
    const totalM = d.match(/^[^:]+:\s+(\d+\.?\d*)\s*GB/i) || d.match(/(\d+\.?\d*)\s*GB\s+total/i);
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
    const out     = await probe('fail2ban-client status 2>/dev/null | head -3');
    const running = /jail list|number of jail/i.test(out);
    checks.push({ name: 'fail2ban', status: running ? 'ok' : 'warn', detail: running ? 'running' : 'installed but not running' });
  }

  // ---- ClamAV ----
  if (hasTool(sec, 'clamscan') || hasTool(sec, 'clamd')) {
    const out   = await probe('clamscan --version 2>/dev/null | head -1');
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
    const out = await probe("ss -tlnp 2>/dev/null | grep -E ':22 |:22$' | head -3");
    if (out) {
      checks.push({ name: 'SSH', status: 'warn', detail: 'Port 22 listening — verify key-based auth is enforced' });
    }
  }

  // ---- Pending system updates (Linux only) ----
  if (!isWin && !isMac) {
    const aptOut = await probe('apt list --upgradable 2>/dev/null | tail -n +2 | wc -l');
    if (aptOut) {
      const pending = parseInt(aptOut, 10) || 0;
      checks.push({
        name:   'System updates',
        status: pending > 0 ? 'warn' : 'ok',
        detail: pending > 0 ? `${pending} packages can be upgraded` : 'Up to date',
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
