// control_engine.mjs -- L2 deterministic diagnostic engine
// Athena guarantees structured diagnostic coverage under incomplete tool data.
// No LLM required. All execution is deterministic with confidence tagging.
//
// v2: tools now PARSE their output into structured data instead of handing raw text to a
// regex. That matters because the old thresholds were things like /\s9[0-9]%|\s100%/ run
// against human-formatted output -- which matches "95%" in a filename, breaks on a locale
// change, and cannot answer "how full, exactly?". With structured data, `analyze` and
// STATUS become real comparisons, and two reports can be diffed for trend.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

// ---- OS-aware tool registry ----
// Each tool: ordered candidate commands per platform, plus an optional parse() that turns
// the winning command's raw output into structured data. parse() returning null is fine --
// the raw text still flows through, just without the structured layer.
// -EncodedCommand takes UTF-16LE base64, so nothing in the script has to survive two
// layers of shell quoting. Passing a quoted -Command string through `cmd /c` does not
// survive: PowerShell ends up evaluating it as a string literal and printing it back.
const PS = s => 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '
  + Buffer.from(s, 'utf16le').toString('base64');

function jsonArray(raw) {
  const t = (raw || '').trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : [j];
  } catch { return null; }
}

const TOOL_REGISTRY = {
  disk_usage: {
    linux:  ['df -PB1 --output=target,size,used,avail 2>/dev/null | tail -n +2', 'df -Pk 2>/dev/null | tail -n +2'],
    darwin: ['df -Pk 2>/dev/null | tail -n +2'],
    win32:  [PS("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress")],
    parse(raw) {
      if (isWin) {
        const rows = jsonArray(raw);
        if (!rows) return null;
        return rows.map(r => {
          const size = Number(r.Size) || 0, free = Number(r.FreeSpace) || 0;
          return { mount: r.DeviceID, sizeBytes: size, freeBytes: free, usedBytes: size - free,
                   usedPct: size ? Math.round(((size - free) / size) * 1000) / 10 : null };
        });
      }
      const out = [];
      for (const line of (raw || '').split('\n')) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4) continue;
        // GNU --output=target,size,used,avail is in bytes; df -Pk is 1K blocks
        const mult = /--output/.test('') ? 1 : 1024;
        const [mount, size, used, avail] = [p[0], Number(p[1]), Number(p[2]), Number(p[3])];
        if (!isFinite(size) || !size) continue;
        out.push({ mount, sizeBytes: size * mult, usedBytes: used * mult, freeBytes: avail * mult,
                   usedPct: Math.round((used / size) * 1000) / 10 });
      }
      return out.length ? out : null;
    },
  },

  memory_usage: {
    linux:  ["awk '/MemTotal|MemAvailable/{print $1,$2}' /proc/meminfo"],
    darwin: ['vm_stat', 'sysctl hw.memsize'],
    win32:  [PS("Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress")],
    parse(raw) {
      if (isWin) {
        const rows = jsonArray(raw); if (!rows) return null;
        const r = rows[0];
        const totalKB = Number(r.TotalVisibleMemorySize) || 0, freeKB = Number(r.FreePhysicalMemory) || 0;
        if (!totalKB) return null;
        return { totalMB: Math.round(totalKB / 1024), availableMB: Math.round(freeKB / 1024),
                 usedPct: Math.round(((totalKB - freeKB) / totalKB) * 1000) / 10 };
      }
      const t = (raw || '').match(/MemTotal:?\s+(\d+)/i), a = (raw || '').match(/MemAvailable:?\s+(\d+)/i);
      if (!t) return null;
      const totalKB = Number(t[1]), availKB = a ? Number(a[1]) : 0;
      return { totalMB: Math.round(totalKB / 1024), availableMB: Math.round(availKB / 1024),
               usedPct: Math.round(((totalKB - availKB) / totalKB) * 1000) / 10 };
    },
  },

  cpu_info: {
    linux:  ['nproc && grep -m1 "model name" /proc/cpuinfo | cut -d: -f2'],
    darwin: ['sysctl -n hw.ncpu machdep.cpu.brand_string'],
    win32:  [PS("Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,LoadPercentage | ConvertTo-Json -Compress")],
    parse(raw) {
      if (isWin) {
        const rows = jsonArray(raw); if (!rows) return null;
        return rows.map(r => ({ model: r.Name, cores: Number(r.NumberOfCores) || null, loadPct: Number(r.LoadPercentage) }));
      }
      const lines = (raw || '').trim().split('\n');
      return lines.length ? [{ cores: Number(lines[0]) || null, model: (lines[1] || '').trim() }] : null;
    },
  },

  uptime: {
    linux:  ['cat /proc/uptime'],
    darwin: ['sysctl -n kern.boottime'],
    win32:  [PS("$o=Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ LastBoot=$o.LastBootUpTime.ToString('o'); UptimeHours=[math]::Round(((Get-Date)-$o.LastBootUpTime).TotalHours,1) } | ConvertTo-Json -Compress")],
    parse(raw) {
      if (isWin) {
        const rows = jsonArray(raw); if (!rows) return null;
        return { lastBoot: rows[0].LastBoot, uptimeHours: Number(rows[0].UptimeHours) };
      }
      const s = Number((raw || '').trim().split(/\s+/)[0]);
      return isFinite(s) ? { uptimeHours: Math.round((s / 3600) * 10) / 10 } : null;
    },
  },

  // ---- Devices and drivers (new in v2) ----
  // Nothing in the old registry knew what a device was, so "the adapter did not come up"
  // was not a question L2 could even ask.
  net_adapters: {
    linux:  ["ip -o link show 2>/dev/null | awk -F': ' '{print $2\" \"$3}'"],
    darwin: ['ifconfig -a 2>/dev/null | grep -E "^[a-z]"'],
    win32:  [PS("Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed,MacAddress,DriverVersion,DriverDate,PnPDeviceID | ConvertTo-Json -Compress -Depth 3")],
    parse(raw) {
      if (!isWin) return null;
      const rows = jsonArray(raw); if (!rows) return null;
      return rows.map(r => ({
        name: r.Name, description: r.InterfaceDescription, status: r.Status,
        linkSpeed: r.LinkSpeed, mac: r.MacAddress,
        driverVersion: r.DriverVersion, driverDate: r.DriverDate,
        pnpId: r.PnPDeviceID,
        isUsb: /^USB\\/i.test(String(r.PnPDeviceID || '')),
        up: String(r.Status).toLowerCase() === 'up',
      }));
    },
  },

  device_problems: {
    linux:  ["dmesg 2>/dev/null | grep -iE 'fail|error' | tail -20"],
    darwin: ["log show --last 10m --predicate 'eventMessage contains \\\"failed\\\"' 2>/dev/null | tail -20"],
    win32:  [PS("Get-PnpDevice | Where-Object { $_.Status -ne 'OK' } | Select-Object Status,Class,FriendlyName,InstanceId,Problem | ConvertTo-Json -Compress -Depth 3")],
    parse(raw) {
      if (!isWin) return null;
      const rows = jsonArray(raw); if (!rows) return null;
      return rows.map(r => ({
        status: r.Status, class: r.Class, name: r.FriendlyName,
        instanceId: r.InstanceId, problem: r.Problem,
        isPhantom: String(r.Status).toLowerCase() === 'unknown',
        isNet: String(r.Class).toLowerCase() === 'net',
      }));
    },
  },

  // Boot history, with the inference that matters: two boots close together mean somebody
  // rebooted immediately, which usually means the first boot came up wrong.
  boot_history: {
    linux:  ['last -x reboot 2>/dev/null | head -12'],
    darwin: ['last reboot 2>/dev/null | head -12'],
    win32:  [PS("Get-WinEvent -FilterHashtable @{LogName='System';Id=27;ProviderName='Microsoft-Windows-Kernel-Boot'} -MaxEvents 20 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Time=$_.TimeCreated.ToString('o'); BootType=$_.Properties[0].Value } } | ConvertTo-Json -Compress")],
    parse(raw) {
      if (!isWin) return null;
      const rows = jsonArray(raw); if (!rows) return null;
      const boots = rows.map(r => ({
        time: r.Time,
        ts: Date.parse(r.Time),
        bootType: Number(r.BootType),
        kind: ({ 0: 'full', 1: 'hybrid', 2: 'resume' })[Number(r.BootType)] || 'unknown',
      })).filter(b => isFinite(b.ts)).sort((a, b) => a.ts - b.ts);

      // A "rapid pair" is two boots inside 5 minutes: boot, something is broken, restart.
      const RAPID_MS = 5 * 60 * 1000;
      const pairs = [];
      for (let i = 1; i < boots.length; i++) {
        const gap = boots[i].ts - boots[i - 1].ts;
        if (gap <= RAPID_MS) {
          pairs.push({ first: boots[i - 1].time, second: boots[i].time, gapSeconds: Math.round(gap / 1000) });
        }
      }
      return { boots, rapidPairs: pairs, rapidPairCount: pairs.length, totalBoots: boots.length };
    },
  },

  // ---- Unchanged text tools (no structure worth extracting) ----
  large_dirs: {
    linux:  ['du -sh /[^p]* 2>/dev/null | sort -rh | head -10'],
    darwin: ['du -sh /* 2>/dev/null | sort -rh | head -10'],
    win32:  [PS("Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue | Select-Object -First 10 Name")],
  },
  process_list: {
    linux:  ['ps aux --sort=-%cpu 2>/dev/null | head -16'],
    darwin: ['ps aux -r 2>/dev/null | head -16'],
    win32:  [PS("Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 Name,CPU,WS | ConvertTo-Json -Compress")],
  },
  // An adapter can be "Up" and still be useless: it enumerated, but never got a lease, so
  // Windows self-assigns 169.254.x.x (APIPA). That is the exact shape of a USB Wi-Fi
  // dongle that came up wrong on a cold boot, and the old version could not see it --
  // net_adapters said Status=Up and STATUS came back OK.
  network_status: {
    linux:  ['ip addr show 2>/dev/null', 'ifconfig 2>/dev/null'],
    darwin: ['ifconfig 2>/dev/null'],
    win32:  [PS("Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress,PrefixOrigin | ConvertTo-Json -Compress")],
    parse(raw) {
      if (!isWin) return null;
      const rows = jsonArray(raw); if (!rows) return null;
      // PrefixOrigin: 1=Manual, 2=WellKnown, 3=Dhcp, 4=RouterAdvertisement
      const ORIGIN = { 0: 'other', 1: 'manual', 2: 'wellknown', 3: 'dhcp', 4: 'ra' };
      const ifaces = rows.map(r => {
        const ip = String(r.IPAddress || '');
        return {
          alias: r.InterfaceAlias,
          ip,
          origin: ORIGIN[Number(r.PrefixOrigin)] || 'unknown',
          isApipa: /^169\.254\./.test(ip),
          isLoopback: /^127\./.test(ip),
        };
      });
      const routable = ifaces.filter(i => !i.isApipa && !i.isLoopback);
      return {
        interfaces: ifaces,
        routable,
        routableCount: routable.length,
        apipaOnly: ifaces.some(i => i.isApipa) && routable.length === 0,
      };
    },
  },
  ping_test: {
    linux:  ['ping -c 3 -W 2 1.1.1.1 2>&1'],
    darwin: ['ping -c 3 -t 3 1.1.1.1 2>&1'],
    win32:  ['ping -n 3 -w 2000 1.1.1.1'],
    parse(raw) {
      const m = (raw || '').match(/(\d+)%\s*(?:packet\s*)?loss/i) || (raw || '').match(/Lost = \d+ \((\d+)% loss\)/i);
      return m ? { lossPct: Number(m[1]) } : null;
    },
  },
  routing_table: {
    linux:  ['ip route show 2>/dev/null', 'route -n 2>/dev/null'],
    darwin: ['netstat -nr 2>/dev/null'],
    win32:  ['route print -4'],
    parse(raw) {
      const text = String(raw || '');
      if (isWin) {
        // Active Routes rows: destination netmask gateway interface metric
        const rx = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d+)/gm;
        const defaults = [];
        let m;
        while ((m = rx.exec(text)) !== null) {
          defaults.push({ gateway: m[1], iface: m[2], metric: Number(m[3]) });
        }
        return { defaults, defaultGateway: defaults.length ? defaults[0].gateway : null, hasDefault: defaults.length > 0 };
      }
      const m = text.match(/^default\s+via\s+(\S+)(?:\s+dev\s+(\S+))?/m)
             || text.match(/^0\.0\.0\.0\s+(\S+)/m);
      const gw = m ? m[1] : null;
      return { defaults: gw ? [{ gateway: gw, iface: (m && m[2]) || null }] : [], defaultGateway: gw, hasDefault: Boolean(gw) };
    },
  },
  open_ports: {
    linux:  ['ss -tlnp 2>/dev/null', 'netstat -tlnp 2>/dev/null'],
    darwin: ['netstat -an -p tcp 2>/dev/null | grep LISTEN'],
    win32:  [PS("Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress")],
  },
  system_logs: {
    linux:  ['journalctl -n 30 --no-pager -p err..emerg 2>/dev/null', 'tail -30 /var/log/syslog 2>/dev/null'],
    darwin: ['log show --last 5m --predicate "messageType == 16" 2>/dev/null | tail -30'],
    win32:  [PS("Get-WinEvent -LogName System -MaxEvents 20 | Where-Object { $_.Level -le 3 } | Select-Object TimeCreated,LevelDisplayName,ProviderName,Id,Message | ConvertTo-Json -Compress -Depth 3")],
  },
  last_reboots: {
    linux:  ['last reboot 2>/dev/null | head -5'],
    darwin: ['last reboot 2>/dev/null | head -5'],
    win32:  [PS("Get-WinEvent -FilterHashtable @{LogName='System';Id=1074} -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object TimeCreated,Message | ConvertTo-Json -Compress -Depth 2")],
  },
  running_services: {
    linux:  ['systemctl list-units --type=service --state=running --no-legend 2>/dev/null | head -20'],
    darwin: ['launchctl list 2>/dev/null | head -20'],
    win32:  [PS("Get-Service | Where-Object Status -eq 'Running' | Select-Object -First 20 Name,DisplayName | ConvertTo-Json -Compress")],
  },
  logged_users: {
    linux:  ['who', 'w 2>/dev/null'],
    darwin: ['who'],
    win32:  [PS("Get-CimInstance Win32_ComputerSystem | Select-Object UserName | ConvertTo-Json -Compress")],
  },
  env_vars: {
    linux:  ["env | grep -v '^LESS_TERMCAP\\|^LS_COLORS\\|^_=' | sed -E 's/^([A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=.*/\\1=<redacted>/I' | sort"],
    darwin: ["env | grep -v '^LESS_TERMCAP\\|^LS_COLORS\\|^_=' | sed -E 's/^([A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=.*/\\1=<redacted>/I' | sort"],
    win32:  [PS("Get-ChildItem Env: | ForEach-Object { if ($_.Name -match 'KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH') { $_.Name + '=<redacted>' } else { $_.Name + '=' + $_.Value } } | Sort-Object")],
  },
};

function commandsFor(toolName) {
  const entry = TOOL_REGISTRY[toolName];
  if (!entry) return [];
  return entry[process.platform] || entry.linux || [];
}

// ---- Capability cache ----
let _caps = null;
async function getCaps() {
  if (!_caps) {
    try {
      const { getCachedCapabilities } = await import('./capabilities.mjs');
      _caps = getCachedCapabilities() || {};
    } catch { _caps = {}; }
  }
  return _caps;
}
export function clearControlEngineCache() { _caps = null; }

// ---- Confidence-tagged execution ----
// Returns { confidence, output, data, cmd }. `data` is the parsed structure when the tool
// knows how to produce one.
async function safeRunTool(toolName) {
  const entry = TOOL_REGISTRY[toolName];
  const commands = commandsFor(toolName);
  if (!commands.length) {
    return { confidence: 'LOW', output: '[no commands defined for ' + toolName + ' on ' + process.platform + ']', data: null, cmd: null };
  }
  const caps = await getCaps();
  const missing = new Set(caps.missingTools || []);
  const toTry = commands.filter(cmd => !missing.has(cmd.trim().split(/\s+/)[0]));
  const ordered = toTry.length ? toTry : commands;

  for (const cmd of ordered) {
    try {
      const output = await execWithTimeout(cmd, 12000);
      if (output && output.trim()) {
        let data = null;
        if (entry.parse) { try { data = entry.parse(output); } catch { data = null; } }
        return { confidence: 'HIGH', output: output.trim(), data, cmd };
      }
      return { confidence: 'MEDIUM', output: '(command succeeded but produced no output)', data: null, cmd };
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOENT' || e.code === 'TIMEOUT') continue;
      if (e.output && e.output.trim()) return { confidence: 'MEDIUM', output: e.output.trim(), data: null, cmd };
    }
  }
  return { confidence: 'LOW', output: '[unavailable on this system -- all commands failed]', data: null, cmd: null };
}

function execWithTimeout(cmd, ms) {
  return new Promise((resolve, reject) => {
    const shell = isWin ? 'cmd' : 'sh';
    const args  = isWin ? ['/c', cmd] : ['-c', cmd];
    const proc  = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); const e = new Error('timeout'); e.code = 'TIMEOUT'; reject(e); }, ms);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out);
      else { const e = new Error('exit ' + code); e.output = out || err; reject(e); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ---- STATUS from data, not from exit codes ----
// Each rule reads the structured data when present. The old version reported whether the
// COMMANDS SUCCEEDED, so a 99%-full disk produced "STATUS: OK" -- and core.mjs then told
// the model not to contradict it.
const RULES = [
  { key: 'disk',      test: d => Array.isArray(d) && d.find(x => x.usedPct >= 95),
    level: 'FAIL', why: d => `filesystem ${d.find(x => x.usedPct >= 95).mount} is ${d.find(x => x.usedPct >= 95).usedPct}% full` },
  { key: 'disk',      test: d => Array.isArray(d) && d.find(x => x.usedPct >= 88),
    level: 'WARN', why: d => `filesystem ${d.find(x => x.usedPct >= 88).mount} is ${d.find(x => x.usedPct >= 88).usedPct}% full` },
  { key: 'memory',    test: d => d && d.availableMB != null && d.availableMB < 400,
    level: 'WARN', why: d => `only ${d.availableMB} MB RAM available` },
  { key: 'ping',      test: d => d && d.lossPct === 100, level: 'FAIL', why: () => 'no network connectivity (100% packet loss)' },
  { key: 'ping',      test: d => d && d.lossPct > 0 && d.lossPct < 100, level: 'WARN', why: d => `${d.lossPct}% packet loss` },
  { key: 'adapters',  test: d => Array.isArray(d) && d.length && !d.some(a => a.up),
    level: 'FAIL', why: () => 'no network adapter is up' },
  { key: 'adapters',  test: d => Array.isArray(d) && d.some(a => a.isUsb && !a.up),
    level: 'WARN', why: d => `USB adapter down: ${d.find(a => a.isUsb && !a.up).description}` },
  { key: 'devices',   test: d => Array.isArray(d) && d.some(x => x.isNet && x.isPhantom),
    level: 'WARN', why: d => `${d.filter(x => x.isNet && x.isPhantom).length} phantom network device node(s) present` },
  // "Up but unusable" -- the failure the old rule set was blind to.
  { key: 'interfaces', test: d => d && d.apipaOnly === true,
    level: 'FAIL', why: d => 'every adapter self-assigned a 169.254.x address (' +
      d.interfaces.filter(i => i.isApipa).map(i => i.alias).join(', ') +
      ') -- the hardware came up but never got a DHCP lease' },
  { key: 'interfaces', test: d => d && d.routableCount === 0,
    level: 'FAIL', why: () => 'no routable IPv4 address on any interface' },
  { key: 'routes',    test: d => d && d.hasDefault === false,
    level: 'FAIL', why: () => 'no default gateway -- nothing can leave this machine' },
  { key: 'boots',     test: d => d && d.rapidPairCount >= 2,
    level: 'WARN', why: d => `${d.rapidPairCount} rapid reboot pairs -- the machine is being restarted immediately after boot, which usually means something does not come up on the first try` },
];

function statusFromResults(results) {
  let status = 'OK';
  const reasons = [];
  for (const [key, r] of Object.entries(results)) {
    if (r.data == null) continue;
    for (const rule of RULES) {
      if (!key.includes(rule.key) && rule.key !== key) continue;
      let hit = false;
      try { hit = Boolean(rule.test(r.data)); } catch { hit = false; }
      if (!hit) continue;
      try { reasons.push(rule.why(r.data)); } catch { reasons.push(rule.key + ' threshold exceeded'); }
      if (rule.level === 'FAIL') status = 'FAIL';
      else if (status !== 'FAIL') status = 'WARN';
      break; // first matching rule per key wins (they are ordered most severe first)
    }
  }
  const confidences = Object.values(results).map(r => r.confidence);
  if (status === 'OK' && confidences.some(c => c === 'LOW')) {
    status = 'UNKNOWN';
    reasons.push('one or more checks could not run -- absence of evidence, not evidence of health');
  }
  statusFromResults.lastReasons = [...new Set(reasons)];
  return status;
}

function formatReport(workflowName, results, extraStatus) {
  const status = extraStatus || statusFromResults(results);
  const lines = ['[WORKFLOW: ' + workflowName.toUpperCase() + ']', 'STATUS: ' + status, '', 'DATA:'];
  for (const [key, r] of Object.entries(results)) {
    lines.push('  [' + r.confidence + '] ' + key.replace(/_/g, ' ') + ':');
    if (r.data != null) {
      lines.push('    ' + JSON.stringify(r.data).slice(0, 1200));
    } else {
      for (const dl of r.output.split('\n').slice(0, 25)) lines.push('    ' + dl);
    }
    lines.push('');
  }
  if (status !== 'OK') {
    lines.push('FINDINGS:');
    for (const why of (statusFromResults.lastReasons || [])) lines.push('  - ' + why);
  }
  return lines.join('\n');
}

// ---- Workflows ----
const WORKFLOWS = {
  system_health: [
    { toolName: 'cpu_info',     key: 'cpu_info' },
    { toolName: 'memory_usage', key: 'memory', analyze: (out, d) => (d && d.availableMB < 600) ? ['process_check'] : [] },
    { toolName: 'disk_usage',   key: 'disk',   analyze: (out, d) => (Array.isArray(d) && d.some(x => x.usedPct >= 88)) ? ['disk_check'] : [] },
    { toolName: 'uptime',       key: 'uptime' },
  ],
  disk_check: [
    { toolName: 'disk_usage', key: 'disk', analyze: (out, d) => (Array.isArray(d) && d.some(x => x.usedPct >= 92)) ? ['process_check'] : [] },
    { toolName: 'large_dirs', key: 'large_directories' },
  ],
  network_check: [
    { toolName: 'net_adapters',   key: 'adapters', analyze: (out, d) =>
        (Array.isArray(d) && (!d.some(a => a.up) || d.some(a => a.isUsb && !a.up))) ? ['device_check'] : [] },
    { toolName: 'network_status', key: 'interfaces' },
    { toolName: 'ping_test',      key: 'ping', analyze: (out, d) => (d && d.lossPct === 100) ? ['routing_check'] : [] },
    { toolName: 'routing_table',  key: 'routes' },
  ],
  // New: the workflow that can actually see a driver/enumeration problem.
  device_check: [
    { toolName: 'net_adapters',    key: 'adapters' },
    { toolName: 'device_problems', key: 'devices', analyze: (out, d) =>
        (Array.isArray(d) && d.some(x => x.isNet)) ? ['boot_check'] : [] },
  ],
  boot_check: [
    { toolName: 'boot_history', key: 'boots' },
    { toolName: 'uptime',       key: 'uptime' },
  ],
  routing_check: [
    { toolName: 'routing_table', key: 'routing_table' },
    { toolName: 'open_ports',    key: 'open_ports' },
  ],
  process_check: [
    { toolName: 'process_list', key: 'top_processes' },
    { toolName: 'memory_usage', key: 'memory' },
  ],
  log_check:      [{ toolName: 'system_logs',      key: 'recent_errors' }],
  port_check:     [{ toolName: 'open_ports',       key: 'listening_ports' }],
  boot_info:      [{ toolName: 'uptime', key: 'uptime' }, { toolName: 'boot_history', key: 'boots' }, { toolName: 'last_reboots', key: 'reboot_history' }],
  service_check:  [{ toolName: 'running_services', key: 'active_services' }],
  user_check:     [{ toolName: 'logged_users',     key: 'logged_in_users' }],
  env_check:      [{ toolName: 'env_vars',         key: 'environment_variables' }],
};

const MAX_REFINEMENT_CYCLES = 2;
const MAX_CROSS_TRIGGERS    = 1;

async function runWorkflow(name) {
  const def = WORKFLOWS[name];
  if (!def) return '[WORKFLOW: ' + name + ']\nSTATUS: FAIL\nERROR: unknown workflow\n';

  const queue = def.map(s => ({ ...s }));
  const results = {};
  const seen = new Set([name]);
  const triggerCount = {};
  let cycles = 0;

  while (queue.length) {
    const step = queue.shift();
    const tagged = await safeRunTool(step.toolName);
    results[step.key] = tagged;

    if (step.analyze && tagged.confidence !== 'LOW' && cycles < MAX_REFINEMENT_CYCLES) {
      let followUps = [];
      try { followUps = step.analyze(tagged.output, tagged.data) || []; } catch { followUps = []; }
      for (const extra of followUps) {
        triggerCount[extra] = (triggerCount[extra] || 0) + 1;
        if (!seen.has(extra) && triggerCount[extra] <= MAX_CROSS_TRIGGERS) {
          seen.add(extra);
          const extraDef = WORKFLOWS[extra];
          if (extraDef) { queue.push(...extraDef.map(s => ({ ...s }))); cycles++; }
        }
      }
    }
  }
  return formatReport(name, results);
}

// A 3B local model handed 7 KB of JSON and told to "interpret" will confabulate -- it
// invents a fault to agree with the user, or calls a link-local address a loopback. The
// findings are already computed English by the time we get here, so expose them: the
// model's job shrinks to picking a fix, which it does reliably.
let _lastPlan = { status: 'OK', findings: [], workflows: [] };
export function lastPlanSummary() { return _lastPlan; }

const RANK = { OK: 0, UNKNOWN: 1, WARN: 2, FAIL: 3 };

export async function runPlan(intents, emit) {
  const reports = [];
  _lastPlan = { status: 'OK', findings: [], workflows: [] };
  for (const name of intents) {
    if (emit) emit({ type: 'token', content: '\n[L2 running: ' + name + '...]\n' });
    let text;
    try { text = await runWorkflow(name); }
    catch (e) { text = '[WORKFLOW: ' + name.toUpperCase() + ']\nSTATUS: FAIL\nERROR: ' + e.message + '\n'; }
    reports.push(text);

    // Read back what formatReport wrote -- one source of truth, no second evaluation.
    const st = (text.match(/^STATUS:\s*(\S+)/m) || [, 'UNKNOWN'])[1];
    const fBlock = text.split(/^FINDINGS:$/m)[1];
    const found = fBlock ? fBlock.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2)) : [];
    _lastPlan.workflows.push({ name, status: st, findings: found });
    _lastPlan.findings.push(...found);
    if ((RANK[st] ?? 1) > (RANK[_lastPlan.status] ?? 0)) _lastPlan.status = st;
  }
  _lastPlan.findings = [...new Set(_lastPlan.findings)];
  return reports.join('\n\n---\n\n');
}

// Structured access for callers that want the data rather than the report text.
export async function collectWorkflow(name) {
  const def = WORKFLOWS[name];
  if (!def) return null;
  const results = {};
  for (const step of def) results[step.key] = await safeRunTool(step.toolName);
  return { workflow: name, status: statusFromResults(results), findings: statusFromResults.lastReasons || [], results };
}

// ---- Intent detection ----
const DIAG_VERB = /\b(check|status|diagnose|diagnostic|scan|inspect|show|report|whats?\s+wrong|what\s+is\s+wrong|troubleshoot|debug|why\s+is|health|fix)\b/i;

// A complaint is as strong a signal as a diagnostic verb -- stronger, really, because it
// is how people actually open. "i cant see my wifi" is a request to go look, even though
// it contains no verb from the list above.
const PROBLEM_PHRASE = new RegExp([
  "\\b(can'?t|cannot|won'?t|wont|does\\s?n'?t|doesnt|is\\s?n'?t|isnt|ai\\s?n'?t)\\b",
  '\\bnot\\s+(work|working|connect|connecting|showing|detected|found|there|up)\\b',
  '\\b(no|missing|gone|disappeared|vanished|dead|broken|busted|stuck|failing|failed|lost|dropped|down)\\b',
  '\\b(stopped|quit|keeps?\\s+(dropping|disconnecting|failing|crashing))\\b',
  '\\b(problem|issue|trouble|weird|strange|acting\\s+up|messed\\s+up|screwed)\\b',
  // Some complaints name only the symptom, with no negation and no verb: "disk is full",
  // "pc is slow", "it keeps freezing". Those were falling through to plain chat.
  '\\b(slow|sluggish|laggy|lagging|freezing|frozen|hanging|crashing|overheating|full)\\b',
  // "running out of space" names the symptom without negating anything. Kept narrow so
  // "out of curiosity" does not become a diagnostic request.
  '\\bout\\s+of\\s+(space|room|disk|memory|ram|storage)\\b',
].join('|'), 'i');

// A trigger word is not the same as a report. "explain how wifi works" and "what does it
// mean when a driver is unsigned" were both firing real diagnostic sweeps against this
// machine, because 'wifi' and 'driver' are strong triggers regardless of what is being
// asked -- and once L2 claims a turn, the model may only annotate, so the actual question
// never got answered.
const EXPLANATORY = new RegExp([
  '^\\s*(explain|describe|define|tell me about)\\b',
  '^\\s*how (do|does|can|would) (i|you|one|a|an|it)\\b',
  '^\\s*what (is|are) (a|an|the)\\b',
  '\\bwhat does .{0,40} mean\\b',
  "\\bwhat'?s the difference\\b",
  '\\b(my|a|his|her|their) friend\\b',
  '\\b(someone|somebody) else\\b',
  '\\bin general\\b',
].join('|'), 'i');

// ...unless they are plainly talking about THIS machine, in which case "explain why my
// wifi keeps dropping" is still a request to go and look.
const OWN_MACHINE = /\b(my|this)\s+(pc|computer|laptop|machine|box|wifi|network|internet|connection|adapter|dongle|driver|disk|drive|storage|ram|memory|cpu)\b/i;

function hasWord(text, phrase) {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9_])' + esc + '(s|es|ing|ed)?($|[^a-z0-9_])', 'i').test(text);
}

const INTENT_MAP = [
  { name: 'system_health', triggers: ['health', 'status', 'overview', 'triage', 'check everything', 'what is wrong', 'whats wrong'] },
  { name: 'disk_check',    triggers: ['disk', 'space', 'storage', 'full', 'drive', 'df', 'partition'] },
  { name: 'network_check', triggers: ['network', 'internet', 'ping', 'wifi', 'connection', 'connect', 'online', 'no internet'] },
  { name: 'device_check',  triggers: ['driver', 'adapter', 'device', 'usb', 'dongle', 'not detected', 'not recognised', 'not recognized', 'didnt load', 'did not load'] },
  { name: 'boot_check',    triggers: ['boot', 'startup', 'start up', 'cold boot', 'first boot', 'on boot', 'restart', 'reboot'] },
  { name: 'process_check', triggers: ['process', 'cpu', 'hang', 'slow', 'freeze', 'freezing', 'lag', 'memory', 'ram', 'task'] },
  { name: 'log_check',     triggers: ['log', 'error', 'crash', 'journal', 'events', 'syslog'] },
  { name: 'port_check',    triggers: ['port', 'listen', 'socket', 'netstat', 'binding'] },
  { name: 'boot_info',     triggers: ['uptime', 'last boot'] },
  { name: 'service_check', triggers: ['service', 'daemon', 'systemd', 'running services', 'services'] },
  { name: 'user_check',    triggers: ['user', 'logged', 'who', 'login', 'auth', 'session'] },
  { name: 'env_check',     triggers: ['environment variable', 'environment variables', 'env var', 'env vars', 'envvar', 'printenv', 'path variable'], requireVerb: true },
];

const STRONG_TRIGGERS = new Set([
  'netstat', 'syslog', 'journalctl', 'systemd', 'uptime', 'df', 'partition', 'printenv',
  'ipconfig', 'tracert', 'daemon', 'reboot', 'last boot', 'socket', 'driver', 'adapter',
  'dongle', 'cold boot', 'first boot', 'no internet',
  // 'wifi' is unambiguous -- nobody says it about anything but the network.
  'wifi',
]);

export function detectIntents(input) {
  const low = String(input || '').toLowerCase();
  // A general question about how something works is not a fault report about this machine.
  if (EXPLANATORY.test(low) && !OWN_MACHINE.test(low)) return null;
  const matched = [];
  const seen = new Set();
  const hasVerb    = DIAG_VERB.test(low);
  const hasProblem = PROBLEM_PHRASE.test(low);
  const asking     = hasVerb || hasProblem;
  for (const entry of INTENT_MAP) {
    if (seen.has(entry.name)) continue;
    const hits = entry.triggers.filter(t => hasWord(low, t));
    if (!hits.length) continue;
    if (!asking && !hits.some(h => STRONG_TRIGGERS.has(h))) continue;
    // env_check stays strict: it is the one workflow that dumps the environment, so it
    // needs an explicit ask rather than an ambient complaint.
    if (entry.requireVerb && !hasVerb) continue;
    matched.push(entry.name);
    seen.add(entry.name);
  }
  return matched.length ? matched : null;
}

export function listWorkflows() {
  return INTENT_MAP.map(e => ({ name: e.name, triggers: e.triggers }));
}
