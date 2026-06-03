// tools.mjs
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { BRAVE_KEY, AUTO } from './config.mjs';
import { handleMemoryTool } from './memory.mjs';
import { loadSkill, saveSkill, updateSkill } from './skills.mjs';
import { handleRecallTool } from './embed.mjs';
import { getCachedCapabilities, detectCapabilities, clearCapabilityCache } from './capabilities.mjs';

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
  { type: 'function', function: { name: 'run_shell', description: 'Execute a shell command on the host machine. Returns stdout + stderr.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write content to a file (creates or overwrites).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace an exact string in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files and folders in a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch a URL and return readable text. Strips HTML.', parameters: { type: 'object', properties: { url: { type: 'string' }, raw: { type: 'boolean' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web via Brave Search.', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'memory', description: 'Manage long-term memory across sessions.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read','add','replace','remove','search'] }, target: { type: 'string', enum: ['athena','user'] }, content: { type: 'string' }, old: { type: 'string' }, query: { type: 'string' } }, required: ['action','target'] } } },
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
];

export async function runTool(name, args, preApproved, sessionTodos, setSessionTodos, requestUserInput) {
  const ok = preApproved || AUTO;

  if (name === 'run_shell') {
    if (!ok) throw new Error('not approved');
    const { stdout, stderr } = await execAsync(args.command, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    return (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '') || '(no output)';
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
    if (count > 1)   return 'edit_file: old_str appears ' + count + ' times — make it more unique';
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
    try { const p = await import('node:child_process'); const proc = p.spawn('xclip -selection clipboard', [], { shell: true }); proc.stdin.write(args.text); proc.stdin.end(); return 'Copied.'; } catch { return '(clipboard unavailable)'; }
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

  if (name === 'load_skill')   return loadSkill(args.name);
  if (name === 'save_skill')   return await saveSkill(args.name, args.description, args.content);
  if (name === 'update_skill') return await updateSkill(args.name, args.description, args.content);

  if (name === 'machine_info') {
    if (args.rescan) clearCapabilityCache();
    const caps = getCachedCapabilities() || await detectCapabilities();
    return JSON.stringify(caps, null, 2);
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

  return 'Unknown tool: ' + name;
}

export const DESTRUCTIVE = new Set(['run_shell', 'write_file', 'edit_file']);
