// memory.mjs — long-term memory read/write and session persistence
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';
import { MEM_CHAR_LIMIT } from './config.mjs';
import { chat } from './api.mjs';
import { embedAndStore, extractTags } from './embed.mjs';

const DELIM = '\n\x15\n';

// ---- Memory file helpers ----
function readEntries(file) {
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
  return `${pct}% — ${chars}/${MEM_CHAR_LIMIT} chars`;
}

// ---- loadMemBlock — used by personality.mjs for system prompt ----
export function loadMemBlock(file, label) {
  if (!existsSync(file)) return '';
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return '';
  const entries = raw.split(DELIM).map(e => e.trim()).filter(Boolean);
  if (!entries.length) return '';
  const chars = entries.join(DELIM).length;
  const pct   = Math.min(100, Math.round(chars / MEM_CHAR_LIMIT * 100));
  return `--- ${label} [${pct}% — ${chars}/${MEM_CHAR_LIMIT} chars] ---\n${entries.join('\n')}`;
}

// ---- handleMemoryTool — called by tools.mjs ----
export async function handleMemoryTool(args) {
  const file = args.target === 'user' ? PATHS.userMem : PATHS.agentMem;

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
    }).catch(e => console.error('[memory] embed failed:', e.message));
    return `Added. ${usageStr(newEntries)}`;
  }

  if (args.action === 'replace') {
    if (!args.old?.trim() || !args.content?.trim()) return 'old and content required for replace.';
    const entries = readEntries(file);
    const idx = entries.findIndex(e => e === args.old.trim());
    if (idx === -1) return 'Entry not found — use exact text from memory read.';
    entries[idx] = args.content.trim();
    const total = entries.join(DELIM).length;
    if (total > MEM_CHAR_LIMIT) return `Memory full after replace (${total}/${MEM_CHAR_LIMIT}). Shorten the new content.`;
    await writeEntries(file, entries);
    embedAndStore({
      text: args.content.trim(),
      type: 'memory',
      tags: [...extractTags(args.content), args.target],
    }).catch(e => console.error('[memory] embed failed:', e.message));
    return `Replaced. ${usageStr(entries)}`;
  }

  if (args.action === 'remove') {
    if (!args.content?.trim()) return 'content required for remove.';
    const entries = readEntries(file);
    const filtered = entries.filter(e => e !== args.content.trim());
    if (filtered.length === entries.length) return 'Entry not found — use exact text from memory read.';
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

// ---- Session save + summarize + auto-embed on exit ----
export async function saveAndSummarize(messages) {
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1);
  const file = join(PATHS.sessDir, `${ts}.jsonl`);
  const lines = messages
    .filter(m => m.role !== 'system')
    .map(m => JSON.stringify(m))
    .join('\n');
  if (!lines.trim()) return;
  await writeFile(file, lines + '\n');

  // Summarize + embed
  try {
    const convo = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[tool]'}`)
      .join('\n');
    if (!convo.trim()) return;

    const sum = await chat([
      { role: 'system', content: 'Summarize this conversation in 3-5 bullet points. Include filenames, commands, values, decisions, problems solved. No preamble.' },
      { role: 'user',   content: convo },
    ]);
    const summary = sum.content || '(no summary)';
    const entry = `\n[${new Date().toLocaleString()}]\n${summary}\n`;
    await appendFile(PATHS.summary, entry);

    // Embed the session summary with auto-extracted tags
    const tags = extractTags(convo + ' ' + summary);
    embedAndStore({
      text: `Session ${ts}: ${summary}`,
      type: 'session',
      tags,
    }).catch(e => console.error('[memory] session embed failed:', e.message));
  } catch (e) { console.error('[memory] summarize failed:', e.message); }
}
