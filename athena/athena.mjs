#!/usr/bin/env node
// ATHENA — portable AI agent. Lives on a drive, runs on any machine.
// Phase 3: browser UI (--ui flag), SQLite memory with FTS5 recall.
// Zero npm dependencies — only Node built-ins.

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { readFile, readdir, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as readline from 'node:readline/promises';
import process from 'node:process';

const execAsync = promisify(exec);

// ---- Paths ----
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PATHS = {
  env:     join(ROOT, 'config', '.env'),
  memDir:  join(ROOT, 'data', 'memory'),
  agentMem: join(ROOT, 'data', 'memory', 'athena.md'),   // env facts, tool quirks, conventions
  userMem:  join(ROOT, 'data', 'memory', 'user.md'),      // who the user is, preferences, habits
  summary:  join(ROOT, 'data', 'memory', 'summary.md'),
  db:       join(ROOT, 'data', 'memory', 'athena.db'),
  sessDir:  join(ROOT, 'data', 'sessions'),
  skills:   join(ROOT, 'skills'),
};

const MEM_CHAR_LIMIT = 2200;

// ---- Session state (in-memory, per session) ----
let SESSION_TODOS = [];
let _requestUserInput = null; // set by CLI or UI runner, used by clarify tool

// ---- Context compression settings ----
const COMPRESS_AT      = 40; // compress when messages exceed this
const COMPRESS_KEEP_START = 4;  // protect first N messages
const COMPRESS_KEEP_END   = 10; // protect last N messages
mkdirSync(PATHS.sessDir, { recursive: true });
mkdirSync(PATHS.memDir,  { recursive: true });
mkdirSync(PATHS.skills,  { recursive: true });

// ---- Env loader ----
function loadEnv(path) {
  const cfg = {};
  if (!existsSync(path)) return cfg;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return cfg;
}

const CFG       = loadEnv(PATHS.env);
const API_KEY   = CFG.OPENAI_API_KEY  || process.env.OPENAI_API_KEY;
const MODEL     = CFG.OPENAI_MODEL    || 'gpt-4o';
const BASE      = CFG.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const AUTO      = (CFG.AUTO_APPROVE   || 'false').toLowerCase() === 'true';
const NAME      = CFG.AGENT_NAME      || 'Athena';
const BRAVE_KEY   = CFG.BRAVE_API_KEY  || process.env.BRAVE_API_KEY  || '';
const NVIDIA_KEY  = CFG.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY || '';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

let ACTIVE_MODEL = MODEL;

const CURATED_MODELS = [
  'gpt-5.5',                              // OpenAI — latest flagship
  'gpt-5.4-mini',                         // OpenAI — fast + lightweight
  'nvidia/nemotron-3-super-120b-a12b',    // NVIDIA — 120B, largest confirmed working
  'deepseek-ai/deepseek-v4-pro',          // NVIDIA — DeepSeek V4 Pro
  'meta/llama-3.3-70b-instruct',          // NVIDIA — Llama 3.3 70B
];

const NVIDIA_MODEL_SET = new Set([
  'nvidia/nemotron-3-super-120b-a12b',
  'deepseek-ai/deepseek-v4-pro',
  'meta/llama-3.3-70b-instruct',
]);

function resolveProvider() {
  if (NVIDIA_MODEL_SET.has(ACTIVE_MODEL)) return { base: NVIDIA_BASE, key: NVIDIA_KEY };
  return { base: BASE, key: API_KEY };
}

// ---- Skills — scan the skills/ folder for SKILL.md files ----
const PLATFORM_ID = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split('\n')) {
    const arr = line.match(/^(\w+):\s*\[(.+)\]$/);
    if (arr) { meta[arr[1]] = arr[2].split(',').map(s => s.trim()); continue; }
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

let _skillsCache = null;
function scanSkills() {
  if (_skillsCache) return _skillsCache;
  if (!existsSync(PATHS.skills)) return (_skillsCache = []);
  try {
    _skillsCache = readdirSync(PATHS.skills)
      .filter(f => statSync(join(PATHS.skills, f)).isDirectory())
      .map(dir => {
        const file = join(PATHS.skills, dir, 'SKILL.md');
        if (!existsSync(file)) return null;
        const src  = readFileSync(file, 'utf8');
        const meta = parseFrontmatter(src);
        // Platform filter — skip if platforms declared and current isn't listed
        if (meta.platforms) {
          const allowed = Array.isArray(meta.platforms) ? meta.platforms : [meta.platforms];
          if (!allowed.includes(PLATFORM_ID)) return null;
        }
        return { dir, name: (meta.name || dir).trim(), desc: (meta.description || '').trim() };
      })
      .filter(Boolean);
    return _skillsCache;
  } catch { return (_skillsCache = []); }
}
const UI_MODE   = process.argv.includes('--ui');

if (!API_KEY) {
  console.error('\n  No OPENAI_API_KEY found. Copy config/.env.example to config/.env and add your key.\n');
  process.exit(1);
}

// ---- SQLite memory (node:sqlite — built into Node 22, zero deps) ----
let db = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(PATHS.db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT    NOT NULL,
      type       TEXT    NOT NULL DEFAULT 'fact',
      content    TEXT    NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, content=memories, content_rowid=id);
    CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
  `);
} catch {
  // Node < 22.5 or SQLite unavailable — memory falls back to athena.md only
}

function dbInsert(type, content) {
  if (!db) return;
  try { db.prepare('INSERT INTO memories (created_at,type,content) VALUES(?,?,?)').run(new Date().toISOString(), type, content); }
  catch {}
}

function dbSearch(query, limit = 10) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT m.created_at, m.type, m.content
      FROM memories m JOIN memories_fts fts ON m.id = fts.rowid
      WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(query, limit);
  } catch { return []; }
}

function dbAll(limit = 30) {
  if (!db) return [];
  try { return db.prepare('SELECT created_at,type,content FROM memories ORDER BY id DESC LIMIT ?').all(limit); }
  catch { return []; }
}

// ---- Tools ----
const TOOLS = [
  { type: 'function', function: {
    name: 'run_shell',
    description: 'Run a shell command on THIS computer and return stdout/stderr.',
    parameters: { type: 'object', properties: {
      command: { type: 'string' },
      reason:  { type: 'string', description: 'One line: why.' },
    }, required: ['command'] },
  }},
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a text file on this machine.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'write_file',
    description: 'Create or overwrite a text file. Prefer edit_file for targeted changes.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' },
    }, required: ['path', 'content'] },
  }},
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Targeted replacement in a file: find old_str (must appear exactly once) and replace with new_str.',
    parameters: { type: 'object', properties: {
      path:    { type: 'string' },
      old_str: { type: 'string' },
      new_str: { type: 'string' },
    }, required: ['path', 'old_str', 'new_str'] },
  }},
  { type: 'function', function: {
    name: 'list_dir',
    description: 'List a directory on this machine.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'fetch_url',
    description: 'Fetch a URL, strip HTML, return text (max 8000 chars).',
    parameters: { type: 'object', properties: {
      url: { type: 'string' },
      raw: { type: 'boolean' },
    }, required: ['url'] },
  }},
  { type: 'function', function: {
    name: 'web_search',
    description: 'Search the web via Brave Search. Use for current events, docs, prices, news.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      count: { type: 'number', description: '1-10, default 5' },
    }, required: ['query'] },
  }},
  { type: 'function', function: {
    name: 'memory',
    description: `Manage persistent memory that survives across sessions. Loaded fresh each session — keep entries compact and high-signal only.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says "remember this" / "don't do that again"
- User shares a preference, habit, or personal detail (name, role, communication style)
- You discover environment facts (OS, installed tools, project layout)
- You learn a workflow convention or quirk specific to this setup
- A fact that will save the user from repeating themselves next session

DO NOT SAVE: task progress, session outcomes, things you just did, temp state, trivia from the conversation, things easily re-discovered.

TWO TARGETS:
- "user": who the user is — name, role, preferences, pet peeves, communication style
- "memory": your notes — env facts, project conventions, tool quirks, lessons learned

ACTIONS: add (new entry) · replace (update existing, old_text identifies it) · remove (delete, old_text identifies it) · read (show current contents)`,
    parameters: { type: 'object', properties: {
      action:   { type: 'string', enum: ['add', 'replace', 'remove', 'read'], description: 'What to do.' },
      target:   { type: 'string', enum: ['memory', 'user'], description: '"memory" for env/agent notes, "user" for user profile.' },
      content:  { type: 'string', description: 'The entry text. Required for add and replace.' },
      old_text: { type: 'string', description: 'Short unique substring identifying the entry to replace or remove.' },
    }, required: ['action', 'target'] },
  }},
  { type: 'function', function: {
    name: 'recall',
    description: 'Search long-term memory for something specific. ONLY call when the user explicitly asks to look up something from a past session. Never call for things already in the current context.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }},
  { type: 'function', function: {
    name: 'clipboard_read',
    description: 'Read the system clipboard.',
    parameters: { type: 'object', properties: {} },
  }},
  { type: 'function', function: {
    name: 'clipboard_write',
    description: 'Write text to the system clipboard.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }},
  { type: 'function', function: {
    name: 'notify',
    description: 'Send a desktop notification.',
    parameters: { type: 'object', properties: {
      title: { type: 'string' }, message: { type: 'string' },
    }, required: ['title', 'message'] },
  }},
  { type: 'function', function: {
    name: 'open',
    description: 'Open a file or URL in the default application.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  }},
  // ---- Windows-only tools (only registered on win32) ----
  ...(process.platform === 'win32' ? [
    { type: 'function', function: {
      name: 'win_volume',
      description: 'Control system volume. Action: up, down, mute, or set (requires level 0-100).',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['up', 'down', 'mute', 'set'] },
        level:  { type: 'number', description: '0-100, only used when action is "set".' },
      }, required: ['action'] },
    }},
    { type: 'function', function: {
      name: 'win_media',
      description: 'Control media playback. Works with Spotify, YouTube, VLC, anything using media keys.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'stop'] },
      }, required: ['action'] },
    }},
    { type: 'function', function: {
      name: 'win_screenshot',
      description: 'Take a screenshot of the screen and save it to Pictures.',
      parameters: { type: 'object', properties: {} },
    }},
    { type: 'function', function: {
      name: 'win_ocr',
      description: 'Read all visible text on screen using OCR. Requires Tesseract to be installed.',
      parameters: { type: 'object', properties: {} },
    }},
    { type: 'function', function: {
      name: 'win_app_open',
      description: 'Open an application by name.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'App name, e.g. "chrome", "notepad", "spotify".' },
      }, required: ['name'] },
    }},
    { type: 'function', function: {
      name: 'win_app_close',
      description: 'Close a running application by name.',
      parameters: { type: 'object', properties: {
        name: { type: 'string' },
      }, required: ['name'] },
    }},
    { type: 'function', function: {
      name: 'win_app_list',
      description: 'List all running applications that have a visible window.',
      parameters: { type: 'object', properties: {} },
    }},
    { type: 'function', function: {
      name: 'win_app_switch',
      description: 'Bring an application window to the foreground.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Part of the app name or window title.' },
      }, required: ['name'] },
    }},
  ] : []),
  { type: 'function', function: {
    name: 'clarify',
    description: 'Ask the user a clarifying question before proceeding with an ambiguous task. Use when requirements are unclear and a wrong assumption would waste effort. Provide up to 4 specific choices when possible — open-ended only when choices can\'t cover it. Do NOT clarify simple or obvious requests.',
    parameters: { type: 'object', properties: {
      question: { type: 'string', description: 'The clarifying question.' },
      choices:  { type: 'array', items: { type: 'string' }, description: 'Up to 4 specific options. Omit for open-ended.' },
    }, required: ['question'] },
  }},
  { type: 'function', function: {
    name: 'todo',
    description: 'Manage an in-session task list for complex multi-step work. Call at the start of any task with 3+ steps, update status as you go, and mark done when complete. Omit `todos` param to read current list. Items: {id, content, status} where status is pending | in_progress | completed | cancelled.',
    parameters: { type: 'object', properties: {
      todos: { type: 'array', items: { type: 'object' }, description: 'Full list of todo items to set. Omit to read.' },
      merge: { type: 'boolean', description: 'If true, update/append rather than replace. Default false.' },
    } },
  }},
  { type: 'function', function: {
    name: 'load_skill',
    description: 'Load the full instructions for a skill from the skills library. The system prompt lists available skills with one-line descriptions — call this when a task matches a skill and you need the full workflow.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'The skill folder name (as shown in the skill index).' },
    }, required: ['name'] },
  }},
];

// ---- PowerShell helper (Windows only) ----
// Uses -EncodedCommand so multi-line scripts with quotes/braces work cleanly.
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

// ---- Strip HTML ----
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Tool execution ----
async function runTool(name, args, preApproved = false) {
  const ok = preApproved || AUTO;
  try {
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
      if (count === 0) return `edit_file error: old_str not found in ${target}`;
      if (count > 1)   return `edit_file error: old_str appears ${count} times — make it more unique`;
      await writeFile(target, original.replace(args.old_str, () => args.new_str));
      return `Edited ${target}`;
    }

    // ---- web ----
    if (name === 'fetch_url') {
      const res = await fetch(args.url, {
        headers: { 'User-Agent': 'Athena-Agent/3.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `fetch_url error: HTTP ${res.status}`;
      const ct = res.headers.get('content-type') || '';
      const body = await res.text();
      const text = (!args.raw && ct.includes('html')) ? stripHtml(body) : body;
      return text.slice(0, 8000) + (text.length > 8000 ? `\n[...truncated]` : '');
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
    if (name === 'memory') {
      const file  = args.target === 'user' ? PATHS.userMem : PATHS.agentMem;
      const DELIM = '\n§\n';

      const readEntries = () => {
        if (!existsSync(file)) return [];
        const raw = readFileSync(file, 'utf8').trim();
        return raw ? raw.split(DELIM).map(e => e.trim()).filter(Boolean) : [];
      };
      const writeEntries = async (entries) => {
        await writeFile(file, entries.join(DELIM));
      };
      const usage = (entries) => {
        const chars = entries.join(DELIM).length;
        const pct   = Math.min(100, Math.round(chars / MEM_CHAR_LIMIT * 100));
        return `${pct}% — ${chars}/${MEM_CHAR_LIMIT} chars`;
      };

      if (args.action === 'read') {
        const entries = readEntries();
        return entries.length
          ? `[${args.target}] ${usage(entries)}\n\n${entries.map((e, i) => `${i + 1}. ${e}`).join('\n\n')}`
          : `[${args.target}] empty`;
      }

      if (args.action === 'add') {
        if (!args.content?.trim()) return 'content is required for add.';
        const entries = readEntries();
        if (entries.includes(args.content.trim())) return 'Entry already exists — not duplicated.';
        const next = [...entries, args.content.trim()];
        const chars = next.join(DELIM).length;
        if (chars > MEM_CHAR_LIMIT)
          return `Memory full (${chars}/${MEM_CHAR_LIMIT} chars). Replace or remove an entry first.`;
        await writeEntries(next);
        dbInsert(args.target, args.content.trim());
        return `Added to [${args.target}]. ${usage(next)}`;
      }

      if (args.action === 'replace') {
        if (!args.old_text?.trim()) return 'old_text is required for replace.';
        if (!args.content?.trim()) return 'content is required for replace.';
        const entries = readEntries();
        const idx = entries.findIndex(e => e.includes(args.old_text.trim()));
        if (idx === -1) return `No entry matched "${args.old_text}".`;
        const next = [...entries];
        next[idx] = args.content.trim();
        const chars = next.join(DELIM).length;
        if (chars > MEM_CHAR_LIMIT)
          return `Memory full (${chars}/${MEM_CHAR_LIMIT} chars). Remove an entry first.`;
        await writeEntries(next);
        return `Replaced in [${args.target}]. ${usage(next)}`;
      }

      if (args.action === 'remove') {
        if (!args.old_text?.trim()) return 'old_text is required for remove.';
        const entries = readEntries();
        const idx = entries.findIndex(e => e.includes(args.old_text.trim()));
        if (idx === -1) return `No entry matched "${args.old_text}".`;
        entries.splice(idx, 1);
        await writeEntries(entries);
        return `Removed from [${args.target}]. ${usage(entries)}`;
      }

      return 'Unknown action.';
    }
    if (name === 'recall') {
      const rows = dbSearch(args.query);
      if (!rows.length) {
        const agentMem = existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '';
        const userMem  = existsSync(PATHS.userMem)  ? readFileSync(PATHS.userMem,  'utf8') : '';
        const all = [agentMem, userMem].filter(Boolean).join('\n---\n');
        return all ? `No SQLite match. All memory:\n${all}` : 'No memories found.';
      }
      return rows.map(r => `[${r.type} · ${new Date(r.created_at).toLocaleDateString()}] ${r.content}`).join('\n');
    }

    // ---- system ----
    if (name === 'clipboard_read') {
      const cmd = process.platform === 'darwin' ? 'pbpaste'
                : process.platform === 'win32'  ? 'powershell -command "Get-Clipboard"'
                : 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null';
      try { const { stdout } = await execAsync(cmd, { timeout: 5000 }); return stdout || '(empty)'; }
      catch { return '(clipboard read failed — xclip/xsel may not be installed)'; }
    }
    if (name === 'clipboard_write') {
      const tmp = join(PATHS.memDir, '.clip_tmp');
      await writeFile(tmp, args.text);
      const cmd = process.platform === 'darwin' ? `cat "${tmp}" | pbcopy`
                : process.platform === 'win32'  ? `powershell -command "Get-Content '${tmp}' | Set-Clipboard"`
                : `cat "${tmp}" | xclip -selection clipboard 2>/dev/null || cat "${tmp}" | xsel --clipboard --input 2>/dev/null`;
      try { await execAsync(cmd, { timeout: 5000 }); return `Copied ${args.text.length} chars to clipboard.`; }
      catch { return '(clipboard write failed)'; }
    }
    if (name === 'notify') {
      const t = args.title.replace(/"/g, '\\"'), m = args.message.replace(/"/g, '\\"');
      const cmd = process.platform === 'darwin'
        ? `osascript -e 'display notification "${m}" with title "${t}"'`
        : process.platform === 'win32'
        ? `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${m}','${t}')"`
        : `notify-send "${t}" "${m}"`;
      try { await execAsync(cmd, { timeout: 5000 }); return 'Notification sent.'; }
      catch { return '(notify failed)'; }
    }
    if (name === 'open') {
      const cmd = process.platform === 'darwin' ? `open "${args.target}"`
                : process.platform === 'win32'  ? `start "" "${args.target}"`
                : `xdg-open "${args.target}" &`;
      try { await execAsync(cmd, { timeout: 5000 }); return `Opened: ${args.target}`; }
      catch (e) { return `(open failed: ${e.message})`; }
    }

    // ---- Windows tools ----
    if (name === 'win_volume') {
      const VK = { up: '0xAF', down: '0xAE', mute: '0xAD' };
      if (args.action === 'set') {
        const level = Math.min(100, Math.max(0, Number(args.level) || 50));
        return await runPS(`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Vol { [DllImport("winmm.dll")] public static extern int waveOutSetVolume(IntPtr h, uint v); }
'@
$v=[uint32]([Math]::Round(${level}/100.0*0xFFFF)); [Vol]::waveOutSetVolume([IntPtr]::Zero,($v -shl 16) -bor $v)
"Volume set to ${level}%"
`);
      }
      return await runPS(`
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte v,byte s,uint f,int e); public static void Press(byte v){keybd_event(v,0,0,0);keybd_event(v,0,2,0);} }
'@
[K]::Press(${VK[args.action]})
"Volume ${args.action}"
`);
    }

    if (name === 'win_media') {
      const VK = { play_pause: '0xB3', next: '0xB0', previous: '0xB1', stop: '0xB2' };
      return await runPS(`
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte v,byte s,uint f,int e); public static void Press(byte v){keybd_event(v,0,0,0);keybd_event(v,0,2,0);} }
'@
[K]::Press(${VK[args.action]})
"Media: ${args.action}"
`);
    }

    if (name === 'win_screenshot') {
      return await runPS(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height)
$g=[System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size)
$p="$env:USERPROFILE\\Pictures\\athena_$(Get-Date -f 'yyyyMMdd_HHmmss').png"
New-Item -ItemType Directory -Path "$env:USERPROFILE\\Pictures" -Force | Out-Null
$b.Save($p); $g.Dispose(); $b.Dispose()
"Screenshot saved to $p"
`);
    }

    if (name === 'win_ocr') {
      return await runPS(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$b=New-Object System.Drawing.Bitmap($s.Width,$s.Height)
$g=[System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size)
$tmp=[System.IO.Path]::GetTempFileName()+".png"
$b.Save($tmp); $g.Dispose(); $b.Dispose()
$tess=@("C:\\Program Files\\Tesseract-OCR\\tesseract.exe","C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe") | Where-Object {Test-Path $_} | Select-Object -First 1
if($tess){ $out=[System.IO.Path]::GetTempFileName(); & $tess $tmp $out -l eng 2>$null; $text=Get-Content "$out.txt" -Raw -ErrorAction SilentlyContinue; Remove-Item $tmp,"$out.txt" -ErrorAction SilentlyContinue; $text }
else { Remove-Item $tmp -ErrorAction SilentlyContinue; "Tesseract not found. Install from https://github.com/UB-Mannheim/tesseract/wiki" }
`);
    }

    if (name === 'win_app_open') {
      const safeName = args.name.replace(/[^a-zA-Z0-9 \-_.]/g, '').slice(0, 100);
      return await runPS(`
try { Start-Process "${safeName}"; "Opened ${safeName}" }
catch {
  $found=@("$env:ProgramFiles","$env:ProgramFiles(x86)","$env:LOCALAPPDATA\\Programs") |
    ForEach-Object { Get-ChildItem -Path $_ -Filter "*${safeName}*.exe" -Recurse -ErrorAction SilentlyContinue } |
    Select-Object -First 1
  if($found){ Start-Process $found.FullName; "Opened $($found.FullName)" } else { "Could not find ${safeName}" }
}
`);
    }

    if (name === 'win_app_close') {
      const safeName = args.name.replace(/[^a-zA-Z0-9 \-_.]/g, '').slice(0, 100);
      return await runPS(`
$p=Get-Process|Where-Object{$_.ProcessName -like "*${safeName}*" -or $_.MainWindowTitle -like "*${safeName}*"}
if($p){ $p|Stop-Process -Force; "Closed $($p.Count) process(es)" } else { "No matching process found for '${safeName}'" }
`);
    }

    if (name === 'win_app_list') {
      return await runPS(`
Get-Process|Where-Object{$_.MainWindowTitle}|Sort-Object ProcessName|Select-Object @{N='Process';E={$_.ProcessName}},@{N='Window Title';E={$_.MainWindowTitle}},@{N='PID';E={$_.Id}}|Format-Table -AutoSize|Out-String
`);
    }

    if (name === 'win_app_switch') {
      const safeName = args.name.replace(/[^a-zA-Z0-9 \-_.]/g, '').slice(0, 100);
      return await runPS(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }
'@
$p=Get-Process|Where-Object{$_.MainWindowTitle -like "*${safeName}*"}|Select-Object -First 1
if($p){ [W]::ShowWindow($p.MainWindowHandle,9); [W]::SetForegroundWindow($p.MainWindowHandle); "Switched to: $($p.MainWindowTitle)" } else { "No window matching '${safeName}' found" }
`);
    }

    if (name === 'clarify') {
      if (!_requestUserInput) return 'clarify not available in this mode.';
      const choices = (args.choices || []).slice(0, 4);
      const answer  = await _requestUserInput(args.question, choices);
      return answer || '(no answer)';
    }

    if (name === 'todo') {
      if (args.todos) {
        if (args.merge) {
          const map = new Map(SESSION_TODOS.map(t => [t.id, t]));
          for (const t of args.todos) map.set(t.id, { ...map.get(t.id) || {}, ...t });
          SESSION_TODOS = [...map.values()];
        } else {
          SESSION_TODOS = args.todos.map(t => ({
            id: String(t.id || Math.random().toString(36).slice(2)),
            content: String(t.content || ''),
            status: ['pending','in_progress','completed','cancelled'].includes(t.status) ? t.status : 'pending',
          }));
        }
      }
      // Broadcast to UI
      if (UI_MODE) broadcast({ type: 'todos', items: SESSION_TODOS });
      const lines = SESSION_TODOS.map(t => {
        const icon = { pending:'○', in_progress:'▶', completed:'✓', cancelled:'✗' }[t.status] || '○';
        return `${icon} [${t.id}] ${t.content} (${t.status})`;
      }).join('\n');
      return lines || '(no todos)';
    }

    if (name === 'load_skill') {
      const file = join(PATHS.skills, args.name, 'SKILL.md');
      if (!existsSync(file)) return `Skill "${args.name}" not found. Available: ${scanSkills().map(s => s.dir).join(', ') || 'none'}`;
      return readFileSync(file, 'utf8');
    }

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Tool error: ${e.message}`;
  }
}

// ---- Non-streaming (summarization only) ----
async function chat(messages) {
  const { base, key } = resolveProvider();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: ACTIVE_MODEL, messages }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message;
}

// ---- Streaming (all interactive turns) ----
// Tries with tools first; if the model rejects them (some NVIDIA models), retries without.
async function* chatStream(messages) {
  const { base, key } = resolveProvider();

  async function doFetch(withTools) {
    const body = { model: ACTIVE_MODEL, messages, stream: true };
    if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
    return fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  }

  let res = await doFetch(true);
  if (!res.ok) {
    const errText = await res.text();
    // Retry without tools if that's the issue (many NVIDIA models don't support them)
    if (res.status === 400 || /tool|function/i.test(errText)) {
      res = await doFetch(false);
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    } else {
      throw new Error(`API ${res.status}: ${errText}`);
    }
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try { yield JSON.parse(raw); } catch {}
    }
  }
}

// ---- System prompt ----
const DELIM = '\n§\n';
function loadMemBlock(file, label) {
  if (!existsSync(file)) return '';
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return '';
  const entries = raw.split(DELIM).map(e => e.trim()).filter(Boolean);
  if (!entries.length) return '';
  const chars = entries.join(DELIM).length;
  const pct   = Math.min(100, Math.round(chars / MEM_CHAR_LIMIT * 100));
  return `--- ${label} [${pct}% — ${chars}/${MEM_CHAR_LIMIT} chars] ---\n${entries.join('\n')}`;
}

function systemPrompt() {
  const agentBlock = loadMemBlock(PATHS.agentMem, 'MEMORY (your notes)');
  const userBlock  = loadMemBlock(PATHS.userMem,  'USER (who you work with)');
  const summary    = existsSync(PATHS.summary) ? readFileSync(PATHS.summary, 'utf8').trim() : '';
  const skills     = scanSkills();
  return [
    `You are ${NAME}, a personal AI agent living on a portable drive, running on whatever machine is plugged in.`,
    `Tools: shell, file read/write/edit, web search, fetch URL, clipboard, notify, open, memory (add/replace/remove/read), recall, load_skill.`,
    `Host: ${process.platform} (${process.arch}). CWD: ${process.cwd()}.`,
    `Answer conversational questions directly — do NOT call tools for things you already know from this context.`,
    `Only call memory(action=add/replace/remove) for durable facts worth keeping across sessions. Never save session noise, task progress, or things easily re-discovered.`,
    `Be direct. Prefer edit_file over write_file. Prefer the smallest action that works.`,
    agentBlock ? `\n${agentBlock}` : '',
    userBlock  ? `\n${userBlock}`  : '',
    summary    ? `\n--- RECENT SESSIONS (last few, not permanent) ---\n${summary.split('\n').slice(-20).join('\n')}` : '',
    skills.length ? `\n--- SKILLS (call load_skill for full instructions) ---\n${skills.map(x => `${x.dir}: ${x.desc}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

// ---- Context auto-compression ----
async function maybeCompress(messages, emit) {
  if (messages.length < COMPRESS_AT) return;
  const start  = messages.slice(0, COMPRESS_KEEP_START);
  const end    = messages.slice(-COMPRESS_KEEP_END);
  const middle = messages.slice(COMPRESS_KEEP_START, -COMPRESS_KEEP_END);
  if (middle.length < 6) return;

  emit({ type: 'system', text: `Compressing ${middle.length} messages to stay within context…` });
  try {
    const sum = await chat([
      { role: 'system', content: 'Summarize this conversation excerpt in 10-15 bullet points. Be specific: include filenames, commands, values, decisions made, problems solved, current state. No preamble.' },
      { role: 'user', content: middle.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role}: ${m.content || '[tool]'}`).join('\n') },
    ]);
    const summary = { role: 'assistant', content: `[Context compressed — ${middle.length} messages → summary]\n${sum.content || ''}` };
    const todoReinject = SESSION_TODOS.length
      ? [{ role: 'user', content: `[Current task list after compression]\n${JSON.stringify(SESSION_TODOS)}` }]
      : [];
    messages.length = 0;
    messages.push(...start, summary, ...todoReinject, ...end);
    emit({ type: 'system', text: `Context compressed (${middle.length} → 1). Continuing…` });
  } catch { /* skip compression on error, keep going */ }
}

// ---- Destructive tool set (for batch approval in CLI mode) ----
const DESTRUCTIVE = new Set(['run_shell', 'write_file', 'edit_file']);

// ---- Core turn loop — streaming ----
// emit() sends events to either the CLI printer or the SSE broadcast.
async function turn(messages, emit) {
  emit({ type: 'status', text: 'thinking' });
  await maybeCompress(messages, emit);
  while (true) {
    // --- stream one API response ---
    let textContent = '';
    const toolCallMap = {}; // index → {id, name, args}
    let hasTools = false;

    for await (const chunk of chatStream(messages)) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!textContent) emit({ type: 'stream_start' }); // tell browser to open a bubble
        textContent += delta.content;
        emit({ type: 'token', content: delta.content });
      }

      if (delta.tool_calls) {
        hasTools = true;
        for (const tc of delta.tool_calls) {
          const slot = (toolCallMap[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id)                  slot.id   += tc.id;
          if (tc.function?.name)      slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
    }

    if (textContent) emit({ type: 'stream_end' });

    // Reconstruct message for history
    const msg = { role: 'assistant', content: textContent || null };
    if (hasTools) {
      msg.tool_calls = Object.values(toolCallMap).map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) { emit({ type: 'done' }); return; }

    // --- execute tool calls ---
    const calls = msg.tool_calls.map(call => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      return { call, args };
    });

    // CLI batch approval
    let batchApproved = AUTO;
    if (!AUTO && !UI_MODE) {
      const destructive = calls.filter(({ call }) => DESTRUCTIVE.has(call.function.name));
      if (destructive.length > 0) {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        const a = (await rl2.question(
          `\n  approve ${destructive.length > 1 ? `all ${destructive.length} actions` : 'this action'}? [y/N] `
        )).trim().toLowerCase();
        rl2.close();
        batchApproved = a === 'y' || a === 'yes';
      }
    }

    for (const { call, args } of calls) {
      emit({ type: 'tool_start', name: call.function.name, args });
      const result = await runTool(call.function.name, args, batchApproved);
      emit({ type: 'tool_result', name: call.function.name, args, result: String(result).slice(0, 2000) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 20000) });
    }
  }
}

// ---- /task runner ----
async function runTask(goal, messages, emit) {
  emit({ type: 'status', text: 'planning' });
  const planMsg = await chat([
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: `Task: ${goal}\n\nOutput ONLY a numbered plan (1-10 steps), one line each, action verb. No prose.` },
  ]);
  const plan = planMsg.content || '';
  emit({ type: 'message', role: 'plan', content: plan });

  if (!UI_MODE) {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const go = (await rl2.question('  run this plan? [y/N] ')).trim().toLowerCase();
    rl2.close();
    if (go !== 'y' && go !== 'yes') { emit({ type: 'message', role: 'system', content: 'Task cancelled.' }); return; }
  }

  await turn([
    ...messages,
    { role: 'user', content: `Execute now, step by step:\n\nTask: ${goal}\n\nPlan:\n${plan}` },
  ], emit);
  messages.push({ role: 'user', content: `(task completed: ${goal})` });
  messages.push({ role: 'assistant', content: 'Task completed.' });
}

// ---- Save + summarize ----
async function saveAndSummarize(messages) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(PATHS.sessDir, `${stamp}.jsonl`), messages.map(m => JSON.stringify(m)).join('\n'));
  if (!messages.filter(m => m.role === 'user').length) return;
  try {
    const sum = await chat([
      { role: 'system', content: 'Summarize this session in 3-6 bullet points. Key decisions, facts learned, unfinished tasks. No preamble.' },
      { role: 'user', content: messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role}: ${m.content || '[tool]'}`).join('\n') },
    ]);
    const text = sum.content || '';
    await appendFile(PATHS.summary, `\n## ${new Date().toLocaleString()}\n${text}\n`);
    dbInsert('summary', text);
  } catch {}
}

// ---- ANSI ----
const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim  = s => `\x1b[2m${s}\x1b[0m`;

// ---- CLI emit ----
let _cliBuf = '';
function cliEmit(ev) {
  if (ev.type === 'status')      { _cliBuf = ''; process.stdout.write(dim(`  ${ev.text}…\r`)); }
  if (ev.type === 'stream_start') { process.stdout.write(`\n${bold(NAME)}: `); _cliBuf = ''; }
  if (ev.type === 'token')        { process.stdout.write(ev.content); _cliBuf += ev.content; }
  if (ev.type === 'stream_end')   { process.stdout.write('\n\n'); _cliBuf = ''; }
  if (ev.type === 'tool_start') {
    const { name, args } = ev;
    if (name === 'run_shell')    console.log(`  ${dim('$')} ${args.command}${args.reason ? dim('  # ' + args.reason) : ''}`);
    else if (name === 'web_search')   console.log(`  ${dim('search')} ${args.query}`);
    else if (name === 'fetch_url')    console.log(`  ${dim('fetch')} ${args.url}`);
    else if (name === 'write_file')   console.log(`  ${dim('write')} ${args.path}`);
    else if (name === 'edit_file')    console.log(`  ${dim('edit')}  ${args.path}`);
    else if (name === 'memory')        console.log(`  ${dim('memory')}  [${args.action}] ${args.target}`);
    else if (name === 'recall')       console.log(`  ${dim('recall')} ${args.query}`);
    else if (name === 'notify')       console.log(`  ${dim('notify')} ${args.title}`);
    else if (name === 'open')         console.log(`  ${dim('open')} ${args.target}`);
  }
  if (ev.type === 'tool_result')  {} // silent in CLI
  if (ev.type === 'system')       console.log(dim(`\n  ${ev.text}\n`));
  if (ev.type === 'todos') {
    const lines = ev.items.filter(t => t.status !== 'cancelled').map(t => {
      const icon = { pending:'○', in_progress:'▶', completed:'✓' }[t.status] || '○';
      return dim(`  ${icon} ${t.content}`);
    }).join('\n');
    if (lines) console.log('\n' + lines);
  }
  if (ev.type === 'message' && ev.content) {
    process.stdout.write('                    \r');
    if (ev.role === 'plan') console.log(`\n${bold('Plan:')}\n${ev.content}\n`);
  }
  if (ev.type === 'done') process.stdout.write('                    \r');
}

// ====================================================================
// ---- Browser UI ----
// ====================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Athena</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--surface:#111;--surface2:#181818;--border:#222;
  --text:#e2e2e2;--dim:#555;--dim2:#888;
  --accent:#7c6af7;--accent2:#a89af9;
  --green:#34d399;--red:#f87171;--yellow:#fbbf24;--blue:#60a5fa;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'SF Mono','Fira Code','Cascadia Code',monospace;font-size:13px;line-height:1.6}
#app{display:flex;flex-direction:column;height:100vh;max-width:900px;margin:0 auto}

/* header */
#header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0}
#logo{font-size:16px;font-weight:700;letter-spacing:.05em;color:var(--accent2)}
#meta{color:var(--dim2);font-size:11px;flex:1}
#mem-btn,#clear-btn{background:none;border:1px solid var(--border);color:var(--dim2);padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;transition:all .15s}
#mem-btn:hover,#clear-btn:hover{border-color:var(--accent);color:var(--accent2)}
#model-select{background:var(--surface);border:1px solid var(--border);color:var(--dim2);padding:3px 6px;border-radius:4px;font-family:inherit;font-size:11px;cursor:pointer;outline:none;transition:border-color .15s;max-width:180px}
#model-select:hover,#model-select:focus{border-color:var(--accent);color:var(--accent2)}
#status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0;transition:background .3s}
#status-dot.thinking{background:var(--yellow);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* messages */
#messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
#messages::-webkit-scrollbar{width:4px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

.msg{display:flex;flex-direction:column;gap:4px;max-width:85%}
.msg.user{align-self:flex-end;align-items:flex-end}
.msg.assistant{align-self:flex-start}
.msg.system{align-self:center;max-width:100%}

.bubble{padding:10px 14px;border-radius:10px;white-space:pre-wrap;word-break:break-word;line-height:1.6}
.msg.user .bubble{background:var(--accent);color:#fff;border-bottom-right-radius:3px}
.msg.assistant .bubble{background:var(--surface2);border:1px solid var(--border);border-bottom-left-radius:3px}
.msg.system .bubble{background:transparent;color:var(--dim2);font-size:11px;text-align:center;border:none;padding:4px}

.label{font-size:10px;color:var(--dim);margin:0 4px}

/* tool block */
.tools-block{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;font-size:12px;align-self:flex-start;max-width:85%}
.tools-header{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;user-select:none;color:var(--dim2)}
.tools-header:hover{color:var(--text)}
.tools-header svg{flex-shrink:0;transition:transform .2s}
.tools-header.open svg{transform:rotate(90deg)}
.tools-list{padding:0 12px 10px;display:flex;flex-direction:column;gap:6px}
.tool-item{display:flex;flex-direction:column;gap:2px}
.tool-cmd{color:var(--accent2);font-family:inherit}
.tool-result{color:var(--dim2);font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto;border-left:2px solid var(--border);padding-left:8px}

/* plan block */
.plan-block{background:var(--surface);border:1px solid var(--yellow);border-radius:8px;padding:12px 14px;align-self:flex-start;max-width:85%}
.plan-label{color:var(--yellow);font-size:10px;margin-bottom:6px;letter-spacing:.08em}
.plan-content{color:var(--text);white-space:pre-wrap}

/* input */
#input-area{display:flex;gap:10px;padding:16px 20px;border-top:1px solid var(--border);flex-shrink:0}
#input{flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-family:inherit;font-size:13px;outline:none;transition:border-color .2s;resize:none;min-height:42px;max-height:160px}
#input:focus{border-color:var(--accent)}
#send{background:var(--accent);border:none;color:#fff;padding:10px 18px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;transition:opacity .2s;flex-shrink:0}
#send:hover{opacity:.85}
#send:disabled{opacity:.4;cursor:default}

/* todo strip */
#todo-strip{display:none;padding:6px 20px;border-bottom:1px solid var(--border);background:var(--surface);gap:8px;flex-wrap:wrap;align-items:center;font-size:11px}
#todo-strip.visible{display:flex}
#todo-label{color:var(--dim);margin-right:4px}
.t-item{display:flex;align-items:center;gap:5px;padding:2px 8px;border-radius:3px;background:var(--surface2);border:1px solid var(--border);color:var(--dim2)}
.t-item.in_progress{border-color:var(--yellow);color:var(--text)}
.t-item.completed{opacity:.4;text-decoration:line-through}
.t-item.cancelled{display:none}
.t-dot{width:5px;height:5px;border-radius:50%;background:var(--dim)}
.in_progress .t-dot{background:var(--yellow)}
.completed .t-dot{background:var(--green)}
/* clarify choices */
.clarify-wrap{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.clarify-btn{background:var(--surface);border:1px solid var(--accent);color:var(--accent2);padding:6px 14px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;transition:all .15s}
.clarify-btn:hover{background:var(--accent);color:#fff}
/* system messages */
.msg.sys .bubble{color:var(--dim2);font-size:11px;text-align:center;background:transparent;border:none;padding:4px}
/* memory panel */
#mem-panel{display:none;position:fixed;top:0;right:0;height:100%;width:340px;background:var(--surface);border-left:1px solid var(--border);z-index:10;flex-direction:column}
#mem-panel.open{display:flex}
#mem-panel-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
#mem-panel-header h3{font-size:13px;color:var(--accent2)}
#close-mem{background:none;border:none;color:var(--dim2);cursor:pointer;font-size:18px}
#mem-content{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.mem-item{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px}
.mem-type{font-size:10px;color:var(--dim);margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
.mem-text{color:var(--text);font-size:12px;word-break:break-word}
.mem-date{font-size:10px;color:var(--dim);margin-top:3px}
.mem-empty{color:var(--dim2);text-align:center;padding:20px;font-size:12px}
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <div id="status-dot"></div>
    <div id="logo">⬡ ${NAME}</div>
    <div id="meta"><select id="model-select" title="Switch model"><option>${MODEL}</option></select> · ${process.platform}/${process.arch}</div>
    <button id="clear-btn" onclick="clearCtx()">clear</button>
    <button id="mem-btn" onclick="openMem()">memory</button>
  </div>
  <div id="todo-strip"><span id="todo-label">tasks</span></div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" rows="1" placeholder="Message Athena… (/task goal, /mem, /forget)" onkeydown="onKey(event)" oninput="resize(this)"></textarea>
    <button id="send" onclick="sendMsg()">Send</button>
  </div>
</div>

<div id="mem-panel">
  <div id="mem-panel-header">
    <h3>Long-term memory</h3>
    <button id="close-mem" onclick="closeMem()">×</button>
  </div>
  <div id="mem-content"><div class="mem-empty">Loading…</div></div>
</div>

<script>
const messages = document.getElementById('messages');
const input    = document.getElementById('input');
const sendBtn  = document.getElementById('send');
const dot      = document.getElementById('status-dot');

let currentTools = null;
let streamBubble  = null;
let busy = false;

// ---- Model selector ----
const modelSel = document.getElementById('model-select');
async function loadModels() {
  try {
    const r = await fetch('/models');
    const { groups, active } = await r.json();
    modelSel.innerHTML = '';
    let found = false;
    for (const group of groups) {
      const grp = document.createElement('optgroup');
      grp.label = group.label;
      for (const m of group.models) {
        const opt = document.createElement('option');
        opt.value = m;
        // Shorten long NVIDIA names: "meta/llama-3.1-405b-instruct" → "llama-3.1-405b"
        opt.textContent = m.includes('/') ? m.split('/')[1].replace(/-instruct.*$/, '') : m;
        opt.title = m;
        if (m === active) { opt.selected = true; found = true; }
        grp.appendChild(opt);
      }
      modelSel.appendChild(grp);
    }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = active; opt.textContent = active; opt.selected = true;
      modelSel.prepend(opt);
    }
  } catch {}
}
modelSel.addEventListener('change', async () => {
  const model = modelSel.value;
  await fetch('/model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({model}) });
});
loadModels();

function setStatus(thinking) {
  busy = thinking;
  sendBtn.disabled = thinking;
  dot.className = thinking ? 'thinking' : '';
}

function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

function addMsg(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'user' ? 'you' : role === 'plan' ? '' : '${NAME}';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  if (role !== 'plan') div.appendChild(label);
  div.appendChild(bubble);
  messages.appendChild(div);
  scrollBottom();
  return bubble;
}

function addPlan(content) {
  const div = document.createElement('div');
  div.className = 'plan-block';
  div.innerHTML = '<div class="plan-label">PROPOSED PLAN</div><div class="plan-content"></div>';
  div.querySelector('.plan-content').textContent = content;
  messages.appendChild(div);
  scrollBottom();
}

function openToolBlock() {
  const block = document.createElement('div');
  block.className = 'tools-block';
  block.innerHTML = \`
    <div class="tools-header">
      <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="2,1 8,5 2,9" fill="currentColor"/></svg>
      <span>tools</span>
    </div>
    <div class="tools-list" style="display:none"></div>
  \`;
  block.querySelector('.tools-header').onclick = () => {
    const open = block.querySelector('.tools-list').style.display !== 'none';
    block.querySelector('.tools-list').style.display = open ? 'none' : 'flex';
    block.querySelector('.tools-header').classList.toggle('open', !open);
  };
  messages.appendChild(block);
  scrollBottom();
  return block;
}

function addToolItem(block, name, args, result) {
  const list = block.querySelector('.tools-list');
  list.style.display = 'flex';
  block.querySelector('.tools-header').classList.add('open');
  const item = document.createElement('div');
  item.className = 'tool-item';
  const cmd = document.createElement('div');
  cmd.className = 'tool-cmd';
  const icons = {run_shell:'$',web_search:'⌕',fetch_url:'↗',read_file:'📄',write_file:'✎',edit_file:'✎',memory:'◉',recall:'⌕',clipboard_read:'📋',clipboard_write:'📋',notify:'🔔',open:'↗',list_dir:'📁'};
  const icon = icons[name] || '·';
  const label = name === 'run_shell' ? args.command
              : name === 'web_search' ? args.query
              : name === 'fetch_url' ? args.url
              : name === 'memory' ? '[' + args.action + '] ' + args.target
              : name === 'recall' ? args.query
              : args.path || args.target || name;
  cmd.textContent = icon + ' ' + label;
  item.appendChild(cmd);
  if (result) {
    const res = document.createElement('div');
    res.className = 'tool-result';
    res.textContent = result;
    item.appendChild(res);
  }
  list.appendChild(item);
  scrollBottom();
  return item;
}

// SSE
const es = new EventSource('/events');
const pendingTools = {}; // name -> item element
es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'status') {
    setStatus(true);
    currentTools = null;
    streamBubble = null;
  }
  if (ev.type === 'stream_start') {
    currentTools = null;
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = '${NAME}';
    streamBubble = document.createElement('div');
    streamBubble.className = 'bubble';
    wrap.appendChild(lbl);
    wrap.appendChild(streamBubble);
    messages.appendChild(wrap);
    scrollBottom();
  }
  if (ev.type === 'token') {
    if (streamBubble) { streamBubble.textContent += ev.content; scrollBottom(); }
  }
  if (ev.type === 'stream_end') { streamBubble = null; }
  if (ev.type === 'tool_start') {
    if (!currentTools) currentTools = openToolBlock();
    pendingTools[ev.name + JSON.stringify(ev.args)] = addToolItem(currentTools, ev.name, ev.args, null);
  }
  if (ev.type === 'tool_result') {
    // update the matching pending tool item with result
    const key = Object.keys(pendingTools).find(k => k.startsWith(ev.name));
    if (key && pendingTools[key]) {
      let res = pendingTools[key].querySelector('.tool-result');
      if (!res) {
        res = document.createElement('div');
        res.className = 'tool-result';
        pendingTools[key].appendChild(res);
      }
      res.textContent = ev.result;
      delete pendingTools[key];
    }
    scrollBottom();
  }
  if (ev.type === 'message') {
    currentTools = null;
    if (ev.role === 'plan') addPlan(ev.content);
    else addMsg(ev.role || 'assistant', ev.content);
  }
  if (ev.type === 'done') {
    setStatus(false);
    currentTools = null;
  }
  if (ev.type === 'todos') {
    const strip = document.getElementById('todo-strip');
    const label = document.getElementById('todo-label');
    strip.innerHTML = '';
    strip.appendChild(label);
    const visible = ev.items.filter(t => t.status !== 'cancelled');
    strip.classList.toggle('visible', visible.length > 0);
    for (const t of ev.items) {
      if (t.status === 'cancelled') continue;
      const el = document.createElement('div');
      el.className = \`t-item \${t.status}\`;
      const dot = document.createElement('div'); dot.className = 't-dot';
      el.appendChild(dot);
      el.appendChild(document.createTextNode(t.content));
      strip.appendChild(el);
    }
  }
  if (ev.type === 'clarify') {
    currentTools = null;
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = '${NAME}';
    const bub = document.createElement('div'); bub.className = 'bubble';
    bub.textContent = ev.question;
    const choices = document.createElement('div'); choices.className = 'clarify-wrap';
    const allChoices = [...(ev.choices || []), 'Other…'];
    for (const c of allChoices) {
      const btn = document.createElement('button'); btn.className = 'clarify-btn'; btn.textContent = c;
      btn.onclick = () => {
        choices.querySelectorAll('.clarify-btn').forEach(b => b.disabled = true);
        choices.style.opacity = '.4';
        input.value = c === 'Other…' ? '' : c;
        if (c !== 'Other…') sendMsg(); else input.focus();
      };
      choices.appendChild(btn);
    }
    bub.appendChild(choices);
    wrap.appendChild(lbl); wrap.appendChild(bub);
    messages.appendChild(wrap); scrollBottom();
    setStatus(false);
  }
  if (ev.type === 'system') {
    const wrap = document.createElement('div'); wrap.className = 'msg sys';
    const bub = document.createElement('div'); bub.className = 'bubble'; bub.textContent = ev.text;
    wrap.appendChild(bub); messages.appendChild(wrap); scrollBottom();
  }
  if (ev.type === 'model_changed') {
    for (const opt of modelSel.options) opt.selected = opt.value === ev.model;
  }
  if (ev.type === 'error') {
    setStatus(false);
    addMsg('system', '⚠ ' + ev.message);
  }
};

// Send
async function sendMsg() {
  const text = input.value.trim();
  if (!text || busy) return;
  addMsg('user', text);
  input.value = '';
  resize(input);
  setStatus(true);
  currentTools = null;
  await fetch('/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}) });
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
}

function resize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function clearCtx() {
  fetch('/clear', {method:'POST'});
  messages.innerHTML = '';
  addMsg('system', 'Context cleared.');
}

async function openMem() {
  document.getElementById('mem-panel').classList.add('open');
  const r = await fetch('/memory');
  const data = await r.json();
  const el = document.getElementById('mem-content');
  if (!data.length) { el.innerHTML = '<div class="mem-empty">No memories yet.<br>Tell Athena to remember something.</div>'; return; }
  el.innerHTML = '';
  for (const m of data) {
    const item = document.createElement('div');
    item.className = 'mem-item';
    const mt = document.createElement('div'); mt.className = 'mem-type'; mt.textContent = m.type;
    const mc = document.createElement('div'); mc.className = 'mem-text'; mc.textContent = m.content;
    const md = document.createElement('div'); md.className = 'mem-date'; md.textContent = new Date(m.created_at).toLocaleDateString();
    item.appendChild(mt); item.appendChild(mc); item.appendChild(md);
    el.appendChild(item);
  }
}

function closeMem() { document.getElementById('mem-panel').classList.remove('open'); }

// Welcome
addMsg('system', '${NAME} is ready. Type a message or use /task <goal> for multi-step tasks.');
</script>
</body>
</html>`;

// ---- Find a free port ----
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

// ---- SSE helpers ----
let sseClients = new Set();
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}

function uiEmit(ev) { broadcast(ev); }

// ---- UI server mode ----
async function serveUI(messages) {
  const port = await getFreePort();

  // Chat input queue: POST /chat pushes here; main loop pops
  let inputResolve = null;
  const inputQueue = [];
  function nextInput() {
    return new Promise(res => {
      if (inputQueue.length) { res(inputQueue.shift()); return; }
      inputResolve = res;
    });
  }
  function pushInput(text) {
    if (inputResolve) { inputResolve(text); inputResolve = null; }
    else inputQueue.push(text);
  }

  const server = createServer(async (req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n'); // comment to establish connection
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.url === '/chat' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) { res.writeHead(413); res.end(); return; }
      }
      const { text } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      pushInput(text);
      return;
    }
    if (req.url === '/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        groups: [
          { label: 'OpenAI',        models: CURATED_MODELS.filter(m => !NVIDIA_MODEL_SET.has(m)) },
          { label: 'NVIDIA',        models: CURATED_MODELS.filter(m =>  NVIDIA_MODEL_SET.has(m)) },
        ],
        active: ACTIVE_MODEL,
      }));
      return;
    }
    if (req.url === '/model' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) { res.writeHead(413); res.end(); return; }
      }
      const { model } = JSON.parse(body);
      if (model) ACTIVE_MODEL = model;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: ACTIVE_MODEL }));
      broadcast({ type: 'model_changed', model: ACTIVE_MODEL });
      return;
    }
    if (req.url === '/clear' && req.method === 'POST') {
      messages.length = 0;
      messages.push({ role: 'system', content: systemPrompt() });
      res.writeHead(200); res.end();
      return;
    }
    if (req.url === '/memory' && req.method === 'GET') {
      const rows = dbAll(50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Athena UI → ${url}\n`);
    const open = process.platform === 'darwin' ? `open "${url}"`
               : process.platform === 'win32'  ? `start "" "${url}"`
               : `xdg-open "${url}" 2>/dev/null &`;
    execAsync(open).catch(() => {});
  });

  // Wire up clarify for UI mode
  _requestUserInput = async (question, choices) => {
    broadcast({ type: 'clarify', question, choices: choices || [] });
    return nextInput();
  };

  // Main UI loop
  while (true) {
    const input = await nextInput();
    if (!input) continue;

    if (input === '/forget') {
      messages.length = 0;
      messages.push({ role: 'system', content: systemPrompt() });
      broadcast({ type: 'message', role: 'system', content: 'Context cleared.' });
      broadcast({ type: 'done' });
      continue;
    }
    if (input === '/mem') {
      const longMem = existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '(empty)';
      broadcast({ type: 'message', role: 'assistant', content: longMem });
      broadcast({ type: 'done' });
      continue;
    }
    if (input.startsWith('/task ')) {
      const goal = input.slice(6).trim();
      try { await runTask(goal, messages, uiEmit); }
      catch (e) { broadcast({ type: 'error', message: e.message }); }
      continue;
    }

    messages.push({ role: 'user', content: input });
    try { await turn(messages, uiEmit); }
    catch (e) { broadcast({ type: 'error', message: e.message }); broadcast({ type: 'done' }); }
  }
}

// ====================================================================
// ---- CLI mode ----
// ====================================================================
async function runCLI() {
  console.clear();
  console.log(bold(`\n  ${NAME}`) + dim(`  ·  ${MODEL}  ·  ${process.platform}/${process.arch}`));
  console.log(dim(`  /exit  /task <goal>  /mem  /forget  /help\n`));

  const messages = [{ role: 'system', content: systemPrompt() }];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => rl.question(q);

  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    console.log('');
    await saveAndSummarize(messages);
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', close);

  // Wire up clarify for CLI mode
  _requestUserInput = async (question, choices) => {
    console.log(`\n  ${bold('?')} ${question}`);
    if (choices.length) choices.forEach((c, i) => console.log(dim(`    ${i + 1}. ${c}`)));
    const raw = await ask(dim('  answer: '));
    const num = parseInt(raw.trim());
    if (choices.length && num >= 1 && num <= choices.length) return choices[num - 1];
    return raw.trim();
  };

  while (true) {
    let input;
    try { input = (await ask(bold('you') + ': ')).trim(); } catch { await close(); break; }
    if (!input) continue;
    if (input === '/exit' || input === '/quit') { await close(); break; }
    if (input === '/help') {
      console.log(dim('\n  /task <goal>  autonomous multi-step\n  /mem          long-term memory\n  /forget       clear context\n  /exit         save + quit\n'));
      continue;
    }
    if (input === '/mem') {
      console.log('\n' + (existsSync(PATHS.agentMem) ? readFileSync(PATHS.agentMem, 'utf8') : '(empty)') + '\n');
      continue;
    }
    if (input === '/forget') {
      messages.length = 0;
      messages.push({ role: 'system', content: systemPrompt() });
      console.log(dim('  context cleared\n'));
      continue;
    }
    if (input.startsWith('/model')) {
      const m = input.slice(6).trim();
      if (!m) { console.log(dim(`  active model: ${ACTIVE_MODEL}\n`)); continue; }
      ACTIVE_MODEL = m;
      console.log(dim(`  switched to ${ACTIVE_MODEL}\n`));
      continue;
    }
    if (input.startsWith('/task ')) {
      const goal = input.slice(6).trim();
      if (!goal) { console.log(dim('  usage: /task <goal>\n')); continue; }
      try { await runTask(goal, messages, cliEmit); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
      continue;
    }
    messages.push({ role: 'user', content: input });
    try { await turn(messages, cliEmit); } catch (e) { console.log(`\n  error: ${e.message}\n`); }
  }
}

// ====================================================================
// ---- Entry point ----
// ====================================================================
if (UI_MODE) {
  const messages = [{ role: 'system', content: systemPrompt() }];
  // Save on exit
  process.on('SIGINT', async () => { await saveAndSummarize(messages); process.exit(0); });
  await serveUI(messages);
} else {
  await runCLI();
}
