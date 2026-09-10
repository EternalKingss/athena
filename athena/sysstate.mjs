// sysstate.mjs -- single source of truth for "is this protection actually ON?"
//
// Why this file exists: threat.mjs and triage.mjs both answered "is there a firewall?"
// and answered it differently. threat.mjs assumed `isWin || isMac` meant yes and added
// zero to the risk score, so on the two platforms where the firewall is most often off
// it could never report a firewall problem -- while triage.mjs, in the same generated
// report, correctly said it was disabled. Both now call in here.
//
// The other habit this replaces: treating "the binary is on PATH" as "the protection is
// enabled". `ufw` being installed says nothing about whether it is running.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function probe(cmd, ms = 8000) {
  try { const { stdout } = await execAsync(cmd, { timeout: ms }); return (stdout || '').trim(); }
  catch { return ''; }
}

// Encode PowerShell for -EncodedCommand: avoids quoting problems and, more importantly,
// avoids locale-dependent output parsing.
function psEnc(script) {
  const buf = Buffer.allocUnsafe(script.length * 2);
  for (let i = 0; i < script.length; i++) buf.writeUInt16LE(script.charCodeAt(i), i * 2);
  return 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + buf.toString('base64');
}

/**
 * Firewall state.
 * @returns {Promise<{enabled: boolean|null, detail: string, source: string}>}
 *   enabled === null means genuinely unknown -- callers must not score that as "fine".
 */
export async function firewallState() {
  if (isWin) {
    // Get-NetFirewallProfile returns booleans, so this works on non-English Windows.
    // The old netsh + /\bON\b/i test failed on localised output and also reported
    // "enabled" when ANY ONE of the three profiles was on.
    const out = await probe(psEnc(
      '$p = Get-NetFirewallProfile -ErrorAction SilentlyContinue; ' +
      'if ($p) { foreach ($x in $p) { Write-Output ($x.Name + "=" + $x.Enabled) } } else { Write-Output "NOPS" }'
    ));
    if (out && !/NOPS/.test(out)) {
      const profiles = out.split('\n').map(l => l.trim()).filter(l => l.includes('='))
        .map(l => { const [n, v] = l.split('='); return { name: n, on: /true/i.test(v) }; });
      if (profiles.length) {
        const off = profiles.filter(p => !p.on).map(p => p.name);
        return off.length
          ? { enabled: false, detail: 'disabled on profile(s): ' + off.join(', '), source: 'Get-NetFirewallProfile' }
          : { enabled: true, detail: 'enabled on all profiles (' + profiles.map(p => p.name).join(', ') + ')', source: 'Get-NetFirewallProfile' };
      }
    }
    // Fallback: netsh. Require every "State" line to read ON, and treat a localised
    // response we cannot parse as unknown rather than as healthy.
    const ns = await probe('netsh advfirewall show allprofiles state 2>nul');
    const states = [...ns.matchAll(/^\s*State\s+(\S+)\s*$/gim)].map(m => m[1]);
    if (!states.length) return { enabled: null, detail: 'could not determine (unparsed netsh output)', source: 'netsh' };
    const allOn = states.every(s => /^on$/i.test(s));
    const anyOff = states.some(s => /^off$/i.test(s));
    if (allOn) return { enabled: true, detail: 'enabled on all ' + states.length + ' profiles', source: 'netsh' };
    if (anyOff) return { enabled: false, detail: states.filter(s => /^off$/i.test(s)).length + ' of ' + states.length + ' profiles disabled', source: 'netsh' };
    return { enabled: null, detail: 'could not determine (localised output: ' + states.join(', ') + ')', source: 'netsh' };
  }

  if (isMac) {
    const out = await probe('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null');
    if (!out) return { enabled: null, detail: 'could not determine', source: 'socketfilterfw' };
    // "Firewall is enabled. (State = 1)" / "Firewall is disabled. (State = 0)"
    if (/state\s*=\s*[12]/i.test(out) || /\benabled\b/i.test(out))
      return { enabled: true, detail: 'application firewall enabled', source: 'socketfilterfw' };
    return { enabled: false, detail: 'application firewall disabled', source: 'socketfilterfw' };
  }

  // Linux: check running state, not installed-ness.
  const ufwSvc = await probe('systemctl is-active ufw 2>/dev/null', 4000);
  if (/^active/.test(ufwSvc)) return { enabled: true, detail: 'ufw active', source: 'systemctl' };
  const fwd = await probe('systemctl is-active firewalld 2>/dev/null', 4000);
  if (/^active/.test(fwd)) return { enabled: true, detail: 'firewalld active', source: 'systemctl' };
  const ufwConf = await probe('grep -i "^ENABLED=" /etc/ufw/ufw.conf 2>/dev/null', 4000);
  if (/=yes/i.test(ufwConf)) return { enabled: true, detail: 'ufw enabled in config', source: '/etc/ufw/ufw.conf' };
  const nft = await probe('nft list ruleset 2>/dev/null | head -20', 5000);
  if (nft && /\b(chain|table)\b/.test(nft)) return { enabled: true, detail: 'nftables ruleset present', source: 'nft' };
  const ipt = await probe("iptables -S 2>/dev/null | grep -v '^-P' | head -5", 5000);
  if (ipt.trim()) return { enabled: true, detail: 'iptables rules present', source: 'iptables' };
  const anyTool = await probe('command -v ufw firewalld nft iptables 2>/dev/null | head -1', 3000);
  if (!anyTool) return { enabled: false, detail: 'no firewall tooling found', source: 'PATH' };
  return { enabled: false, detail: 'firewall tooling installed but no active ruleset', source: 'probe' };
}

/**
 * Antivirus / endpoint protection state.
 * @returns {Promise<{enabled: boolean|null, detail: string, sigDaysOld: number|null, source: string}>}
 */
export async function avState() {
  if (isWin) {
    // Windows was skipped entirely before -- Defender was never queried by threat.mjs.
    const out = await probe(psEnc(
      '$d = Get-MpComputerStatus -ErrorAction SilentlyContinue; ' +
      'if ($d) { ' +
      'Write-Output ("AV=" + $d.AntivirusEnabled); ' +
      'Write-Output ("RTP=" + $d.RealTimeProtectionEnabled); ' +
      'Write-Output ("SIG=" + [math]::Floor((Get-Date).Subtract($d.AntivirusSignatureLastUpdated).TotalDays)) ' +
      '} else { Write-Output "NODEF" }'
    ));
    if (!out || /NODEF/.test(out))
      return { enabled: null, detail: 'Windows Defender unavailable (third-party AV?)', sigDaysOld: null, source: 'Get-MpComputerStatus' };
    const av  = /AV=True/i.test(out);
    const rtp = /RTP=True/i.test(out);
    const sig = parseInt((out.match(/SIG=(-?\d+)/) || [])[1] ?? '', 10);
    const sigDaysOld = isNaN(sig) ? null : sig;
    if (!av || !rtp)
      return { enabled: false, detail: 'Defender ' + (!av ? 'disabled' : 'real-time protection off'), sigDaysOld, source: 'Get-MpComputerStatus' };
    return {
      enabled: true,
      detail: 'Defender active' + (sigDaysOld !== null && sigDaysOld > 3 ? ', signatures ' + sigDaysOld + 'd old' : ', signatures current'),
      sigDaysOld,
      source: 'Get-MpComputerStatus',
    };
  }

  if (isMac) {
    const xp = await probe('system_profiler SPInstallHistoryDataType 2>/dev/null | grep -ci xprotect', 6000);
    const n = parseInt(xp, 10);
    if (!isNaN(n) && n > 0) return { enabled: true, detail: 'XProtect present', sigDaysOld: null, source: 'system_profiler' };
    return { enabled: null, detail: 'no third-party AV detected (XProtect status unknown)', sigDaysOld: null, source: 'system_profiler' };
  }

  const clamRunning = await probe('systemctl is-active clamav-daemon 2>/dev/null || systemctl is-active clamd 2>/dev/null', 4000);
  if (/^active/.test(clamRunning)) return { enabled: true, detail: 'clamav daemon active', sigDaysOld: null, source: 'systemctl' };
  const clamBin = await probe('command -v clamscan 2>/dev/null', 3000);
  if (clamBin) return { enabled: false, detail: 'clamav installed but daemon not running', sigDaysOld: null, source: 'systemctl' };
  return { enabled: false, detail: 'no antivirus detected', sigDaysOld: null, source: 'PATH' };
}

/**
 * fail2ban state (Linux only). null elsewhere or when undeterminable.
 */
export async function fail2banState() {
  if (isWin || isMac) return { enabled: null, detail: 'n/a on this platform', source: 'platform' };
  const svc = await probe('systemctl is-active fail2ban 2>/dev/null', 4000);
  if (/^active/.test(svc)) return { enabled: true, detail: 'fail2ban active', source: 'systemctl' };
  const bin = await probe('command -v fail2ban-client 2>/dev/null', 3000);
  if (bin) return { enabled: false, detail: 'fail2ban installed but not running', source: 'systemctl' };
  return { enabled: false, detail: 'fail2ban not installed', source: 'PATH' };
}
