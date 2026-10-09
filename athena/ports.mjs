// Listening-port enumeration, shared by network.mjs (situational awareness) and
// threat.mjs (exposure findings). One implementation so both report the same ports.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';

export async function getListeningPorts() {
  let out = '';
  try {
    const cmd = isWin
      ? 'netstat -an 2>nul | findstr LISTENING'
      : 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';
    out = (await execAsync(cmd, { timeout: 10000 })).stdout.trim();
  } catch (e) {
    if (process.env.DEBUG) console.debug(`[ports] ${e.code || e.message}`);
    return [];
  }
  return out.split('\n')
    .filter(l => isWin ? Boolean(l.trim()) : l.includes('LISTEN'))
    .map(l => { const m = l.match(/:(\d+)\s/); return m ? Number(m[1]) : null; })
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
}
