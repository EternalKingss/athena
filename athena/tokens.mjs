// tokens.mjs -- lightweight token budget estimator (no npm deps)
// Uses char-based heuristics: ~3.5 chars/token for prose, ~2.5 for code/JSON.
// Accurate enough for compression threshold decisions.

const MODEL_BUDGETS = {
  'gpt-4o':                    120000,
  'gpt-4o-mini':               120000,
  'gpt-4-turbo':               120000,
  'gpt-4':                     8000,
  'o1':                        200000,
  'o1-mini':                   200000,
  'o3-mini':                   200000,
  'claude-opus-4-8':           180000,
  'claude-sonnet-4-6':         180000,
  'claude-haiku-4-5-20251001': 180000,
};

const DEFAULT_BUDGET = 100000;

// Returns token budget for a model ID (prefix match).
export function getModelBudget(model) {
  if (!model) return DEFAULT_BUDGET;
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
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function?.arguments || '');
      }
    }
  }
  return total;
}
