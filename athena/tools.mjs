// tools.mjs
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, isAbsolute, delimiter, relative, sep } from 'node:path';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { BRAVE_KEY, AUTO } from './config.mjs';
import { PATHS } from './paths.mjs';
import { handleMemoryTool, logProhibitedPattern } from './memory.mjs';
import { loadSkill, saveSkill, updateSkill, getSkillStatus, rollbackSkill, listSkillVersions } from './skills.mjs';
import { handleRecallTool } from './embed.mjs';
import { getCachedCapabilities, detectCapabilities, clearCapabilityCache } from './capabilities.mjs';
import { logAuditEvent } from './audit.mjs';
import { logError } from './telemetry.mjs';
import { getRemediationPlan } from './remediate.mjs';

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

// ---- Native filesystem search helpers (zero-dep, cross-platform) ----
const WALK_IGNORE = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.cache',
  '__pycache__', '.venv', 'venv', '.next', 'target', '.gradle', '.idea',
]);

// Iterative directory walk. Yields absolute file paths, skipping heavy dirs.
async function* walkFiles(root, maxFiles = 20000) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!WALK_IGNORE.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        yield full;
        if (++count >= maxFiles) return;
      }
    }
  }
}

// Minimal glob -> RegExp. Supports **, *, ?, and literal path separators.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

function relPosix(root, file) { return relative(root, file).split(sep).join('/'); }

export const TOOLS = [
  { type: 'function', function: { name: 'run_shell', description: 'Execute a shell command on the host machine. On Windows, wrap scripts with powershell prefix. Returns stdout + stderr.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write content to a file (creates or overwrites).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace an exact string in a file. Always call read_file first to get the exact text to replace.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files and folders in a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch a URL and return readable text. Strips HTML.', parameters: { type: 'object', properties: { url: { type: 'string' }, raw: { type: 'boolean' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web via Brave Search.', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'memory', description: 'Manage long-term memory across sessions.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read','add','replace','remove','search'] }, target: { type: 'string', enum: ['athena','user','instincts'] }, content: { type: 'string' }, old: { type: 'string' }, query: { type: 'string' } }, required: ['action','target'] } } },
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
  { type: 'function', function: { name: 'skill_rollback', description: 'Roll back a skill to a prior version. Use list_versions:true to see available versions.', parameters: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'number' }, list_versions: { type: 'boolean' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'find_files', description: 'Find files by glob pattern (e.g. "**/*.mjs", "src/*.js"). Native recursive walk, skips node_modules/.git. Returns matching paths. Far cheaper than shelling out to find.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Root dir to search (default: cwd)' }, max: { type: 'number' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep_files', description: 'Search file contents by regex across a directory tree (native, no shell, skips binaries). Returns file:line:match. Supports a glob filter and N context lines. Use this to locate code before editing.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Root dir or single file (default: cwd)' }, glob: { type: 'string', description: 'Only search files whose path matches this glob' }, context: { type: 'number', description: 'Lines of context around each match (0-5)' }, ignore_case: { type: 'boolean' }, max: { type: 'number' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'multi_edit', description: 'Apply several exact-string replacements to ONE file atomically. Each old_str must match exactly once. If any edit fails to match, nothing is written. Always read_file first.', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['old_str', 'new_str'] } } }, required: ['path', 'edits'] } } },
];

// ---- Sudo lockout safety ----
// Track failed sudo attempts per machine to avoid PAM account lockout.
function _loadSudoState() {
  try {
    if (existsSync(PATHS.sudoState)) return JSON.parse(readFileSync(PATHS.sudoState, 'utf8'));
  } catch {}
  return {};
}

async function _checkSudoLockout() {
  const s = _loadSudoState();
  const machineId = process.env.ATHENA_MACHINE_ID || 'default';
  const rec = s[machineId] || {};
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const remaining = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return { locked: true, message: `sudo locked for ${remaining} more min (3 failed attempts -- try manually)` };
  }
  return { locked: false, machineId, state: s, rec };
}

async function _recordSudoAttempt(machineId, state, success) {
  const rec = state[machineId] || { count: 0 };
  if (success) { rec.count = 0; rec.lockedUntil = null; }
  else {
    rec.count = (rec.count || 0) + 1;
    rec.lastAttempt = Date.now();
    if (rec.count >= 3) rec.lockedUntil = Date.now() + 30 * 60 * 1000; // 30 min lockout
  }
  state[machineId] = rec;
  await writeFile(PATHS.sudoState, JSON.stringify(state, null, 2)).catch(e => logError('sudoState', e));
}

export async function runTool(name, args, preApproved, sessionTodos, setSessionTodos, requestUserInput) {
  const ok = preApproved || AUTO;

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
      // Auto-retry with sudo on permission errors (Linux/Mac only -- Windows uses UAC not sudo)
      if (isPermErr(e.message) && process.platform !== 'win32' && !args.command.trimStart().startsWith('sudo ')) {
        const lock = await _checkSudoLockout();
        if (lock.locked) return lock.message;
        try {
          const result = await runCmd('sudo ' + args.command);
          await _recordSudoAttempt(lock.machineId, lock.state, true);
          return result;
        } catch (e2) {
          await _recordSudoAttempt(lock.machineId, lock.state, false);
          throw new Error(e2.message);
        }
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
  if (name === 'multi_edit') {
    if (!ok) throw new Error('not approved');
    const target = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!edits.length) return 'multi_edit: no edits provided';
    let content = await readFile(target, 'utf8');
    // Validate-and-apply in memory; only write if ALL edits succeed (atomic).
    for (let i = 0; i < edits.length; i++) {
      const { old_str, new_str } = edits[i] || {};
      if (old_str === undefined || new_str === undefined)
        return 'multi_edit: edit ' + (i + 1) + ' missing old_str/new_str -- no changes written';
      const c = content.split(old_str).length - 1;
      if (c === 0) return 'multi_edit: edit ' + (i + 1) + ' old_str not found -- no changes written: ' + String(old_str).slice(0, 60);
      if (c > 1)   return 'multi_edit: edit ' + (i + 1) + ' old_str matches ' + c + ' times -- make it unique. No changes written.';
      content = content.replace(old_str, () => new_str);
    }
    await writeFile(target, content);
    return 'multi_edit: applied ' + edits.length + ' edit(s) to ' + target;
  }

  if (name === 'find_files') {
    const root = isAbsolute(args.path || '.') ? (args.path || process.cwd()) : resolve(process.cwd(), args.path || '.');
    const rx   = globToRegExp(String(args.pattern || '*'));
    const max  = Math.min(Number(args.max) || 200, 1000);
    const matches = [];
    for await (const file of walkFiles(root)) {
      const rel  = relPosix(root, file);
      const base = file.split(/[\\/]/).pop();
      if (rx.test(rel) || rx.test(base)) {
        matches.push(file);
        if (matches.length >= max) break;
      }
    }
    if (!matches.length) return 'No files match ' + args.pattern + ' under ' + root;
    return matches.join('\n') + (matches.length >= max ? '\n[...capped at ' + max + ']' : '');
  }

  if (name === 'grep_files') {
    const root = isAbsolute(args.path || '.') ? (args.path || process.cwd()) : resolve(process.cwd(), args.path || '.');
    let rx;
    try { rx = new RegExp(args.pattern, args.ignore_case ? 'i' : ''); }
    catch (e) { return 'grep_files: invalid regex -- ' + e.message; }
    const globRx     = args.glob ? globToRegExp(args.glob) : null;
    const ctx        = Math.min(Math.max(Number(args.context) || 0, 0), 5);
    const maxMatches = Math.min(Number(args.max) || 100, 500);

    const rootStat = await stat(root).catch(() => null);
    const files = [];
    if (rootStat?.isFile()) files.push(root);
    else {
      for await (const f of walkFiles(root)) {
        if (!globRx || globRx.test(relPosix(root, f)) || globRx.test(f.split(/[\\/]/).pop())) files.push(f);
      }
    }

    const out = [];
    let total = 0;
    for (const file of files) {
      if (total >= maxMatches) break;
      let content;
      try { content = await readFile(file, 'utf8'); } catch { continue; }
      if (content.indexOf('\u0000') !== -1) continue; // skip binary
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i])) continue;
        if (ctx > 0) {
          for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++)
            out.push(file + ':' + (j + 1) + (j === i ? ':' : '-') + lines[j]);
          out.push('--');
        } else {
          out.push(file + ':' + (i + 1) + ':' + lines[i]);
        }
        if (++total >= maxMatches) break;
      }
    }
    if (!out.length) return 'No matches for /' + args.pattern + '/ under ' + root;
    return out.join('\n') + (total >= maxMatches ? '\n[...capped at ' + maxMatches + ' matches]' : '');
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

  if (name === 'machine_health_trend') {
    const { machineTrend } = await import('./machines.mjs');
    const trend = machineTrend();
    return trend.error || trend.summary;
  }

  if (name === 'remediate') {
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
    const isPermErr = msg => /permission denied|need.*root|must be.*root|you need to be root|EACCES|Operation not permitted/i.test(msg);
    const results = [];
    for (const step of plan.steps) {
      let ran = step;
      try {
        const { stdout, stderr } = await execAsync(step, { timeout: 60000 });
        results.push(`✓ ${ran}\n  ${((stdout || stderr || '').trim()).slice(0, 200)}`);
      } catch (e) {
        // If permission error and not already using sudo, retry with sudo (Linux/Mac only)
        if (isPermErr(e.message) && process.platform !== 'win32' && !step.trimStart().startsWith('sudo ')) {
          ran = 'sudo ' + step;
          try {
            const { stdout, stderr } = await execAsync(ran, { timeout: 60000 });
            results.push(`✓ ${ran}\n  ${((stdout || stderr || '').trim()).slice(0, 200)}`);
            continue;
          } catch (e2) {
            results.push(`✗ ${ran}\n  ${e2.message.slice(0, 200)}\n  [needs manual: run with elevated privileges]`);
            continue;
          }
        }
        results.push(`✗ ${ran}\n  ${e.message.slice(0, 200)}`);
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

  return 'Unknown tool: ' + name;
}

export function classifyRisk(name, args, machineProfile) {
  const safe = new Set([
    'read_file', 'list_dir', 'fetch_url', 'web_search', 'memory', 'recall',
    'clarify', 'todo', 'notify', 'open', 'clipboard_read',
    'machine_info', 'boot_triage', 'threat_assess', 'network_scan',
    'generate_report', 'audit_replay', 'machine_diff', 'machine_health_trend',
    'workspace_read', 'spawn_agent', 'save_skill', 'update_skill',
    'query_machine_logs', 'diff_machine_state', 'skill_rollback',
    'find_files', 'grep_files',
  ]);
  if (safe.has(name)) return { tier: 0, reason: 'read-only or informational' };

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
    const cmd = (args && args.command || '').toLowerCase();
    if (/\b(rm\s+-rf|rmdir\s+\/s|del\s+\/[sqf]|format\s+[a-z]:|(^|\s)dd\s|mkfs|fdisk|reg\s+(delete|add)|sc\s+(delete|stop|start)|shutdown|reboot)\b/.test(cmd))
      return { tier: 2, reason: 'shell command matches destructive pattern' };
    if (/\b(pip\s+install|npm\s+install|apt(-get)?\s+install|winget\s+install|choco\s+install|curl.+-o|wget.+-O|mv |move |copy |cp |xcopy|set-content|out-file|new-item)\b/.test(cmd))
      return { tier: 1, reason: 'shell command installs or writes files' };
    return { tier: 1, reason: 'shell command with unknown side effects' };
  }

  if (name === 'write_file') {
    const path = (args && args.path || '').replace(/\\/g, '/').toLowerCase();
    if (/^\/(etc|usr|bin|sbin|boot|sys|proc)|^[a-z]:\/windows/i.test(path))
      return { tier: 2, reason: 'write to system path' };
    return { tier: 1, reason: 'file write -- recoverable' };
  }

  if (name === 'edit_file' || name === 'multi_edit') {
    const path = (args && args.path || '').replace(/\\/g, '/').toLowerCase();
    if (/^\/(etc|usr|bin|sbin|boot)|^[a-z]:\/windows/i.test(path))
      return { tier: 2, reason: 'edit of system file' };
    return { tier: 1, reason: 'file edit -- recoverable' };
  }

  if (name === 'clipboard_write')
    return { tier: 1, reason: 'overwrites clipboard contents' };

  if (name === 'workspace_write')
    return { tier: 0, reason: 'in-memory agent workspace' };

  return { tier: 1, reason: 'unclassified tool -- treating as low-impact' };
}

export const DESTRUCTIVE = new Set(['run_shell', 'write_file', 'edit_file', 'multi_edit', 'remediate']);
