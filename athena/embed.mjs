// embed.mjs — semantic memory engine
// Embeddings stored as JSONL on the drive. Zero npm deps.
// Cosine similarity search in pure JS — fast enough for thousands of entries.
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';
import { generateEmbedding } from './api.mjs';

const EMBED_FILE = join(PATHS.memDir, 'embeddings.jsonl');

// ---- Cosine similarity ----
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- Load all embeddings from disk ----
function loadAll() {
  if (!existsSync(EMBED_FILE)) return [];
  const lines = readFileSync(EMBED_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

// ---- Store a new embedding entry ----
export async function storeEmbedding({ id, text, type, tags = [], embedding }) {
  const entry = {
    id:         id || `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    text:       text.slice(0, 500), // cap stored text length
    type,       // 'memory' | 'session' | 'skill'
    tags,
    embedding,
    created:    new Date().toISOString(),
  };
  await appendFile(EMBED_FILE, JSON.stringify(entry) + '\n');
  return entry.id;
}

// ---- Generate + store in one call ----
export async function embedAndStore({ text, type, tags = [], id }) {
  try {
    const embedding = await generateEmbedding(text);
    return await storeEmbedding({ id, text, type, tags, embedding });
  } catch {
    // Non-fatal — embeddings are best-effort
    return null;
  }
}

// ---- Semantic search: return top K most similar entries ----
export async function searchSimilar(query, topK = 5, filterType = null) {
  let queryVec;
  try { queryVec = await generateEmbedding(query); }
  catch { return []; }

  const entries = loadAll();
  const scored = entries
    .filter(e => !filterType || e.type === filterType)
    .map(e => ({ ...e, score: cosine(queryVec, e.embedding) }))
    .filter(e => e.score > 0.3) // relevance threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map(e => ({
    text:    e.text,
    type:    e.type,
    tags:    e.tags,
    created: e.created,
    score:   Math.round(e.score * 100) / 100,
  }));
}

// ---- Extract tags from text via simple keyword heuristic ----
// (no extra API call — fast, good enough for session tagging)
export function extractTags(text) {
  const tags = [];
  const lower = text.toLowerCase();

  // OS / platform
  if (/windows|win32|powershell|\.bat|regedit|ntfs/i.test(lower))  tags.push('windows');
  if (/linux|ubuntu|debian|bash|apt|systemd/i.test(lower))         tags.push('linux');
  if (/macos|darwin|homebrew|brew/i.test(lower))                   tags.push('macos');

  // Topics
  if (/network|wifi|ethernet|ip address|ping|dns|subnet/i.test(lower))  tags.push('network');
  if (/git|commit|push|pull|branch|merge|repo/i.test(lower))            tags.push('git');
  if (/python|pip|venv|\.py/i.test(lower))                              tags.push('python');
  if (/node|npm|\.mjs|\.js|javascript/i.test(lower))                    tags.push('node');
  if (/docker|container|image|compose/i.test(lower))                    tags.push('docker');
  if (/sql|database|query|table|schema/i.test(lower))                   tags.push('database');
  if (/disk|drive|partition|ntfs|storage|ssd|hdd/i.test(lower))         tags.push('storage');
  if (/boot|grub|bcd|mbr|uefi|bios|recovery/i.test(lower))             tags.push('boot');
  if (/error|fix|debug|crash|fail|broken|issue/i.test(lower))          tags.push('debugging');
  if (/install|setup|config|configure/i.test(lower))                    tags.push('setup');
  if (/athena|skill|memory|agent/i.test(lower))                         tags.push('athena');

  return [...new Set(tags)]; // dedupe
}

// ---- Semantic recall tool handler ----
export async function handleRecallTool(args) {
  const query   = args.query?.trim();
  const topK    = Math.min(Number(args.count) || 5, 10);
  const type    = args.type || null; // 'memory' | 'session' | 'skill' | null (all)

  if (!query) return 'query is required.';

  // Recall requires an OpenAI key for embeddings — fail clearly if missing
  const { API_KEY } = await import('./config.mjs');
  if (!API_KEY) return 'Recall requires an OpenAI API key for embeddings. Add OPENAI_API_KEY to config/.env.';

  const results = await searchSimilar(query, topK, type);
  if (!results.length) return 'No relevant memories found.';

  return results.map((r, i) =>
    `${i + 1}. [${r.type}${r.tags.length ? ' · ' + r.tags.join(', ') : ''}] (${r.score})\n   ${r.text}`
  ).join('\n\n');
}
