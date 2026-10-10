// tokens.mjs -- lightweight token budget estimator (no npm deps)
// Uses char-based heuristics: ~3.5 chars/token for prose, ~2.5 for code/JSON.
// Accurate enough for compression threshold decisions.

const MODEL_BUDGETS = {
  'claude-opus-5':             180000,
  'claude-sonnet-5':           180000,
  'claude-haiku-4-5-20251001': 180000,
  'claude-':                   180000,
};

// Fallback local budget, used only before a local model has actually reported
// which --ctx-size it started with. local_llm.mjs's startup ladder can settle
// on 8192 or degrade to 4096 depending on what the machine can handle -- a
// flat guess here was wrong in exactly the case that mattered: when the
// ladder degraded to 4096, this stayed tuned for the 8192 case, compression
// never triggered before llama-server's real limit, and the resulting
// HTTP 400 kept firing on every subsequent message because nothing had
// trimmed the conversation down first. See globalThis.__athenaLocalCtxSize,
// published by local_llm.mjs once a config actually comes up healthy.
const LOCAL_BUDGET_FALLBACK = 3000;

const DEFAULT_BUDGET = 100000;

// Reserved headroom per local request: --n-predict (max response length)
// plus a safety margin, because this file's own char-based estimate is
// approximate, not exact. Compression should fire well before the server's
// actual hard ctx-size, not right up against it.
const LOCAL_RESPONSE_RESERVE = 2048;
const LOCAL_SAFETY_MARGIN    = 0.6; // use 60% of whatever's left after the reserve

// Returns token budget for a model ID (prefix match).
export function getModelBudget(model) {
  if (!model) return DEFAULT_BUDGET;
  if (model.startsWith('local-')) {
    const liveCtx = globalThis.__athenaLocalCtxSize;
    if (typeof liveCtx === 'number' && liveCtx > 0) {
      return Math.max(500, Math.floor((liveCtx - LOCAL_RESPONSE_RESERVE) * LOCAL_SAFETY_MARGIN));
    }
    return LOCAL_BUDGET_FALLBACK;
  }
  for (const [key, budget] of Object.entries(MODEL_BUDGETS)) {
    if (model.startsWith(key)) return budget;
  }
  return DEFAULT_BUDGET;
}

// Estimate tokens for a single string.
// Code/JSON is denser (~2.5 chars/token); prose is ~3.5.
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const codeSignals = (text.match(/[{}\[\]<>]|^\s{2,}/gm) || []).length;
  const isCode = codeSignals > text.length / 60;
  return Math.ceil(text.length / (isCode ? 2.5 : 3.5));
}

// Estimate total tokens across a messages array (includes per-message overhead).
export function estimateMessages(messages) {
  let total = 0;
  for (const m of messages) {
    total += 4;
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block.content === 'string') total += estimateTokens(block.content);
        else if (typeof block.text === 'string') total += estimateTokens(block.text);
      }
    }
    // Screenshot images (core.mjs splitScreenshot): about width*height/750 tokens each.
    if (Array.isArray(m.images)) {
      for (const img of m.images) total += Math.ceil(((img.width || 1280) * (img.height || 800)) / 750);
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function?.arguments || '');
      }
    }
  }
  return total;
}
