// compress.mjs — deterministic tool output compression
// Inspired by headroom's content-type routing + structural compression,
// reimplemented with zero dependencies using only Node built-ins.
//
// Techniques used per type:
//   json  → preserve schema (all keys), truncate long string values, cap arrays at 3
//   code  → strip comments and blank lines, then head+tail if still large
//   logs  → deduplicate consecutive similar lines, then head+tail
//   text  → paragraph-aware or line-based head+tail

const COMPRESS_THRESHOLD = 1500; // chars — skip compression below this
const HARD_CAP           = 8000; // chars — absolute ceiling after compression

// ---- Public entry point ----
export function compressOutput(text, toolName) {
  if (!text || text.length <= COMPRESS_THRESHOLD) return text;

  const type = detectType(text, toolName);
  let out;
  if      (type === 'json') out = compressJSON(text);
  else if (type === 'code') out = compressCode(text);
  else if (type === 'logs') out = compressLogs(text);
  else                      out = compressText(text);

  // Hard cap — always enforced regardless of type
  if (out.length > HARD_CAP) {
    const half = Math.floor(HARD_CAP * 0.6);
    const tail = Math.floor(HARD_CAP * 0.3);
    out = out.slice(0, half)
      + `\n…[${out.length - half - tail} chars omitted]…\n`
      + out.slice(-tail);
  }

  return out;
}

// ---- Type detection ----
// Tool name is the strongest signal; content is the fallback.
function detectType(text, toolName) {
  if (toolName === 'run_shell') {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); return 'json'; } catch {}
    }
    return 'logs';
  }

  if (toolName === 'read_file') {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); return 'json'; } catch {}
    }
    if (/\b(def |class |import |from |function |const |export |fn |impl |pub |#include)\b/.test(t))
      return 'code';
    return 'text';
  }

  // Generic fallback for fetch_url, recall, web_search, etc.
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); return 'json'; } catch {}
  }
  if (/\b(ERROR|WARN|INFO|DEBUG|FATAL)\b|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(t))
    return 'logs';
  if (/\b(import |export |function |class |def |const |let |var )\b/.test(t))
    return 'code';
  return 'text';
}

// ---- JSON compressor ----
// Keeps full schema (all keys visible), truncates long string values,
// caps arrays at 3 items. LLM can still navigate the structure.
function compressJSON(text) {
  try {
    const obj = JSON.parse(text.trim());
    const compressed = compressValue(obj, 0);
    return JSON.stringify(compressed);
  } catch {
    return compressText(text); // malformed JSON → treat as text
  }
}

function compressValue(val, depth) {
  if (val === null || typeof val === 'boolean' || typeof val === 'number') return val;

  if (typeof val === 'string') {
    return val.length > 80 ? val.slice(0, 80) + '…' : val;
  }

  if (Array.isArray(val)) {
    const kept = val.slice(0, 3).map(v => compressValue(v, depth + 1));
    if (val.length > 3) kept.push(`(…${val.length - 3} more)`);
    return kept;
  }

  if (typeof val === 'object') {
    // Beyond depth 4 just show key names without values
    if (depth > 4) return '(…)';
    const out = {};
    for (const [k, v] of Object.entries(val))
      out[k] = compressValue(v, depth + 1);
    return out;
  }

  return val;
}

// ---- Code compressor ----
// Strips block comments, line comments, and excess blank lines.
// If the result is still large, falls back to head+tail.
function compressCode(text) {
  let out = text;

  // Remove block comments /* ... */ (non-greedy, dot-all)
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove line comments — // and # (but preserve shebangs and URLs)
  out = out.replace(/^[ \t]*\/\/[^\n]*/gm, '');
  out = out.replace(/^[ \t]*#(?!!)[^\n]*/gm, ''); // # but not #!

  // Collapse 3+ consecutive blank lines → 1
  out = out.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace on each line (optional — saves chars)
  out = out.split('\n').map(l => l.trimEnd()).join('\n').trim();

  if (out.length <= HARD_CAP) return out;

  // Still too long — head+tail
  return headTailLines(out, 60, 30);
}

// ---- Log compressor ----
// Deduplicate consecutive lines that differ only in timestamps/numbers.
// Then head+tail if still large.
function compressLogs(text) {
  const lines  = text.split('\n');
  const deduped = [];
  let dupCount = 0;
  let prevNorm  = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    // Normalize: strip timestamps and numeric IDs for comparison
    const norm = line
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.Z+-]*/g, '<ts>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\d+/g, '<n>')
      .trim();

    if (norm === prevNorm) {
      dupCount++;
    } else {
      if (dupCount > 0) deduped.push(`  (…repeated ${dupCount}×)`);
      dupCount = 0;
      deduped.push(line);
      prevNorm = norm;
    }
  }
  if (dupCount > 0) deduped.push(`  (…repeated ${dupCount}×)`);

  const deduped_text = deduped.join('\n');
  if (deduped_text.length <= HARD_CAP) return deduped_text;

  return headTailLines(deduped_text, 30, 20);
}

// ---- Text compressor ----
// Paragraph-aware: keep first 4 + last 2 paragraphs.
// Falls back to line-based head+tail for dense output.
function compressText(text) {
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 8) {
    const head    = paragraphs.slice(0, 4);
    const tail    = paragraphs.slice(-2);
    const omitted = paragraphs.length - 6;
    return [...head, `\n…[${omitted} paragraphs omitted]…\n`, ...tail].join('\n\n');
  }

  // Not enough paragraphs — line-based
  return headTailLines(text, 30, 20);
}

// ---- Shared head+tail helper ----
function headTailLines(text, headN, tailN) {
  const lines   = text.split('\n');
  if (lines.length <= headN + tailN) return text;
  const head    = lines.slice(0, headN);
  const tail    = lines.slice(-tailN);
  const omitted = lines.length - headN - tailN;
  return [...head, `…[${omitted} lines omitted]…`, ...tail].join('\n');
}
