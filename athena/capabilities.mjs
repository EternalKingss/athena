// capabilities.mjs — detect what's installed on the host machine at startup
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PATHS } from './paths.mjs';

const execAsync = promisify(exec);

let _cache = null;

async function probe(cmd) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    return stdout.trim() || null;
  } catch (e) {
    // Non-zero exit is normal (last which failed) — still return any stdout collected
    return e.stdout?.trim() || null;
  }
}

// One subprocess per group — far fewer disk seeks than one-per-binary.
async function checkAll(names) {
  if (!names.length) return [];
  let out;
  if (process.platform === 'win32') {
    const checks = names.map(n => `(where "${n}" >nul 2>&1 && echo ${n})`).join(' & ');
    out = await probe(`cmd /d /c ${checks}`);
  } else {
    const list = names.map(n => `"${n}"`).join(' ');
    out = await probe(`bash -c 'for c in ${list}; do which "$c" >/dev/null 2>&1 && echo "$c"; done'`);
  }
  if (!out) return [];
  const found = new Set(out.split('\n').map(l => l.trim()).filter(Boolean));
  return names.filter(n => found.has(n));
}

async function detectGPUs() {
  const gpus = [];
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  const nvOut = await probe('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null');
  if (nvOut) nvOut.split('\n').filter(Boolean).forEach(n => gpus.push('NVIDIA ' + n.trim()));

  const rocmOut = await probe('rocm-smi --showproductname 2>/dev/null | grep -i "gpu\\|card" | head -4');
  if (rocmOut) rocmOut.split('\n').filter(Boolean).forEach(n => gpus.push('AMD ' + n.trim()));

  if (!gpus.length && isWin) {
    const wmicOut = await probe('wmic path win32_VideoController get Name /format:list 2>nul');
    if (wmicOut) {
      wmicOut.split('\n')
        .filter(l => l.includes('='))
        .map(l => l.split('=')[1]?.trim())
        .filter(Boolean)
        .forEach(n => gpus.push(n));
    }
  }

  if (!gpus.length && isMac) {
    const spOut = await probe("system_profiler SPDisplaysDataType 2>/dev/null | grep 'Chipset Model'");
    if (spOut) spOut.split('\n').forEach(l => {
      const v = l.replace(/.*Chipset Model:\s*/, '').trim();
      if (v) gpus.push(v);
    });
  }

  if (!gpus.length) {
    const lspciOut = await probe("lspci 2>/dev/null | grep -i 'vga\\|3d\\|display'");
    if (lspciOut) lspciOut.split('\n').filter(Boolean).forEach(n => gpus.push(n.trim()));
  }

  return gpus;
}

async function detectNetwork() {
  const ifaces = networkInterfaces();
  const interfaces = [];
  const vpn = [];

  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (!addrs) continue;
    const isVPN = /^(tun|tap|wg|ppp|utun|ipsec|vpn|proton|mullvad|nordlynx|windscribe)/i.test(name);
    if (isVPN) vpn.push(name);
    for (const addr of addrs) {
      if (addr.internal) continue;
      interfaces.push({ name, family: addr.family, address: addr.address, isVPN });
    }
  }

  let publicIP = null;
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    publicIP = data.ip;
  } catch { /* offline or blocked */ }

  return { interfaces, vpn, publicIP };
}

async function detectSystemResources() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  let ramTotal = null, ramFree = null, cpuModel = null, cpuCores = null, disks = [];

  if (isWin) {
    const ramOut = await probe('wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /format:list 2>nul');
    if (ramOut) {
      const total = ramOut.match(/TotalVisibleMemorySize=(\d+)/)?.[1];
      const free  = ramOut.match(/FreePhysicalMemory=(\d+)/)?.[1];
      if (total) ramTotal = Math.round(Number(total) / 1024 / 1024 * 10) / 10 + ' GB';
      if (free)  ramFree  = Math.round(Number(free)  / 1024 / 1024 * 10) / 10 + ' GB free';
    }
    const cpuOut = await probe('wmic cpu get Name,NumberOfCores /format:list 2>nul');
    if (cpuOut) {
      cpuModel = cpuOut.match(/Name=(.+)/)?.[1]?.trim();
      cpuCores = cpuOut.match(/NumberOfCores=(\d+)/)?.[1];
    }
    const diskOut = await probe('wmic logicaldisk where drivetype=3 get Caption,Size,FreeSpace /format:list 2>nul');
    if (diskOut) {
      const entries = diskOut.split(/\n\n/).filter(Boolean);
      for (const e of entries) {
        const cap  = e.match(/Caption=(\S+)/)?.[1];
        const size = e.match(/Size=(\d+)/)?.[1];
        const free = e.match(/FreeSpace=(\d+)/)?.[1];
        if (cap && size) disks.push(`${cap} ${Math.round(Number(size)/1e9)}GB (${Math.round(Number(free||0)/1e9)}GB free)`);
      }
    }
  } else if (isMac) {
    const [totalOut, vmOut, cpuOut, coresOut, diskOut] = await Promise.all([
      probe('sysctl -n hw.memsize 2>/dev/null'),
      probe("vm_stat 2>/dev/null | grep 'Pages free'"),
      probe('sysctl -n machdep.cpu.brand_string 2>/dev/null'),
      probe('sysctl -n hw.ncpu 2>/dev/null'),
      probe("df -h . 2>/dev/null | tail -1"),
    ]);
    if (totalOut) ramTotal = Math.round(Number(totalOut) / 1e9 * 10) / 10 + ' GB';
    if (vmOut) {
      const pages = Number(vmOut.match(/(\d+)/)?.[1] || 0);
      ramFree = Math.round(pages * 4096 / 1e9 * 10) / 10 + ' GB free';
    }
    cpuModel = cpuOut?.trim() || null;
    cpuCores = coresOut?.trim() || null;
    if (diskOut) {
      const parts = diskOut.trim().split(/\s+/);
      disks.push(`${parts[8] || '/'}: ${parts[1]} total, ${parts[3]} free`);
    }
  } else {
    const [memOut, cpuOut, coresOut, diskOut] = await Promise.all([
      probe('cat /proc/meminfo 2>/dev/null | grep -E "MemTotal|MemAvailable"'),
      probe("cat /proc/cpuinfo 2>/dev/null | grep 'model name' | head -1 | cut -d: -f2"),
      probe('nproc 2>/dev/null'),
      probe("df -h --output=target,size,avail -x tmpfs -x devtmpfs 2>/dev/null | grep -E '^/$|^/home'"),
    ]);
    if (memOut) {
      const total = memOut.match(/MemTotal:\s+(\d+)/)?.[1];
      const avail = memOut.match(/MemAvailable:\s+(\d+)/)?.[1];
      if (total) ramTotal = Math.round(Number(total) / 1024 / 1024 * 10) / 10 + ' GB';
      if (avail) ramFree  = Math.round(Number(avail) / 1024 / 1024 * 10) / 10 + ' GB free';
    }
    cpuModel = cpuOut?.trim() || null;
    cpuCores = coresOut?.trim() || null;
    if (diskOut) disks = diskOut.trim().split('\n').filter(Boolean).map(l => {
      const p = l.trim().split(/\s+/);
      return `${p[0]}: ${p[1]} total, ${p[2]} free`;
    });
  }

  return { ramTotal, ramFree, cpuModel, cpuCores: cpuCores ? Number(cpuCores) : null, disks };
}

function detectMCPServers() {
  const home = homedir();
  const cwd  = process.cwd();
  const found = [];

  const paths = [
    join(home, '.claude.json'),
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    join(home, '.cursor', 'mcp.json'),
    join(home, '.config', 'cursor', 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(cwd, 'mcp.json'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const servers = raw.mcpServers || raw.servers || {};
      const names = Object.keys(servers);
      if (names.length) {
        const label = p.startsWith(home) ? p.replace(home, '~') : p;
        names.forEach(n => found.push(`${n} (${label})`));
      }
    } catch { /* ignore parse errors */ }
  }

  return found;
}

async function detect() {
  const [
    langs, compilers, pkgMgrs, containers,
    browsers, ides, databases, devops, utils,
    security, gpus, network, system,
  ] = await Promise.all([
    checkAll(['python3', 'python', 'ruby', 'php', 'perl', 'lua', 'julia', 'Rscript', 'swift', 'kotlin', 'scala', 'elixir', 'erlang', 'haskell', 'ghc', 'ocaml', 'zig']),
    checkAll(['gcc', 'g++', 'clang', 'clang++', 'javac', 'kotlinc', 'rustc', 'cargo', 'go', 'dotnet', 'tsc', 'mvn', 'gradle', 'cmake', 'make', 'ninja', 'msbuild', 'bazel']),
    checkAll(['npm', 'pnpm', 'yarn', 'bun', 'deno', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'pdm', 'gem', 'composer', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'zypper', 'snap', 'flatpak', 'winget', 'choco', 'scoop', 'nix']),
    checkAll(['docker', 'docker-compose', 'podman', 'kubectl', 'k3s', 'helm', 'minikube', 'kind', 'nerdctl', 'buildah', 'skopeo', 'kompose']),
    checkAll(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'firefox', 'brave-browser', 'microsoft-edge', 'opera', 'safari', 'lynx', 'w3m']),
    checkAll(['code', 'cursor', 'zed', 'vim', 'nvim', 'emacs', 'nano', 'micro', 'idea', 'pycharm', 'webstorm', 'goland', 'clion', 'rider', 'datagrip', 'fleet', 'helix', 'hx', 'subl', 'atom', 'brackets']),
    checkAll(['mysql', 'mysqladmin', 'psql', 'sqlite3', 'redis-cli', 'mongosh', 'mongo', 'influx', 'cqlsh', 'ClickHouse', 'duckdb']),
    checkAll(['git', 'gh', 'glab', 'aws', 'az', 'gcloud', 'terraform', 'tofu', 'ansible', 'pulumi', 'vault', 'consul', 'nomad', 'packer', 'vagrant', 'flyctl', 'fly', 'railway', 'vercel', 'netlify', 'wrangler']),
    checkAll(['curl', 'wget', 'jq', 'yq', 'fx', 'httpie', 'xh', 'ffmpeg', 'convert', 'tmux', 'screen', 'zellij', 'htop', 'btop', 'tree', 'fd', 'fzf', 'rg', 'ag', 'bat', 'eza', 'lsd', 'rsync', 'ssh', 'gpg', 'openssl', 'sops', 'age']),
    checkAll(['nmap', 'wireshark', 'tshark', 'tcpdump', 'burpsuite', 'sqlmap', 'hydra', 'nikto', 'masscan', 'gobuster', 'ffuf', 'metasploit', 'msfconsole', 'aircrack-ng', 'hashcat', 'john', 'clamscan', 'clamd', 'maldet', 'lynis', 'ufw', 'iptables', 'nftables', 'fail2ban']),
    detectGPUs(),
    detectNetwork(),
    detectSystemResources(),
  ]);

  const mcp = detectMCPServers();

  // Bundled tools living on the drive itself (in runtime/)
  const bundled = {
    python: existsSync(PATHS.python),
    lokiPy: existsSync(PATHS.lokiPy),
  };

  return {
    langs, compilers, pkgMgrs, containers,
    browsers, ides, databases, devops, utils,
    security, gpus, network, system,
    mcp, bundled,
    node: process.version,
    detectedAt: new Date().toISOString(),
  };
}

export async function detectCapabilities() {
  if (_cache) return _cache;
  _cache = await detect();
  return _cache;
}

export function getCachedCapabilities() {
  return _cache;
}

export function clearCapabilityCache() {
  _cache = null;
}

export function capabilitiesSummary() {
  const caps = _cache;
  if (!caps) return '';

  const lines = ['MACHINE (detected at startup):'];

  // System resources
  const s = caps.system;
  if (s) {
    if (s.cpuModel) lines.push(`  CPU:              ${s.cpuModel}${s.cpuCores ? ` (${s.cpuCores} cores)` : ''}`);
    if (s.ramTotal)  lines.push(`  RAM:              ${s.ramTotal}${s.ramFree ? `, ${s.ramFree}` : ''}`);
    if (s.disks?.length) lines.push(`  Disk:             ${s.disks.join(' | ')}`);
  }

  // Network
  const n = caps.network;
  if (n) {
    const addrs = n.interfaces.filter(i => i.family === 'IPv4').map(i => `${i.name}:${i.address}${i.isVPN ? ' [VPN]' : ''}`);
    if (addrs.length) lines.push(`  Network:          ${addrs.join(', ')}`);
    if (n.publicIP)   lines.push(`  Public IP:        ${n.publicIP}`);
    if (n.vpn.length) lines.push(`  VPN:              ${n.vpn.join(', ')} (active)`);
  }

  if (caps.gpus.length)       lines.push('  GPUs:             ' + caps.gpus.join(' | '));
  if (caps.langs.length)      lines.push('  Languages:        ' + caps.langs.join(', '));
  if (caps.compilers.length)  lines.push('  Compilers/Build:  ' + caps.compilers.join(', '));
  if (caps.pkgMgrs.length)    lines.push('  Pkg Managers:     ' + caps.pkgMgrs.join(', '));
  if (caps.containers.length) lines.push('  Containers:       ' + caps.containers.join(', '));
  if (caps.browsers.length)   lines.push('  Browsers:         ' + caps.browsers.join(', '));
  if (caps.ides.length)       lines.push('  IDEs/Editors:     ' + caps.ides.join(', '));
  if (caps.databases.length)  lines.push('  Databases:        ' + caps.databases.join(', '));
  if (caps.devops.length)     lines.push('  DevOps/Cloud:     ' + caps.devops.join(', '));
  if (caps.utils.length)      lines.push('  Utilities:        ' + caps.utils.join(', '));
  if (caps.security.length)   lines.push('  Security Tools:   ' + caps.security.join(', '));
  if (caps.mcp.length)        lines.push('  MCP Servers:      ' + caps.mcp.join(', '));

  const b = caps.bundled;
  const bundledList = [
    b.python ? 'python (drive)' : null,
    b.lokiPy ? 'loki (drive)'   : null,
  ].filter(Boolean);
  if (bundledList.length) lines.push('  Bundled on drive: ' + bundledList.join(', '));

  return lines.join('\n');
}
