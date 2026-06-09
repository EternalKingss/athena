// network.mjs -- Network situational awareness (Pillar 4)
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { getCachedCapabilities } from './capabilities.mjs';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function probe(cmd, label) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    return stdout.trim();
  } catch (e) {
    if (label && process.env.DEBUG) console.debug(`[network:${label}] ${e.code || e.message}`);
    return '';
  }
}

async function getRoutes() {
  if (isWin)  return probe('route print 0.0.0.0 2>nul', 'routes');
  if (isMac)  return probe('netstat -rn -f inet 2>/dev/null | head -25', 'routes');
  return probe('ip route 2>/dev/null || netstat -rn 2>/dev/null | head -25', 'routes');
}

async function getDNSServers() {
  if (isWin) {
    const out = await probe('ipconfig /all 2>nul', 'dns');
    return out.split('\n')
      .filter(l => /DNS Server/i.test(l))
      .map(l => l.split(':').slice(1).join(':').trim())
      .filter(Boolean);
  }
  if (isMac) {
    const out = await probe('scutil --dns 2>/dev/null | grep nameserver | head -5', 'dns');
    return out.split('\n').map(l => l.replace(/.*nameserver\[.*?\]\s*:\s*/, '').trim()).filter(Boolean);
  }
  if (existsSync('/etc/resolv.conf')) {
    try {
      return readFileSync('/etc/resolv.conf', 'utf8')
        .split('\n')
        .filter(l => l.startsWith('nameserver'))
        .map(l => l.replace('nameserver', '').trim());
    } catch (e) {
      if (process.env.DEBUG) console.debug(`[network:dns] resolv.conf read failed: ${e.message}`);
      return [];
    }
  }
  return [];
}

async function getListeningPorts() {
  let out = '';
  if (isWin) {
    out = await probe('netstat -an 2>nul | findstr LISTENING', 'ports');
  } else {
    out = await probe('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', 'ports');
  }
  const ports = out.split('\n')
    .filter(l => isWin ? Boolean(l) : l.includes('LISTEN'))
    .map(l => { const m = l.match(/:(\d+)\s/); return m ? Number(m[1]) : null; })
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
  return ports;
}

export async function getSituationalAwareness() {
  const ifaces = networkInterfaces();
  const interfaces = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal) interfaces.push({ name, family: addr.family, address: addr.address, mac: addr.mac });
    }
  }

  const [routes, dns, listeningPorts] = await Promise.all([
    getRoutes(),
    getDNSServers(),
    getListeningPorts(),
  ]);

  return { interfaces, routes, dns, listeningPorts };
}

export async function handleNetworkScanTool(args) {
  const deep   = args?.deep === true;
  const target = args?.target || '127.0.0.1';

  const aw    = await getSituationalAwareness();
  const lines = ['## Network Situational Awareness', ''];

  const ipv4 = aw.interfaces.filter(i => i.family === 'IPv4');
  if (ipv4.length) {
    lines.push('### Interfaces');
    ipv4.forEach(i => lines.push(`  ${i.name}: ${i.address}${i.mac ? ` (${i.mac})` : ''}`));
    lines.push('');
  }

  if (aw.dns.length) {
    lines.push('### DNS Servers');
    aw.dns.forEach(d => lines.push(`  ${d}`));
    lines.push('');
  }

  if (aw.listeningPorts.length) {
    lines.push('### Listening Ports');
    lines.push(`  ${aw.listeningPorts.join(', ')}`);
    lines.push('');
  }

  if (aw.routes) {
    lines.push('### Routes');
    aw.routes.split('\n').slice(0, 20).forEach(l => lines.push(`  ${l}`));
    lines.push('');
  }

  if (deep) {
    lines.push(`### nmap Scan (${target})`);
    const caps    = getCachedCapabilities();
    const hasNmap = caps?.security?.some(s => s.toLowerCase().includes('nmap'));
    if (hasNmap) {
      const nmapOut = await probe(`nmap -sV --open -T4 ${target} 2>/dev/null`, 'nmap');
      lines.push(nmapOut || '  (no output)');
    } else {
      lines.push('  nmap not available -- install it for deep port scanning.');
    }
    lines.push('');
  }

  return lines.join('\n');
}
