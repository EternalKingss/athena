// control_engine.mjs -- L2 deterministic diagnostic engine
// Athena guarantees structured diagnostic coverage under incomplete tool data.
// No LLM required. All execution is deterministic with confidence tagging.
import { spawn } from 'node:child_process';

// ---- OS-aware tool registry -- abstract name -> platform commands ----
const TOOL_REGISTRY = {
  disk_usage: {
    linux:  ['df -h', 'df -k'],
    darwin: ['df -h'],
    win32:  ['wmic logicaldisk get caption,freespace,size /format:list',
             'powershell "Get-PSDrive -PSProvider FileSystem | Select Name,Used,Free"'],
  },
  large_dirs: {
    linux:  ['du -sh /[^p]* 2>/dev/null | sort -rh | head -10'],
    darwin: ['du -sh /* 2>/dev/null | sort -rh | head -10'],
    win32:  ['powershell "Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue | Sort-Object Length -Desc | Select -First 10 Name,Length"'],
  },
  process_list: {
    linux:  ['ps aux --sort=-%cpu 2>/dev/null | head -16', 'top -bn1 2>/dev/null | head -20'],
    darwin: ['ps aux -r 2>/dev/null | head -16'],
    win32:  ['tasklist /FO TABLE', 'powershell "Get-Process | Sort CPU -Desc | Select -First 15 Name,CPU,WS"'],
  },
  memory_usage: {
    linux:  ['free -h', 'cat /proc/meminfo | head -5'],
    darwin: ['vm_stat', 'sysctl hw.memsize hw.physmem'],
    win32:  ['wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:list',
             'powershell "(Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory,TotalVisibleMemorySize)"'],
  },
  network_status: {
    linux:  ['ip addr show 2>/dev/null', 'ifconfig 2>/dev/null', 'cat /proc/net/dev'],
    darwin: ['ifconfig 2>/dev/null'],
    win32:  ['ipconfig /all', 'netsh interface show interface'],
  },
  ping_test: {
    linux:  ['ping -c 3 -W 2 8.8.8.8 2>&1', 'ping -c 3 -W 2 1.1.1.1 2>&1'],
    darwin: ['ping -c 3 -t 3 8.8.8.8 2>&1', 'ping -c 3 -t 3 1.1.1.1 2>&1'],
    win32:  ['ping -n 3 -w 2000 8.8.8.8', 'ping -n 3 -w 2000 1.1.1.1'],
  },
  routing_table: {
    linux:  ['ip route show 2>/dev/null', 'route -n 2>/dev/null'],
    darwin: ['netstat -nr 2>/dev/null'],
    win32:  ['route print', 'netstat -r'],
  },
  open_ports: {
    linux:  ['ss -tlnp 2>/dev/null', 'netstat -tlnp 2>/dev/null'],
    darwin: ['netstat -an -p tcp 2>/dev/null | grep LISTEN'],
    win32:  ['netstat -ano | findstr LISTENING', 'powershell "Get-NetTCPConnection -State Listen"'],
  },
  system_logs: {
    linux:  ['journalctl -n 30 --no-pager -p err..emerg 2>/dev/null',
             'tail -30 /var/log/syslog 2>/dev/null',
             'tail -30 /var/log/messages 2>/dev/null'],
    darwin: ['log show --last 5m --predicate "messageType == 16 OR messageType == 17" 2>/dev/null | tail -30',
             'tail -30 /var/log/system.log 2>/dev/null'],
    win32:  ['powershell "Get-EventLog -LogName System -Newest 20 -EntryType Error,Warning | Format-List TimeGenerated,EntryType,Message"'],
  },
  uptime: {
    linux:  ['uptime', 'cat /proc/uptime'],
    darwin: ['uptime'],
    win32:  ['net stats workstation | findstr /i "since"', 'powershell "(Get-Date) - (gcim Win32_OperatingSystem).LastBootUpTime"'],
  },
  last_reboots: {
    linux:  ['last reboot 2>/dev/null | head -5', 'who -b 2>/dev/null'],
    darwin: ['last reboot 2>/dev/null | head -5'],
    win32:  ['powershell "Get-EventLog -LogName System -Source User32 -Newest 5 | Where-Object {$_.EventID -eq 1074} | Format-List TimeGenerated,Message"'],
  },
  running_services: {
    linux:  ['systemctl list-units --type=service --state=running 2>/dev/null | head -20',
             'service --status-all 2>&1 | grep " + " | head -20'],
    darwin: ['launchctl list 2>/dev/null | head -20'],
    win32:  ['sc query type= all state= running', 'powershell "Get-Service | Where-Object Status -eq Running | Select Name,DisplayName | head -20"'],
  },
  logged_users: {
    linux:  ['who', 'w 2>/dev/null', 'last -5 2>/dev/null'],
    darwin: ['who', 'w 2>/dev/null'],
    win32:  ['query user 2>/dev/null', 'powershell "Get-LocalUser | Where-Object Enabled -eq True"'],
  },
  env_vars: {
    linux:  ['env | grep -v "^LESS_TERMCAP\\|^LS_COLORS\\|^_=" | sort'],
    darwin: ['env | grep -v "^LESS_TERMCAP\\|^LS_COLORS\\|^_=" | sort'],
    win32:  ['set | findstr /v "CommonProgram\\|Program\\|System\\|USERPROFILE"'],
  },
  cpu_info: {
    linux:  ['nproc', 'lscpu 2>/dev/null | head -20', 'cat /proc/cpuinfo | grep "model name" | head -2'],
    darwin: ['sysctl -n hw.ncpu hw.model machdep.cpu.brand_string'],
    win32:  ['wmic cpu get Name,NumberOfCores,MaxClockSpeed /format:list'],
  },
};

// Returns ordered command list for current platform with linux as fallback for unknown Unix
function commandsFor(toolName) {
  const entry = TOOL_REGISTRY[toolName];
  if (!entry) return [];
  const plat = process.platform;
  return entry[plat] || entry.linux || [];
}

// ---- Capability cache (integrates capabilities.mjs) ----
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

// ---- Confidence-tagged shell execution ----
// Returns { confidence: 'HIGH'|'MEDIUM'|'LOW', output: string, cmd: string|null }
async function safeRunTool(toolName) {
  const commands = commandsFor(toolName);
  if (!commands.length) return { confidence: 'LOW', output: '[no commands defined for ' + toolName + ' on ' + process.platform + ']', cmd: null };

  // Filter out commands whose binary caps scan already marked missing
  const caps = await getCaps();
  const known_missing = new Set(caps.missingTools || []);
  const toTry = commands.filter(cmd => {
    const bin = cmd.trim().split(/\s+/)[0].replace(/^powershell$/i, '');
    return !known_missing.has(bin);
  });
  const ordered = toTry.length ? toTry : commands; // fallback: try all if caps unknown

  for (const cmd of ordered) {
    try {
      const output = await execWithTimeout(cmd, 10000);
      if (output && output.trim()) return { confidence: 'HIGH', output: output.trim(), cmd };
      return { confidence: 'MEDIUM', output: '(command succeeded but produced no output)', cmd };
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOENT' || e.code === 'TIMEOUT') continue;
      // Non-zero exit WITH output is still useful data
      if (e.output && e.output.trim()) return { confidence: 'MEDIUM', output: e.output.trim(), cmd };
    }
  }
  return { confidence: 'LOW', output: '[unavailable on this system -- all commands failed]', cmd: null };
}

function execWithTimeout(cmd, ms) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd' : 'sh';
    const args  = isWin ? ['/c', cmd] : ['-c', cmd];
    const proc  = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      const e = new Error('timeout'); e.code = 'TIMEOUT'; reject(e);
    }, ms);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out);
      else {
        const e = new Error('exit ' + code);
        e.output = out || err;
        reject(e);
      }
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ---- Report formatter ----
function statusFromResults(results) {
  const confidences = Object.values(results).map(r => r.confidence);
  if (confidences.every(c => c === 'HIGH')) return 'OK';
  if (confidences.some(c => c === 'LOW'))   return 'WARN';
  return 'OK';
}

function formatReport(workflowName, results, extraStatus) {
  const status = extraStatus || statusFromResults(results);
  const lines = [
    '[WORKFLOW: ' + workflowName.toUpperCase() + ']',
    'STATUS: ' + status,
    '',
    'DATA:',
  ];
  for (const [key, r] of Object.entries(results)) {
    lines.push('  [' + r.confidence + '] ' + key.replace(/_/g, ' ') + ':');
    const dataLines = r.output.split('\n').slice(0, 30); // cap output per tool
    for (const dl of dataLines) lines.push('    ' + dl);
    lines.push('');
  }
  if (status === 'WARN' || status === 'FAIL') {
    lines.push('RECOMMENDED ACTIONS:');
    lines.push('  Review DATA sections marked [LOW] or [MEDIUM] above.');
    lines.push('  Run individual workflows for deeper diagnosis.');
  }
  return lines.join('\n');
}

// ---- Workflow definitions ----
// Each workflow is an array of steps. Steps have:
//   toolName: key into TOOL_REGISTRY
//   key: label in report
//   analyze(output): returns array of follow-up workflow names to trigger
const WORKFLOWS = {
  system_health: [
    { toolName: 'cpu_info',     key: 'cpu_info' },
    { toolName: 'memory_usage', key: 'memory', analyze: out => {
      // Low memory: trigger process_check
      if (/available:\s*[0-9]+[Mk]/i.test(out) || /MemAvailable:\s*[0-9]{1,5}\s/i.test(out)) return ['process_check'];
      return [];
    }},
    { toolName: 'disk_usage',   key: 'disk', analyze: out => {
      if (/\s9[0-9]%|\s100%/.test(out)) return ['disk_check'];
      return [];
    }},
    { toolName: 'uptime',       key: 'uptime' },
  ],
  disk_check: [
    { toolName: 'disk_usage',   key: 'disk_usage', analyze: out => {
      if (/\s9[0-9]%|\s100%/.test(out)) return ['process_check'];
      return [];
    }},
    { toolName: 'large_dirs',   key: 'large_directories' },
  ],
  network_check: [
    { toolName: 'network_status', key: 'interfaces' },
    { toolName: 'ping_test',      key: 'connectivity', analyze: out => {
      if (/100% packet loss|unreachable|timed out/i.test(out)) return ['routing_check'];
      return [];
    }},
    { toolName: 'routing_table',  key: 'routes' },
  ],
  routing_check: [
    { toolName: 'routing_table', key: 'routing_table' },
    { toolName: 'open_ports',    key: 'open_ports' },
  ],
  process_check: [
    { toolName: 'process_list',  key: 'top_processes' },
    { toolName: 'memory_usage',  key: 'memory_state' },
  ],
  log_check: [
    { toolName: 'system_logs', key: 'recent_errors' },
  ],
  port_check: [
    { toolName: 'open_ports', key: 'listening_ports' },
  ],
  boot_info: [
    { toolName: 'uptime',       key: 'uptime' },
    { toolName: 'last_reboots', key: 'reboot_history' },
  ],
  service_check: [
    { toolName: 'running_services', key: 'active_services' },
  ],
  user_check: [
    { toolName: 'logged_users', key: 'logged_in_users' },
  ],
  env_check: [
    { toolName: 'env_vars', key: 'environment_variables' },
  ],
};

// ---- Iterative adaptive workflow executor ----
const MAX_REFINEMENT_CYCLES = 2;
const MAX_CROSS_TRIGGERS    = 1;

async function runWorkflow(name) {
  const def = WORKFLOWS[name];
  if (!def) return '[WORKFLOW: ' + name + ']\nSTATUS: FAIL\nERROR: unknown workflow\n';

  const queue        = def.map(s => ({ ...s }));
  const results      = {};
  const seen         = new Set([name]);
  const triggerCount = {};
  let   cycles       = 0;

  while (queue.length) {
    const step   = queue.shift();
    const tagged = await safeRunTool(step.toolName);
    results[step.key] = tagged;

    if (step.analyze && tagged.confidence !== 'LOW' && cycles < MAX_REFINEMENT_CYCLES) {
      const followUps = step.analyze(tagged.output);
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

// ---- Multi-workflow plan executor ----
export async function runPlan(intents, emit) {
  const reports = [];
  for (const name of intents) {
    if (emit) emit({ type: 'token', content: '\n[L2 running: ' + name + '...]\n' });
    try {
      reports.push(await runWorkflow(name));
    } catch (e) {
      reports.push('[WORKFLOW: ' + name.toUpperCase() + ']\nSTATUS: FAIL\nERROR: ' + e.message + '\n');
    }
  }
  return reports.join('\n\n---\n\n');
}

// ---- Intent detection -- returns array (planner, not classifier) ----
const INTENT_MAP = [
  { name: 'system_health', triggers: ['health', 'status', 'overview', 'triage', 'check everything', 'what is wrong', 'whats wrong'] },
  { name: 'disk_check',    triggers: ['disk', 'space', 'storage', 'full', 'drive', 'df', 'partition'] },
  { name: 'network_check', triggers: ['network', 'internet', 'ping', 'wifi', 'connection', 'connect', 'online'] },
  { name: 'process_check', triggers: ['process', 'cpu', 'hang', 'slow', 'freeze', 'freezing', 'lag', 'memory', 'ram', 'task'] },
  { name: 'log_check',     triggers: ['log', 'error', 'crash', 'journal', 'events', 'syslog'] },
  { name: 'port_check',    triggers: ['port', 'listen', 'socket', 'netstat', 'binding'] },
  { name: 'boot_info',     triggers: ['boot', 'uptime', 'restart', 'reboot', 'started', 'last boot'] },
  { name: 'service_check', triggers: ['service', 'daemon', 'systemd', 'running services', 'services'] },
  { name: 'user_check',    triggers: ['user', 'logged', 'who', 'login', 'auth', 'session'] },
  { name: 'env_check',     triggers: ['env', 'path', 'variable', 'shell', 'environment'] },
];

export function detectIntents(input) {
  const low     = input.toLowerCase();
  const matched = [];
  const seen    = new Set();
  for (const entry of INTENT_MAP) {
    if (!seen.has(entry.name) && entry.triggers.some(t => low.includes(t))) {
      matched.push(entry.name);
      seen.add(entry.name);
    }
  }
  return matched.length ? matched : null;
}

export function listWorkflows() {
  return INTENT_MAP.map(e => ({ name: e.name, triggers: e.triggers }));
}
