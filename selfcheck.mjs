import { readdirSync, existsSync, readFileSync as rfs, writeFileSync as wfs, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Athena lives on a removable drive, so the drive letter (and the OS) varies -- resolve
// everything from this file's own location, never a hardcoded D:\ATHENA.
const ROOT = dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);

let p = 0, f = 0;
const t = (n, c, e) => c ? (p++, console.log('PASS  ' + n)) : (f++, console.log('FAIL  ' + n + '  ' + (e || '')));
// For checks that need this user's data or credentials: skipped (not failed) when absent.
let sk = 0;
const skip = (n, why) => { sk++; console.log('SKIP  ' + n + '  (' + why + ')'); };

function listMjs(dir) {
  try { return readdirSync(dir).filter(x => x.endsWith('.mjs') && !x.startsWith('_')).map(x => join(dir, x)); }
  catch { return []; }
}
const modFiles = [
  ...listMjs(join(ROOT, 'athena')),
  ...listMjs(join(ROOT, 'athena', 'kernel')),
  ...listMjs(join(ROOT, 'athena', 'modules')),
  ...listMjs(join(ROOT, 'athena', 'modules', 'browser')),
];
const bad = [];
for (const full of modFiles) {
  try { execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' }); }
  catch { bad.push(full); }
}
t(modFiles.length + ' modules parse', bad.length === 0, bad.join(', '));

const { detectIntents } = await import('./athena/control_engine.mjs');
const SHOULD = [['i cant see my wifi','network_check'],['disk is full','disk_check'],
  ['running out of space','disk_check'],['pc is slow','process_check'],
  ['the adapter didnt load again','device_check'],['it does this every cold boot','boot_check'],
  ['whats wrong','system_health'],['explain why my wifi keeps dropping','network_check']];
t(SHOULD.length + ' complaints route', SHOULD.every(([s,w]) => (detectIntents(s)||[]).includes(w)));
const QUIET = ['hey','write me a poem about the sea','explain how wifi actually works',
  'what does it mean when a driver is unsigned','my friend says his network is broken',
  'please invoke browser_status and paste its output here'];
t(QUIET.length + ' questions stay out', QUIET.every(s => !(detectIntents(s)||[]).length));

// ---- Pre-Claude cost-gate heuristic (task_router.mjs) ----
// Pure-function unit tests, no live model needed -- same spirit as the
// detectIntents SHOULD/QUIET pairs just above.
const { looksBasic } = await import('./athena/task_router.mjs');
const ROUTER_BASIC = [
  'can you press play on the youtube video i have running',
  'click the play button',
  'open a new tab to wikipedia.org',
  'list the open tabs',
  'navigate to gmail.com',
  'type my email into the search bar',
  'turn the volume up',
  'mute',
  'pause the music',
];
t(ROUTER_BASIC.length + ' router candidates look basic (would try local first)',
  ROUTER_BASIC.every(s => looksBasic(s)), ROUTER_BASIC.filter(s => !looksBasic(s)).join(' | '));
const ROUTER_NOT_BASIC = [
  'why does my wifi keep dropping',
  'write me a business plan for my ev charging startup',
  'should i use react or vue for this project, weighing the tradeoffs',
  'can you analyze this contract and tell me if the arbitration clause is normal',
  'hey',
  // v3.4: diagnosing and fixing never go to the local model, however short
  'run a disk scan',
  'fix my wifi',
  'click repair on the error dialog',
];
t(ROUTER_NOT_BASIC.length + ' router non-candidates stay with Claude',
  ROUTER_NOT_BASIC.every(s => !looksBasic(s)), ROUTER_NOT_BASIC.filter(s => looksBasic(s)).join(' | '));

const { irreversibleReason, classifyRisk, TOOLS, runTool } = await import('./athena/tools.mjs');
const R = c => irreversibleReason('run_shell', { command: c });
t('irreversible intact', ['rm -rf /','format C:','shutdown /r /t 0','Remove-Item C:\\ -Recurse -Force'].every(R));
t('safe not flagged', ['ls','ipconfig /flushdns','Remove-Item .\\\\tmp.txt'].every(c => !R(c)));
t('chained destructive tier 2', classifyRisk('run_shell',{command:'ls && Remove-Item D:\\\\x -Recurse -Force'}).tier === 2);
t('chained read-only tier 1', classifyRisk('run_shell',{command:'ls && pwd'}).tier === 1);
t('apply_fix gate sees stored steps', irreversibleReason('apply_fix',{id:'clear-windows-update-cache'}) !== null);

// Only purchase/checkout clicks are gated. See tools.mjs's PURCHASE_LIKE comment.
t('browser_click purchase-like tier 2',
  classifyRisk('browser_click', {text:'Place Order'}).tier === 2 && classifyRisk('browser_click', {text:'Buy Now'}).tier === 2);
t('browser_click purchase-like irreversible', irreversibleReason('browser_click', {text:'Complete Purchase'}) !== null);
t('browser_click ordinary tier 1', classifyRisk('browser_click', {text:'Next page'}).tier === 1);
t('browser_click ordinary not irreversible', irreversibleReason('browser_click', {text:'Next page'}) === null);
const names = TOOLS.map(x => x.function?.name);
t('37 tools, no dupes', names.length === 37 && new Set(names).size === 37, names.length);

const { publishMachineId } = await import('./athena/machines.mjs');
const { loadInstincts } = await import('./athena/memory.mjs');
const here = publishMachineId();
t('machine id resolves', Boolean(here) && here.length > 8, here);
const block = loadInstincts();
if (existsSync(join(ROOT, 'data', 'memory', 'instincts.md')))
  t('instincts still load', block.includes('INSTINCTS') && block.length > 200, block.length + ' chars');
else skip('instincts still load', 'no data/memory/instincts.md on this drive');
t('no other-machine facts leaked', !block.includes('Athlon Silver') || block.includes('[conflict]'));

const { allFixes } = await import('./athena/machine_fixes.mjs');
const fixes = await allFixes();
t(fixes.length + ' fixes have verify + detect', fixes.every(x => x.verify && x.detect));

// ---- Athena OS kernel -- registry, router, daemon, module 1 ----
const { PATHS } = await import('./athena/paths.mjs');
const { registerModule, isHealthy, _resetRegistryForTests } = await import('./athena/kernel/registry.mjs');
const { dispatch } = await import('./athena/kernel/router.mjs');
const { scheduleTask, listScheduled, tick } = await import('./athena/kernel/daemon.mjs');
const { bootKernel, _resetKernelForTests } = await import('./athena/kernel/index.mjs');
const { makeCapability, ContractViolation } = await import('./athena/kernel/contract.mjs');

_resetKernelForTests();
const kernel = bootKernel({ startHeartbeat: false }); // no live interval in a one-shot test process

const sysMod = kernel.listModules().find(m => m.name === 'system');
t('module 1 (system) registers all 37 tools as capabilities', sysMod?.capabilities.length === 37, sysMod?.capabilities.length);
t('module 1 healthy after boot', kernel.isHealthy('system') === true);

// ---- Module 2 (browser) -- isolation, tool-surface merge, relay round-trip ----
// Static import-graph check: module 1 and module 2 must never import each
// other's files, whatever their comments say -- only actual import
// specifiers count, so a header comment that merely *mentions* "browser"
// (kernel/index.mjs's does, describing future registrations) can't cause a
// false failure here.
function importSpecifiers(src) {
  return [...src.matchAll(/^s*imports+[^'"]*froms+['"]([^'"]+)['"]/gm)].map(m => m[1]);
}
const systemSrc  = rfs('./athena/modules/system.mjs', 'utf8');
const browserSrc = rfs('./athena/modules/browser.mjs', 'utf8');
const relaySrc   = rfs('./athena/modules/browser/relay.mjs', 'utf8');
const systemImports  = importSpecifiers(systemSrc);
const browserImports = importSpecifiers(browserSrc);
const relayImports   = importSpecifiers(relaySrc);
const noCrossImports =
  !systemImports.some(s => s.includes('browser')) &&
  !browserImports.some(s => s.includes('system') || s.includes('../tools.mjs')) &&
  !relayImports.some(s => s.includes('system') || s.includes('tools.mjs'));
t('module 1 and module 2 never import each other (static import-graph check)',
  noCrossImports, JSON.stringify({ systemImports, browserImports, relayImports }));

const browserMod = kernel.listModules().find(m => m.name === 'browser');
t('module 2 (browser) registers all 12 capabilities', browserMod?.capabilities.length === 12, browserMod?.capabilities.length);
t('module 2 healthy after boot (relay listening)', kernel.isHealthy('browser') === true);

const { toolsForModel } = await import('./athena/kernel/toolSurface.mjs');
const cloudNames = toolsForModel('claude-opus-5').map(x => x.function.name);
// Module 3 only joins the tool surface when Google credentials are configured.
const googleUp = kernel.isHealthy('google') === true;
const G = googleUp ? 6 : 0, GL = googleUp ? 3 : 0;
if (!googleUp) skip('Google capabilities in the tool surface', 'Google OAuth not configured in config/.env');
t('kernel tool surface merges module 2 capabilities for cloud models',
  cloudNames.length === 49 + G && cloudNames.includes('browser_navigate') && cloudNames.includes('browser_snapshot') && cloudNames.includes('browser_click_at') && cloudNames.includes('browser_screenshot') && cloudNames.includes('delegate_to_local') && !cloudNames.includes('read_applicant_profile'),
  cloudNames.length);
if (googleUp) t('kernel tool surface merges module 3 (google) capabilities for cloud models',
  cloudNames.includes('email_list') && cloudNames.includes('email_draft') && cloudNames.includes('calendar_create_event'),
  cloudNames.length);
const localToolNames = toolsForModel('local-qwen2-5-3b-instruct-q4-k-m').map(x => x.function.name);
t('kernel tool surface respects localOk:false for local models',
  localToolNames.length === 11 + GL && localToolNames.includes('browser_navigate') && !localToolNames.includes('browser_screenshot') && !localToolNames.includes('browser_snapshot') && !localToolNames.includes('browser_click_at') && !localToolNames.includes('delegate_to_local') && !localToolNames.includes('read_applicant_profile'),
  localToolNames.length);
if (googleUp) t('kernel tool surface keeps google writes cloud-only for local models',
  localToolNames.includes('email_list') && localToolNames.includes('calendar_list') && !localToolNames.includes('email_draft') && !localToolNames.includes('calendar_create_event') && !localToolNames.includes('calendar_update_event'),
  localToolNames.length);

// Simulated-extension round trip through the REAL relay HTTP server bootKernel()
// started -- proves the poll / execute / report loop works end to end with
// plain HTTP calls standing in for the extension, no live Chrome required.
const { BROWSER_RELAY_PORT } = await import('./athena/config.mjs');
const relayBase = 'http://127.0.0.1:' + BROWSER_RELAY_PORT;
const navPromise = kernel.dispatch('browser_navigate', { url: 'https://example.com' }, {});
await new Promise(r => setTimeout(r, 50)); // let the command land in the relay's queue
const polled = await fetch(relayBase + '/poll').then(r => r.json());
t('simulated extension polls and receives the queued command',
  polled.command?.action === 'browser_navigate' && polled.command?.args?.url === 'https://example.com');
await fetch(relayBase + '/result', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: polled.command.id, ok: true, data: { navigated: 'https://example.com', tabId: 1 } }),
});
const navResult = await navPromise;
let navParsed = null;
try { navParsed = JSON.parse(navResult); } catch {}
t("dispatch resolves with the simulated extension's reported result",
  navParsed?.navigated === 'https://example.com', navResult);

// ---- v3.5: trusted input, snapshot refs, purchase guard, screenshots as images ----
// A click by ref, coordinates or an opaque selector carries no text for classifyRisk to
// read, so the module hands the extension the purchase pattern to check against the real
// element. It must not be sent when the gate already saw purchase-like text (the user was
// asked), and the model must never be able to set or clear it itself.
const { PURCHASE_LIKE } = await import('./athena/kernel/risk_patterns.mjs');
const { withPurchaseGuard } = await import('./athena/modules/browser.mjs');
t('purchase guard rides on ref / coordinate / opaque-selector clicks and on Enter',
  withPurchaseGuard('browser_click', { ref: 7 }).guard === PURCHASE_LIKE.source &&
  withPurchaseGuard('browser_click_at', { x: 10, y: 20 }).guard === PURCHASE_LIKE.source &&
  withPurchaseGuard('browser_click', { selector: '#btn-7' }).guard === PURCHASE_LIKE.source &&
  withPurchaseGuard('browser_key', { key: 'Enter' }).guard === PURCHASE_LIKE.source);
t('purchase guard is skipped once the approval gate saw the purchase text, and never on non-clicks',
  withPurchaseGuard('browser_click', { ref: 7, text: 'Place order' }).guard === undefined &&
  withPurchaseGuard('browser_navigate', { url: 'https://example.com' }).guard === undefined &&
  withPurchaseGuard('browser_type', { ref: 3, text: 'hello' }).guard === undefined);
t('browser_click_at with purchase-like text is tier 2 and irreversible; ordinary is tier 1',
  classifyRisk('browser_click_at', { x: 1, y: 2, text: 'Buy Now' }).tier === 2 &&
  irreversibleReason('browser_click_at', { x: 1, y: 2, text: 'Complete Purchase' }) !== null &&
  classifyRisk('browser_click_at', { x: 1, y: 2 }).tier === 1);
const refClick = kernel.dispatch('browser_click', { ref: 4, guard: '' }, { preApproved: true });
await new Promise(r => setTimeout(r, 50));
const refPolled = await fetch(relayBase + '/poll').then(r => r.json());
t('a model-supplied guard is replaced: the extension always gets the real pattern',
  refPolled.command?.action === 'browser_click' && refPolled.command?.args?.ref === 4 &&
  refPolled.command?.args?.guard === PURCHASE_LIKE.source, JSON.stringify(refPolled.command?.args));
await fetch(relayBase + '/result', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: refPolled.command.id, ok: false, error: 'refused: "Place order" looks like a purchase/checkout control.' }),
});
const refResult = await refClick;
t('an extension refusal reaches the model as an error', /^Error: .*refused: "Place order"/.test(refResult), refResult);

// Screenshots used to reach the model as text, cut at compressOutput's 8000-char cap --
// a broken base64 stub. They now travel as an image block next to the metadata.
const { splitScreenshot, pruneOldImages } = await import('./athena/core.mjs');
const fakePng = 'iVBORw0KGgo' + 'A'.repeat(20000);
const shot = splitScreenshot('browser_screenshot', JSON.stringify({ dataUrl: 'data:image/png;base64,' + fakePng, width: 1280, height: 720, url: 'https://example.com' }));
t('a screenshot result is split into metadata text and an intact image',
  shot && shot.image.data === fakePng && shot.image.media_type === 'image/png' &&
  !shot.text.includes('base64') && JSON.parse(shot.text).width === 1280 &&
  splitScreenshot('browser_read_text', '{"text":"x"}') === null && splitScreenshot('browser_screenshot', 'Error: no tab') === null);
const hist = [1, 2, 3, 4].map(i => ({ role: 'tool', content: 'shot ' + i, images: [{ media_type: 'image/png', data: 'x' }] }));
pruneOldImages(hist);
t('only the newest screenshots stay in context (room left for the one being added)',
  hist.filter(m => m.images).length === 2 && !hist[0].images && /older screenshot removed/.test(hist[0].content) && hist[3].images);

// ---- Module 2 (browser) extension: syntax check ----
// Native messaging was tried and reverted -- it needs a per-machine
// registry entry pointing Chrome at a host executable, which fights the
// "plug into any machine, zero setup" goal this whole project runs on.
// background.js now talks to the relay directly over HTTP long-poll (see
// relay.mjs's ?wait=1 handling above, already covered by the simulated
// round-trip check below), so there's no pinned extension ID and no
// separate host process to verify -- just that the script parses.
const extBad = [];
for (const f of ['./extension/background.js']) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch { extBad.push(f); }
}
t('extension script parses (background.js)', extBad.length === 0, extBad.join(', '));

const directResult = await runTool('machine_fixes', {}, true, [], () => {}, async () => '');
const viaKernel = await kernel.dispatch('machine_fixes', {}, { preApproved: true });
t('dispatch reaches the real tool (non-error, non-empty)',
  typeof viaKernel === 'string' && viaKernel.length > 0 && !viaKernel.startsWith('Error: ') &&
  typeof directResult === 'string' && !directResult.startsWith('Error: '));

const unknownResult = await kernel.dispatch('does_not_exist_capability', {});
t('unknown capability returns a clean error string, not a throw',
  unknownResult === 'Error: no module registered for capability "does_not_exist_capability"');

// ---- v3.3: network triage (net_triage.mjs) -- decision logic, no real adapters touched ----
const { diagnose, triageNetwork, _resetTriageForTests } = await import('./athena/net_triage.mjs');
const P = (o) => ({ host: 'api.example', routable: 1, apipa: 0, hostReachable: false, rawReachable: false, dnsResolves: false, ...o });
t('triage diagnoses each layer',
  diagnose(P({ hostReachable: true })) === 'ok' &&
  diagnose(P({ routable: 0 })) === 'adapter' &&
  diagnose(P({ routable: 0, apipa: 1 })) === 'dhcp' &&
  diagnose(P({ rawReachable: true })) === 'dns' &&
  diagnose(P({ rawReachable: true, dnsResolves: true })) === 'provider' &&
  diagnose(P({})) === 'stack');

// Scripted probe: returns `before` until a fix has been applied, then `after`.
function scripted(before, after) {
  const st = { applied: [] };
  st.deps = {
    settleMs: 0,
    probe: async () => (st.applied.length ? after : before),
    learnedFixes: async () => st.learned || [],
    apply: async (step) => { st.applied.push(typeof step === 'string' ? step : step.learned ? 'learned:' + step.learned : 'action:' + step.action); return { ok: true }; },
  };
  return st;
}
let tri = scripted(P({ routable: 0 }), P({ hostReachable: true }));
_resetTriageForTests();
let triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: adapter down on Windows -> adapter-bounce, restored',
  triRes.restored === true && tri.applied.join() === 'adapter-bounce', JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ rawReachable: true }), P({ hostReachable: true }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'linux', deps: tri.deps });
t('triage: DNS failure on Linux -> dns-cache-flush-linux, restored',
  triRes.restored === true && tri.applied.join() === 'dns-cache-flush-linux', JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ routable: 0, apipa: 1 }), P({ routable: 0, apipa: 1 }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: DHCP renew that does not help is tried once, then stops',
  triRes.restored === false && tri.applied.join() === 'dhcp-renew', JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({}), P({}));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: broken stack is never auto-reset -- recommends winsock-reset instead',
  triRes.restored === false && tri.applied.length === 0 && /winsock-reset/.test(triRes.advice || ''), JSON.stringify({ triRes, applied: tri.applied }));
t('triage: broken stack counts as network down (offline mode, no local fallback)', triRes.networkDown === true);

tri = scripted(P({ rawReachable: true, dnsResolves: true }), P({}));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: provider outage applies no local fix', triRes.restored === false && tri.applied.length === 0 && triRes.layer === 'provider');
t('triage: provider outage is not "offline" (local fallback still allowed)', triRes.networkDown === false);

tri = scripted(P({ rawReachable: true }), P({ hostReachable: true }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps, applyFixes: false });
t('triage: NET_TRIAGE=off still diagnoses, applies nothing',
  triRes.restored === false && tri.applied.length === 0 && triRes.layer === 'dns' && triRes.networkDown === true, JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ routable: 0 }), P({ hostReachable: true }));
_resetTriageForTests();
const [triA, triB] = await Promise.all([
  triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps }),
  triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps }),
]);
t('triage: concurrent failures share one run (one fix applied, not two)',
  triA.restored && triB.restored && tri.applied.length === 1, tri.applied.join());
_resetTriageForTests();

// ---- v3.4: Wi-Fi layers -- parsers on real-format output, then the ladder ----
const NT = await import('./athena/net_triage.mjs');
const NETSH_CONNECTED = [
  'There is 1 interface on the system:', '',
  '    Name                   : Wi-Fi',
  '    Description            : Intel(R) Wi-Fi 6 AX201 160MHz',
  '    State                  : connected',
  '    SSID                   : HomeNet',
  '    Signal                 : 24%',
  '    Radio status           : Hardware On',
  '                             Software On', ''].join('\r\n');
const NETSH_RADIO_OFF = NETSH_CONNECTED.replace('State                  : connected', 'State                  : disconnected').replace('Software On', 'Software Off');
const ifc = NT.parseNetshInterfaces(NETSH_CONNECTED);
const ifcOff = NT.parseNetshInterfaces(NETSH_RADIO_OFF);
t('netsh interfaces parse (state, SSID, signal, radio)',
  ifc.connected === true && ifc.ssid === 'HomeNet' && ifc.signal === 24 && ifc.radioOff === false &&
  ifcOff.connected === false && ifcOff.radioOff === true, JSON.stringify({ ifc, ifcOff }));
t('netsh reports a stopped WLAN service',
  NT.parseNetshInterfaces('The Wireless AutoConfig Service (wlansvc) is not running.').serviceStopped === true);
t('netsh profiles and networks parse',
  NT.parseNetshProfiles('User profiles\r\n-------------\r\n    All User Profile     : HomeNet\r\n    All User Profile     : Cafe & Co\r\n').join('|') === 'HomeNet|Cafe & Co' &&
  NT.parseNetshNetworks('SSID 1 : Neighbour\r\n    Network type : Infrastructure\r\nSSID 2 : HomeNet\r\n').join('|') === 'Neighbour|HomeNet');
t('Get-NetAdapter JSON parse (single object and array)',
  NT.parseWinAdapters('{"Name":"Wi-Fi","Status":"Disabled"}').status === 'Disabled' &&
  NT.parseWinAdapters('[{"Name":"Wi-Fi 2","Status":"Up"}]').device === 'Wi-Fi 2' && NT.parseWinAdapters('') === null);
t('nmcli device/connection parse (escaped colons)',
  NT.parseNmDevices('ethernet:unavailable:eth0:\nwifi:disconnected:wlp2s0:\n').device === 'wlp2s0' &&
  NT.parseNmConnections('Wired:802-3-ethernet\nCafe\\: Guest:802-11-wireless\n').join() === 'Cafe: Guest');
t('reconnect candidates = saved networks in range, saved order',
  NT.reconnectCandidates({ known: ['A', 'B', 'C'], inRange: ['C', 'X', 'A'] }).join() === 'A,C' &&
  NT.reconnectCandidates({ known: ['A'], inRange: ['X'] }).length === 0 &&
  NT.reconnectCandidates({ known: ['A', 'B'], inRange: [] }).join() === 'A,B');

t('portal check: only redirect / 200 / 511 count as a sign-in page, not proxy errors',
  NT.classifyPortalStatus(204) === false && NT.classifyPortalStatus(302) === true && NT.classifyPortalStatus(200) === true &&
  NT.classifyPortalStatus(511) === true && NT.classifyPortalStatus(403) === null && NT.classifyPortalStatus(407) === null && NT.classifyPortalStatus(502) === null);
const W = (o) => ({ present: true, device: 'Wi-Fi', connected: false, radioOff: false, disabled: false, known: ['HomeNet'], inRange: ['HomeNet'], ...o });
t('triage diagnoses the Wi-Fi layers',
  NT.diagnose(P({ routable: 0, wifi: W({ serviceStopped: true }) })) === 'wifi-service' &&
  NT.diagnose(P({ routable: 0, wifi: W({ disabled: true }) })) === 'wifi-disabled' &&
  NT.diagnose(P({ routable: 0, wifi: W({ radioOff: true }) })) === 'wifi-radio-off' &&
  NT.diagnose(P({ routable: 0, wifi: W({}) })) === 'wifi-disconnected' &&
  NT.diagnose(P({ routable: 0, apipa: 1, wifi: W({ connected: true }) })) === 'dhcp' &&
  NT.diagnose(P({ captive: true, hostReachable: true })) === 'captive');
t('Wi-Fi off on a machine with working Ethernet is not a Wi-Fi problem',
  NT.diagnose(P({ routable: 1, wifi: W({ radioOff: true }) })) === 'stack' &&
  NT.diagnose(P({ routable: 1, hostReachable: true, wifi: W({ radioOff: true }) })) === 'ok');

tri = scripted(P({ routable: 0, wifi: W({}) }), P({ hostReachable: true }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: Wi-Fi disconnected on Windows -> rejoin saved network, restored',
  triRes.restored === true && tri.applied.join() === 'action:connect-known-wifi', JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ routable: 0, wifi: W({ radioOff: true }) }), P({}));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: Wi-Fi radio off on Windows -> no command exists, tells the user how',
  triRes.restored === false && tri.applied.length === 0 && /airplane mode/.test(triRes.advice || '') && triRes.networkDown === true, JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ routable: 0, wifi: W({ radioOff: true }) }), P({ hostReachable: true }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'linux', deps: tri.deps });
t('triage: Wi-Fi radio off on Linux -> nmcli radio on, restored',
  triRes.restored === true && tri.applied.join() === 'action:nm-radio-on', JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ captive: true, rawReachable: true, dnsResolves: true }), P({ hostReachable: true }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: captive portal -> no fix, tells the user to sign in',
  triRes.restored === false && tri.applied.length === 0 && triRes.layer === 'captive' && /sign-in/.test(triRes.advice || ''), JSON.stringify({ triRes, applied: tri.applied }));

tri = scripted(P({ routable: 0, wifi: W({ known: ['HomeNet'], inRange: ['Neighbour'] }) }), P({ routable: 0, wifi: W({ known: ['HomeNet'], inRange: ['Neighbour'] }) }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: no saved network in range -> says so by name',
  triRes.restored === false && /HomeNet/.test(triRes.advice || '') && /in range/.test(triRes.advice || ''), JSON.stringify(triRes));
_resetTriageForTests();

// ---- Review fixes (v3.4.1) ----
tri = scripted(P({ routable: 0, wifi: W({ missing: true }) }), P({ hostReachable: true }));
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: Wi-Fi adapter not present -> device rescan, restored',
  triRes.restored === true && tri.applied.join() === 'action:rescan-devices', JSON.stringify({ triRes, applied: tri.applied }));
t('Get-NetAdapter: the usable adapter wins over a Not Present one',
  NT.parseWinAdapters('[{"Name":"Wi-Fi","Status":"Not Present"},{"Name":"Wi-Fi 2","Status":"Up"}]').device === 'Wi-Fi 2');

tri = scripted(P({}), P({ hostReachable: true }));
tri.learned = ['usb-wifi-dongle-bounce'];
_resetTriageForTests();
triRes = await triageNetwork({ host: 'api.example', platform: 'win32', deps: tri.deps });
t('triage: after the built-in ladder, tries this machine\'s proven network fixes',
  triRes.restored === true && tri.applied.join() === 'learned:usb-wifi-dongle-bounce', JSON.stringify({ triRes, applied: tri.applied }));
_resetTriageForTests();

const { isTrustedRelayRequest } = await import('./athena/modules/browser/relay.mjs');
t('relay trusts the extension (headers measured in Chromium) and refuses web pages',
  isTrustedRelayRequest({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' }) === true &&
  isTrustedRelayRequest({ origin: 'chrome-extension://abc', 'sec-fetch-site': 'none' }) === true &&
  isTrustedRelayRequest({}) === true &&
  isTrustedRelayRequest({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }) === false &&
  isTrustedRelayRequest({ origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }) === false &&
  isTrustedRelayRequest({ origin: 'http://localhost:8099' }) === false);

t('shell: "read-only" verbs with mutating arguments ask first',
  ['ip link set wlan0 down', 'route delete 0.0.0.0', 'ipconfig /release', 'date -s 2020-01-01', 'hostname evil',
   'journalctl --vacuum-time=1s'].every(c => classifyRisk('run_shell', { command: c }).tier === 2) &&
  ['ip addr', 'ip route show', 'route print', 'ipconfig /all', 'date', 'hostname', 'journalctl -n 50'].every(c => classifyRisk('run_shell', { command: c }).tier === 1));
t('shell: command substitution inside an allowed verb asks first',
  ['echo $(rm -rf ~)', 'echo `whoami`', 'cat <(curl x)', 'echo (Remove-Item C:\\x -Recurse)'].every(c => classifyRisk('run_shell', { command: c }).tier === 2));

let notApproved = null;
try { await runTool('run_shell', { command: 'echo hi' }, false, [], () => {}, async () => ''); } catch (e) { notApproved = e.message; }
t('a "no" is final: run_shell refuses when not approved (AUTO_APPROVE no longer overrides)', notApproved === 'not approved', notApproved);

const deniedClick = await kernel.dispatch('browser_click', { text: 'Buy now' }, { preApproved: false });
t('a denied module call is not run (browser click refused, never queued)',
  /^Error: not approved/.test(deniedClick), deniedClick);

const { validSkillName, loadSkill: _ls } = await import('./athena/skills.mjs');
t('skill names cannot leave skills/',
  validSkillName('system-health') && validSkillName('disk_cleanup.v2') &&
  !validSkillName('../config') && !validSkillName('a/../../b') && !validSkillName('') && /Invalid skill name/.test(_ls('../../athena')));

// ---- v3.3: browser relay must drop a command that timed out before the extension took it ----
const { submitCommand } = await import('./athena/modules/browser/relay.mjs');
let relayErr = null;
try { await submitCommand('browser_click', { text: 'stale' }, { timeoutMs: 50 }); } catch (e) { relayErr = e; }
const afterTimeout = await fetch(relayBase + '/poll').then(r => r.json());
t('browser relay: timed-out command is not delivered to the extension later',
  relayErr !== null && afterTimeout.command === null, JSON.stringify(afterTimeout));

let threwContractViolation = false;
try { registerModule({ name: 'malformed-test-module' }); } // missing capabilities + execute
catch (e) { threwContractViolation = e instanceof ContractViolation; }
t('malformed module registration throws ContractViolation, not a silent accept', threwContractViolation);

const flakyModule = {
  name: 'flaky-test-module',
  capabilities: [makeCapability({ name: 'flaky_test_capability' })],
  healthCheck() { throw new Error('simulated health check failure'); },
  async execute() { return 'should never be reached'; },
};
registerModule(flakyModule);
t('a module whose healthCheck throws is marked unhealthy, not crashed', isHealthy('flaky-test-module') === false);
const flakyDispatchResult = await dispatch('flaky_test_capability', {});
t('dispatch refuses a disabled module cleanly instead of calling it',
  flakyDispatchResult.startsWith('Error: module "flaky-test-module" is currently disabled'));

// Daemon: prove missed-window catch-up without touching the real persisted
// schedule -- back it up, run the test against the real file (that's what
// PATHS.schedule points at), then restore exactly what was there before.
const scheduleExisted = existsSync(PATHS.schedule);
const scheduleBackup = scheduleExisted ? rfs(PATHS.schedule, 'utf8') : null;
let daemonFireCount = 0;
const daemonTestModule = {
  name: 'daemon-test-module',
  capabilities: [makeCapability({ name: 'daemon_test_capability' })],
  async execute() { daemonFireCount++; return 'daemon test fired'; },
};
registerModule(daemonTestModule);
scheduleTask({ capability: 'daemon_test_capability', args: {}, dueAt: new Date(Date.now() - 60_000).toISOString(), note: 'selfcheck: past-due, must fire (missed-window catch-up)' });
scheduleTask({ capability: 'daemon_test_capability', args: {}, dueAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'selfcheck: future, must not fire yet' });
const firedThisTick = await tick(dispatch);
t('daemon fires a past-due task on tick (survives a missed window rather than skipping it)',
  daemonFireCount === 1 && firedThisTick.length === 1 && firedThisTick[0].status === 'fired');
const stillPending = listScheduled();
t('daemon leaves the not-yet-due task pending', stillPending.length === 1 && stillPending[0].status === 'pending');
if (scheduleExisted) wfs(PATHS.schedule, scheduleBackup);
else { try { rmSync(PATHS.schedule); } catch {} }

// ---- Local-model context-overflow fix + error telemetry ----
const { getModelBudget } = await import('./athena/tokens.mjs');
const { isLocalContextOverflow } = await import('./athena/api.mjs');
const { logError, recentErrors } = await import('./athena/telemetry.mjs');

const savedCtx = globalThis.__athenaLocalCtxSize;
globalThis.__athenaLocalCtxSize = undefined;
t('local budget falls back to a conservative default with no live ctx-size',
  getModelBudget('local-qwen2-5-3b-instruct-q4-k-m') === 3000);
globalThis.__athenaLocalCtxSize = 8192;
t('local budget scales to an 8192 live ctx-size',
  getModelBudget('local-qwen2-5-3b-instruct-q4-k-m') === Math.floor((8192 - 2048) * 0.6));
globalThis.__athenaLocalCtxSize = 4096;
const budgetAt4096 = getModelBudget('local-qwen2-5-3b-instruct-q4-k-m');
t('local budget scales down further when the ladder degrades to 4096 (this was the actual bug)',
  budgetAt4096 === Math.floor((4096 - 2048) * 0.6) && budgetAt4096 < 3000, budgetAt4096);
globalThis.__athenaLocalCtxSize = savedCtx;

t('isLocalContextOverflow matches a real llama.cpp overflow message',
  isLocalContextOverflow({ status: 400, message: 'HTTP 400: {"error":{"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}' }) === true);
t('isLocalContextOverflow ignores an unrelated 400 (e.g. a tool-schema error)',
  isLocalContextOverflow({ status: 400, message: 'HTTP 400: {"error":"invalid function call"}' }) === false);
t('isLocalContextOverflow ignores non-400s entirely',
  isLocalContextOverflow({ status: 429, message: 'exceeds context size' }) === false);

// logError/recentErrors -- write a synthetic entry, read it back, then restore
// the real file exactly as found (same discipline as the schedule.json test above).
const errorsExisted = existsSync(PATHS.errorsLog);
const errorsBackup  = errorsExisted ? rfs(PATHS.errorsLog, 'utf8') : null;
logError('selfcheck_probe', new Error('synthetic test error'), { probe: true });
await new Promise(r => setTimeout(r, 50)); // appendFile is async, fire-and-forget in logError
const errText = recentErrors(5);
t('logError writes an entry recentErrors() can read back',
  errText.includes('selfcheck_probe') && errText.includes('synthetic test error'));
if (errorsExisted) wfs(PATHS.errorsLog, errorsBackup);
else { try { rmSync(PATHS.errorsLog); } catch {} }

_resetKernelForTests();

// real boot
const proc = spawn(process.execPath, ['athena/athena.mjs'], {
  cwd: ROOT, env: { ...process.env, ATHENA_NO_OPEN: '1', ATHENA_UI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
proc.stdout.on('data', d => out += d);
proc.stderr.on('data', d => out += d);
await new Promise(r => setTimeout(r, 9000));
proc.kill('SIGTERM');
await new Promise(r => setTimeout(r, 700));
try { proc.kill('SIGKILL'); } catch {}
const fatal = out.split('\n').filter(l => /ReferenceError|SyntaxError|TypeError|is not defined|Cannot find|does not provide an export|ContractViolation/i.test(l));
t('boots clean', fatal.length === 0, fatal.slice(0,3).join(' | '));
console.log('   boot: ' + (out.match(/Athena[\s\S]{0,120}/) || [''])[0].replace(/\u001b\[[0-9;]*m/g,'').replace(/\s+/g,' ').slice(0,110));

console.log('\n' + p + ' passed, ' + f + ' failed' + (sk ? ', ' + sk + ' skipped' : ''));
process.exit(f ? 1 : 0);
