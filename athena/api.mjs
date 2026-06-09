// api.mjs -- LLM API calls (OpenAI-compatible + Anthropic Claude)
import {
  API_KEY, BASE,
  ANTHROPIC_KEY, ANTHROPIC_BASE, ANTHROPIC_VERSION,
  CURATED_MODELS, LOCAL_LLM_PORT, isOfflineMode, state,
} from './config.mjs';

// ---- Model-switch broadcast callback (set by ui.mjs) ----
let _onModelSwitch = null;
export function setModelSwitchCallback(fn) { _onModelSwitch = fn; }

// ---- Provider detection for a given model ----
function providerForModel(model) {
  if (model.startsWith('local-')) {
    return { provider: 'local', base: 'http://127.0.0.1:' + LOCAL_LLM_PORT + '/v1', key: 'local' };
  }
  if (model.startsWith('claude-')) {
    if (!ANTHROPIC_KEY) return null;
    return { provider: 'anthropic', base: ANTHROPIC_BASE, key: ANTHROPIC_KEY };
  }
  if (!API_KEY) return null;
  return { provider: 'openai', base: BASE, key: API_KEY };
}

// ---- Per-model failure tracking ----
const _modelFailures  = {};
const _modelResetAt   = {};
const MODEL_FAIL_MAX  = 2;
const MODEL_RESET_MS  = 15 * 60 * 1000;

function recordModelFailure(model) {
  const now = Date.now();
  if (!_modelResetAt[model] || now > _modelResetAt[model]) {
    _modelFailures[model] = 0;
    _modelResetAt[model]  = now + MODEL_RESET_MS;
  }
  _modelFailures[model] = (_modelFailures[model] || 0) + 1;
  console.warn('[api:failover] Model "' + model + '" failure ' + _modelFailures[model] + '/' + MODEL_FAIL_MAX);
}

function isModelBlocked(model) {
  if (!_modelResetAt[model] || Date.now() > _modelResetAt[model]) {
    _modelFailures[model] = 0;
    return false;
  }
  return (_modelFailures[model] || 0) >= MODEL_FAIL_MAX;
}

// ---- Build priority-ordered model fallback list ----
// Current model first, then rest of same provider group, then other groups.
function buildFallbackList() {
  const current = state.activeModel;
  const result  = [];
  let currentGroupIdx = -1;
  for (let i = 0; i < CURATED_MODELS.length; i++) {
    if ((CURATED_MODELS[i].models || []).includes(current)) { currentGroupIdx = i; break; }
  }
  result.push(current);
  if (currentGroupIdx >= 0) {
    for (const m of CURATED_MODELS[currentGroupIdx].models) {
      if (m !== current) result.push(m);
    }
    for (let i = 0; i < CURATED_MODELS.length; i++) {
      if (i === currentGroupIdx) continue;
      for (const m of CURATED_MODELS[i].models) result.push(m);
    }
  } else {
    for (const g of CURATED_MODELS) for (const m of (g.models || [])) {
      if (m !== current) result.push(m);
    }
  }
  if (isOfflineMode()) {
    const local  = result.filter(m => m.startsWith('local-'));
    const others = result.filter(m => !m.startsWith('local-'));
    return [...local, ...others];
  }
  return result;
}

// ---- Pick the best available model, update state, broadcast if changed ----
function pickModel() {
  const original = state.activeModel;
  for (const model of buildFallbackList()) {
    if (isModelBlocked(model)) continue;
    const prov = providerForModel(model);
    if (!prov) continue; // no key for this provider
    if (model !== original) {
      console.warn('[api:failover] Auto-switching from "' + original + '" to "' + model + '"');
      state.activeModel = model;
      if (_onModelSwitch) _onModelSwitch(model);
    }
    return { ...prov, model };
  }
  // All blocked -- reset and use original
  for (const k of Object.keys(_modelFailures)) _modelFailures[k] = 0;
  const prov = providerForModel(original) || { provider: 'openai', base: BASE, key: API_KEY };
  return { ...prov, model: original };
}

export function getProviderStatus() {
  return buildFallbackList().map(model => {
    const prov = providerForModel(model);
    const provider = prov ? prov.provider : (model.startsWith('claude-') ? 'anthropic' : 'openai');
    return {
      model,
      provider,
      failures: _modelFailures[model] || 0,
      blocked:  isModelBlocked(model),
    };
  });
}

// ---- Transform OpenAI-style tools -> Anthropic tools format ----
function toAnthropicTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ---- Transform messages: extract system, fix tool result format ----
function toAnthropicMessages(messages) {
  const userMessages = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      userMessages.push({
        role: 'user',
        content: [{
          type:        'tool_result',
          tool_use_id: m.tool_call_id,
          content:     String(m.content),
        }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      userMessages.push({ role: 'assistant', content });
      continue;
    }
    userMessages.push({ role: m.role, content: m.content || '' });
  }
  return userMessages;
}

function extractSystem(messages) {
  return messages.find(m => m.role === 'system')?.content || '';
}

// ---- HTTP helpers ----
const RETRYABLE = new Set([429, 502, 503, 504]);
// Quota/auth errors trigger model failover
const FAILOVER_TRIGGERS = new Set([429, 402, 401, 403]);

function mkHttpError(status, text, res) {
  const err = new Error('HTTP ' + status + ': ' + text);
  err.status = status;
  const ra = Number(res?.headers?.get('retry-after'));
  if (ra > 0) err.retryAfter = ra;
  return err;
}

async function withRetry(fn, maxAttempts = 3) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === maxAttempts || !RETRYABLE.has(err.status)) throw err;
      const wait = err.retryAfter != null ? err.retryAfter * 1000 : delay;
      console.debug('[api] HTTP ' + err.status + ' -- retrying in ' + Math.round(wait/1000) + 's');
      await new Promise(r => setTimeout(r, wait));
      delay = Math.min(delay * 2, 32000);
    }
  }
}

// ---- Single-shot (non-streaming) ----
export async function chat(messages) {
  let modelAttempts = 0;
  while (modelAttempts < 4) {
    const { provider, base, key, model } = pickModel();
    try {
      return await withRetry(async () => {
        if (provider === 'anthropic') {
          const res = await fetch(base + '/messages', {
            method: 'POST',
            headers: {
              'Content-Type':      'application/json',
              'x-api-key':         key,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              system:   extractSystem(messages),
              messages: toAnthropicMessages(messages),
            }),
          });
          if (!res.ok) {
            const t = await res.text();
            if (FAILOVER_TRIGGERS.has(res.status)) recordModelFailure(model);
            throw mkHttpError(res.status, t, res);
          }
          const data = await res.json();
          return { role: 'assistant', content: data.content?.find(b => b.type === 'text')?.text || '' };
        }
        const res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({ model, messages }),
        });
        if (!res.ok) {
          const t = await res.text();
          if (FAILOVER_TRIGGERS.has(res.status)) recordModelFailure(model);
          throw mkHttpError(res.status, t, res);
        }
        const data = await res.json();
        return data.choices?.[0]?.message ?? { content: '' };
      });
    } catch (err) {
      if (FAILOVER_TRIGGERS.has(err.status)) {
        recordModelFailure(model);
        modelAttempts++;
        continue;
      }
      throw err;
    }
  }
  throw new Error('All models exhausted -- check your API keys and quota.');
}

// ---- Streaming generator ----
export async function* chatStream(messages, tools) {
  let modelAttempts = 0;
  while (modelAttempts < 4) {
    const { provider, base, key, model } = pickModel();
    try {
      if (provider === 'anthropic') {
        yield* claudeStream(messages, tools, base, key, model);
      } else {
        yield* openaiStream(messages, tools, base, key, model);
      }
      return;
    } catch (err) {
      if (FAILOVER_TRIGGERS.has(err.status)) {
        recordModelFailure(model);
        modelAttempts++;
        console.warn('[api:failover] Stream error on "' + model + '" (' + err.status + ') -- trying next model');
        continue;
      }
      throw err;
    }
  }
  throw new Error('All models exhausted for streaming.');
}

// ---- OpenAI streaming ----
async function* openaiStream(messages, tools, base, key, model) {
  const res = await withRetry(async () => {
    const body = { model, messages, stream: true };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    let r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      if (r.status === 400 && /tool|function/i.test(errText)) {
        const body2 = { model, messages, stream: true };
        r = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body2),
        });
        if (!r.ok) throw mkHttpError(r.status, await r.text(), r);
        return r;
      }
      throw mkHttpError(r.status, errText, r);
    }
    return r;
  });

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
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

// ---- Claude streaming -- yields OpenAI-shaped chunks for core.mjs compatibility ----
async function* claudeStream(messages, tools, base, key, model) {
  const anthropicTools = toAnthropicTools(tools);
  const body = {
    model,
    max_tokens: 8192,
    stream:     true,
    system:     extractSystem(messages),
    messages:   toAnthropicMessages(messages),
  };
  if (anthropicTools?.length) body.tools = anthropicTools;

  const res = await withRetry(async () => {
    const r = await fetch(base + '/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw mkHttpError(r.status, await r.text(), r);
    return r;
  });

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '';
  const toolBlocks   = {};
  let toolCallIndex  = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (line.startsWith('event: ')) continue;
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }

      if (ev.type === 'content_block_start') {
        if (ev.content_block?.type === 'tool_use') {
          toolCallIndex++;
          toolBlocks[ev.index] = {
            id: ev.content_block.id, name: ev.content_block.name,
            input_json: '', toolCallIndex,
          };
        }
      }
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta;
        if (delta?.type === 'text_delta') yield { choices: [{ delta: { content: delta.text } }] };
        if (delta?.type === 'input_json_delta' && toolBlocks[ev.index])
          toolBlocks[ev.index].input_json += delta.partial_json;
      }
      if (ev.type === 'content_block_stop') {
        const block = toolBlocks[ev.index];
        if (block) {
          yield { choices: [{ delta: { tool_calls: [{ index: block.toolCallIndex, id: block.id, type: 'function', function: { name: block.name, arguments: block.input_json } }] } }] };
          delete toolBlocks[ev.index];
        }
      }
      if (ev.type === 'message_stop') return;
    }
  }
  // Flush any tool blocks never closed
  for (const block of Object.values(toolBlocks)) {
    yield { choices: [{ delta: { tool_calls: [{ index: block.toolCallIndex, id: block.id, type: 'function', function: { name: block.name, arguments: block.input_json } }] } }] };
  }
}

// ---- Embedding generation ----
export async function generateEmbedding(text) {
  if (!API_KEY) throw new Error('No embedding provider configured. Add OPENAI_API_KEY to config/.env.');
  const res = await fetch(BASE + '/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!res.ok) throw new Error('Embedding API ' + res.status + ': ' + await res.text());
  const data = await res.json();
  return data.data[0].embedding;
}
