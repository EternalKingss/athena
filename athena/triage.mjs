// triage.mjs — Boot intelligence: health checks wired to detected security tools (Pillars 1 + 9)
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCachedCapabilities } from './capabilities.mjs';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Encode PowerShell script for -EncodedCommand to avoid quote hell on Windows
function _psEnc(script) {
  const buf = Buffer.allocUnsafe(script.length * 2);
  for (let i = 0; i < script.length; i++) buf.writeUInt16LE(script.charCodeAt(i), i * 2);
  return 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + buf.toString('base64');
}

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

  // ---- Internet connectivity ----
  // Quick check — is the machine online? Uses capabilities cache if available, otherwise probes.
  const netCaps = caps?.network;
  if (netCaps) {
    const online = Boolean(netCaps.publicIP);
    checks.push({
      name:   'Internet',
      status: online ? 'ok' : 'warn',
      detail: online ? 'online (' + netCaps.publicIP + ')' : 'no public IP detected — may be offline or blocked',
    });
  } else {
    // capabilities not cached yet — do a lightweight probe
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
      const ipData = await ipRes.json();
      checks.push({ name: 'Internet', status: 'ok', detail: 'online (' + ipData.ip + ')' });
    } catch {
      checks.push({ name: 'Internet', status: 'warn', detail: 'no response from internet — may be offline' });
    }
  }

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

  // ---- Security tools inventory (info only) ----
  const useful = sec.filter(s =>
    ['nmap', 'lynis', 'clamscan', 'fail2ban', 'ufw', 'iptables', 'nftables', 'tshark', 'tcpdump', 'masscan'].some(k => s.includes(k))
  );
  if (useful.length) {
    checks.push({ name: 'Security tools', status: 'info', detail: `Available: ${useful.join(', ')}` });
  }

  // ---- Windows checks (parallel) ----
  // Run all Windows probes + slow WU check simultaneously so total wait = longest single check
  if (isWin) {
    const wuScript  = 'powershell -NoProfile -NonInteractive -Command "(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search(\'IsInstalled=0\').Updates.Count" 2>nul';
    const [uptOut, resOut, defOut, crashOut, kp41Out, wuOut] = await Promise.all([
      probe(_psEnc('$o=Get-CimInstance Win32_OperatingSystem; $upDays=[math]::Floor($o.LocalDateTime.Subtract($o.LastBootUpTime).TotalDays); Write-Output ("Uptime=" + $upDays + "d")'), 'uptime-win'),
      probe(_psEnc('$o=Get-CimInstance Win32_OperatingSystem; $ramPct=[math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/$o.TotalVisibleMemorySize*100,0); $cpuPct=(Get-CimInstance Win32_Processor).LoadPercentage; Write-Output ("RAM=" + $ramPct); Write-Output ("CPU=" + $cpuPct)'), 'resources-win'),
      probe(_psEnc('$d=Get-MpComputerStatus -ErrorAction SilentlyContinue; if($d){$daysOld=[math]::Floor((Get-Date).Subtract($d.AntivirusSignatureLastUpdated).TotalDays); Write-Output ("DefEnabled="+$d.AntivirusEnabled); Write-Output ("RTP="+$d.RealTimeProtectionEnabled); Write-Output ("SigDaysOld="+$daysOld)}else{Write-Output "Defender=unavailable"}'), 'defender-win'),
      probe(_psEnc('$cutoff=(Get-Date).AddHours(-24); $evts=Get-WinEvent -FilterHashtable @{LogName="Application";Id=1000;StartTime=$cutoff} -MaxEvents 10 -ErrorAction SilentlyContinue; Write-Output ("AppCrashes="+($evts ? $evts.Count : 0)); if($evts){$evts | Select-Object -First 3 | ForEach-Object { Write-Output ("Crash: "+$_.ProviderName+" @ "+$_.TimeCreated.ToString("HH:mm")) }}'), 'crashes-win'),
      probe(_psEnc('$cutoff=(Get-Date).AddDays(-7); $evts=Get-WinEvent -FilterHashtable @{LogName="System";Id=41;StartTime=$cutoff} -MaxEvents 10 -ErrorAction SilentlyContinue; Write-Output ("KP41="+($evts ? $evts.Count : 0)); if($evts){$evts | Select-Object -First 3 | ForEach-Object { Write-Output ("KP41: "+$_.TimeCreated.ToString("MM/dd HH:mm")) }}'), 'kp41-win'),
      execAsync(wuScript, { timeout: 15000 }).then(r => r.stdout?.trim() || '').catch(e => ({ _err: e })),
    ]);

    // Uptime
    const upDays = parseInt(uptOut?.match(/Uptime=(\d+)/)?.[1] || '', 10);
    if (!isNaN(upDays)) checks.push({
      name: 'Uptime', status: upDays > 30 ? 'warn' : 'ok',
      detail: upDays === 0 ? 'Less than 1 day' : upDays + ' day' + (upDays !== 1 ? 's' : '') + (upDays > 30 ? ' — long uptime, pending reboot likely' : ''),
    });

    // RAM + CPU
    const ramPct = parseInt(resOut?.match(/RAM=(\d+)/)?.[1] || '', 10);
    const cpuPct = parseInt(resOut?.match(/CPU=(\d+)/)?.[1] || '', 10);
    if (!isNaN(ramPct)) checks.push({ name: 'RAM', status: ramPct > 92 ? 'critical' : ramPct > 80 ? 'warn' : 'ok', detail: ramPct + '% in use' });
    if (!isNaN(cpuPct) && cpuPct > 70) checks.push({ name: 'CPU', status: 'warn', detail: cpuPct + '% load (snapshot)' });

    // Windows Defender
    if (defOut) {
      if (/Defender=unavailable/i.test(defOut)) {
        checks.push({ name: 'Antivirus', status: 'warn', detail: 'Windows Defender unavailable (third-party AV?)' });
      } else {
        const rtpOn  = /RTP=True/i.test(defOut);
        const avOn   = /DefEnabled=True/i.test(defOut);
        const daysM  = defOut.match(/SigDaysOld=(\d+)/);
        const sigAge = daysM ? parseInt(daysM[1], 10) : 0;
        checks.push({
          name: 'Windows Defender',
          status: (!avOn || !rtpOn) ? 'critical' : sigAge > 7 ? 'warn' : 'ok',
          detail: (avOn && rtpOn ? 'active' : 'DISABLED') + (sigAge > 3 ? ', signatures ' + sigAge + 'd old' : ', signatures current'),
        });
      }
    }

    // App crashes
    const crashCount = parseInt(crashOut?.match(/AppCrashes=(\d+)/)?.[1] || '0', 10);
    if (crashCount > 0) {
      const details = (crashOut || '').split('\n').filter(l => l.startsWith('Crash:')).map(l => l.slice(7)).join(', ');
      checks.push({ name: 'App crashes', status: crashCount > 3 ? 'critical' : 'warn', detail: crashCount + ' in last 24h: ' + (details || 'see Event Viewer') });
    }

    // Kernel-Power 41 (unexpected shutdown/reboot)
    const kp41Count = parseInt(kp41Out?.match(/KP41=(\d+)/)?.[1] || '0', 10);
    if (kp41Count > 0) {
      const kp41Times = (kp41Out || '').split('\n').filter(l => l.startsWith('KP41:')).map(l => l.slice(6)).join(', ');
      checks.push({ name: 'Unexpected reboots', status: kp41Count >= 3 ? 'critical' : 'warn', detail: kp41Count + ' in last 7 days' + (kp41Times ? ': ' + kp41Times : '') + ' — investigate thermal/RAM/PSU' });
    }

    // Windows Update
    if (typeof wuOut === 'string') {
      const pending = parseInt(wuOut.trim(), 10);
      if (!isNaN(pending)) checks.push({ name: 'System updates', status: pending > 0 ? 'warn' : 'ok', detail: pending > 0 ? pending + ' Windows updates pending' : 'Up to date' });
      else checks.push({ name: 'System updates', status: 'unknown', detail: 'COM check returned no data — run Windows Update manually' });
    } else {
      const wuReason = wuOut?._err?.killed || /timed?.?out/i.test(wuOut?._err?.message || '') ? 'check timed out' : 'COM check failed';
      checks.push({ name: 'System updates', status: 'unknown', detail: wuReason + ' — run Windows Update manually' });
    }
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
