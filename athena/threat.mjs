// threat.mjs — Threat surface assessment with risk scoring (Pillar 7)
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCachedCapabilities } from './capabilities.mjs';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function probe(cmd) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    return stdout.trim();
  } catch { return ''; }
}

// Ports that deserve a finding even if common
const SENSITIVE_PORTS = new Set([21, 23, 25, 80, 110, 143, 445, 3306, 5432, 6379, 27017]);

function riskLevel(score) {
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

async function getListeningPorts() {
  let out = '';
  if (isWin) {
    out = await probe('netstat -an 2>nul | findstr LISTENING');
  } else {
    out = await probe('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null');
  }
  return out.split('\n')
    .filter(l => isWin ? Boolean(l.trim()) : l.includes('LISTEN'))
    .map(l => { const m = l.match(/:(\d+)\s/); return m ? Number(m[1]) : null; })
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
}

async function getUnusualSUID() {
  if (isWin || isMac) return [];
  // Known-safe SUID binaries (partial match is fine — we just want to skip the obvious ones)
  const SAFE = new Set(['sudo', 'su', 'passwd', 'gpasswd', 'newgrp', 'chsh', 'chfn', 'mount', 'umount', 'ping', 'unix_chkpwd', 'pkexec', 'crontab', 'at']);
  const out  = await probe('find /usr /bin /sbin /usr/local -perm /4000 -type f 2>/dev/null | head -40');
  return out.split('\n').filter(Boolean)
    .filter(p => !SAFE.has(p.split('/').pop()));
}

async function getWorldWritableDirs() {
  if (isWin || isMac) return [];
  const out = await probe("find /var /etc /srv -type d -perm -002 -not -path '*/tmp*' 2>/dev/null | head -20");
  return out.split('\n').filter(Boolean);
}

async function getRunningServices() {
  if (isWin) {
    const out = await probe('sc query type= all state= running 2>nul | findstr SERVICE_NAME');
    return out.split('\n').map(l => l.replace(/SERVICE_NAME:\s*/, '').trim()).filter(Boolean);
  }
  if (isMac) {
    const out = await probe("launchctl list 2>/dev/null | awk 'NR>1 && $3 != \"\" {print $3}' | head -30");
    return out.split('\n').filter(Boolean);
  }
  const out = await probe("systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | head -40");
  return out.split('\n').filter(Boolean);
}

export async function assessThreatSurface() {
  const caps = getCachedCapabilities();
  const sec  = (caps?.security || []).map(s => s.toLowerCase());
  const findings = [];
  let score = 0;

  const [openPorts, unusualSUID, wwDirs, services] = await Promise.all([
    getListeningPorts(),
    getUnusualSUID(),
    getWorldWritableDirs(),
    getRunningServices(),
  ]);

  // Open ports
  const dangerous = openPorts.filter(p => SENSITIVE_PORTS.has(p));
  if (openPorts.length > 12) {
    score += 8;
    findings.push({ severity: 'medium', text: `${openPorts.length} listening ports — consider reducing attack surface` });
  }
  if (dangerous.length) {
    score += dangerous.length * 7;
    findings.push({ severity: 'high', text: `Sensitive services exposed on port(s): ${dangerous.join(', ')}` });
  }
  if (openPorts.includes(22)) {
    score += 5;
    findings.push({ severity: 'medium', text: 'SSH (port 22) is open — verify key-based auth is enforced and root login disabled' });
  }

  // Firewall
  const hasFirewall = isWin || isMac || sec.some(s =>
    ['ufw', 'iptables', 'nftables', 'firewalld'].some(fw => s.includes(fw))
  );
  if (!hasFirewall) {
    score += 20;
    findings.push({ severity: 'high', text: 'No firewall detected. Install and enable ufw, iptables, or nftables.' });
  }

  // fail2ban
  const hasFail2ban = sec.some(s => s.includes('fail2ban'));
  if (!hasFail2ban && !isWin && openPorts.includes(22)) {
    score += 8;
    findings.push({ severity: 'medium', text: 'No fail2ban detected — SSH brute-force protection is absent' });
  }

  // AV
  const hasAV = sec.some(s => ['clamscan', 'clamd', 'maldet'].some(a => s.includes(a)));
  if (!hasAV && !isWin) {
    score += 8;
    findings.push({ severity: 'medium', text: 'No antivirus detected (ClamAV recommended)' });
  }

  // SUID
  if (unusualSUID.length) {
    score += Math.min(unusualSUID.length * 3, 15);
    findings.push({
      severity: 'medium',
      text: `${unusualSUID.length} unusual SUID binaries: ${unusualSUID.slice(0, 5).join(', ')}${unusualSUID.length > 5 ? '…' : ''}`,
    });
  }

  // World-writable dirs
  if (wwDirs.length > 2) {
    score += 5;
    findings.push({ severity: 'low', text: `${wwDirs.length} world-writable directories outside /tmp` });
  }

  // Service count
  if (services.length > 35) {
    score += 5;
    findings.push({ severity: 'low', text: `${services.length} running services — large attack surface` });
  }

  score = Math.min(score, 100);

  return {
    score,
    level: riskLevel(score),
    openPorts,
    unusualSUID,
    wwDirs,
    findings,
    services: services.slice(0, 25),
  };
}

export function formatThreatReport(threat) {
  const lines = [
    `## Threat Surface Assessment`,
    `**Risk Score:** ${threat.score}/100 — **${threat.level}**`,
    '',
  ];

  if (threat.findings.length) {
    lines.push('### Findings');
    const icon = { high: '✗', medium: '⚠', low: '○' };
    for (const f of threat.findings) {
      lines.push(`  ${icon[f.severity] || '?'} [${f.severity.toUpperCase()}] ${f.text}`);
    }
    lines.push('');
  } else {
    lines.push('No significant threats detected.', '');
  }

  if (threat.openPorts.length) {
    lines.push('### Listening Ports');
    lines.push(`  ${threat.openPorts.join(', ')}`);
    lines.push('');
  }

  if (threat.unusualSUID.length) {
    lines.push('### Unusual SUID Binaries');
    threat.unusualSUID.slice(0, 10).forEach(p => lines.push(`  ${p}`));
    lines.push('');
  }

  return lines.join('\n');
}
