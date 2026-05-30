// tools.mjs — tool definitions (TOOLS array) and execution (runTool)
import { readFileSync, existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { BRAVE_KEY, AUTO } from './config.mjs';
import { handleMemoryTool } from './memory.mjs';
import { loadSkill, saveSkill, updateSkill } from './skills.mjs';
import { handleRecallTool } from './embed.mjs';

const execAsync = promisify(exec);

// ---- PowerShell helper (Windows only) ----
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

// ---- Strip HTML for fetch_url ----
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Tool definitions ----
export const TOOLS = [
  { type: 'function', function: {
    name: 'run_shell',
    description: 'Execute a shell command on the host machine. Returns stdout + stderr. Use for anything that needs the OS: git, npm, pip, system commands, scripts.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    }, required: ['command'] },
  }},
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a file from disk. Returns full text content.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
    }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites). Prefer edit_file for targeted changes. For task-generated scripts, temp files, or working outputs — write to the host temp dir or home dir, NOT inside the ATHENA drive directory.',
    parameters: { type: 'object', properties: {
      path:    { type: 'string', description: 'File path.' },
      content: { type: 'string', description: 'Full file content.' },
    }, required: ['path', 'content'] },
  }},
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Replace an exact string in a file. Safer than write_file for targeted edits. old_str must be unique in the file.',
    parameters: { type: 'object', properties: {
      path:    { type: 'string' },
      old_str: { type: 'string', description: 'Exact text to find and replace.' },
      new_str: { type: 'string', description: 'Text to replace it with.' },
    }, required: ['path', 'old_str', 'new_str'] },
  }},
  { type: 'function', function: {
    name: 'list_dir',
    description: 'List files and folders in a directory.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Directory path. Defaults to cwd.' },
    }},
  }},
  { type: 'function', function: {
    name: 'fetch_url',
    description: 'Fetch a URL and return its readable text content. Strips HTML — good for reading docs, articles, GitHub pages, Stack Overflow. Does not execute JavaScript (SPAs may be empty).',
    parameters: { type: 'object', properties: {
      url: { type: 'string' },
      raw: { type: 'boolean', description: 'Return raw body without HTML stripping. Default false.' },
    }, required: ['url'] },
  }},
  { type: 'function', function: {
    name: 'web_search',
    description: 'Search the web via Brave Search. Returns titles, URLs, and snippets. Follow up with fetch_url to read a full page.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      count: { type: 'number', description: '1-10 results. Default 5.' },
    }, required: ['query'] },
  }},
  { type: 'function', function: {
    name: 'memory',
    description: 'Manage long-term memory that persists across sessions. Use "athena" target for your own operational knowledge; "user" for facts about the person you work with. Only save durable, cross-session facts — never save task progress or things easily re-discovered.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'add', 'replace', 'remove', 'search'] },
      target: { type: 'string', enum: ['athena', 'user'], description: 'Which memory file.' },
      content: { type: 'string', description: 'The fact to add/remove (required for add/remove).' },
      old:    { type: 'string', description: 'Exact text to replace (required for replace).' },
      query:  { type: 'string', description: 'Search query (required for search).' },
    }, required: ['action', 'target'] },
  }},
  { type: 'function', function: {
    name: 'clipboard_read',
    description: 'Read current clipboard text from the host machine.',
    parameters: { type: 'object', properties: {} },
  }},
  { type: 'function', function: {
    name: 'clipboard_write',
    description: 'Write text to the host clipboard.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' },
    }, required: ['text'] },
  }},
  { type: 'function', function: {
    name: 'notify',
    description: 'Send a desktop notification on the host machine.',
    parameters: { type: 'object', properties: {
      title:   { type: 'string' },
      message: { type: 'string' },
    }, required: ['title', 'message'] },
  }},
  { type: 'function', function: {
    name: 'open',
    description: 'Open a file, folder, or URL with the default app on the host.',
    parameters: { type: 'object', properties: {
      target: { type: 'string', description: 'Path or URL to open.' },
    }, required: ['target'] },
  }},
  { type: 'function', function: {
    name: 'clarify',
    description: 'Ask one sharp clarifying question before proceeding with an ambiguous task. Provide up to 4 specific choices when possible. Do NOT use for simple or obvious requests.',
    parameters: { type: 'object', properties: {
      question: { type: 'string' },
      choices:  { type: 'array', items: { type: 'string' }, description: 'Up to 4 specific options.' },
    }, required: ['question'] },
  }},
  { type: 'function', function: {
    name: 'todo',
    description: 'Manage an in-session task list for complex multi-step work. Call at start of any 3+ step task, update as you go. Omit todos param to read current list.',
    parameters: { type: 'object', properties: {
      todos: { type: 'array', items: { type: 'object' }, description: 'Full list [{id, content, status}]. Omit to read.' },
      merge: { type: 'boolean', description: 'If true, update/append rather than replace.' },
    }},
  }},
  { type: 'function', function: {
    name: 'recall',
    description: 'Semantic search over all past memory, sessions, and skills using meaning — not just keyword matching. Use when you want to surface what you know about a topic, what was done in a past session, or whether a similar problem was solved before.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'What to search for — describe it naturally.' },
      count: { type: 'number', description: 'Max results to return (1-10). Default 5.' },
      type:  { type: 'string', enum: ['memory', 'session', 'skill'], description: 'Filter by type. Omit to search all.' },
    }, required: ['query'] },
  }},
  { type: 'function', function: {
    name: 'load_skill',
    description: 'Load full instructions for a skill from the drive. The system prompt lists available skills — call this when a task matches one.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Skill folder name as shown in the skill index.' },
    }, required: ['name'] },
  }},
  { type: 'function', function: {
    name: 'save_skill',
    description: 'Save a new skill permanently to the drive. Call this when you solve something non-trivial in a repeatable way — network diagnostics, deployment steps, a fix pattern, a workflow. This is how you build your own playbook.',
    parameters: { type: 'object', properties: {
      name:        { type: 'string', description: 'Short slug name, no spaces (e.g. "network-check").' },
      description: { type: 'string', description: 'One-line description of what the skill does.' },
      content:     { type: 'string', description: 'Full skill instructions in markdown.' },
    }, required: ['name', 'description', 'content'] },
  }},
  { type: 'function', function: {
    name: 'update_skill',
    description: 'Update an existing skill with improved instructions. Use when you find a better method than what was previously saved.',
    parameters: { type: 'object', properties: {
      name:        { type: 'string', description: 'Skill name to update.' },
      description: { type: 'string', description: 'Updated one-line description.' },
      content:     { type: 'string', description: 'Updated skill instructions in markdown.' },
    }, required: ['name', 'description', 'content'] },
  }},
];

// ---- runTool ----
export async function runTool(name, args, preApproved, sessionTodos, setSessionTodos, requestUserInput) {
  const ok = preApproved || AUTO;

  // ---- shell ----
  if (name === 'run_shell') {
    if (!ok) throw new Error('not approved');
    const { stdout, stderr } = await execAsync(args.command, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    return (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '') || '(no output)';
  }

  // ---- files ----
  if (name === 'read_file')  return await readFile(args.path, 'utf8');
  if (name === 'list_dir') {
    const dir = args.path || process.cwd();
    const items = await readdir(dir);
    const out = [];
    for (const it of items) {
      try { const s = await stat(join(dir, it)); out.push(`${s.isDirectory() ? 'DIR ' : 'FILE'}  ${it}`); }
      catch { out.push(`?     ${it}`); }
    }
    return out.join('\n') || '(empty)';
  }
  if (name === 'write_file') {
    if (!ok) throw new Error('not approved');
    const target = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
    await writeFile(target, args.content);
    return `Wrote ${args.content.length} chars to ${target}`;
  }
  if (name === 'edit_file') {
    if (!ok) throw new Error('not approved');
    const target = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
    const original = await readFile(target, 'utf8');
    const count = original.split(args.old_str).length - 1;
    if (count === 0) return `edit_file: old_str not found in ${target}`;
    if (count > 1)   return `edit_file: old_str appears ${count} times — make it more unique`;
    await writeFile(target, original.replace(args.old_str, args.new_str));
    return `Edited ${target}`;
  }

  // ---- web ----
  if (name === 'fetch_url') {
    const res = await fetch(args.url, {
      headers: { 'User-Agent': 'Athena-Agent/4.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `fetch_url error: HTTP ${res.status}`;
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = (!args.raw && ct.includes('html')) ? stripHtml(body) : body;
    return text.slice(0, 8000) + (text.length > 8000 ? '\n[...truncated]' : '');
  }
  if (name === 'web_search') {
    if (!BRAVE_KEY) return 'web_search: no BRAVE_API_KEY in config/.env';
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=${count}`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_KEY }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return `web_search error: HTTP ${res.status}`;
    const data = await res.json();
    return (data.web?.results || [])
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ''}`)
      .join('\n\n') || 'No results.';
  }

  // ---- memory ----
  if (name === 'memory') return await handleMemoryTool(args);

  // ---- clipboard ----
  if (name === 'clipboard_read') {
    if (process.platform === 'win32') return runPS('Get-Clipboard');
    try { const { stdout } = await execAsync('pbpaste 2>/dev/null || xclip -o 2>/dev/null || xsel -o 2>/dev/null'); return stdout.trim() || '(empty)'; } catch { return '(clipboard unavailable)'; }
  }
  if (name === 'clipboard_write') {
    if (process.platform === 'win32') return runPS(`Set-Clipboard '${args.text.replace(/'/g, "''")}'`);
    try { const p = await import('node:child_process'); const proc = p.spawn('xclip -selection clipboard', [], { shell: true }); proc.stdin.write(args.text); proc.stdin.end(); return 'Copied.'; } catch { return '(clipboard unavailable)'; }
  }

  // ---- notify ----
  if (name === 'notify') {
    if (process.platform === 'win32') {
      await runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${args.message.replace(/'/g,"''")}','${args.title.replace(/'/g,"''")}') | Out-Null`).catch(() => {});
    } else if (process.platform === 'darwin') {
      await execAsync(`osascript -e 'display notification "${args.message}" with title "${args.title}"'`).catch(() => {});
    } else {
      await execAsync(`notify-send "${args.title}" "${args.message}"`).catch(() => {});
    }
    return `Notified: ${args.title}`;
  }

  // ---- open ----
  if (name === 'open') {
    const cmd = process.platform === 'win32' ? `start "" "${args.target}"` : process.platform === 'darwin' ? `open "${args.target}"` : `xdg-open "${args.target}"`;
    await execAsync(cmd).catch(() => {});
    return `Opened ${args.target}`;
  }

  // ---- clarify ----
  if (name === 'clarify') {
    if (!requestUserInput) return args.question;
    const choices = args.choices || [];
    return await requestUserInput(args.question, choices);
  }

  // ---- todo ----
  if (name === 'todo') {
    if (!args.todos) return JSON.stringify(sessionTodos, null, 2) || '[]';
    const updated = args.merge
      ? sessionTodos.map(t => args.todos.find(u => u.id === t.id) || t).concat(args.todos.filter(u => !sessionTodos.find(t => t.id === u.id)))
      : args.todos;
    setSessionTodos(updated);
    return JSON.stringify(updated, null, 2);
  }

  // ---- recall (semantic search) ----
  if (name === 'recall') return await handleRecallTool(args);

  // ---- skills ----
  if (name === 'load_skill')   return loadSkill(args.name);
  if (name === 'save_skill')   return await saveSkill(args.name, args.description, args.content);
  if (name === 'update_skill') return await updateSkill(args.name, args.description, args.content);

  return `Unknown tool: ${name}`;
}

export const DESTRUCTIVE = new Set(['run_shell', 'write_file', 'edit_file']);
