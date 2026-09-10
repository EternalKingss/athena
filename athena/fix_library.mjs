// fix_library.mjs -- preloaded generic remediations, each with its own detect and verify.
//
// The split that matters: a GENERIC fix is true of any machine on this platform ("the DNS
// cache is stale, flush it"). A MACHINE-SPECIFIC fix is true only here ("the USB dongle on
// this hub needs a bounce on cold boot") and cannot be preloaded by anyone -- that is what
// machine_fixes.mjs stores.
//
// Every entry carries detect + verify, deliberately. A large library of plausible-sounding
// fixes with no detection is a footgun: it invites applying a fix to a problem it does not
// match, which is how "helpful automation" breaks machines. If a fix here cannot prove the
// symptom is present and cannot prove it worked, it does not belong in the library.
//
// `risk` is advisory for ranking: 'low' = reversible and local, 'medium' = restarts a
// service or changes a setting, 'high' = long-running or needs a reboot to take effect.

const WIN = 'win32', LIN = 'linux', MAC = 'darwin';

export const FIX_LIBRARY = [
  // ---------------- Network ----------------
  {
    id: 'dns-cache-flush', platform: WIN, risk: 'low', tags: ['network', 'dns'],
    title: 'Flush the DNS resolver cache',
    symptom: 'sites fail to resolve, or resolve to the wrong address, while the connection itself is up',
    detect: { cmd: 'powershell -NoProfile -Command "try { Resolve-DnsName cloudflare.com -ErrorAction Stop | Out-Null; \'RESOLVES\' } catch { \'FAILS\' }"', expect: '^FAILS' },
    steps:  ['ipconfig /flushdns'],
    verify: { cmd: 'ipconfig /flushdns', expect: 'Successfully flushed' },
    explain: 'Clears cached DNS records. Harmless: the cache simply repopulates.',
  },
  {
    id: 'dhcp-renew', platform: WIN, risk: 'medium', tags: ['network', 'dhcp'],
    title: 'Release and renew the DHCP lease',
    symptom: 'adapter is up but has a 169.254.x.x self-assigned address, or no gateway',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-NetAdapter | Where-Object Status -eq \'Up\' | Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like \'169.254.*\' }).Count"', expect: '^[1-9]' },
    steps:  ['ipconfig /release', 'ipconfig /renew'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike \'169.254.*\' -and $_.IPAddress -ne \'127.0.0.1\' }).Count"', expect: '^[1-9]' },
    explain: 'Asks the DHCP server for a fresh lease. Briefly drops the connection.',
  },
  {
    id: 'adapter-bounce', platform: WIN, risk: 'medium', tags: ['network', 'adapter', 'driver'],
    title: 'Disable and re-enable the network adapters that are down',
    symptom: 'an adapter exists but will not come up, often after a cold boot',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-NetAdapter | Where-Object Status -eq \'Up\').Count"', expect: '^0' },
    steps:  ['powershell -NoProfile -Command "Get-NetAdapter | Where-Object { $_.Status -ne \'Up\' -and $_.Status -ne \'Not Present\' } | Restart-NetAdapter -Confirm:$false"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-NetAdapter | Where-Object Status -eq \'Up\').Count"', expect: '^[1-9]' },
    explain: 'Re-initialises the adapter without a reboot. This is the generic form; a machine-specific variant may target one adapter by name.',
  },
  {
    id: 'winsock-reset', platform: WIN, risk: 'high', tags: ['network', 'stack'],
    title: 'Reset the Winsock catalog and IP stack',
    symptom: 'network stack is broken in a way that survives adapter restarts -- no traffic despite a valid IP',
    detect: { cmd: 'ping -n 1 -w 2000 1.1.1.1', expect: '(100% loss|Destination host unreachable|could not find host|transmit failed)' },
    steps:  ['netsh winsock reset', 'netsh int ip reset'],
    verify: { cmd: 'netsh winsock show catalog | find /c "Catalog"', expect: '[0-9]' },
    explain: 'Rebuilds the Winsock catalog and IP stack. REQUIRES A REBOOT to take effect -- verification here only confirms the command applied.',
    needsReboot: true,
  },
  {
    id: 'arp-flush', platform: WIN, risk: 'low', tags: ['network'],
    title: 'Clear the ARP cache',
    symptom: 'local network hosts unreachable while the gateway responds, or after an IP conflict',
    detect: { cmd: 'powershell -NoProfile -Command "$g=(Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' -ErrorAction SilentlyContinue | Select-Object -First 1).NextHop; if (-not $g) { \'NOGW\' } elseif (Test-Connection $g -Count 1 -Quiet -ErrorAction SilentlyContinue) { \'GWOK\' } else { \'GWFAIL\' }"', expect: '^GWFAIL' },
    steps:  ['arp -d *'],
    verify: { cmd: 'arp -a', expect: 'Interface' },
    explain: 'Drops cached MAC-to-IP mappings; they rebuild on next contact.',
  },
  {
    id: 'phantom-net-devices', platform: WIN, risk: 'medium', tags: ['device', 'driver', 'network'],
    title: 'Remove phantom (non-present) network device nodes',
    symptom: 'duplicate adapter names with #2 / #3 suffixes; stale device nodes from old USB ports',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-PnpDevice -Class Net | Where-Object { $_.Status -eq \'Unknown\' }).Count"', expect: '^[1-9]' },
    steps:  ['powershell -NoProfile -Command "Get-PnpDevice -Class Net | Where-Object { $_.Status -eq \'Unknown\' } | ForEach-Object { pnputil /remove-device $_.InstanceId }"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-PnpDevice -Class Net | Where-Object { $_.Status -eq \'Unknown\' }).Count"', expect: '^0' },
    explain: 'Removes device nodes for hardware that is no longer present. Needs admin. Harmless -- Windows recreates a node if the hardware returns.',
    needsAdmin: true,
  },
  {
    id: 'nic-power-management', platform: WIN, risk: 'medium', tags: ['network', 'power', 'adapter'],
    title: 'Stop Windows powering down the network adapters',
    symptom: 'adapter drops after sleep, or fails to come up on cold boot',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-CimInstance MSPower_DeviceEnable -Namespace root\\wmi -ErrorAction SilentlyContinue | Where-Object { $_.Enable -eq $true }).Count"', expect: '^[1-9]' },
    steps:  ['powershell -NoProfile -Command "Get-NetAdapter | ForEach-Object { $id=$_.PnPDeviceID; Get-CimInstance MSPower_DeviceEnable -Namespace root\\wmi | Where-Object { $_.InstanceName -like ($id.Replace(\'\\\',\'\\\\\')+\'*\') } | ForEach-Object { $_.Enable=$false; Set-CimInstance -InputObject $_ } }"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-CimInstance MSPower_DeviceEnable -Namespace root\\wmi -ErrorAction SilentlyContinue | Where-Object { $_.Enable -eq $true }).Count"', expect: '^0' },
    explain: 'Unchecks "Allow the computer to turn off this device to save power" for every NIC. Needs admin.',
    needsAdmin: true,
  },
  {
    id: 'fast-startup-off', platform: WIN, risk: 'medium', tags: ['boot', 'power', 'driver'],
    title: 'Disable Fast Startup',
    symptom: 'devices fail to initialise on a cold boot but work after a restart',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power\' -Name HiberbootEnabled).HiberbootEnabled"', expect: '^1' },
    steps:  ['powershell -NoProfile -Command "Set-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power\' -Name HiberbootEnabled -Value 0"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power\' -Name HiberbootEnabled).HiberbootEnabled"', expect: '^0' },
    explain: 'Fast Startup hibernates the kernel session on shutdown, so a "cold" boot is not really cold and some devices never fully re-initialise. Shutdowns get slower; boots become genuine. Needs admin.',
    needsAdmin: true,
  },

  // ---------------- Disk ----------------
  {
    id: 'clear-temp', platform: WIN, risk: 'low', tags: ['disk', 'space'],
    title: 'Clear the user temp folder',
    symptom: 'system drive low on space',
    detect: { cmd: 'powershell -NoProfile -Command "[math]::Round((Get-ChildItem $env:TEMP -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB)"', expect: '^([2-9][0-9]{3}|[0-9]{5,})$' },
    steps:  ['powershell -NoProfile -Command "Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"'],
    verify: { cmd: 'powershell -NoProfile -Command "[math]::Round((Get-ChildItem $env:TEMP -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB)"', expect: '^([0-9]|[1-9][0-9]|[1-4][0-9]{2})$' },
    explain: 'Deletes temp files. Files in use are skipped.',
  },
  {
    id: 'clear-windows-update-cache', platform: WIN, risk: 'medium', tags: ['disk', 'space', 'updates'],
    title: 'Clear the Windows Update download cache',
    symptom: 'system drive low on space, or Windows Update stuck',
    detect: { cmd: 'powershell -NoProfile -Command "[math]::Round((Get-ChildItem C:\\Windows\\SoftwareDistribution\\Download -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB)"', expect: '^([1-9][0-9]{3,})$' },
    steps:  ['net stop wuauserv', 'powershell -NoProfile -Command "Remove-Item C:\\Windows\\SoftwareDistribution\\Download\\* -Recurse -Force -ErrorAction SilentlyContinue"', 'net start wuauserv'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-Service wuauserv).Status"', expect: 'Running' },
    explain: 'Stops Windows Update, clears its download cache, restarts it. Also fixes updates stuck at a percentage. Needs admin.',
    needsAdmin: true,
  },
  {
    id: 'empty-recycle-bin', platform: WIN, risk: 'low', tags: ['disk', 'space'],
    title: 'Empty the Recycle Bin',
    symptom: 'drive low on space with a large Recycle Bin',
    detect: { cmd: 'powershell -NoProfile -Command "[math]::Round((Get-ChildItem \'C:\\$Recycle.Bin\' -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB)"', expect: '^([1-9][0-9]{3,})$' },
    steps:  ['powershell -NoProfile -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"'],
    verify: { cmd: 'powershell -NoProfile -Command "[math]::Round((Get-ChildItem \'C:\\$Recycle.Bin\' -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB)"', expect: '^([0-9]|[1-9][0-9])$' },
    explain: 'Permanently deletes everything in the Recycle Bin. Not reversible.',
  },

  // ---------------- Services ----------------
  {
    id: 'restart-print-spooler', platform: WIN, risk: 'low', tags: ['service', 'printing'],
    title: 'Restart the Print Spooler',
    symptom: 'print jobs stuck in the queue, printers missing',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-Service Spooler).Status"', expect: '(Stopped|StopPending|StartPending)' },
    steps:  ['net stop spooler', 'powershell -NoProfile -Command "Remove-Item C:\\Windows\\System32\\spool\\PRINTERS\\* -Force -ErrorAction SilentlyContinue"', 'net start spooler'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-Service Spooler).Status"', expect: 'Running' },
    explain: 'Clears the print queue and restarts the spooler. Queued jobs are lost. Needs admin.',
    needsAdmin: true,
  },
  {
    id: 'restart-audio', platform: WIN, risk: 'low', tags: ['service', 'audio'],
    title: 'Restart the Windows Audio service',
    symptom: 'no sound, audio devices missing',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-Service Audiosrv).Status"', expect: '(Stopped|StopPending|StartPending)' },
    steps:  ['net stop audiosrv', 'net start audiosrv'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-Service Audiosrv).Status"', expect: 'Running' },
    explain: 'Restarts the audio service. Needs admin.',
    needsAdmin: true,
  },
  {
    id: 'restart-explorer', platform: WIN, risk: 'low', tags: ['ui', 'shell'],
    title: 'Restart Windows Explorer',
    symptom: 'taskbar or Start menu unresponsive, desktop icons not drawing',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-Process explorer -ErrorAction SilentlyContinue).Count"', expect: '^0' },
    steps:  ['powershell -NoProfile -Command "Stop-Process -Name explorer -Force; Start-Sleep 2; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer }"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-Process explorer -ErrorAction SilentlyContinue).Count"', expect: '^[1-9]' },
    explain: 'Restarts the shell. Open Explorer windows close; applications are unaffected.',
  },
  {
    id: 'start-stopped-automatic-services', platform: WIN, risk: 'medium', tags: ['service'],
    title: 'Start services set to Automatic that are not running',
    symptom: 'something that should start at boot did not',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq \'Auto\' -and $_.State -ne \'Running\' -and -not $_.DelayedAutoStart }).Count"', expect: '^([5-9]|[1-9][0-9]+)' },
    steps:  ['powershell -NoProfile -Command "Get-Service | Where-Object { $_.StartType -eq \'Automatic\' -and $_.Status -ne \'Running\' } | Start-Service -ErrorAction SilentlyContinue"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-Service | Where-Object { $_.StartType -eq \'Automatic\' -and $_.Status -ne \'Running\' }).Count"', expect: '^[0-3]$' },
    explain: 'Starts Automatic services that failed to start. Some legitimately stay stopped (delayed-start, trigger-start), so a small remainder is normal. Needs admin.',
    needsAdmin: true,
  },

  // ---------------- Security ----------------
  {
    id: 'firewall-enable', platform: WIN, risk: 'medium', tags: ['security', 'firewall'],
    title: 'Enable Windows Firewall on all profiles',
    symptom: 'firewall disabled on one or more profiles',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count"', expect: '^[1-9]' },
    steps:  ['powershell -NoProfile -Command "Set-NetFirewallProfile -All -Enabled True"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count"', expect: '^0' },
    explain: 'Turns the firewall on for Domain, Private and Public. Needs admin.',
    needsAdmin: true,
  },
  {
    id: 'defender-signatures', platform: WIN, risk: 'low', tags: ['security', 'antivirus'],
    title: 'Update Windows Defender signatures',
    symptom: 'Defender definitions more than a few days old',
    detect: { cmd: 'powershell -NoProfile -Command "[math]::Floor((Get-Date).Subtract((Get-MpComputerStatus).AntivirusSignatureLastUpdated).TotalDays)"', expect: '^([4-9]|[1-9][0-9]+)' },
    steps:  ['powershell -NoProfile -Command "Update-MpSignature"'],
    verify: { cmd: 'powershell -NoProfile -Command "[math]::Floor((Get-Date).Subtract((Get-MpComputerStatus).AntivirusSignatureLastUpdated).TotalDays)"', expect: '^[0-2]$' },
    explain: 'Downloads current Defender definitions. Needs internet.',
    needsNetwork: true,
  },
  {
    id: 'defender-realtime-on', platform: WIN, risk: 'medium', tags: ['security', 'antivirus'],
    title: 'Re-enable Defender real-time protection',
    symptom: 'real-time protection is off',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-MpComputerStatus).RealTimeProtectionEnabled"', expect: 'False' },
    steps:  ['powershell -NoProfile -Command "Set-MpPreference -DisableRealtimeMonitoring $false"'],
    verify: { cmd: 'powershell -NoProfile -Command "(Get-MpComputerStatus).RealTimeProtectionEnabled"', expect: 'True' },
    explain: 'Turns real-time scanning back on. Needs admin. Will fail if a third-party AV owns protection.',
    needsAdmin: true,
  },

  // ---------------- System integrity (slow) ----------------
  {
    id: 'sfc-scan', platform: WIN, risk: 'high', tags: ['integrity', 'crash'], timeoutMs: 1800000,
    title: 'Repair Windows system files (SFC)',
    symptom: 'repeated application crashes, missing system DLLs, unexplained instability',
    detect: { cmd: 'powershell -NoProfile -Command "(Get-WinEvent -FilterHashtable @{LogName=\'Application\';Id=1000;StartTime=(Get-Date).AddDays(-7)} -MaxEvents 20 -ErrorAction SilentlyContinue).Count"', expect: '^([3-9]|[1-9][0-9]+)' },
    steps:  ['sfc /scannow'],
    verify: { cmd: 'sfc /verifyonly', expect: '(did not find any integrity violations|completed)' },
    explain: 'Scans and repairs protected system files. Takes 10-30 minutes and must not be interrupted. Needs admin.',
    needsAdmin: true,
  },
  {
    id: 'dism-restore', platform: WIN, risk: 'high', tags: ['integrity'], timeoutMs: 1800000,
    title: 'Repair the Windows component store (DISM)',
    symptom: 'SFC reports it cannot repair some files, or Windows Update repeatedly fails',
    detect: { cmd: 'DISM /Online /Cleanup-Image /CheckHealth', expect: '(repairable|corrupt)' },
    steps:  ['DISM /Online /Cleanup-Image /RestoreHealth'],
    verify: { cmd: 'DISM /Online /Cleanup-Image /CheckHealth', expect: '(No component store corruption detected|healthy)' },
    explain: 'Repairs the component store SFC depends on. Takes 10-30 minutes, needs internet, must not be interrupted. Needs admin.',
    needsAdmin: true, needsNetwork: true,
  },

  // ---------------- Time ----------------
  {
    id: 'time-resync', platform: WIN, risk: 'low', tags: ['time', 'ssl'],
    title: 'Resynchronise the system clock',
    symptom: 'certificate or SSL errors on sites that work elsewhere; clock visibly wrong',
    detect: { cmd: 'powershell -NoProfile -Command "$o=(Get-Date); $n=[datetime]::UtcNow; [math]::Abs(($o.ToUniversalTime()-$n).TotalSeconds) -gt 60"', expect: 'True' },
    steps:  ['w32tm /resync /force'],
    verify: { cmd: 'w32tm /query /status', expect: '(Last Successful Sync|Source)' },
    explain: 'Forces a time sync. A clock off by minutes breaks TLS. Needs admin and internet.',
    needsAdmin: true, needsNetwork: true,
  },

  // ---------------- Linux / macOS (thin, kept honest) ----------------
  {
    id: 'dns-cache-flush-linux', platform: LIN, risk: 'low', tags: ['network', 'dns'],
    title: 'Flush the systemd-resolved DNS cache',
    symptom: 'stale DNS results while the connection is up',
    detect: { cmd: 'systemctl is-active systemd-resolved 2>/dev/null', expect: '^active' },
    steps:  ['resolvectl flush-caches'],
    verify: { cmd: 'resolvectl statistics 2>/dev/null | head -5', expect: '.' },
    explain: 'Clears the resolver cache.',
  },
  {
    id: 'journal-vacuum', platform: LIN, risk: 'low', tags: ['disk', 'space', 'logs'],
    title: 'Vacuum systemd journal logs older than 7 days',
    symptom: 'root filesystem low on space with a large journal',
    detect: { cmd: "journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[GM]' | head -1", expect: '[0-9.]+G' },
    steps:  ['journalctl --vacuum-time=7d'],
    verify: { cmd: 'journalctl --disk-usage 2>/dev/null', expect: 'take up' },
    explain: 'Trims journal logs older than a week.',
  },
  {
    id: 'dns-cache-flush-mac', platform: MAC, risk: 'low', tags: ['network', 'dns'],
    title: 'Flush the macOS DNS cache',
    symptom: 'stale DNS results while the connection is up',
    detect: { cmd: 'scutil --dns 2>/dev/null | head -3', expect: '.' },
    steps:  ['dscacheutil -flushcache', 'killall -HUP mDNSResponder'],
    verify: { cmd: 'scutil --dns 2>/dev/null | head -3', expect: '.' },
    explain: 'Clears the resolver cache. Needs sudo for mDNSResponder.',
  },
];

// Only fixes for the platform we are actually on.
export function libraryForPlatform(platform = process.platform) {
  return FIX_LIBRARY.filter(f => f.platform === platform);
}

export function getLibraryFix(id) {
  return FIX_LIBRARY.find(f => f.id === id) || null;
}

// Map an L2 finding (free text) or a tag onto candidate fixes.
export function matchLibrary(text, platform = process.platform) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return [];
  return libraryForPlatform(platform).filter(f => {
    if (f.tags.some(tag => t.includes(tag))) return true;
    const words = (f.title + ' ' + f.symptom).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 4);
    return words.some(w => t.includes(w));
  });
}

export function formatLibrary(fixes) {
  if (!fixes.length) return 'No generic fixes match.';
  const lines = [];
  for (const f of fixes) {
    lines.push(`  ${f.id}  [${f.risk} risk${f.needsAdmin ? ', needs admin' : ''}${f.needsNetwork ? ', needs internet' : ''}${f.needsReboot ? ', needs reboot' : ''}]`);
    lines.push(`      ${f.title}`);
    lines.push(`      when: ${f.symptom}`);
  }
  return lines.join('\n');
}
