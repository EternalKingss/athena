// net_triage.mjs -- L2 network triage ("combat medic"): get Athena back to her cloud model.
//
// When a cloud model call dies on the wire, api.mjs calls triageNetwork() once before it
// fails over to the next model. Triage measures where the connection is broken, applies
// the matching fix from fix_library.mjs (through machine_fixes.mjs's applyFix, so every
// fix keeps its detect/steps/verify contract and its confidence history), re-measures,
// and stops the moment the provider is reachable again.
//
// Measurement uses Node's own sockets and resolver, not ping: ICMP is blocked on plenty
// of networks that carry HTTPS fine, and ping output is localised on Windows. What we
// actually need to know is "can a TCP connection reach the API host on 443", so that is
// what gets tested.
//
// Layers, in the order they are checked:
//   captive           -- a hotel/cafe login page intercepts traffic -> tell the user to sign in
//   wifi-missing      -- Windows cannot see the Wi-Fi adapter     -> rescan devices, then replug advice
//   wifi-service      -- WLAN AutoConfig stopped (Windows)       -> start it
//   wifi-disabled     -- Wi-Fi adapter disabled                  -> enable it
//   wifi-radio-off    -- radio off / airplane mode               -> turn it on where an OS command exists
//   wifi-disconnected -- radio on, not joined to any network     -> rejoin a saved network in range
//   adapter -- no non-loopback IPv4 address at all        -> bring the adapter back up
//   dhcp    -- only 169.254.x.x (APIPA) addresses         -> release/renew the lease
//   dns     -- raw IPs reachable, API hostname won't resolve -> flush the DNS cache
//   stack   -- valid IP, nothing reachable                 -> NOT automatic, see below
// The Wi-Fi layers are only considered when no other adapter has a working address -- a
// machine on Ethernet with Wi-Fi off is not a Wi-Fi problem.
// When the built-in ladder runs out, fixes this machine has LEARNED (recorded online by
// Claude via learn_fix, network-tagged, and proven by their own verify step) are tried
// next -- the hard-coded list covers what is predictable, the learned list covers what
// is peculiar to this machine.
//
// The winsock / IP-stack reset is never run here. It needs a reboot to take effect, and it
// wipes VPN and other layered-provider entries -- that is a decision for the user, made
// through fix_issues with approval, not something to fire silently because one request
// failed. On "stack", triage reports what it measured and recommends it.
//
// Every command is async with a timeout; nothing here can block the event loop.
//
// Offline, this is ALL Athena does (v3.4): the only job without a connection is getting
// the connection back. Once the cloud model is reachable it handles everything else, so
// api.mjs does not fall back to the local model when triage says the network itself is
// down, and core.mjs answers with the network report instead of a general health sweep.

import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { NET_TRIAGE } from './config.mjs';

const PROBE_TIMEOUT_MS = 4000;
const CMD_TIMEOUT_MS   = 10000;
const SETTLE_MS        = 15000;   // how long to keep re-probing after a fix before giving up on it
const SETTLE_STEP_MS   = 3000;
const COOLDOWN_MS      = 3 * 60 * 1000;
const MAX_ROUNDS       = 5;       // e.g. radio on -> rejoin network -> renew lease -> flush DNS
// Well-known anycast resolvers, used only as "is there any route to the internet at all".
const RAW_TARGETS = ['1.1.1.1', '8.8.8.8'];
// Answers 204 with an empty body on a clean connection; a login page answers anything else.
const PORTAL_CHECK = { host: 'connectivitycheck.gstatic.com', path: '/generate_204' };

// What handles which layer, per platform. A string is a fix_library.mjs id (run through
// applyFix, so it keeps its detect/verify contract); { action } is a Wi-Fi command below
// whose arguments (adapter or network names) are only known at run time. Missing or
// empty = nothing safe to automate; the advice text says what the user has to do.
const LADDER = {
  win32: {
    'wifi-missing':      [{ action: 'rescan-devices' }, { action: 'usb-reenumerate' }, { action: 'usb-controller-reset' }],
    'wifi-service':      [{ action: 'start-wlansvc' }],
    'wifi-disabled':     [{ action: 'enable-wifi-adapter' }],
    'wifi-disconnected': [{ action: 'connect-known-wifi' }],
    adapter: ['adapter-bounce', { action: 'rescan-devices' }, { action: 'usb-reenumerate' }, { action: 'usb-controller-reset' }], dhcp: ['dhcp-renew'], dns: ['dns-cache-flush'],
  },
  linux: {
    'wifi-disabled':     [{ action: 'nm-radio-on' }, { action: 'nm-connect' }],
    'wifi-radio-off':    [{ action: 'nm-radio-on' }],
    'wifi-disconnected': [{ action: 'nm-connect' }],
    adapter: ['network-restart-linux'], dhcp: ['network-restart-linux'], dns: ['dns-cache-flush-linux'],
  },
  darwin: {
    'wifi-radio-off': [{ action: 'mac-radio-on' }],
    dns: ['dns-cache-flush-mac'],
  },
};
const STACK_RECOMMENDATION = {
  win32: 'winsock-reset (needs admin and a reboot -- Athena asks before running it)',
  linux: 'restart NetworkManager or reboot',
  darwin: 'turn Wi-Fi off and on, or reboot',
};

let _reporter = null;
let _inFlight = null;
let _lastRun  = 0;
let _lastResult = null;

// core.mjs points this at the current turn's emit so progress shows up in the UI.
export function setTriageReporter(fn) { _reporter = typeof fn === 'function' ? fn : null; }
function report(text) {
  try { if (_reporter) _reporter(text); else console.warn('[net_triage] ' + text); } catch {}
}

// No shell: arguments go to the program as-is, so a network name containing quotes or
// '&' cannot turn into a second command.
function run(file, args, timeout = CMD_TIMEOUT_MS) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

function tcpReachable(host, port = 443, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const sock = connect({ host, port });
    const done = ok => { clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function resolves(host, timeoutMs = PROBE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      lookup(host).then(() => true, () => false),
      new Promise(r => { timer = setTimeout(() => r(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// What the portal check's HTTP status means. A sign-in page answers with a redirect, a
// 200 login page, or 511 Network Authentication Required. Anything else -- a corporate
// proxy's 403/407, a 5xx -- is not evidence of a portal, and treating it as one would
// tell someone on a perfectly good office network to "sign in".
export function classifyPortalStatus(status) {
  if (status === 204) return false;
  if (status === 200 || status === 511 || (status >= 300 && status < 400)) return true;
  return null;
}

// true = a login page answered, false = clean 204, null = no evidence either way.
function captivePortal(timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const req = httpRequest({ host: PORTAL_CHECK.host, path: PORTAL_CHECK.path, method: 'GET', timeout: timeoutMs }, res => {
      res.resume();
      resolve(classifyPortalStatus(res.statusCode));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function addressSummary() {
  let routable = 0, apipa = 0;
  for (const addrs of Object.values(networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (a.address.startsWith('169.254.')) apipa++;
      else routable++;
    }
  }
  return { routable, apipa };
}

// ---- Wi-Fi state parsers (pure; exported for selfcheck fixtures) ----
// netsh labels are English-only; on a localised Windows these parsers find nothing and
// the Wi-Fi layers are skipped -- triage falls back to the address/DNS layers.

// Get-NetAdapter ... | ConvertTo-Json  ->  the first physical 802.11 adapter
// With several Wi-Fi adapters (built-in plus a USB dongle) the most usable one decides.
const WIN_STATUS_RANK = { up: 0, disconnected: 1, disabled: 2, 'not present': 3 };
export function parseWinAdapters(json) {
  let list;
  try { list = JSON.parse(String(json || '').trim() || 'null'); } catch { return null; }
  if (!list) return null;
  if (!Array.isArray(list)) list = [list];
  const rank = a => WIN_STATUS_RANK[String(a.Status || '').toLowerCase()] ?? 1;
  const a = list.filter(x => x && x.Name).sort((x, y) => rank(x) - rank(y))[0] || null;
  return a ? { device: a.Name, status: String(a.Status || '') } : null;
}

// Get-PnpDevice -Class Net | ConvertTo-Json  ->  is there a Wi-Fi device Windows knows of?
// A USB dongle that lost the cold-boot enumeration race is gone from Get-NetAdapter
// entirely (even with -IncludeHidden); only PnP still remembers it, as Present=false or
// with a driver error. Wi-Fi Direct virtual adapters are not real radios and are skipped.
export function parseWinPnpWifi(json) {
  let list;
  try { list = JSON.parse(String(json || '').trim() || 'null'); } catch { return null; }
  if (!list) return null;
  if (!Array.isArray(list)) list = [list];
  const wifi = list.filter(d => d && /wi-?fi|wireless|wlan|802\.11/i.test(String(d.FriendlyName || ''))
    && !/wi-?fi direct|virtual/i.test(String(d.FriendlyName || '')));
  if (!wifi.length) return null;
  const broken = wifi.filter(d => d.Present !== false && !/^ok$/i.test(String(d.Status || '')));
  return { device: String(wifi[0].FriendlyName), broken: broken.map(d => String(d.InstanceId || '')).filter(Boolean) };
}

export function parseNetshInterfaces(text) {
  const t = String(text || '');
  if (/wlansvc|AutoConfig Service .*is not running/i.test(t)) return { serviceStopped: true };
  const field = name => {
    const m = t.match(new RegExp('^\\s*' + name + '\\s*:\\s*(.+)$', 'mi'));
    return m ? m[1].trim() : '';
  };
  const state  = field('State').toLowerCase();
  const signal = parseInt(field('Signal'), 10);
  return {
    serviceStopped: false,
    hasInterface: /^\s*Name\s*:/mi.test(t),
    connected: state === 'connected',
    ssid: field('SSID') || null,
    signal: Number.isFinite(signal) ? signal : null,
    radioOff: /\b(Software|Hardware)\s+Off\b/i.test(t),
  };
}

export function parseNetshProfiles(text) {
  return [...String(text || '').matchAll(/^\s*All User Profile\s*:\s*(.+)$/gmi)].map(m => m[1].trim()).filter(Boolean);
}

export function parseNetshNetworks(text) {
  return [...String(text || '').matchAll(/^\s*SSID \d+\s*:\s*(.*)$/gmi)].map(m => m[1].trim()).filter(Boolean);
}

// nmcli -t escapes ':' inside values as '\:'
function nmSplit(line) {
  return String(line).split(/(?<!\\):/).map(x => x.replace(/\\:/g, ':'));
}

// nmcli -t -f TYPE,STATE,DEVICE,CONNECTION device  ->  the first wifi device
export function parseNmDevices(text) {
  for (const line of String(text || '').split('\n')) {
    const [type, state, device, connection] = nmSplit(line.trim());
    if (type !== 'wifi') continue;
    return { device, state: state || '', connection: connection || null };
  }
  return null;
}

export function parseNmConnections(text) {
  return String(text || '').split('\n').map(l => nmSplit(l.trim()))
    .filter(([name, type]) => name && type === '802-11-wireless').map(([name]) => name);
}

async function readWifiWin() {
  const ad = parseWinAdapters((await run('powershell', ['-NoProfile', '-Command',
    'Get-NetAdapter -Physical -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 9 } | Select-Object Name,Status | ConvertTo-Json -Compress'])).out);
  if (!ad) {
    const pnp = parseWinPnpWifi((await run('powershell', ['-NoProfile', '-Command',
      'Get-PnpDevice -Class Net -ErrorAction SilentlyContinue | Select-Object FriendlyName,Status,Present,InstanceId | ConvertTo-Json -Compress'])).out);
    return pnp ? { present: true, missing: true, device: pnp.device, known: [], inRange: [] } : null;
  }
  // "Not Present": Windows knows the adapter but cannot see it now -- a USB dongle that
  // is unplugged or failed to enumerate on a cold boot, or a driver that did not load.
  if (/not present/i.test(ad.status)) return { present: true, missing: true, device: ad.device, known: [], inRange: [] };
  const w = { present: true, device: ad.device, disabled: /^disabled$/i.test(ad.status), known: [], inRange: [] };
  if (w.disabled) return w;
  const ifc = parseNetshInterfaces((await run('netsh', ['wlan', 'show', 'interfaces'])).out);
  if (ifc.serviceStopped) return { ...w, serviceStopped: true };
  Object.assign(w, { connected: ifc.connected, ssid: ifc.ssid, signal: ifc.signal, radioOff: ifc.radioOff });
  if (!w.connected && !w.radioOff) {
    w.known   = parseNetshProfiles((await run('netsh', ['wlan', 'show', 'profiles'])).out);
    w.inRange = parseNetshNetworks((await run('netsh', ['wlan', 'show', 'networks'])).out);
  }
  return w;
}

async function readWifiLinux() {
  const dev = parseNmDevices((await run('nmcli', ['-t', '-f', 'TYPE,STATE,DEVICE,CONNECTION', 'device'])).out);
  if (!dev) return null;
  const radio = (await run('nmcli', ['-t', 'radio', 'wifi'])).out.trim().toLowerCase();
  const w = {
    present: true, device: dev.device,
    radioOff: radio === 'disabled',
    disabled: /unmanaged/.test(dev.state),
    connected: /^connected/.test(dev.state),
    ssid: dev.connection, known: [], inRange: [],
  };
  if (!w.connected && !w.radioOff) {
    w.known = parseNmConnections((await run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'])).out);
    w.inRange = (await run('nmcli', ['-t', '-f', 'SSID', 'device', 'wifi', 'list'])).out.split('\n').map(x => x.replace(/\\:/g, ':').trim()).filter(Boolean);
  }
  return w;
}

async function readWifiMac() {
  const ports = (await run('networksetup', ['-listallhardwareports'])).out;
  const m = ports.match(/Hardware Port:\s*(Wi-Fi|AirPort)\s*\n\s*Device:\s*(\S+)/i);
  if (!m) return null;
  const device = m[2];
  const power = (await run('networksetup', ['-getairportpower', device])).out;
  const net = (await run('networksetup', ['-getairportnetwork', device])).out;
  const ssid = (net.match(/Current (?:Wi-Fi|AirPort) Network:\s*(.+)/i) || [])[1] || null;
  return { present: true, device, radioOff: /:\s*Off\b/i.test(power), connected: !!ssid, ssid: ssid && ssid.trim(), known: [], inRange: [] };
}

export async function readWifiState(platform = process.platform) {
  try {
    if (platform === 'win32')  return await readWifiWin();
    if (platform === 'linux')  return await readWifiLinux();
    if (platform === 'darwin') return await readWifiMac();
  } catch {}
  return null;
}

// Saved networks that are actually in range, saved order kept. Falls back to every saved
// network when the scan came back empty (some drivers scan slowly right after radio-on).
export function reconnectCandidates(w) {
  const known = (w && w.known) || [];
  const inRange = new Set((w && w.inRange) || []);
  const hits = known.filter(n => inRange.has(n));
  return (hits.length ? hits : (inRange.size ? [] : known)).slice(0, 3);
}

// ---- Wi-Fi actions ----
async function wifiAction(name, w) {
  const dev = w && w.device;
  switch (name) {
    case 'start-wlansvc':
      return run('net', ['start', 'wlansvc']);
    case 'rescan-devices':
    {
      // Re-enumerates hardware, which brings back a USB adapter that failed to start;
      // then restarts any Wi-Fi device that enumerated but whose driver errored.
      const scan = await run('pnputil', ['/scan-devices'], 30000);
      await new Promise(res => setTimeout(res, 5000));
      const pnp = parseWinPnpWifi((await run('powershell', ['-NoProfile', '-Command',
        'Get-PnpDevice -Class Net -ErrorAction SilentlyContinue | Select-Object FriendlyName,Status,Present,InstanceId | ConvertTo-Json -Compress'])).out);
      let out = scan.out;
      for (const idn of (pnp && pnp.broken) || []) out += (await run('pnputil', ['/restart-device', idn], 30000)).out;
      return { ok: scan.ok, out };
    }
    case 'usb-reenumerate': {
      // A dongle that loses the cold-boot race shows up as "Unknown USB Device (Device
      // Descriptor Request Failed)" -- the port saw something but never learned what it was.
      // A rescan does not retry it. Removing that node and restarting its parent hub makes
      // the port enumerate again: a software unplug/replug. Other devices on the same hub
      // drop for a second or two.
      const ps = "$n=0; Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^USB.VID_0000' -or $_.FriendlyName -match 'Descriptor Request Failed|Port Reset Failed|Set Address Failed' } | ForEach-Object { $p=(Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_Parent -ErrorAction SilentlyContinue).Data; pnputil /remove-device $_.InstanceId | Out-Null; if ($p) { pnputil /restart-device $p | Out-Null }; $n++ }; pnputil /scan-devices | Out-Null; 'reset ' + $n + ' failed USB device(s)'";
      const r = await run('powershell', ['-NoProfile', '-Command', ps], 60000);
      const n = parseInt((r.out.match(/reset (\d+)/) || [])[1] || '0', 10);
      if (n > 0) await new Promise(res => setTimeout(res, 10000));   // dongle, driver, then association
      return { ok: r.ok && n > 0, out: n > 0 ? r.out : 'no failed USB device found' };
    }
    case 'usb-controller-reset': {
      // When a cold boot leaves the port with nothing on it at all (no device node, not even
      // a failed one), there is nothing to re-enumerate. What a warm reboot does that fixes
      // it is reset the USB host controller while the dongle is already powered. So do that:
      // walk from the dongle's last-known device node up to its PCI host controller and
      // restart it. Everything else on that controller (often a keyboard or mouse) drops for
      // a few seconds. Unknown controller -> restart every USB host controller.
      const ps = "$w = Get-PnpDevice -Class Net -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^USB' -and $_.FriendlyName -match 'Wi-?Fi|Wireless|WLAN|802.11' } | Sort-Object { (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_LastArrivalDate -ErrorAction SilentlyContinue).Data } -Descending | Select-Object -First 1; $c=$null; if ($w) { $c=$w.InstanceId; for ($i=0; $i -lt 8 -and $c -and $c -notmatch '^PCI'; $i++) { $c=(Get-PnpDeviceProperty -InstanceId $c -KeyName DEVPKEY_Device_Parent -ErrorAction SilentlyContinue).Data } }; $ctl = if ($c -match '^PCI') { @($c) } else { @(Get-PnpDevice -PresentOnly -Class USB -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^PCI' } | ForEach-Object { $_.InstanceId }) }; foreach ($x in $ctl) { pnputil /restart-device $x | Out-Null }; 'restarted ' + $ctl.Count + ' USB controller(s)'";
      const r = await run('powershell', ['-NoProfile', '-Command', ps], 90000);
      const n = parseInt((r.out.match(/restarted (\d+)/) || [])[1] || '0', 10);
      if (n > 0) await new Promise(res => setTimeout(res, 15000));   // controller, dongle, driver, association
      return { ok: r.ok && n > 0, out: r.out };
    }
    case 'enable-wifi-adapter':
      if (!dev) return { ok: false, out: 'no Wi-Fi adapter name' };
      return run('powershell', ['-NoProfile', '-Command', "Enable-NetAdapter -Name '" + String(dev).replace(/'/g, "''") + "' -Confirm:$false"]);
    case 'connect-known-wifi': {
      const tried = [];
      for (const ssid of reconnectCandidates(w)) {
        const r = await run('netsh', ['wlan', 'connect', 'name=' + ssid]);
        tried.push(ssid);
        if (!r.ok) continue;
        await new Promise(res => setTimeout(res, 6000));
        const now = await readWifiWin().catch(() => null);
        if (now && now.connected) return { ok: true, out: 'connected to ' + ssid };
      }
      return { ok: false, out: tried.length ? 'could not join ' + tried.join(', ') : 'no saved network in range' };
    }
    case 'nm-radio-on':
      return run('nmcli', ['radio', 'wifi', 'on']);
    case 'nm-connect': {
      if (dev) {
        const r = await run('nmcli', ['device', 'connect', dev], 30000);
        if (r.ok) return r;
      }
      for (const name2 of reconnectCandidates(w)) {
        const r = await run('nmcli', ['connection', 'up', 'id', name2], 30000);
        if (r.ok) return r;
      }
      return { ok: false, out: 'no saved network would connect' };
    }
    case 'mac-radio-on':
      if (!dev) return { ok: false, out: 'no Wi-Fi device' };
      return run('networksetup', ['-setairportpower', dev, 'on']);
  }
  return { ok: false, out: 'unknown action ' + name };
}

// One measurement of the path to `host`. Pure observation, no side effects.
export async function probe(host, platform = process.platform) {
  const addrs = addressSummary();
  const [hostOk, rawOk, dnsOk, captive, wifi] = await Promise.all([
    tcpReachable(host),
    Promise.all(RAW_TARGETS.map(ip => tcpReachable(ip))).then(r => r.some(Boolean)),
    resolves(host),
    captivePortal(),
    readWifiState(platform),
  ]);
  return { host, ...addrs, hostReachable: hostOk, rawReachable: rawOk, dnsResolves: dnsOk, captive, wifi };
}

// Which layer is broken, from one probe. Exported for selfcheck.
export function diagnose(p) {
  if (p.captive === true) return 'captive';
  if (p.hostReachable) return 'ok';
  const w = p.wifi;
  if (w && w.present && p.routable === 0) {
    if (w.missing) return 'wifi-missing';
    if (w.serviceStopped) return 'wifi-service';
    if (w.disabled) return 'wifi-disabled';
    if (w.radioOff) return 'wifi-radio-off';
    if (!w.connected && p.apipa === 0) return 'wifi-disconnected';
  }
  if (p.routable === 0 && p.apipa === 0) return 'adapter';
  if (p.routable === 0 && p.apipa > 0) return 'dhcp';
  if (p.rawReachable && !p.dnsResolves) return 'dns';
  if (p.rawReachable && p.dnsResolves) return 'provider';   // internet works; the API host itself is down or blocked
  return 'stack';
}

// Layers that mean "this machine has no working internet" -- as opposed to 'provider',
// where the internet is fine and only the AI service is down.
export const NETWORK_DOWN_LAYERS = new Set([
  'captive', 'wifi-missing', 'wifi-service', 'wifi-disabled', 'wifi-radio-off', 'wifi-disconnected',
  'adapter', 'dhcp', 'dns', 'stack',
]);

// The one fix triage never runs on its own; core.mjs offers it with an explicit yes/no.
export function stackResetFixId(platform = process.platform) {
  return platform === 'win32' ? 'winsock-reset' : null;
}

export const LAYER_TEXT = {
  captive:             'a sign-in page (hotel, airport, cafe Wi-Fi) is intercepting the connection',
  'wifi-missing':      'Windows cannot see the Wi-Fi adapter (unplugged, or its driver did not start)',
  'wifi-service':      'the Windows Wi-Fi service (WLAN AutoConfig) is stopped',
  'wifi-disabled':     'the Wi-Fi adapter is disabled',
  'wifi-radio-off':    'Wi-Fi is switched off (radio off or airplane mode)',
  'wifi-disconnected': 'Wi-Fi is on but not connected to any network',
  adapter:  'no network adapter has an address',
  dhcp:     'the adapter only has a self-assigned 169.254.x.x address (DHCP failed)',
  dns:      'the internet is reachable but the API hostname will not resolve (DNS)',
  provider: 'the internet works but the AI provider itself is not answering',
  stack:    'the adapter has an address but nothing on the internet is reachable',
};

// What the user has to do when automation could not finish the job.
function adviceFor(layer, platform, p) {
  const w = (p && p.wifi) || {};
  switch (layer) {
    case 'captive':
      return 'Open any website in the browser, complete the sign-in page, then send your message again.';
    case 'wifi-missing':
      return 'If it is a USB Wi-Fi adapter, unplug it and plug it back in (another port if possible). Otherwise restart the computer -- the driver did not start.';
    case 'wifi-service':
      return 'Starting it needs admin -- run Athena as administrator, or restart the computer.';
    case 'wifi-disabled':
      return platform === 'win32'
        ? 'Enabling the adapter needs admin -- run Athena as administrator, or enable it in Settings > Network & internet > Advanced network settings.'
        : 'Enable the Wi-Fi adapter in your network settings.';
    case 'wifi-radio-off':
      return 'Turn Wi-Fi on -- the Wi-Fi button or Fn key, or switch airplane mode off.';
    case 'wifi-disconnected': {
      const c = reconnectCandidates(w);
      if (!(w.known || []).length) return 'There are no saved Wi-Fi networks on this machine -- pick a network and enter its password.';
      if (!c.length) return 'None of the saved networks (' + w.known.slice(0, 3).join(', ') + ') is in range -- move closer, or pick a network and enter its password.';
      return 'Could not join ' + c.join(', ') + ' -- the password may have changed, or the signal is too weak.';
    }
    case 'provider':
      return 'Nothing to fix locally -- the provider is down or blocked on this network.';
    case 'stack':
      return 'Not fixed automatically. Next step: ' + (STACK_RECOMMENDATION[platform] || 'reboot') + '.';
  }
  return 'Automatic fixes did not restore it.';
}

async function settle(host, probeFn, settleMs) {
  const deadline = Date.now() + settleMs;
  let p = await probeFn(host);
  while (!p.hostReachable && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, SETTLE_STEP_MS));
    p = await probeFn(host);
  }
  return p;
}

function stepKey(step) {
  if (typeof step === 'string') return step;
  return step.learned ? 'learned:' + step.learned : 'action:' + step.action;
}
const stepLabel = key => key.replace(/^(action|learned):/, '');

const NETWORK_TAGS = /^(network|wifi|wi-fi|wireless|adapter|dhcp|dns|wlan|nic)$/i;
// This machine's own proven network fixes (never the generic library entries -- those
// are already in the ladder). Highest confidence first, at most two.
async function learnedNetworkFixes() {
  try {
    const { listFixes } = await import('./machine_fixes.mjs');
    return (listFixes() || [])
      .filter(f => f && f.source !== 'library' && f.status === 'proven' && (f.tags || []).some(t => NETWORK_TAGS.test(String(t))))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 2)
      .map(f => f.id);
  } catch { return []; }
}

// deps lets selfcheck drive the ladder with a scripted probe and a fake apply, so the
// decision logic is tested without touching a real network adapter.
async function runTriage(host, platform, deps = {}, { applyFixes = true } = {}) {
  const probeFn  = deps.probe || (h => probe(h, platform));
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const ladder = LADDER[platform] || {};
  const tried = new Set();
  const steps = [];
  let p = await probeFn(host);
  let layer = diagnose(p);
  if (layer === 'ok') return { restored: true, alreadyOk: true, layer, steps };

  report('Cloud AI unreachable -- network triage: ' + LAYER_TEXT[layer] + '.');
  if (!applyFixes) {
    report('Automatic network fixes are off (NET_TRIAGE=off) -- reporting only.');
    return { restored: false, layer, steps, advice: 'Automatic fixes are off. ' + adviceFor(layer, platform, p), networkDown: NETWORK_DOWN_LAYERS.has(layer), wifi: p.wifi || null };
  }

  const apply = deps.apply || (async (step, probeNow) => {
    if (step.learned) {
      const { applyFix } = await import('./machine_fixes.mjs');
      return applyFix(step.learned);   // no force: its own detect decides whether it applies
    }
    if (typeof step === 'string') {
      const { applyFix } = await import('./machine_fixes.mjs');
      // force: the probe already established the symptom, more precisely than the
      // library's generic detect command can.
      return applyFix(step, { force: true });
    }
    return wifiAction(step.action, probeNow.wifi);
  });

  let learnedQueue = null;
  for (let round = 0; round < MAX_ROUNDS + 2; round++) {
    let step = (ladder[layer] || []).find(st => !tried.has(stepKey(st)));
    if (!step && NETWORK_DOWN_LAYERS.has(layer) && layer !== 'captive') {
      if (learnedQueue === null) learnedQueue = await (deps.learnedFixes || learnedNetworkFixes)();
      const id = learnedQueue.find(x => !tried.has('learned:' + x));
      if (id) step = { learned: id };
    }
    if (!step) break;
    const key = stepKey(step);
    tried.add(key);
    report('Applying ' + stepLabel(key) + (step.learned ? ' (learned on this machine)' : '') + ' ...');
    let res;
    try { res = await apply(step, p); }
    catch (e) { res = { ok: false, message: e.message }; }
    steps.push({ layer, fixId: stepLabel(key), learned: !!step.learned, ok: !!(res && res.ok) });
    p = await settle(host, probeFn, settleMs);
    const next = diagnose(p);
    if (next === 'ok') {
      report('Connection restored by ' + stepLabel(key) + '.');
      return { restored: true, layer, steps, networkDown: false };
    }
    if (next !== layer) report('Now: ' + LAYER_TEXT[next] + '.');
    layer = next;
  }

  const advice = adviceFor(layer, platform, p);
  const w = p.wifi;
  const weak = w && w.connected && w.signal != null && w.signal < 30 ? ' Wi-Fi signal is weak (' + w.signal + '%).' : '';
  report('Network triage finished: ' + LAYER_TEXT[layer] + '. ' + advice + weak);
  return { restored: false, layer, steps, advice: advice + weak, networkDown: NETWORK_DOWN_LAYERS.has(layer), wifi: w || null };
}

// Entry point. Concurrent callers share one run; a finished run is cached for COOLDOWN_MS
// so a burst of failing requests (agents, retries) triggers one triage, not ten.
// With NET_TRIAGE=off it still measures and diagnoses -- offline mode needs to know whether
// the network is down -- it just applies no fixes.
export async function triageNetwork({ host, platform = process.platform, deps, applyFixes } = {}) {
  if (!host) return { restored: false, skipped: 'no host' };
  if (_inFlight) return _inFlight;
  if (_lastResult && Date.now() - _lastRun < COOLDOWN_MS) return { ..._lastResult, cached: true };
  _inFlight = runTriage(host, platform, deps, { applyFixes: applyFixes ?? (NET_TRIAGE || !!deps) })
    .catch(e => ({ restored: false, error: e.message }))
    .then(r => { _lastRun = Date.now(); _lastResult = r; _inFlight = null; return r; });
  return _inFlight;
}

// The most recent finished run (or null), for core.mjs's offline reply.
export function lastTriage() {
  return _lastResult ? { ..._lastResult, at: _lastRun } : null;
}

export function _resetTriageForTests() { _inFlight = null; _lastRun = 0; _lastResult = null; }
