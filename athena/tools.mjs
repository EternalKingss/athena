// tools.mjs
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, isAbsolute, delimiter } from 'node:path';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { BRAVE_KEY } from './config.mjs';
import { PATHS } from './paths.mjs';
import { handleMemoryTool } from './memory.mjs';
import { loadSkill, saveSkill, updateSkill, getSkillStatus, rollbackSkill, listSkillVersions } from './skills.mjs';
import { handleRecallTool } from './embed.mjs';
import { getCachedCapabilities, detectCapabilities, clearCapabilityCache } from './capabilities.mjs';
import { logAuditEvent } from './audit.mjs';
import { logError } from './telemetry.mjs';
import { getRemediationPlan } from './remediate.mjs';
import { createRequire } from 'node:module';
// Model routing (which brain -- local or cloud -- actually does a subtask) is core OS
// plumbing, not a pluggable capability domain, so delegate_to_local lives here with the
// rest of the built-in tool surface instead of being its own registered kernel module.
import { runBoundedAgentLoop } from './agent_loop.mjs';
import { pickLocalModelId } from './local_llm.mjs';

// previewCall is synchronous (the approval gate cannot await), so the fix store is loaded
// through a sync require rather than a dynamic import.
let _fixesMod = null;
function requireSyncFixes() {
  if (!_fixesMod) {
    const req = createRequire(import.meta.url);
    // machine_fixes.mjs is ESM; read it through the already-warm module cache when present,
    // otherwise fall back to a minimal direct read of the store.
    _fixesMod = { getFix: (id) => {
      const { readFileSync, existsSync } = req('node:fs');
      const { join } = req('node:path');
      try {
        const dir = join(PATHS.memDir, 'machines');
        const files = req('node:fs').readdirSync(dir).filter(f => f.endsWith('.fixes.json'));
        for (const f of files) {
          const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          const hit = (j.fixes || []).find(x => x.id === id);
          if (hit) return hit;
        }
      } catch {}
      // Fall back to the preloaded library so a first-time library fix still renders its
      // real commands in the approval gate.
      try {
        const src = readFileSync(new URL('./fix_library.mjs', import.meta.url), 'utf8');
        const m = src.match(new RegExp("id: '" + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'[\\s\\S]{0,1400}?\\n  \\},"));
        if (m) {
          const title = (m[0].match(/title: '([^']+)'/) || [])[1] || id;
          const explain = (m[0].match(/explain: '((?:[^'\\]|\\.)*)'/) || [])[1];
          const needsAdmin = /needsAdmin:\s*true/.test(m[0]);
          const needsReboot = /needsReboot:\s*true/.test(m[0]);
          const steps = [...m[0].matchAll(/steps:\s*\[([\s\S]*?)\],/g)]
            .flatMap(x => [...x[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(y => y[1].replace(/\\(['\\])/g, '$1')));
          return { id, title, steps, verify: null,
                   explain: explain ? explain.replace(/\\(['\\])/g, '$1') : '',
                   needsAdmin, needsReboot };
        }
      } catch {}
      return null;
    }};
  }
  return _fixesMod;
}

// A preview the user can actually judge. The old approval prompt rendered
// args.command || args.path || JSON.stringify(args), so "remediate ssh" showed
// {"issue":"ssh","execute":true} -- and approving it rewrote sshd_config and
// restarted the daemon. An approval prompt that hides the command trains the
// user to click yes, which is worse than no prompt.
export function previewCall(name, args) {
  const a = args || {};
  if (name === 'run_shell') return String(a.command || '(no command)');
  if (name === 'remediate') {
    const plan = getRemediationPlan(a.issue);
    if (!plan.found) return String(a.issue || '') + ' -- no playbook';
    const head = plan.issue + ' on ' + plan.platform + (a.execute ? ' -- WILL RUN:' : ' -- plan only:');
    return [head, ...plan.steps.map(s => '        $ ' + s)].join('\n');
  }
  if (name === 'write_file') return String(a.path || '') + '  (' + String(a.content || '').length + ' chars)';
  if (name === 'edit_file')  return String(a.path || '');
  if (name === 'spawn_agent') return 'agent "' + a.name + '" -- ' + String(a.goal || '').slice(0, 200);
  if (name === 'save_skill' || name === 'update_skill')
    return 'skill "' + a.name + '" (' + String(a.content || '').length + ' chars of instructions)';
  if (name === 'apply_fix') {
    try {
      // Show the actual commands, not the fix id -- approving "id: wifi-bounce" tells the
      // user nothing about what is about to run on their machine.
      const { getFix } = requireSyncFixes();
      const f = getFix(a.id);
      if (!f) return 'fix "' + a.id + '" (not found on this machine)';
      return [f.title, ...f.steps.map(s => '        $ ' + s), '        verify: ' + (f.verify && f.verify.cmd)].join('\n');
    } catch { return 'fix "' + a.id + '"'; }
  }
  if (name === 'learn_fix')
    return [String(a.title || ''), ...(a.steps || []).map(s => '        $ ' + s)].join('\n');
  if (name === 'fix_issues') {
    // Lead with what it MEANS, then what it runs. A wall of PowerShell is not informed
    // consent; "turn off Fast Startup, reversible" is.
    try {
      const { getFix } = requireSyncFixes();
      const lines = [];
      for (const id of (a.ids || [])) {
        const f = getFix(id);
        if (!f) { lines.push('- ' + id + ' (not found)'); continue; }
        lines.push('- ' + f.title);
        if (f.explain) lines.push('    ' + String(f.explain).split('. ')[0] + '.');
        if (f.needsAdmin)  lines.push('    needs an elevated shell');
        if (f.needsReboot) lines.push('    takes effect after a reboot');
        for (const s of f.steps || []) lines.push('    $ ' + s);
      }
      return lines.join('\n') || '(no fixes)';
    } catch { return (a.ids || []).join(', '); }
  }
  return JSON.stringify(a).slice(0, 200);
}

let _agentFns = null;
export function setAgentFunctions(fns) { _agentFns = fns; }

const execAsync = promisify(exec);

function psEncode(script) {
  const buf = Buffer.allocUnsafe(script.length * 2);
  for (let i = 0; i < script.length; i++) buf.writeUInt16LE(script.charCodeAt(i), i * 2);
  return buf.toString('base64');
}
async function runPS(script) {
  const { stdout, stderr } = await execAsync(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${psEncode(script)}`,
    { timeout: 15000 }
  );
  return (stdout || '').trim() || (stderr || '').trim() || '(no output)';
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export const TOOLS = [
  { type: 'function', function: { name: 'run_shell', description: 'Execute a shell command on the host machine. On Windows, wrap scripts with powershell prefix. Returns stdout + stderr.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write content to a file (creates or overwrites).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace an exact string in a file. Always call read_file first to get the exact text to replace.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files and folders in a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch a URL and return readable text. Strips HTML.', parameters: { type: 'object', properties: { url: { type: 'string' }, raw: { type: 'boolean' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web via Brave Search.', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'memory', description: 'Manage long-term memory across sessions.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read','add','replace','remove','search'] }, target: { type: 'string', enum: ['athena','user','instincts','prohibited'] }, content: { type: 'string' }, old: { type: 'string' }, query: { type: 'string' } }, required: ['action','target'] } } },
  { type: 'function', function: { name: 'clipboard_read', description: 'Read current clipboard text.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'clipboard_write', description: 'Write text to the clipboard.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'notify', description: 'Send a desktop notification.', parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['title','message'] } } },
  { type: 'function', function: { name: 'open', description: 'Open a file, folder, or URL with the default app.', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } } },
  { type: 'function', function: { name: 'clarify', description: 'Ask one clarifying question before an ambiguous task.', parameters: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } }, required: ['question'] } } },
  { type: 'function', function: { name: 'todo', description: 'Manage an in-session task list for multi-step work.', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object' } }, merge: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'recall', description: 'Semantic search over past memory and sessions.', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' }, type: { type: 'string', enum: ['memory','session','skill'] } }, required: ['query'] } } },
  { type: 'function', function: { name: 'load_skill', description: 'Load a skill from the drive.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'save_skill', description: 'Save a new skill to the drive.', parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' } }, required: ['name','description','content'] } } },
  { type: 'function', function: { name: 'update_skill', description: 'Update an existing skill.', parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' } }, required: ['name','description','content'] } } },
  { type: 'function', function: { name: 'spawn_agent', description: 'Spawn a background agent to work on a task in parallel. Use to run multiple things simultaneously.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Short agent name (e.g. researcher, syscheck).' }, goal: { type: 'string', description: 'Full task description for the agent.' } }, required: ['name','goal'] } } },
  { type: 'function', function: { name: 'workspace_read', description: 'Read results posted by agents to the shared workspace.', parameters: { type: 'object', properties: { key_prefix: { type: 'string' } } } } },
  { type: 'function', function: { name: 'workspace_write', description: 'Post a result to the shared workspace so other agents can access it.', parameters: { type: 'object', properties: { key: { type: 'string' }, data: { type: 'string' } }, required: ['key','data'] } } },
  { type: 'function', function: { name: 'machine_info', description: 'Return detected machine capabilities: installed languages, compilers, package managers, containers, browsers, IDEs, databases, DevOps tools, utilities, GPUs, and MCP servers. Pass rescan:true to re-detect.', parameters: { type: 'object', properties: { rescan: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'boot_triage', description: 'Run a boot health check: firewall status, disk space, AV, SSH exposure, fail2ban, pending system updates. Returns pass/warn/critical for each check.', parameters: { type: 'object', properties: { format: { type: 'string', enum: ['summary', 'full'] } } } } },
  { type: 'function', function: { name: 'threat_assess', description: 'Assess the machine threat surface: risk score (0-100), open ports, SUID binaries, missing firewall/AV, world-writable directories. Returns HIGH/MEDIUM/LOW risk level.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'network_scan', description: 'Show network situational awareness: interfaces, DNS servers, listening ports, routing table. Pass deep:true and target IP to run an nmap scan if available.', parameters: { type: 'object', properties: { target: { type: 'string', description: 'Target IP for nmap scan (default: 127.0.0.1)' }, deep: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'generate_report', description: 'Generate a professional Markdown report. type: system (hardware+software inventory), security (threats+triage), network (interfaces+ports), full (all combined).', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['system', 'security', 'network', 'full'] } }, required: ['type'] } } },
  { type: 'function', function: { name: 'audit_replay', description: 'Replay the audit trail for a given date. Shows all tool calls and session events with timestamps.', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD format (default: today)' } } } } },
  { type: 'function', function: { name: 'machine_health_trend', description: 'Show longitudinal health trend for this machine: visit history, capability changes over time, usage frequency, and any detected deterioration patterns.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'machine_diff', description: 'Compare the current machine state against the last saved fingerprint. Shows what tools, languages, or hardware changed since the last visit.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remediate', description: 'Get a guided remediation plan for a security or system issue. Returns exact commands to fix the problem. Set execute:true to apply the fix (requires approval).', parameters: { type: 'object', properties: { issue: { type: 'string', description: 'The issue to fix, e.g. "firewall not enabled", "ssh root login allowed", "pending updates"' }, execute: { type: 'boolean' } }, required: ['issue'] } } },
  { type: 'function', function: { name: 'machine_fixes', description: 'List remediations learned specifically for THIS machine, and check which ones currently apply. Use this before generic remediation -- a machine-specific fix beats a generic playbook. Pass detect:true to run each fix\'s detect command and see what applies right now.', parameters: { type: 'object', properties: { detect: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'learn_fix', description: 'Record a remediation that is specific to this machine, so it survives across sessions and reboots. Requires a verify command -- without a way to prove it worked, a fix is only a stored guess. Use after you have diagnosed something the generic playbooks do not cover.', parameters: { type: 'object', properties: { title: { type: 'string' }, symptom: { type: 'string', description: 'What the user observes when this is wrong.' }, detect: { type: 'object', description: '{cmd, expect} -- a command plus a regex whose match means the symptom IS present.' }, steps: { type: 'array', items: { type: 'string' }, description: 'Commands to run, in order.' }, verify: { type: 'object', description: '{cmd, expect} -- a command plus a regex whose match means the fix WORKED.' }, explain: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'steps', 'verify'] } } },
  { type: 'function', function: { name: 'fix_issues', description: 'Detect every fix that currently applies to this machine and apply the ones you choose, lowest risk first, verifying after each and stopping if one fails. This is the "just fix it" path: call machine_fixes with detect:true first to see what applies, then call this with those ids. Never pass ids you have not shown the user.', parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, dry_run: { type: 'boolean' } }, required: ['ids'] } } },
  { type: 'function', function: { name: 'apply_fix', description: 'Apply a previously learned machine-specific fix by id. Runs its detect command first and skips if the symptom is absent, then runs the steps, then runs the verify command and adjusts the fix\'s confidence based on whether verification passed. Pass dry_run:true to see what would run.', parameters: { type: 'object', properties: { id: { type: 'string' }, dry_run: { type: 'boolean' }, force: { type: 'boolean' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'diff_machine_state', description: 'Compare what is RUNNING right now -- processes, listening ports, loaded drivers -- against a saved baseline of this machine in a known-good state. Use it when something worked before and does not now, especially after a reboot: a driver present in the baseline and missing now is the answer. Pass save:true while the machine is healthy to record the baseline first.', parameters: { type: 'object', properties: { save: { type: 'boolean', description: 'Capture the current state as the new baseline instead of diffing against it.' } } } } },
  { type: 'function', function: { name: 'skill_rollback', description: 'Roll back a skill to a prior version. Use list_versions:true to see available versions.', parameters: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'number' }, list_versions: { type: 'boolean' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'delegate_to_local', description: 'Hand a single, concrete, well-scoped subtask to whichever local model is loaded on this machine, and have it actually carried out and verified -- not just described. Use for mechanical, low-risk actions (a browser click, a file read, listing tabs) that do not need real judgment. Do not use this for anything ambiguous, judgment-heavy, multi-interpretation, or destructive.', parameters: { type: 'object', properties: { task: { type: 'string', description: 'One concrete subtask, described the way you would brief a junior assistant.' }, maxSteps: { type: 'number', description: 'Max tool-call rounds before giving up (default 6, hard cap 12).' } }, required: ['task'] } } },
];

// (The sudo lockout counter lived here. It existed only to make the automatic sudo
// retry safe; now that Athena never escalates on its own, there is nothing to count.)

export async function runTool(name, args, preApproved, sessionTodos, setSessionTodos, requestUserInput) {
  // The approval decision is made once, in core.mjs (which already folds AUTO_APPROVE in).
  // This used to be `preApproved || AUTO`, which under AUTO_APPROVE ran an irreversible
  // command even after the user answered "no" to it -- the one prompt AUTO still shows.
  const ok = preApproved === true;

  // Audit every tool call (non-blocking, best-effort)
  logAuditEvent('tool_call', { tool: name, args }).catch(e => logError('auditEvent', e));

  if (name === 'run_shell') {
    if (!ok) throw new Error('not approved');
    // Prepend bundled Python bin dirs so drive Python/pip take priority over host
    const env = { ...process.env };
    if (existsSync(PATHS.python)) {
      const extra = PATHS.pythonBin + delimiter + PATHS.pythonPkg;
      env.PATH = extra + delimiter + (env.PATH || '');
    }
    const isPermErr = msg => /permission denied|need.*root|must be.*root|you need to be root|EACCES|Operation not permitted/i.test(msg);
    const runCmd = async cmd => {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120000, maxBuffer: 1024 * 1024 * 10, env });
      return (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '') || '(no output)';
    };
    try {
      return await runCmd(args.command);
    } catch (e) {
      // No silent sudo escalation. This used to retry as `sudo <cmd>` automatically:
      // the user approved X and got sudo X. Elevation is a different decision and needs
      // its own approval, so surface it and let the model re-request explicitly.
      if (isPermErr(e.message) && process.platform !== 'win32' && !args.command.trimStart().startsWith('sudo ')) {
        return 'Permission denied: ' + e.message.slice(0, 200) +
          '\n[needs elevation -- re-issue the command with an explicit "sudo " prefix if that is really intended; it will require separate approval]';
      }
      throw e;
    }
  }

  if (name === 'read_file')  return await readFile(args.path, 'utf8');
  if (name === 'list_dir') {
    const dir = args.path || process.cwd();
    const items = await readdir(dir);
    const out = [];
    for (const it of items) {
      try { const s = await stat(join(dir, it)); out.push((s.isDirectory() ? 'DIR ' : 'FILE') + '  ' + it); }
      catch { out.push('?     ' + it); }
    }
    return out.join('\n') || '(empty)';
  }
  if (name === 'write_file') {
    if (!ok) throw new Error('not approved');
    const target = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
    await writeFile(target, args.content);
    return 'Wrote ' + args.content.length + ' chars to ' + target;
  }
  if (name === 'edit_file') {
    if (!ok) throw new Error('not approved');
    const target = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
    const original = await readFile(target, 'utf8');
    const count = original.split(args.old_str).length - 1;
    if (count === 0) return 'edit_file: old_str not found in ' + target;
    if (count > 1)   return 'edit_file: old_str appears ' + count + ' times -- make it more unique';
    await writeFile(target, original.replace(args.old_str, () => args.new_str));
    return 'Edited ' + target;
  }

  if (name === 'fetch_url') {
    const res = await fetch(args.url, { headers: { 'User-Agent': 'Athena-Agent/4.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return 'fetch_url error: HTTP ' + res.status;
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = (!args.raw && ct.includes('html')) ? stripHtml(body) : body;
    return text.slice(0, 8000) + (text.length > 8000 ? '\n[...truncated]' : '');
  }
  if (name === 'web_search') {
    if (!BRAVE_KEY) return 'web_search: no BRAVE_API_KEY in config/.env';
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
    const res = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(args.query) + '&count=' + count,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_KEY }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return 'web_search error: HTTP ' + res.status;
    const data = await res.json();
    return (data.web?.results || []).map((r, i) => (i+1) + '. ' + r.title + '\n   ' + r.url + '\n   ' + (r.description || '')).join('\n\n') || 'No results.';
  }

  if (name === 'memory') return await handleMemoryTool(args);

  if (name === 'clipboard_read') {
    if (process.platform === 'win32') return runPS('Get-Clipboard');
    try { const { stdout } = await execAsync('pbpaste 2>/dev/null || xclip -o 2>/dev/null || xsel -o 2>/dev/null'); return stdout.trim() || '(empty)'; } catch { return '(clipboard unavailable)'; }
  }
  if (name === 'clipboard_write') {
    if (process.platform === 'win32') {
      const b64 = Buffer.from(String(args.text)).toString('base64');
      return runPS(`[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | Set-Clipboard`);
    }
    // Mac uses pbcopy, Linux uses xclip then xsel as fallback -- await the process so write is complete before returning
    const tryWrite = cmd => new Promise((resolve, reject) => {
      const proc = spawn(cmd, [], { shell: true });
      proc.stdin.write(String(args.text));
      proc.stdin.end();
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('exit ' + code)));
      proc.on('error', reject);
    });
    const cmds = process.platform === 'darwin'
      ? ['pbcopy']
      : ['xclip -selection clipboard', 'xsel --clipboard --input'];
    for (const cmd of cmds) {
      try { await tryWrite(cmd); return 'Copied.'; } catch {}
    }
    return '(clipboard unavailable)';
  }

  if (name === 'notify') {
    if (process.platform === 'win32') {
      const safeMsg   = String(args.message).split("'").join("''");
      const safeTitle = String(args.title).split("'").join("''");
      const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('" + safeMsg + "','" + safeTitle + "') | Out-Null";
      await runPS(ps).catch(() => {});
    } else if (process.platform === 'darwin') {
      const cmd = 'osascript -e ' + JSON.stringify('display notification ' + JSON.stringify(String(args.message)) + ' with title ' + JSON.stringify(String(args.title)));
      await execAsync(cmd).catch(() => {});
    } else {
      await execAsync('notify-send ' + JSON.stringify(String(args.title)) + ' ' + JSON.stringify(String(args.message))).catch(() => {});
    }
    return 'Notified: ' + args.title;
  }

  if (name === 'open') {
    const t = JSON.stringify(String(args.target));
    const cmd = process.platform === 'win32' ? 'start "" ' + t : process.platform === 'darwin' ? 'open ' + t : 'xdg-open ' + t;
    await execAsync(cmd).catch(() => {});
    return 'Opened ' + args.target;
  }

  if (name === 'clarify') {
    if (!requestUserInput) return args.question;
    return await requestUserInput(args.question, args.choices || []);
  }

  if (name === 'todo') {
    if (!args.todos) return JSON.stringify(sessionTodos, null, 2) || '[]';
    const updated = args.merge
      ? sessionTodos.map(t => args.todos.find(u => u.id === t.id) || t).concat(args.todos.filter(u => !sessionTodos.find(t => t.id === u.id)))
      : args.todos;
    setSessionTodos(updated);
    return JSON.stringify(updated, null, 2);
  }

  if (name === 'recall') return await handleRecallTool(args);

  if (name === 'load_skill') {
    const status = getSkillStatus(args.name);
    const skillContent = loadSkill(args.name);
    if (status === 'unverified') {
      // Reaching here means the Tier 2 approval gate was passed -- promote to verified.
      const existingDesc = (skillContent.match(/^description:\s*(.+)$/m) || [])[1] || '';
      const body = skillContent.replace(/^---[\s\S]*?---\n+/, '');
      updateSkill(args.name, existingDesc, body, 'verified').catch(() => {});
      return '[NOW VERIFIED: ' + args.name + ' -- approved by user, promoted from unverified]\n\n' + skillContent;
    }
    return skillContent;
  }
  if (name === 'save_skill')   return await saveSkill(args.name, args.description, args.content);
  if (name === 'update_skill') return await updateSkill(args.name, args.description, args.content);

  if (name === 'machine_info') {
    if (args.rescan) clearCapabilityCache();
    const caps = getCachedCapabilities() || await detectCapabilities();
    return JSON.stringify(caps, null, 2);
  }

  if (name === 'boot_triage') {
    const { runBootTriage, formatTriageReport } = await import('./triage.mjs');
    const triage = await runBootTriage();
    if (args.format === 'full') return formatTriageReport(triage);
    const STATUS_ICON = { ok: '✓', warn: '⚠', critical: '✗', info: 'ℹ', unknown: '?' };
    const lines = [triage.summary, ''];
    triage.checks.forEach(c => lines.push(`  ${STATUS_ICON[c.status] || '?'} ${c.name}: ${c.detail}`));
    return lines.join('\n');
  }

  if (name === 'threat_assess') {
    const { assessThreatSurface, formatThreatReport } = await import('./threat.mjs');
    return formatThreatReport(await assessThreatSurface());
  }

  if (name === 'network_scan') {
    const { handleNetworkScanTool } = await import('./network.mjs');
    return await handleNetworkScanTool(args);
  }

  if (name === 'generate_report') {
    const { handleReportTool } = await import('./report.mjs');
    return handleReportTool(args);
  }

  if (name === 'audit_replay') {
    const { replayAudit } = await import('./audit.mjs');
    return replayAudit(args.date);
  }

  if (name === 'machine_diff') {
    const { checkMachineReturn } = await import('./machines.mjs');
    const caps = getCachedCapabilities() || await detectCapabilities();
    const result = await checkMachineReturn(caps);
    return result.report;
  }

  // Phase 16e shipped captureRuntimeState/diffRuntimeState/saveRuntimeBaseline/
  // loadRuntimeBaseline and then never exposed a tool for any of them, so ~90 lines of
  // working drift detection could not be reached. It is exactly the check that answers
  // "the adapter came up last boot and not this one".
  if (name === 'diff_machine_state') {
    const { captureRuntimeState, diffRuntimeState, saveRuntimeBaseline, loadRuntimeBaseline } =
      await import('./machines.mjs');
    const current = await captureRuntimeState();
    if (args && args.save) {
      await saveRuntimeBaseline(current);
      return 'Baseline saved (' + (current.processes || []).length + ' processes, ' +
             (current.listeningPorts || []).length + ' listening ports, ' +
             ((current.drivers || current.modules || []).length) + ' drivers/modules). ' +
             'Call diff_machine_state again later to see what changed.';
    }
    const baseline = loadRuntimeBaseline();
    if (!baseline)
      return 'No baseline recorded for this machine yet. Run diff_machine_state with save:true while everything is working, then compare after something breaks.';
    return diffRuntimeState(baseline, current);
  }

  if (name === 'machine_health_trend') {
    const { machineTrend } = await import('./machines.mjs');
    const trend = machineTrend();
    return trend.error || trend.summary;
  }

  if (name === 'remediate') {
    // Machine-specific fixes win over generic playbooks. A playbook knows what is true of
    // "a Windows box"; a learned fix knows what is true of THIS one, which is where the
    // problems worth an agent actually live.
    try {
      const { detectApplicable, formatFixes } = await import('./machine_fixes.mjs');
      const applicable = (await detectApplicable()).filter(f => f.applicable === true && f.status !== 'retired');
      if (applicable.length) {
        return 'This machine has a learned fix that currently applies -- prefer it over the generic playbook:\n\n'
          + formatFixes(applicable)
          + '\nRun it with apply_fix, id: ' + applicable[0].id;
      }
    } catch { /* fix store unavailable -- fall through to playbooks */ }
    const plan = getRemediationPlan(args.issue);
    if (!plan.found) return plan.message;
    if (!args.execute) {
      const lines = [
        `Remediation plan for: ${plan.issue}`,
        `Platform: ${plan.platform}`,
        '',
        `Check command: ${plan.check}`,
        '',
        'Steps:',
        ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
        '',
        `Explanation: ${plan.explain}`,
        '',
        'Call remediate with execute:true to apply (requires approval).',
      ];
      if (!plan.steps.length) lines.splice(5, 0, '  (no automated steps -- see explanation)');
      return lines.join('\n');
    }
    if (!ok) throw new Error('not approved');
    if (!plan.steps.length) return plan.explain;

    // Run the playbook's own check FIRST. Applying steps blind "fixes" things that were
    // never broken -- and these playbooks are not harmless when they misfire: the ssh one
    // disables password auth and restarts sshd, which locks you out of a box you reach by
    // password. The check exists in every playbook; it was simply never called.
    const results = [];
    if (plan.check) {
      try {
        const { stdout, stderr } = await execAsync(plan.check, { timeout: 30000 });
        results.push('Pre-check: ' + plan.check + '\n  ' + ((stdout || stderr || '').trim().slice(0, 300) || '(no output)'));
      } catch (e) {
        results.push('Pre-check: ' + plan.check + '\n  (failed: ' + e.message.slice(0, 150) + ')');
      }
    }

    const isPermErr = msg => /permission denied|need.*root|must be.*root|you need to be root|EACCES|Operation not permitted/i.test(msg);
    for (const step of plan.steps) {
      try {
        const { stdout, stderr } = await execAsync(step, { timeout: 60000 });
        results.push(`✓ ${step}\n  ${((stdout || stderr || '').trim()).slice(0, 200)}`);
      } catch (e) {
        // No silent escalation here either -- report and stop rather than re-running as root.
        const hint = isPermErr(e.message) && process.platform !== 'win32'
          ? '\n  [needs elevation -- run this step manually with sudo]'
          : '';
        results.push(`✗ ${step}\n  ${e.message.slice(0, 200)}${hint}`);
      }
    }
    return results.join('\n\n');
  }

  if (name === 'spawn_agent') {
    if (!_agentFns?.spawnAgent) return 'Agent system not initialized.';
    const agentId = _agentFns.spawnAgent(args.name, args.goal);
    return 'Agent ' + JSON.stringify(args.name) + ' spawned (id: ' + agentId + '). Running in parallel. Use workspace_read to check results.';
  }
  if (name === 'workspace_read') {
    if (!_agentFns?.workspaceRead) return '{}';
    const result = _agentFns.workspaceRead(args.key_prefix);
    return Object.keys(result).length ? JSON.stringify(result, null, 2) : '(workspace is empty)';
  }
  if (name === 'workspace_write') {
    if (!_agentFns?.workspaceWrite) return 'Agent system not initialized.';
    _agentFns.workspaceWrite(args.key, args.data, 'agent');
    return 'Stored in workspace[' + JSON.stringify(args.key) + ']';
  }

  if (name === 'machine_fixes') {
    const { listFixes, detectApplicable, formatFixes } = await import('./machine_fixes.mjs');
    const fixes = args && args.detect ? await detectApplicable() : listFixes();
    return formatFixes(fixes);
  }

  if (name === 'learn_fix') {
    if (!ok) throw new Error('not approved');
    const { recordFix } = await import('./machine_fixes.mjs');
    const r = await recordFix({
      title: args.title, symptom: args.symptom, detect: args.detect,
      steps: args.steps, verify: args.verify, explain: args.explain, tags: args.tags,
    });
    return r.message;
  }

  if (name === 'fix_issues') {
    const { applyFixes } = await import('./machine_fixes.mjs');
    if (!args.dry_run && !ok) throw new Error('not approved');
    const r = await applyFixes(args.ids, { dryRun: Boolean(args.dry_run) });
    return r.message;
  }

  if (name === 'apply_fix') {
    const { applyFix } = await import('./machine_fixes.mjs');
    if (!args.dry_run && !ok) throw new Error('not approved');
    const r = await applyFix(args.id, { force: Boolean(args.force), dryRun: Boolean(args.dry_run) });
    return r.message;
  }

  if (name === 'skill_rollback') {
    if (args.list_versions) {
      const versions = listSkillVersions(args.name);
      return versions.length
        ? 'Available versions for "' + args.name + '": ' + versions.map(v => 'v' + v).join(', ')
        : 'No saved versions for "' + args.name + '".';
    }
    if (!args.version) return 'version number required (or pass list_versions:true to see options).';
    return await rollbackSkill(args.name, args.version);
  }

  if (name === 'delegate_to_local') {
    const task = String(args.task || '').trim();
    if (!task) return JSON.stringify({ ok: false, failureReason: 'delegate_to_local needs a task' });
    const maxSteps = Number.isFinite(args.maxSteps) && args.maxSteps > 0 ? Math.min(Math.floor(args.maxSteps), 12) : 6;
    const modelId = await pickLocalModelId();
    if (!modelId) return JSON.stringify({ ok: false, failureReason: 'no local model available to delegate to -- drop a .gguf into runtime/models/, or set LOCAL_MODEL_PREF' });
    const result = await runBoundedAgentLoop({
      model: modelId,
      systemPrompt: "You are Athena's local worker model, given exactly one concrete subtask by Athena's main (cloud) reasoning model. You have a small set of real tools -- use them to actually carry out the subtask. Do not describe what you would do; call the tool. When the subtask is genuinely complete, reply with a short confirmation and make no further tool calls. If you cannot complete it, say why in one or two sentences and stop -- do not guess or improvise beyond what was asked.",
      task,
      maxSteps,
    });
    return JSON.stringify(result);
  }

  return 'Unknown tool: ' + name;
}

// ---- Tool surface for small local models ----
// Basic commands only (v3.4): volume, media, opening things, the browser. Diagnosing and
// fixing belong to Claude, so the local model gets no fix, write or diagnostic tools --
// run_shell stays because that is how volume and media keys are driven.
export const LOCAL_TOOL_NAMES = new Set([
  'run_shell',
  'read_file',
  'list_dir',
  'memory',
  'clarify',
]);

export function toolsForModel(model) {
  if (!model || !String(model).startsWith('local-')) return TOOLS;
  const subset = TOOLS.filter(t => LOCAL_TOOL_NAMES.has(t.function?.name));
  return subset.length ? subset : TOOLS;
}

// ---- Operations that still ask, even with AUTO_APPROVE on ----
// The test is not "is this dangerous" -- plenty of dangerous things are recoverable. The
// test is: if the model got this wrong, can it be undone? Formatting a disk, wiping a
// registry hive, or rebooting mid-work cannot. A single prompt is cheap insurance against
// an unbounded loss; everything else runs without asking.
//
// Flight booking (phase 5) deliberately never gets a flight_book tool at all -- see
// docs/MODULE3_PLAN.md Section 1. The only way it touches the outside world is through
// browser_click, so this pattern is the one place that boundary has to hold even if an
// agent_loop task or a prompt bug tries to click through it anyway.
//
// Only actions that move money (a purchase, a booking) get this approval gate. Email is
// moot: modules/google.mjs's OAuth app was never granted gmail.send, so there's no code
// path that could send one. This is a text-match heuristic on the clicked element and can
// be wrong in either direction -- a bare "Submit" with no other cue is genuinely ambiguous.
const PURCHASE_LIKE = /\b(place order|buy now|pay now|book now|confirm (order|purchase|payment|booking)|complete (purchase|order|booking|checkout)|checkout|finalize (order|booking))\b/i;

const IRREVERSIBLE = [
  { re: /\b(format|mkfs|diskpart)\b/i,                       why: 'formats or repartitions a disk' },
  { re: /\bcipher\s+\/w\b/i,                                 why: 'securely wipes free space' },
  { re: /\breg\s+delete\b/i,                                 why: 'deletes registry keys' },
  // order-independent: any recursive delete verb + any root-ish target, however arranged
  { fn: text => {
      const recursiveDelete = /(Remove-Item|\brm\b|\brmdir\b|\brd\b|\bdel\b)/i.test(text)
        && /(-Recurse|-r\b|\/s\b|-[a-z]*r[a-z]*\b)/i.test(text);
      if (!recursiveDelete) return false;
      const rootTarget = /(^|[\s'"])([A-Za-z]:\\?)([\s'"]|$)/.test(text)      // C:\  or  C:
        || /(^|[\s'"])\/([\s'"]|$)/.test(text)                                  // bare /
        || /\$env:SystemRoot|%SystemRoot%|%SystemDrive%/i.test(text)
        || /[A-Za-z]:\\(Windows|Users|Program Files)([\s'"\\]|$)/i.test(text)
        || /(^|[\s'"])(~|\/home|\/etc|\/usr|\/var|\/boot)([\s'"\/]|$)/.test(text);
      return recursiveDelete && rootTarget;
    }, why: 'recursive delete targeting a drive root or system directory' },
  { re: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i,     why: 'reboots or shuts down the machine' },
  { re: /\bbcdedit\b/i,                                      why: 'changes boot configuration' },
  { re: /\bClear-Disk\b/i,                                   why: 'erases a disk' },
];

export function irreversibleReason(name, args) {
  const a = args || {};
  const parts = [a.command, a.content, ...(Array.isArray(a.steps) ? a.steps : [])];

  // A click is not a shell command, so it never shows up in `parts` above -- but clicking
  // a purchase/checkout control is exactly as irreversible as anything else in this list
  // once it fires (money moves). Checked here on name rather than folded into IRREVERSIBLE,
  // because the target text lives in args.selector/args.text, not
  // args.command/content/steps -- see PURCHASE_LIKE's comment above.
  if (name === 'browser_click') {
    const target = [a.selector, a.text].filter(Boolean).join(' ');
    if (PURCHASE_LIKE.test(target)) return 'clicks a purchase/checkout control ("' + target.slice(0, 60) + '")';
  }

  // apply_fix and fix_issues name a stored fix by id -- the commands live in the fix store
  // or the library, never in the arguments. Reading only the arguments made this gate
  // return null for exactly the two tools whose purpose is running remediation commands,
  // so a stored fix containing "format C:" was auto-approved under AUTO_APPROVE.
  // previewCall already resolves ids synchronously through requireSyncFixes(); the gate
  // just was not using it.
  if (name === 'apply_fix' || name === 'fix_issues') {
    if (a.dry_run) return null;                       // nothing executes on a dry run
    const ids = [a.id, ...(Array.isArray(a.ids) ? a.ids : [])].filter(Boolean);
    for (const id of ids) {
      try {
        const fx = requireSyncFixes().getFix(String(id));
        if (fx && Array.isArray(fx.steps)) parts.push(...fx.steps);
      } catch { /* unresolvable id -- runTool will report it */ }
    }
  }

  const text = parts.filter(Boolean).join('\n');
  if (!text) return null;
  for (const r of IRREVERSIBLE) {
    try {
      if (r.fn ? r.fn(text) : r.re.test(text)) return r.why;
    } catch { /* a broken rule must not make everything look safe */ }
  }
  return null;
}

export function classifyRisk(name, args, machineProfile) {
  const safe = new Set([
    'read_file', 'list_dir', 'fetch_url', 'web_search', 'memory', 'recall',
    'clarify', 'todo', 'notify', 'open', 'clipboard_read',
    'machine_info', 'boot_triage', 'threat_assess', 'network_scan',
    'generate_report', 'audit_replay', 'machine_diff', 'machine_health_trend',
    'workspace_read',
    'diff_machine_state',
  ]);
  if (safe.has(name)) return { tier: 0, reason: 'read-only or informational' };

  // spawn_agent creates an agent that runs tools of its own. It was tier 0 ("read-only
  // or informational"), which made it a complete bypass of this entire function.
  if (name === 'spawn_agent')
    return { tier: 2, reason: 'spawns a background agent that will run tools' };

  // Writing a skill writes instructions that later load as trusted context. That is a
  // durable change to behaviour, not an informational call.
  if (name === 'save_skill' || name === 'update_skill')
    return { tier: 1, reason: 'writes skill instructions that later load as trusted' };

  // Reading what this machine has learned is informational.
  if (name === 'machine_fixes') return { tier: 0, reason: 'lists machine-specific fixes' };

  // Recording a fix writes a durable instruction that a later session may execute.
  if (name === 'learn_fix') return { tier: 1, reason: 'records a machine-specific remediation for future sessions' };

  // Applying one runs real commands on this machine.
  if (name === 'fix_issues')
    return (args && args.dry_run)
      ? { tier: 0, reason: 'dry run -- shows what would be applied' }
      : { tier: 2, reason: 'applies ' + ((args && args.ids || []).length) + ' remediation(s) to this machine' };

  if (name === 'apply_fix')
    return (args && args.dry_run)
      ? { tier: 0, reason: 'dry run -- shows the steps without running them' }
      : { tier: 2, reason: 'runs a stored remediation against this machine' };

  if (name === 'skill_rollback')
    return args && args.list_versions
      ? { tier: 0, reason: 'listing skill versions' }
      : { tier: 1, reason: 'overwrites current skill with a prior version' };

  // load_skill: verified skills are Tier 0; unverified (auto-crystallized) are Tier 1
  // so chain-loading an unverified skill from inside a verified one gets logged
  if (name === 'load_skill') {
    const status = getSkillStatus(args && args.name);
    if (status === 'unverified') return { tier: 2, reason: 'loading unverified crystallized skill -- approve to verify' };
    return { tier: 0, reason: 'loading verified skill' };
  }

  if (name === 'remediate' && args && args.execute === true)
    return { tier: 2, reason: 'remediation with execute:true applies system changes' };

  if (name === 'remediate')
    return { tier: 1, reason: 'remediation plan lookup -- no execution' };

  if (name === 'run_shell') {
    // Allowlist, not denylist. A denylist can never be complete: the old one caught
    // `rm -rf` but not `Remove-Item -Recurse -Force`, so the Windows way of wiping a
    // tree scored tier 1 and -- because tier 1 is auto-approved -- ran with no prompt.
    // Inverting it makes the failure mode "asked about something harmless" instead of
    // "silently ran something destructive".
    //
    // The allowlist must be applied to EVERY segment, not just the first token. Taking
    // `cmd.split(...)[0]` meant "ls && Remove-Item D:\ATHENA\data -Recurse -Force" was
    // labelled "read-only shell command", because the classifier never looked past "ls".
    // Anything chained after a safe command inherited the safe command's verdict.
    const cmd = String((args && args.command) || '').trim();
    const READ_ONLY = new Set([
      'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'findstr', 'grep', 'rg',
      'stat', 'file', 'which', 'where', 'whoami', 'hostname', 'date', 'uptime', 'df',
      'du', 'free', 'ps', 'top', 'tasklist', 'netstat', 'ipconfig', 'ifconfig', 'ip',
      'route', 'ping', 'nslookup', 'tracert', 'echo', 'uname', 'ver', 'git',
      'systemctl', 'journalctl',
    ]);
    // 'node' is gone from the list above: running a script is never a read-only act.
    //
    // git and systemctl are multiplexers -- the binary says nothing about what the call
    // does. Listing the mutating subcommands was the wrong way round for the same reason
    // the top-level list is an allowlist: `git config --global core.editor evil` is not
    // push/reset/clean/rebase/checkout/switch/merge/rm/commit, so it scored read-only.
    // Allowlist the subcommands that only report, and treat everything else as a write.
    const SUB_READ_ONLY = {
      git: new Set(['status', 'log', 'diff', 'show', 'describe', 'rev-parse', 'ls-files',
                    'ls-remote', 'blame', 'shortlog', 'whatchanged', 'cat-file',
                    'count-objects', 'grep', 'version']),
      systemctl: new Set(['status', 'list-units', 'list-unit-files', 'is-active',
                          'is-enabled', 'is-failed', 'show', 'cat']),
    };
    // Verbs that only report when called plainly but change the system with certain
    // arguments: `ip link set wlan0 down`, `route delete`, `ipconfig /release`,
    // `date -s`, `hostname newname`, `journalctl --vacuum-time`. Any of these arguments
    // makes the call a write.
    const MUTATING_ARGS = {
      ip:         /^(add|del|delete|set|flush|change|replace|append|prepend|up|down|exec|netns|monitor)$/,
      route:      /^(add|del|delete|change|flush|-f|-p)$/,
      ipconfig:   /^\/(release|release6|renew|renew6|flushdns|registerdns|setclassid|setclassid6)$/,
      date:       /^(-s|--set|\d.*)$/,
      hostname:   /^[^-]/,
      journalctl: /^--(vacuum-\w+|rotate|flush|sync|relinquish-var|setup-keys)(=.*)?$/,
    };
    const subIsRead = (verb, seg) => {
      const mut = MUTATING_ARGS[verb];
      if (mut && seg.split(/\s+/).slice(1).some(a => a && mut.test(a.toLowerCase()))) return false;
      const allowed = SUB_READ_ONLY[verb];
      if (!allowed) return true;                       // not a multiplexer
      const sub = (seg.split(/\s+/)[1] || '').toLowerCase().replace(/^--/, '');
      return allowed.has(sub);
    };

    // Split on every operator that starts a new command. Redirections and `tee` are
    // handled separately because they are writes, not new commands.
    const segments = cmd
      .split(/(?:&&|\|\||[;&|\n])+/)
      .map(s => s.trim())
      .filter(Boolean);

    if (/[>]|\btee\b/.test(cmd))
      return { tier: 2, reason: 'shell command that redirects output to a file' };

    // Command substitution runs a second command inside an allowed one: `echo $(...)`,
    // backticks, `<(...)`, and PowerShell's `(...)` / `$(...)` subexpressions. The
    // segment's verb says nothing about what runs inside, so none of it is read-only.
    if (/\$\(|`|<\(|\$\{|(^|\s)\(/.test(cmd))
      return { tier: 2, reason: 'shell command containing a sub-command' };

    for (const seg of segments) {
      const verb = seg.toLowerCase().split(/[\s(]+/).filter(Boolean)[0] || '';
      if (!READ_ONLY.has(verb) || !subIsRead(verb, seg)) {
        return segments.length > 1
          ? { tier: 2, reason: 'chained shell command; "' + seg.slice(0, 60) + '" has unreviewed side effects' }
          : { tier: 2, reason: 'shell command with unreviewed side effects' };
      }
    }
    if (!segments.length) return { tier: 2, reason: 'shell command with unreviewed side effects' };
    return { tier: 1, reason: 'read-only shell command' };
  }

  // Classify the path that will ACTUALLY be written. runTool resolves relative paths
  // against cwd, so "../../../../Windows/System32/x" reached a system path while the
  // raw string matched no system-path pattern and scored tier 1.
  const SYSTEM_PATH = /^\/(etc|usr|bin|sbin|boot|sys|proc)(\/|$)|^[a-z]:\/(windows|program files)/i;
  const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase();
  const resolved = p => {
    try { return norm(resolve(process.cwd(), String(p || ''))); }
    catch { return norm(p); }
  };
  // Both forms: the raw string catches "/etc/passwd" (which on Windows resolves to a
  // harmless-looking D:/etc/passwd), and the resolved form catches traversal like
  // "../../../../Windows/System32/x" that matches nothing in raw form.
  const hitsSystemPath = p => SYSTEM_PATH.test(norm(p)) || SYSTEM_PATH.test(resolved(p));

  if (name === 'write_file') {
    if (hitsSystemPath(args && args.path))
      return { tier: 2, reason: 'write to system path' };
    return { tier: 1, reason: 'file write -- recoverable' };
  }

  if (name === 'edit_file') {
    if (hitsSystemPath(args && args.path))
      return { tier: 2, reason: 'edit of system file' };
    return { tier: 1, reason: 'file edit -- recoverable' };
  }

  if (name === 'clipboard_write')
    return { tier: 1, reason: 'overwrites clipboard contents' };

  if (name === 'workspace_write')
    return { tier: 0, reason: 'in-memory agent workspace' };

  if (name === 'browser_click') {
    const target = [args && args.selector, args && args.text].filter(Boolean).join(' ');
    if (PURCHASE_LIKE.test(target))
      return { tier: 2, reason: 'clicks a purchase/checkout control -- confirm before this goes out' };
    return { tier: 1, reason: 'clicks an element on the page' };
  }

  return { tier: 1, reason: 'unclassified tool -- treating as low-impact' };
}

