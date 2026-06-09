// memory.mjs -- long-term memory read/write and session persistence
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile, appendFile, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';
import { MEM_CHAR_LIMIT } from './config.mjs';
import { chat } from './api.mjs';
import { embedAndStore, extractTags } from './embed.mjs';
import { runMemoryGC } from './memory_gc.mjs';
import { logError } from './telemetry.mjs';

// ---- Session file pruning -- keeps last 60 days, max 100 files ----
export async function pruneOldSessions() {
  try {
    const files = readdirSync(PATHS.sessDir)
      .filter(f => f.endsWith('.jsonl') && f !== '.gitkeep')
      .map(f => ({ name: f, path: join(PATHS.sessDir, f), mtime: statSync(join(PATHS.sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const KEEP_DAYS = 60;
    const MAX_FILES = 100;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

    for (let i = 0; i < files.length; i++) {
      if (i >= MAX_FILES || files[i].mtime < cutoff) {
        await unlink(files[i].path).catch(() => {});
      }
    }
  } catch { /* non-fatal */ }
}

// ---- Summary pruning -- keep last N entries ----
const MAX_SUMMARY_ENTRIES = 30;
async function pruneSummary() {
  try {
    if (!existsSync(PATHS.summary)) return;
    const raw = await readFile(PATHS.summary, 'utf8');
    // Split on entry boundaries (lines starting with "[" that look like timestamps)
    const entries = raw.split(/\n(?=\[)/).filter(e => e.trim());
    if (entries.length <= MAX_SUMMARY_ENTRIES) return;
    const kept = entries.slice(-MAX_SUMMARY_ENTRIES);
    await writeFile(PATHS.summary, kept.join('\n'));
  } catch { /* non-fatal */ }
}

const DELIM = '\n\x15\n';

// ---- Memory file helpers ----
export function readEntries(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  return raw ? raw.split(DELIM).map(e => e.trim()).filter(Boolean) : [];
}

async function writeEntries(file, entries) {
  await writeFile(file, entries.join(DELIM));
}

function usageStr(entries) {
  const chars = entries.join(DELIM).length;
  const pct   = Math.min(100, Math.round(chars / MEM_CHAR_LIMIT * 100));
  return `${pct}% -- ${chars}/${MEM_CHAR_LIMIT} chars`;
}

// ---- loadMemBlock -- used by personality.mjs for system prompt ----
export function loadMemBlock(file, label) {
  if (!existsSync(file)) return '';
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return '';
  const entries = raw.split(DELIM).map(e => e.trim()).filter(Boolean);
  if (!entries.length) return '';
  const chars = entries.join(DELIM).length;
  const pct   = Math.min(100, Math.round(chars / MEM_CHAR_LIMIT * 100));
  return `--- ${label} [${pct}% -- ${chars}/${MEM_CHAR_LIMIT} chars] ---\n${entries.join('\n')}`;
}

// ---- loadInstincts -- loads instincts block for system prompt ----
export function loadInstincts() {
  if (!existsSync(PATHS.instincts)) return '';
  const raw = readFileSync(PATHS.instincts, 'utf8').trim();
  if (!raw) return '';
  const entries = raw.split(DELIM).map(e => e.trim()).filter(Boolean);
  if (!entries.length) return '';
  return '--- INSTINCTS (atomic learned behaviors -- apply these automatically) ---\n' + entries.join('\n');
}

// ---- loadProhibited -- loaded into system prompt to prevent repeating dead ends ----
export function loadProhibited() {
  if (!existsSync(PATHS.prohibited)) return '';
  const raw = readFileSync(PATHS.prohibited, 'utf8').trim();
  if (!raw) return '';
  const entries = raw.split(DELIM).map(e => e.trim()).filter(Boolean);
  if (!entries.length) return '';
  return '--- PROHIBITED PATTERNS (dead ends -- do not retry these approaches) ---\n' + entries.join('\n');
}

// ---- logProhibitedPattern -- called when a tool chain fails repeatedly ----
export async function logProhibitedPattern(toolName, reason, env) {
  const entry = '[env:' + (env || process.platform) + '] [tool:' + toolName + '] DEAD END: ' + reason;
  const existing = readEntries(PATHS.prohibited);
  if (existing.some(e => e.includes('[tool:' + toolName + ']') && e.includes(reason.slice(0, 40)))) return;
  const newEntries = [...existing, entry];
  const total = newEntries.join(DELIM).length;
  if (total > MEM_CHAR_LIMIT) return;  // don't overflow
  await writeFile(PATHS.prohibited, newEntries.join(DELIM));
}

// ---- checkProhibited -- returns matching dead-end entry or null ----
export function checkProhibited(toolName, args) {
  if (!existsSync(PATHS.prohibited)) return null;
  const entries = readEntries(PATHS.prohibited);
  const tag = '[tool:' + toolName + ']';
  const match = entries.find(e => e.includes(tag));
  return match || null;
}

// ---- handleMemoryTool -- called by tools.mjs ----
export async function handleMemoryTool(args) {
  const file = args.target === 'instincts' ? PATHS.instincts
    : args.target === 'prohibited' ? PATHS.prohibited
    : args.target === 'user' ? PATHS.userMem : PATHS.agentMem;

  if (args.action === 'read') {
    const entries = readEntries(file);
    return entries.length
      ? `[${args.target}] ${usageStr(entries)}\n\n${entries.map((e, i) => `${i + 1}. ${e}`).join('\n\n')}`
      : `[${args.target}] empty`;
  }

  if (args.action === 'add') {
    if (!args.content?.trim()) return 'content required for add.';
    const entries = readEntries(file);
    if (entries.includes(args.content.trim())) return 'Already in memory.';
    const newEntries = [...entries, args.content.trim()];
    const total = newEntries.join(DELIM).length;
    if (total > MEM_CHAR_LIMIT) return `Memory full (${total}/${MEM_CHAR_LIMIT}). Remove something first.`;
    await writeEntries(file, newEntries);
    embedAndStore({
      text: args.content.trim(),
      type: 'memory',
      tags: [...extractTags(args.content), args.target],
    }).catch(e => logError('memory.embed.add', e));
    return `Added. ${usageStr(newEntries)}`;
  }

  if (args.action === 'replace') {
    if (!args.old?.trim() || !args.content?.trim()) return 'old and content required for replace.';
    const entries = readEntries(file);
    const idx = entries.findIndex(e => e === args.old.trim());
    if (idx === -1) return 'Entry not found -- use exact text from memory read.';
    entries[idx] = args.content.trim();
    const total = entries.join(DELIM).length;
    if (total > MEM_CHAR_LIMIT) return `Memory full after replace (${total}/${MEM_CHAR_LIMIT}). Shorten the new content.`;
    await writeEntries(file, entries);
    embedAndStore({
      text: args.content.trim(),
      type: 'memory',
      tags: [...extractTags(args.content), args.target],
    }).catch(e => logError('memory.embed.replace', e));
    return `Replaced. ${usageStr(entries)}`;
  }

  if (args.action === 'remove') {
    if (!args.content?.trim()) return 'content required for remove.';
    const entries = readEntries(file);
    const filtered = entries.filter(e => e !== args.content.trim());
    if (filtered.length === entries.length) return 'Entry not found -- use exact text from memory read.';
    await writeEntries(file, filtered);
    return `Removed. ${usageStr(filtered)}`;
  }

  if (args.action === 'search') {
    if (!args.query?.trim()) return 'query required for search.';
    const q = args.query.toLowerCase();
    const entries = readEntries(file);
    const hits = entries.filter(e => e.toLowerCase().includes(q));
    return hits.length ? hits.map((e, i) => `${i + 1}. ${e}`).join('\n\n') : 'No matches.';
  }

  return `Unknown action: ${args.action}`;
}

// ---- Cheap summarization model -- never burn expensive tokens on housekeeping ----
// Uses gpt-4o-mini (OpenAI) or claude-haiku (Anthropic) per summarizeWithCheapModel() below.

async function summarizeWithCheapModel(messages) {
  // Temporarily override active model for this call only
  const { state } = await import('./config.mjs');
  const saved = state.activeModel;
  // Pick cheapest available model
  const { API_KEY, ANTHROPIC_KEY } = await import('./config.mjs');
  if (API_KEY) state.activeModel = 'gpt-4o-mini';
  else if (ANTHROPIC_KEY) state.activeModel = 'claude-haiku-4-5-20251001';
  try {
    return await chat(messages);
  } finally {
    state.activeModel = saved;
  }
}

// ---- Session save + summarize + auto-embed on exit ----
// isAgent: true = background agent session (saved separately, never pollutes main summary.md)
export async function saveAndSummarize(messages, isAgent = false) {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1);
  const file = join(PATHS.sessDir, `${ts}.jsonl`);
  const lines = messages
    .filter(m => m.role !== 'system')
    .map(m => JSON.stringify(m))
    .join('\n');
  if (!lines.trim()) return;
  await writeFile(file, lines + '\n');

  // Agent sessions: don't pollute main summary.md, but embed the final result
  // so it's searchable via recall even after the workspace is cleared on restart.
  if (isAgent) {
    const lastMsg = [...messages].reverse().find(m => m.role === 'assistant');
    const finalText = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : lastMsg?.content?.find?.(b => b.type === 'text')?.text || '';
    if (finalText && finalText.length > 50) {
      const agentTags = [...extractTags(finalText), 'agent'];
      embedAndStore({
        text: '[agent session ' + ts + '] ' + finalText.slice(0, 400),
        type: 'session',
        tags: agentTags,
      }).catch(() => {});
    }
    return;
  }

  // Skip trivial sessions (only 1-2 user messages) -- no point summarizing "hey" chats
  const userMsgs = messages.filter(m => m.role === 'user');
  if (userMsgs.length < 2) return;

  // Summarize + embed using cheapest available model
  try {
    const convo = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[tool]'}`)
      .join('\n');
    if (!convo.trim()) return;

    const sum = await summarizeWithCheapModel([
      { role: 'system', content: 'Summarize this conversation in 3-5 bullet points. Include filenames, commands, values, decisions, problems solved. No preamble.' },
      { role: 'user',   content: convo },
    ]);
    const summary = sum.content || '(no summary)';
    const entry = `\n[${new Date().toLocaleString()}]\n${summary}\n`;
    await appendFile(PATHS.summary, entry);
    await pruneSummary();

    // Embed the session summary with auto-extracted tags
    const tags = extractTags(convo + ' ' + summary);
    embedAndStore({
      text: `Session ${ts}: ${summary}`,
      type: 'session',
      tags,
    }).catch(e => logError('memory.embed.session', e));
  } catch (e) { logError('memory.summarize', e); }

  // ---- Phase 10: instinct auto-promotion ----
  // Runs after every non-agent session. Promotes high-confidence candidates automatically.
  autoPromoteInstincts().catch(() => {});

  // Memory GC: dedup, contradiction resolution, decay (runs every 5th session)
  runMemoryGC().catch(e => logError('memory.gc', e));
}

// ---- Scan recent sessions for candidate instincts ----
// Looks at tool call frequency in the last N sessions and returns suggestions.
// Returns {tool, count, conf, suggestion} objects.
// conf is a 0-100 confidence score based on frequency across sessions.
export function scanForInstincts(lookback = 5) {
  if (!existsSync(PATHS.sessDir)) return [];
  const toolCounts   = {};  // tool → total call count
  const toolSessions = {};  // tool → sessions it appeared in

  const sessionFiles = readdirSync(PATHS.sessDir)
    .filter(f => f.endsWith('.jsonl') && f !== '.gitkeep')
    .sort()
    .slice(-lookback);

  for (const f of sessionFiles) {
    try {
      const seenInSession = new Set();
      const lines = readFileSync(join(PATHS.sessDir, f), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              const key = tc.function?.name || 'unknown';
              toolCounts[key] = (toolCounts[key] || 0) + 1;
              seenInSession.add(key);
            }
          }
        } catch {}
      }
      for (const k of seenInSession) toolSessions[k] = (toolSessions[k] || 0) + 1;
    } catch {}
  }

  const n = sessionFiles.length || 1;
  return Object.entries(toolCounts)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const spread = (toolSessions[name] || 0) / n;
      const conf   = Math.min(100, Math.round(40 + spread * 40 + Math.min(count, 20) * 1));
      return { tool: name, count, conf, suggestion: 'Frequently used: ' + name + ' (' + count + 'x across ' + (toolSessions[name] || 0) + '/' + n + ' sessions)' };
    });
}

// Auto-promote high-confidence instincts (Phase 10)
const PROMOTE_CONF_THRESHOLD = 85;
const PROMOTE_SEEN_THRESHOLD = 3;

async function autoPromoteInstincts() {
  const candidates = scanForInstincts(10);
  if (!candidates.length) return;

  const existing = readEntries(PATHS.instincts);
  const existingSet = new Set(existing.map(e => e.toLowerCase()));

  for (const c of candidates) {
    if (c.conf < PROMOTE_CONF_THRESHOLD) continue;
    if (c.count < PROMOTE_SEEN_THRESHOLD * 2) continue;

    const entry = '[conf:' + c.conf + '] [domain:behavior] [seen:' + c.count + '] Tool "' + c.tool + '" used heavily -- prefer this tool for relevant tasks';
    if (existingSet.has(entry.toLowerCase())) continue;
    if (existing.some(e => e.includes('"' + c.tool + '"'))) continue;

    const newEntries = [...existing, entry];
    const total = newEntries.join('\n\x15\n').length;
    if (total > MEM_CHAR_LIMIT) break;

    await writeFile(PATHS.instincts, newEntries.join('\n\x15\n'));
    existing.push(entry);
  }
}
