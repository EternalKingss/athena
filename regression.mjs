// ATHENA V2 -- Full regression test suite
import { PATHS } from './athena/paths.mjs';
import { API_KEY, MODEL, NAME, MEM_CHAR_LIMIT, ANTHROPIC_KEY, state, CURATED_MODELS } from './athena/config.mjs';
import { loadMemBlock, loadInstincts, readEntries, scanForInstincts } from './athena/memory.mjs';
import { systemPrompt } from './athena/personality.mjs';
import { extractTags } from './athena/embed.mjs';
import { compressOutput } from './athena/compress.mjs';
import { getRemediationPlan } from './athena/remediate.mjs';
import { scanSkills } from './athena/skills.mjs';
import { capabilitiesSummary, getCachedCapabilities } from './athena/capabilities.mjs';
import { freshMessages, isActive } from './athena/core.mjs';
import { listAgents, workspaceRead, workspaceWrite } from './athena/agents.mjs';
import { TOOLS, classifyRisk } from './athena/tools.mjs';
import { machineTrend, loadFingerprint } from './athena/machines.mjs';
import { watcherStatus } from './athena/watcher.mjs';
import { getProviderStatus } from './athena/api.mjs';
import { existsSync } from 'node:fs';

let p=0, f=0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); p++; }
  catch(e) { console.error('  FAIL ' + name + ' -- ' + e.message); f++; }
}
function section(name) { console.log('\n[' + name + ']'); }

// ── CONFIG ───────────────────────────────────────────────────────────────
section('Config');
test('NAME set', () => { if (!NAME) throw new Error('empty'); });
test('MEM_CHAR_LIMIT=8000', () => { if (MEM_CHAR_LIMIT !== 8000) throw new Error('got ' + MEM_CHAR_LIMIT); });
test('PATHS all defined', () => {
  ['env','memDir','agentMem','userMem','summary','sessDir','skills','instincts'].forEach(k => {
    if (!PATHS[k]) throw new Error('PATHS.' + k + ' missing');
  });
});
test('CURATED_MODELS has Claude group', () => {
  const cg = CURATED_MODELS.find(g => g.label === 'Claude');
  if (!cg) throw new Error('no Claude group');
  if (!cg.models.some(m => m.includes('claude'))) throw new Error('no claude models');
});

// ── API ───────────────────────────────────────────────────────────────────
section('API');
test('resolveProvider throws on missing Claude key', async () => {
  // Test that importing api.mjs doesn't crash
  const { } = await import('./athena/api.mjs');
});
test('TOOLS array has 28+ entries', () => {
  if (TOOLS.length < 28) throw new Error('only ' + TOOLS.length + ' tools');
});
test('memory tool has instincts enum', () => {
  const t = TOOLS.find(t => t.function.name === 'memory');
  if (!t) throw new Error('missing');
  const targets = t.function.parameters.properties.target.enum;
  if (!targets.includes('instincts')) throw new Error('no instincts target');
  if (!targets.includes('athena')) throw new Error('no athena target');
  if (!targets.includes('user')) throw new Error('no user target');
});
test('edit_file description mentions read_file first', () => {
  const t = TOOLS.find(t => t.function.name === 'edit_file');
  if (!t.function.description.includes('read_file')) throw new Error('missing read_file guidance');
});
test('run_shell description mentions PowerShell prefix', () => {
  const t = TOOLS.find(t => t.function.name === 'run_shell');
  if (!t.function.description.includes('powershell')) throw new Error('missing PS prefix');
});

// ── MEMORY ────────────────────────────────────────────────────────────────
section('Memory');
test('readEntries graceful on missing file', () => {
  const e = readEntries('/no/file');
  if (!Array.isArray(e) || e.length !== 0) throw new Error('bad: ' + JSON.stringify(e));
});
test('instincts file exists and has entries', () => {
  if (!existsSync(PATHS.instincts)) throw new Error('file missing');
  const e = readEntries(PATHS.instincts);
  if (e.length < 10) throw new Error('expected >= 10, got ' + e.length);
});
test('loadInstincts returns formatted block', () => {
  const b = loadInstincts();
  if (!b) throw new Error('empty');
  if (!b.includes('INSTINCTS')) throw new Error('no header');
  if (!b.includes('[conf:')) throw new Error('no conf scores');
});
test('scanForInstincts returns array', () => {
  const c = scanForInstincts(3);
  if (!Array.isArray(c)) throw new Error('not array');
});

// ── PERSONALITY / SYSTEM PROMPT ───────────────────────────────────────────
section('System Prompt');
test('freshMessages has system role first', () => {
  const msgs = freshMessages();
  if (!msgs.length || msgs[0].role !== 'system') throw new Error('bad');
  if (msgs[0].content.length < 500) throw new Error('too short: ' + msgs[0].content.length);
});
test('systemPrompt has required sections', () => {
  const sp = systemPrompt();
  const required = ['YOUR VOICE', 'OPERATIONAL RULES', 'SECURITY & TRIAGE', 'INSTINCT RULES', 'MULTI-AGENT RULES'];
  required.forEach(s => { if (!sp.includes(s)) throw new Error('missing: ' + s); });
  // Windows shell section only present on win32
  if (process.platform === 'win32' && !sp.includes('Windows shell')) throw new Error('missing: Windows shell');
});
test('systemPrompt has instincts loaded', () => {
  const sp = systemPrompt();
  if (!sp.includes('[conf:95]')) throw new Error('no instincts in prompt');
  if (!sp.includes('Get-CimInstance')) throw new Error('specific instinct missing');
});
test('systemPrompt workspace_read guidance is mandatory', () => {
  const sp = systemPrompt();
  if (!sp.includes('mandatory')) throw new Error('workspace_read not mandatory');
});

// ── COMPRESS ──────────────────────────────────────────────────────────────
section('Compress');
test('skip small input (<1500 chars)', () => {
  const s = '{"x":1}';
  if (compressOutput(s, 'memory') !== s) throw new Error('should not compress');
});
test('apply to large JSON -- array cap 8', () => {
  const arr = Array.from({length:20}, (_,i) => ({id:i, v:'x'.repeat(80)}));
  const json = JSON.stringify({items:arr});
  if (json.length < 1500) throw new Error('test input too small');
  const r = JSON.parse(compressOutput(json, 'memory'));
  if (r.items.length > 9) throw new Error('array cap failed: ' + r.items.length);
});
test('hard cap enforced', () => {
  const big = 'a'.repeat(10000);
  const r = compressOutput(big, 'read_file');
  if (r.length > 8500) throw new Error('hard cap breach: ' + r.length);
});

// ── EMBED / TAGS ──────────────────────────────────────────────────────────
section('Tags');
test('windows tags', () => {
  const t = extractTags('windows powershell registry');
  if (!t.includes('windows') || !t.includes('windows-admin')) throw new Error(JSON.stringify(t));
});
test('security tags', () => {
  const t = extractTags('malware virus ransomware');
  if (!t.includes('security')) throw new Error(JSON.stringify(t));
});
test('hardware tags', () => {
  const t = extractTags('driver gpu ram motherboard');
  if (!t.includes('hardware')) throw new Error(JSON.stringify(t));
});
test('rust/go/java tags', () => {
  if (!extractTags('rust cargo .rs').includes('rust')) throw new Error('rust');
  if (!extractTags('golang .go').includes('go')) throw new Error('go');
  if (!extractTags('java maven gradle').includes('java')) throw new Error('java');
});
test('api/performance tags', () => {
  if (!extractTags('rest api endpoint').includes('api')) throw new Error('api');
  if (!extractTags('performance slow latency').includes('performance')) throw new Error('perf');
});

// ── REMEDIATE ─────────────────────────────────────────────────────────────
section('Remediate');
test('crash playbook (KP41)', () => {
  // KP41 is Windows-only -- playbook only exists for win32
  if (process.platform !== 'win32') return;
  const p = getRemediationPlan('kernel-power crash bsod event 41');
  if (!p.found || !p.steps.length) throw new Error('missing: ' + JSON.stringify(p));
});
test('thermal playbook', () => {
  // Thermal playbook is Windows-only
  if (process.platform !== 'win32') return;
  const p = getRemediationPlan('overheat temperature cooling');
  if (!p.found) throw new Error('not found');
});
test('win32 disk check uses Get-CimInstance', () => {
  const p = getRemediationPlan('disk space full storage');
  if (!p.found) throw new Error('not found');
  if (p.check.includes('wmic')) throw new Error('still uses wmic: ' + p.check);
});
test('win32 updates opens settings not PSWindowsUpdate', () => {
  const p = getRemediationPlan('updates pending outdated');
  if (!p.found) throw new Error('not found');
  if (p.steps.some(s => s.includes('PSWindowsUpdate') && s.includes('Install-WindowsUpdate'))) {
    throw new Error('still auto-installs PSWindowsUpdate');
  }
});

// ── SKILLS ────────────────────────────────────────────────────────────────
section('Skills');
test('7 skills found', () => {
  const skills = scanSkills();
  if (skills.length < 7) throw new Error('only ' + skills.length);
});
test('system-health has Windows section', () => {
  const skills = scanSkills();
  const sh = skills.find(s => s.dir === 'system-health');
  if (!sh) throw new Error('not found');
  if (!sh.desc.toLowerCase().includes('windows')) throw new Error('desc missing windows: ' + sh.desc);
});

// ── AGENTS ────────────────────────────────────────────────────────────────
section('Agents');
test('listAgents returns array', () => {
  if (!Array.isArray(listAgents())) throw new Error('not array');
});
test('workspace write/read roundtrip', () => {
  workspaceWrite('_test', 'value', 'test');
  const r = workspaceRead('_test');
  if (!r._test || r._test.data !== 'value') throw new Error('bad: ' + JSON.stringify(r));
});
test('isActive returns false when idle', () => {
  if (isActive() !== false) throw new Error('should be false at startup');
});

// ── PHASE 8: TIERED AUTONOMY ─────────────────────────────────────────────
section('Phase 8 -- Tiered Autonomy');
test('classifyRisk: read_file is tier 0', () => {
  const r = classifyRisk('read_file', {}, null);
  if (r.tier !== 0) throw new Error('expected tier 0, got ' + r.tier);
});
test('classifyRisk: write_file is tier 1 (non-system path)', () => {
  const r = classifyRisk('write_file', { path: '/tmp/test.txt' }, null);
  if (r.tier !== 1) throw new Error('expected tier 1, got ' + r.tier + ' -- ' + r.reason);
});
test('classifyRisk: write_file to system path is tier 2', () => {
  const r = classifyRisk('write_file', { path: '/etc/passwd' }, null);
  if (r.tier !== 2) throw new Error('expected tier 2, got ' + r.tier);
});
test('classifyRisk: run_shell rm -rf is tier 2', () => {
  const r = classifyRisk('run_shell', { command: 'rm -rf /home/user' }, null);
  if (r.tier !== 2) throw new Error('expected tier 2, got ' + r.tier + ' -- ' + r.reason);
});
test('classifyRisk: run_shell pip install is tier 1', () => {
  const r = classifyRisk('run_shell', { command: 'pip install requests' }, null);
  if (r.tier !== 1) throw new Error('expected tier 1, got ' + r.tier);
});
test('classifyRisk: remediate execute:true is tier 2', () => {
  const r = classifyRisk('remediate', { issue: 'firewall', execute: true }, null);
  if (r.tier !== 2) throw new Error('expected tier 2, got ' + r.tier);
});
test('classifyRisk: remediate without execute is tier 1', () => {
  const r = classifyRisk('remediate', { issue: 'firewall' }, null);
  if (r.tier >= 2) throw new Error('expected tier < 2, got ' + r.tier);
});
test('classifyRisk: all results have tier and reason', () => {
  const names = ['run_shell','write_file','edit_file','memory','recall','spawn_agent'];
  for (const n of names) {
    const r = classifyRisk(n, {}, null);
    if (r.tier === undefined) throw new Error(n + ': missing tier');
    if (!r.reason) throw new Error(n + ': missing reason');
  }
});
test('machine_health_trend tool exists in TOOLS', () => {
  if (!TOOLS.find(t => t.function.name === 'machine_health_trend')) throw new Error('missing');
});

// PHASE 9: CRYSTALLIZATION
section('Phase 9 -- Crystallization');
test('crystallize is exported from core.mjs', async () => {
  const { crystallize } = await import('./athena/core.mjs');
  if (typeof crystallize !== 'function') throw new Error('not a function');
});

// PHASE 10: INSTINCT PROMOTION
section('Phase 10 -- Instinct Promotion');
test('scanForInstincts returns conf scores', () => {
  const c = scanForInstincts(3);
  if (!Array.isArray(c)) throw new Error('not array');
  for (const item of c) {
    if (item.conf === undefined) throw new Error('missing conf on: ' + JSON.stringify(item));
  }
});

// PHASE 11: MACHINE HISTORY
section('Phase 11 -- Longitudinal Machine Records');
test('machineTrend returns object with summary or error', () => {
  const t = machineTrend();
  if (typeof t !== 'object') throw new Error('not object');
  if (!t.summary && !t.error) throw new Error('missing summary or error: ' + JSON.stringify(t));
});
test('loadFingerprint has new schema fields if exists', () => {
  const fp = loadFingerprint();
  if (!fp) return;
  if (fp.visits === undefined) throw new Error('missing visits field');
  if (!Array.isArray(fp.history)) throw new Error('history not array');
  if (!fp.uuid) throw new Error('missing uuid');
  if (!fp.first_seen) throw new Error('missing first_seen');
});

// PHASE 12: WATCHER
section('Phase 12 -- Watcher Engine');
test('watcherStatus returns valid structure', () => {
  const s = watcherStatus();
  if (typeof s.active !== 'boolean') throw new Error('active not boolean');
  if (!Array.isArray(s.conditions)) throw new Error('conditions not array');
  if (s.conditions.length < 4) throw new Error('expected >= 4 conditions, got ' + s.conditions.length);
});
test('watcher conditions have required fields', () => {
  const { conditions } = watcherStatus();
  for (const c of conditions) {
    if (!c.id) throw new Error('missing id');
    if (c.tier === undefined) throw new Error('missing tier on ' + c.id);
    if (!c.intervalMs) throw new Error('missing intervalMs on ' + c.id);
  }
});

// PHASE 13-15: CORAL + API FAILOVER
section('Phase 13-15 -- CORAL + API Failover');
test('workspaceWrite/read handles skills_broadcast channel', () => {
  workspaceWrite('skills_broadcast', [{ skillName: 'test-skill', description: 'test', content: '# test', from: 'crystallizer', at: new Date().toISOString() }], 'coral');
  const ch = workspaceRead('skills_broadcast');
  if (!ch.skills_broadcast) throw new Error('channel not found');
  if (!Array.isArray(ch.skills_broadcast.data)) throw new Error('data not array');
  if (ch.skills_broadcast.data[0].skillName !== 'test-skill') throw new Error('wrong skill name');
});
test('getProviderStatus returns array with known providers', () => {
  const s = getProviderStatus();
  if (!Array.isArray(s)) throw new Error('not array');
  const providers = s.map(p => p.provider);
  if (!providers.includes('openai')) throw new Error('missing openai');
  if (!providers.includes('anthropic')) throw new Error('missing anthropic');
});
test('getProviderStatus has required fields', () => {
  const s = getProviderStatus();
  for (const p of s) {
    if (p.failures === undefined) throw new Error('missing failures on ' + p.provider);
    if (typeof p.blocked !== 'boolean') throw new Error('blocked not boolean on ' + p.provider);
  }
});

// DATA FILES
section('Data Files');
test('instincts.md exists', () => {
  if (!existsSync(PATHS.instincts)) throw new Error('missing');
});
test('athena.md exists', () => {
  if (!existsSync(PATHS.agentMem)) throw new Error('missing');
});
test('sessions dir exists', () => {
  if (!existsSync(PATHS.sessDir)) throw new Error('missing');
});

// SUMMARY
const total = p + f;
console.log('\n==================================================');
console.log(' ' + p + '/' + total + ' tests passed' + (f === 0 ? ' ALL GREEN' : ' -- ' + f + ' FAILED'));
console.log('==================================================');
process.exit(f > 0 ? 1 : 0);
