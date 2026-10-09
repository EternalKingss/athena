// threat.mjs -- Threat surface assessment with risk scoring (Pillar 7)
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCachedCapabilities } from './capabilities.mjs';
import { firewallState, avState, fail2banState } from './sysstate.mjs';
import { getListeningPorts } from './ports.mjs';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function probe(cmd, label) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    return stdout.trim();
  } catch (e) {
    if (label && process.env.DEBUG) console.debug(`[threat:${label}] ${e.code || e.message}`);
    return '';
  }
}

// Ports that deserve a finding even if common
const SENSITIVE_PORTS = new Set([21, 23, 25, 80, 110, 143, 445, 3306, 5432, 6379, 27017]);

function riskLevel(score) {
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

async function getUnusualSUID() {
  if (isWin || isMac) return [];
  // Known-safe SUID binaries (partial match is fine -- we just want to skip the obvious ones)
  const SAFE = new Set(['sudo', 'su', 'passwd', 'gpasswd', 'newgrp', 'chsh', 'chfn', 'mount', 'umount', 'ping', 'unix_chkpwd', 'pkexec', 'crontab', 'at']);
  const out  = await probe('find /usr /bin /sbin /usr/local -perm /4000 -type f 2>/dev/null | head -40', 'suid');
  return out.split('\n').filter(Boolean)
    .filter(p => !SAFE.has(p.split('/').pop()));
}

async function getWorldWritableDirs() {
  if (isWin || isMac) return [];
  const out = await probe("find /var /etc /srv -type d -perm -002 -not -path '*/tmp*' 2>/dev/null | head -20", 'world-writable');
  return out.split('\n').filter(Boolean);
}

async function getRunningServices() {
  if (isWin) {
    const out = await probe('sc query type= all state= running 2>nul | findstr SERVICE_NAME', 'services');
    return out.split('\n').map(l => l.replace(/SERVICE_NAME:\s*/, '').trim()).filter(Boolean);
  }
  if (isMac) {
    const out = await probe("launchctl list 2>/dev/null | awk 'NR>1 && $3 != \"\" {print $3}' | head -30", 'services');
    return out.split('\n').filter(Boolean);
  }
  const out = await probe("systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | head -40", 'services');
  return out.split('\n').filter(Boolean);
}

export async function assessThreatSurface() {
  const caps = getCachedCapabilities();
  const sec  = (caps?.security || []).map(s => s.toLowerCase());
  const findings = [];
  let score = 0;

  const [openPorts, unusualSUID, wwDirs, services, fw, av, f2b] = await Promise.all([
    getListeningPorts(),
    getUnusualSUID(),
    getWorldWritableDirs(),
    getRunningServices(),
    firewallState(),
    avState(),
    fail2banState(),
  ]);

  // Open ports
  const dangerous = openPorts.filter(p => SENSITIVE_PORTS.has(p));
  if (openPorts.length > 12) {
    score += 8;
    findings.push({ severity: 'medium', text: `${openPorts.length} listening ports -- consider reducing attack surface` });
  }
  if (dangerous.length) {
    score += dangerous.length * 7;
    findings.push({ severity: 'high', text: `Sensitive services exposed on port(s): ${dangerous.join(', ')}` });
  }
  if (openPorts.includes(22)) {
    score += 5;
    findings.push({ severity: 'medium', text: 'SSH (port 22) is open -- verify key-based auth is enforced and root login disabled' });
  }

  // Firewall -- actual state, on every platform. This used to short-circuit to "fine"
  // on Windows and macOS (`isWin || isMac`), so the two platforms where the firewall is
  // most often off could never produce a firewall finding.
  if (fw.enabled === false) {
    score += 20;
    findings.push({ severity: 'high', text: 'Firewall is OFF -- ' + fw.detail });
  } else if (fw.enabled === null) {
    score += 5;
    findings.push({ severity: 'medium', text: 'Firewall state could not be determined -- ' + fw.detail + ' (verify manually)' });
  }

  // fail2ban -- running, not merely installed
  if (!isWin && !isMac && openPorts.includes(22) && f2b.enabled === false) {
    score += 8;
    findings.push({ severity: 'medium', text: 'SSH is exposed and fail2ban is not protecting it -- ' + f2b.detail });
  }

  // Antivirus -- including Windows Defender, which was never checked at all
  if (av.enabled === false) {
    score += 12;
    findings.push({ severity: 'high', text: 'Antivirus not active -- ' + av.detail });
  } else if (av.enabled === null) {
    score += 3;
    findings.push({ severity: 'low', text: 'Antivirus state unknown -- ' + av.detail });
  } else if (av.sigDaysOld !== null && av.sigDaysOld > 7) {
    score += 6;
    findings.push({ severity: 'medium', text: 'Antivirus signatures are ' + av.sigDaysOld + ' days old' });
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
    findings.push({ severity: 'low', text: `${services.length} running services -- large attack surface` });
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
    protections: { firewall: fw, antivirus: av, fail2ban: f2b },
  };
}

export function formatThreatReport(threat) {
  const lines = [
    `## Threat Surface Assessment`,
    `**Risk Score:** ${threat.score}/100 -- **${threat.level}**`,
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

  const p = threat.protections;
  if (p) {
    lines.push('### Protections (measured, not inferred)');
    const mark = v => v.enabled === true ? '✓' : v.enabled === false ? '✗' : '?';
    lines.push(`  ${mark(p.firewall)} Firewall: ${p.firewall.detail}  [${p.firewall.source}]`);
    lines.push(`  ${mark(p.antivirus)} Antivirus: ${p.antivirus.detail}  [${p.antivirus.source}]`);
    if (p.fail2ban.enabled !== null)
      lines.push(`  ${mark(p.fail2ban)} fail2ban: ${p.fail2ban.detail}`);
    lines.push('');
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
