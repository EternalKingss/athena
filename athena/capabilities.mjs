// capabilities.mjs — detect what's installed on the host machine at startup
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
    out = await probe(`cmd /d /c "${checks}"`);
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
    browsers, ides, databases, devops, utils, gpus,
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
    detectGPUs(),
  ]);

  const mcp = detectMCPServers();

  return {
    langs, compilers, pkgMgrs, containers,
    browsers, ides, databases, devops, utils,
    gpus, mcp,
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
  if (caps.langs.length)      lines.push('  Languages:        ' + caps.langs.join(', '));
  if (caps.compilers.length)  lines.push('  Compilers/Build:  ' + caps.compilers.join(', '));
  if (caps.pkgMgrs.length)    lines.push('  Pkg Managers:     ' + caps.pkgMgrs.join(', '));
  if (caps.containers.length) lines.push('  Containers:       ' + caps.containers.join(', '));
  if (caps.browsers.length)   lines.push('  Browsers:         ' + caps.browsers.join(', '));
  if (caps.ides.length)       lines.push('  IDEs/Editors:     ' + caps.ides.join(', '));
  if (caps.databases.length)  lines.push('  Databases:        ' + caps.databases.join(', '));
  if (caps.devops.length)     lines.push('  DevOps/Cloud:     ' + caps.devops.join(', '));
  if (caps.utils.length)      lines.push('  Utilities:        ' + caps.utils.join(', '));
  if (caps.gpus.length)       lines.push('  GPUs:             ' + caps.gpus.join(' | '));
  if (caps.mcp.length)        lines.push('  MCP Servers:      ' + caps.mcp.join(', '));

  return lines.join('\n');
}
