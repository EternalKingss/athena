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
// Layers, cheapest first:
//   adapter -- no non-loopback IPv4 address at all        -> bring the adapter back up
//   dhcp    -- only 169.254.x.x (APIPA) addresses         -> release/renew the lease
//   dns     -- raw IPs reachable, API hostname won't resolve -> flush the DNS cache
//   stack   -- valid IP, nothing reachable                 -> NOT automatic, see below
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
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { NET_TRIAGE } from './config.mjs';

const PROBE_TIMEOUT_MS = 4000;
const SETTLE_MS        = 15000;   // how long to keep re-probing after a fix before giving up on it
const SETTLE_STEP_MS   = 3000;
const COOLDOWN_MS      = 3 * 60 * 1000;
// Well-known anycast resolvers, used only as "is there any route to the internet at all".
const RAW_TARGETS = ['1.1.1.1', '8.8.8.8'];

// Which library fix handles which layer, per platform. Missing = nothing safe to automate.
const LADDER = {
  win32:  { adapter: ['adapter-bounce'], dhcp: ['dhcp-renew'], dns: ['dns-cache-flush'] },
  linux:  { adapter: ['network-restart-linux'], dhcp: ['network-restart-linux'], dns: ['dns-cache-flush-linux'] },
  darwin: { dns: ['dns-cache-flush-mac'] },
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

// One measurement of the path to `host`. Pure observation, no side effects.
export async function probe(host) {
  const addrs = addressSummary();
  const [hostOk, rawOk, dnsOk] = await Promise.all([
    tcpReachable(host),
    Promise.all(RAW_TARGETS.map(ip => tcpReachable(ip))).then(r => r.some(Boolean)),
    resolves(host),
  ]);
  return { host, ...addrs, hostReachable: hostOk, rawReachable: rawOk, dnsResolves: dnsOk };
}

// Which layer is broken, from one probe. Exported for selfcheck.
export function diagnose(p) {
  if (p.hostReachable) return 'ok';
  if (p.routable === 0 && p.apipa === 0) return 'adapter';
  if (p.routable === 0 && p.apipa > 0) return 'dhcp';
  if (p.rawReachable && !p.dnsResolves) return 'dns';
  if (p.rawReachable && p.dnsResolves) return 'provider';   // internet works; the API host itself is down or blocked
  return 'stack';
}

// Layers that mean "this machine has no working internet" -- as opposed to 'provider',
// where the internet is fine and only the AI service is down.
export const NETWORK_DOWN_LAYERS = new Set(['adapter', 'dhcp', 'dns', 'stack']);

// The one fix triage never runs on its own; core.mjs offers it with an explicit yes/no.
export function stackResetFixId(platform = process.platform) {
  return platform === 'win32' ? 'winsock-reset' : null;
}

export const LAYER_TEXT = {
  adapter:  'no network adapter has an address',
  dhcp:     'the adapter only has a self-assigned 169.254.x.x address (DHCP failed)',
  dns:      'the internet is reachable but the API hostname will not resolve (DNS)',
  provider: 'the internet works but the AI provider itself is not answering',
  stack:    'the adapter has an address but nothing on the internet is reachable',
};

async function settle(host, probeFn, settleMs) {
  const deadline = Date.now() + settleMs;
  let p = await probeFn(host);
  while (!p.hostReachable && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, SETTLE_STEP_MS));
    p = await probeFn(host);
  }
  return p;
}

// deps lets selfcheck drive the ladder with a scripted probe and a fake applyFix, so the
// decision logic is tested without touching a real network adapter.
async function runTriage(host, platform, deps = {}, { applyFixes = true } = {}) {
  const probeFn  = deps.probe || probe;
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
    return { restored: false, layer, steps, advice: 'Automatic fixes are off.', networkDown: NETWORK_DOWN_LAYERS.has(layer) };
  }
  const applyFix = deps.applyFix || (await import('./machine_fixes.mjs')).applyFix;

  for (let round = 0; round < 3; round++) {
    const fixId = (ladder[layer] || []).find(id => !tried.has(id));
    if (!fixId) break;
    tried.add(fixId);
    report('Applying ' + fixId + ' ...');
    let res;
    // force: the probe above already established the symptom, more precisely than the
    // library's generic detect command can.
    try { res = await applyFix(fixId, { force: true }); }
    catch (e) { res = { ok: false, message: e.message }; }
    steps.push({ layer, fixId, ok: !!res.ok });
    p = await settle(host, probeFn, settleMs);
    const next = diagnose(p);
    if (next === 'ok') {
      report('Connection restored by ' + fixId + '.');
      return { restored: true, layer, steps, networkDown: false };
    }
    if (next !== layer) report('Now: ' + LAYER_TEXT[next] + '.');
    layer = next;
  }

  let advice;
  if (layer === 'provider') advice = 'Nothing to fix locally -- the provider is down or blocked on this network.';
  else if (layer === 'stack') advice = 'Not fixed automatically. Next step: ' + (STACK_RECOMMENDATION[platform] || 'reboot') + '.';
  else advice = 'Automatic fixes did not restore it.';
  report('Network triage finished: ' + LAYER_TEXT[layer] + '. ' + advice);
  return { restored: false, layer, steps, advice, networkDown: NETWORK_DOWN_LAYERS.has(layer) };
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
