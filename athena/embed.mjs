// embed.mjs -- semantic memory engine
// Embeddings stored as JSONL on the drive. Zero npm deps.
// Tier A (always works): BM25 keyword search -- no API key needed.
// Tier B (when OpenAI key available): cosine similarity on dense vectors.
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, appendFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';
import { generateEmbedding } from './api.mjs';

const EMBED_FILE = join(PATHS.memDir, 'embeddings.jsonl');
const MAX_ENTRIES = 2000;
const KEEP_DAYS   = 90;

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

// ---- BM25 keyword search (Tier A -- works without API key) ----
function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

function extractTermFrequency(text) {
  const freq = {};
  for (const w of tokenize(text)) freq[w] = (freq[w] || 0) + 1;
  return freq;
}

function bm25Search(query, entries, topK = 5) {
  const K1 = 1.5, B = 0.75;
  const queryTerms = tokenize(query);
  if (!queryTerms.length || !entries.length) return [];

  // Document frequencies and average doc length
  const df = {};
  let totalLen = 0;
  for (const e of entries) {
    const terms = e.terms || {};
    const docLen = Object.values(terms).reduce((s, v) => s + v, 0);
    totalLen += docLen;
    for (const t of Object.keys(terms)) df[t] = (df[t] || 0) + 1;
  }
  const avgdl = totalLen / entries.length || 1;
  const N = entries.length;

  const scored = entries.map(e => {
    const terms = e.terms || {};
    const docLen = Object.values(terms).reduce((s, v) => s + v, 0);
    let score = 0;
    for (const qt of queryTerms) {
      const f = terms[qt] || 0;
      if (!f) continue;
      const n = df[qt] || 0;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      const tf = (f * (K1 + 1)) / (f + K1 * (1 - B + B * docLen / avgdl));
      score += idf * tf;
    }
    return { ...e, score };
  });

  return scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(e => ({
      text:    e.text,
      type:    e.type,
      tags:    e.tags,
      created: e.created,
      score:   Math.round(e.score * 100) / 100,
    }));
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

// ---- Prune embeddings file to MAX_ENTRIES ----
// Keeps all entries from the last KEEP_DAYS, then fills remaining slots with
// the most recent older entries. Writes atomically via temp-rename.
async function pruneEmbeddings() {
  try {
    const entries = loadAll();
    if (entries.length <= MAX_ENTRIES) return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const recent  = entries.filter(e => new Date(e.created).getTime() >= cutoff);
    const older   = entries.filter(e => new Date(e.created).getTime() <  cutoff)
      .sort((a, b) => new Date(b.created) - new Date(a.created)); // newest first
    const slots = Math.max(0, MAX_ENTRIES - recent.length);
    const kept  = [...recent, ...older.slice(0, slots)];
    const tmp   = EMBED_FILE + '.tmp';
    await writeFile(tmp, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
    await rename(tmp, EMBED_FILE);
  } catch { /* non-fatal */ }
}

// ---- Store a new embedding entry ----
async function storeEmbedding({ id, text, type, tags = [], embedding }) {
  const entry = {
    id:        id || (Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
    text:      text.slice(0, 500),
    type,
    tags,
    terms:     extractTermFrequency(text.slice(0, 500)),
    embedding,
    created:   new Date().toISOString(),
  };
  await appendFile(EMBED_FILE, JSON.stringify(entry) + '\n');
  // Prune asynchronously after every 50th write (modulo based on id)
  if (Math.random() < 0.02) pruneEmbeddings().catch(() => {});
  return entry.id;
}

// ---- Generate + store in one call ----
export async function embedAndStore({ text, type, tags = [], id }) {
  try {
    let embedding = null;
    try { embedding = await generateEmbedding(text); } catch { /* no API key -- BM25 only */ }
    return await storeEmbedding({ id, text, type, tags, embedding });
  } catch {
    return null;
  }
}

// ---- Semantic search: cosine (if vectors available) or BM25 ----
async function searchSimilar(query, topK = 5, filterType = null) {
  const entries = loadAll();
  const filtered = filterType ? entries.filter(e => e.type === filterType) : entries;

  // Prefer vector search if we have a key
  let queryVec = null;
  try { queryVec = await generateEmbedding(query); } catch { /* fall through to BM25 */ }

  if (queryVec) {
    const scored = filtered
      .filter(e => Array.isArray(e.embedding) && e.embedding.length)
      .map(e => ({ ...e, score: cosine(queryVec, e.embedding) }))
      .filter(e => e.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    if (scored.length) {
      return scored.map(e => ({
        text:    e.text,
        type:    e.type,
        tags:    e.tags,
        created: e.created,
        score:   Math.round(e.score * 100) / 100,
      }));
    }
  }

  // BM25 fallback -- works without any API key
  return bm25Search(query, filtered, topK);
}

// ---- Extract tags from text via simple keyword heuristic ----
export function extractTags(text) {
  const tags = [];
  const lower = text.toLowerCase();
  if (/windows|win32|powershell|\.bat|regedit|ntfs/i.test(lower))  tags.push('windows');
  if (/linux|ubuntu|debian|bash|apt|systemd/i.test(lower))         tags.push('linux');
  if (/macos|darwin|homebrew|brew/i.test(lower))                   tags.push('macos');
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
  if (/athena|skill|memory|agent|workspace/i.test(lower))               tags.push('athena');
  if (/security|malware|virus|ransomware|exploit|cve|vulnerability|nmap/i.test(lower))  tags.push('security');
  if (/driver|device|hardware|usb|bluetooth|gpu|ram|motherboard|peripheral/i.test(lower))  tags.push('hardware');
  if (/registry|regedit|group policy|gpo|event log|task scheduler|wmic/i.test(lower))  tags.push('windows-admin');
  if (/rust|cargo|\.rs/i.test(lower))   tags.push('rust');
  if (/golang?|\.go$/i.test(lower))     tags.push('go');
  if (/java|maven|gradle|\.java|\.jar/i.test(lower))  tags.push('java');
  if (/api|rest|http|endpoint|webhook|graphql/i.test(lower))  tags.push('api');
  if (/performance|slow|memory leak|latency|throughput|benchmark/i.test(lower))  tags.push('performance');
  if (/vpn|firewall|proxy|nat|router|port forward/i.test(lower))  tags.push('network');
  if (/winget|chocolatey|scoop|package manager/i.test(lower))     tags.push('windows');
  return [...new Set(tags)];
}

// ---- Semantic recall tool handler ----
export async function handleRecallTool(args) {
  const query = args.query?.trim();
  const topK  = Math.min(Number(args.count) || 5, 10);
  const type  = args.type || null;
  if (!query) return 'query is required.';
  const results = await searchSimilar(query, topK, type);
  if (!results.length) return 'No relevant memories found.';
  return results.map((r, i) =>
    `${i + 1}. [${r.type}${r.tags?.length ? ' * ' + r.tags.join(', ') : ''}] (${r.score})\n   ${r.text}`
  ).join('\n\n');
}
