// api.mjs -- LLM API calls (OpenAI-compatible + Anthropic Claude)
import {
  API_KEY, BASE,
  ANTHROPIC_KEY, ANTHROPIC_BASE, ANTHROPIC_VERSION,
  CURATED_MODELS, state,
} from './config.mjs';

// ---- Provider detection ----
function resolveProvider() {
  const m = state.activeModel;
  if (m.startsWith('claude-')) {
    if (!ANTHROPIC_KEY) throw new Error('Claude model selected but ANTHROPIC_API_KEY is not set in config/.env');
    return { provider: 'anthropic', base: ANTHROPIC_BASE, key: ANTHROPIC_KEY };
  }
  if (!API_KEY) throw new Error('No API key set. Add OPENAI_API_KEY or ANTHROPIC_API_KEY to config/.env');
  return { provider: 'openai', base: BASE, key: API_KEY };
}

// ---- Transform OpenAI-style tools → Anthropic tools format ----
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

// ---- Retry / backoff (Pillar 11) ----
const RETRYABLE = new Set([429, 502, 503, 504]);

// ---- Phase 15: API failover ----
// Tracks quota/auth failures per provider. When a provider hits its failure
// threshold, calls are transparently rerouted to the next available provider.
// Order: OpenAI → Anthropic (whichever keys are configured).
const _providerFailures = { openai: 0, anthropic: 0 };
const FAILOVER_THRESHOLD = 2;   // failures before switching
const FAILOVER_RESET_MS  = 15 * 60 * 1000; // reset counts after 15 min
const _failoverResetAt   = { openai: 0, anthropic: 0 };

function recordProviderFailure(provider) {
  const now = Date.now();
  if (now > _failoverResetAt[provider]) {
    _providerFailures[provider] = 0;
    _failoverResetAt[provider]  = now + FAILOVER_RESET_MS;
  }
  _providerFailures[provider]++;
  if (_providerFailures[provider] >= FAILOVER_THRESHOLD) {
    console.warn(`[api:failover] Provider "${provider}" hit failure threshold -- will auto-switch`);
  }
}

function isProviderBlocked(provider) {
  if (Date.now() > _failoverResetAt[provider]) {
    _providerFailures[provider] = 0;
  }
  return _providerFailures[provider] >= FAILOVER_THRESHOLD;
}

// Returns a provider object, skipping any that are currently blocked.
// Falls back gracefully: if all providers are blocked, clears counts and uses default.
function resolveProviderWithFailover() {
  const base = resolveProvider();
  const prov = base.provider === 'anthropic' ? 'anthropic' : 'openai';

  if (!isProviderBlocked(prov)) return { ...base, providerKey: prov };

  // Try failover order
  const order = [
    API_KEY       && { provider: 'openai',    base: BASE,          key: API_KEY,       providerKey: 'openai'    },
    ANTHROPIC_KEY && { provider: 'anthropic', base: ANTHROPIC_BASE, key: ANTHROPIC_KEY, providerKey: 'anthropic' },
  ].filter(Boolean);

  for (const candidate of order) {
    if (!isProviderBlocked(candidate.providerKey)) {
      // Switch active model to something the failover provider supports
      const fallbackModel = candidate.providerKey === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';
      console.warn(`[api:failover] Switching from "${prov}" to "${candidate.providerKey}" (model: ${fallbackModel})`);
      state.activeModel = fallbackModel;
      return candidate;
    }
  }

  // All providers blocked -- reset and use the default
  for (const k of Object.keys(_providerFailures)) _providerFailures[k] = 0;
  return { ...base, providerKey: prov };
}

export function getProviderStatus() {
  return Object.entries(_providerFailures).map(([prov, fails]) => ({
    provider: prov,
    failures: fails,
    blocked:  isProviderBlocked(prov),
    resetAt:  _failoverResetAt[prov] ? new Date(_failoverResetAt[prov]).toISOString() : null,
  }));
}

function mkHttpError(status, text, res) {
  const err = new Error(`HTTP ${status}: ${text}`);
  err.status = status;
  const ra = Number(res?.headers?.get('retry-after'));
  if (ra > 0) err.retryAfter = ra;
  return err;
}

async function withRetry(fn, maxAttempts = 4) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === maxAttempts || !RETRYABLE.has(err.status)) throw err;
      const wait = err.retryAfter != null ? err.retryAfter * 1000 : delay;
      console.debug(`[api] HTTP ${err.status} -- retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, wait));
      delay = Math.min(delay * 2, 32000);
    }
  }
}

// ---- Single-shot (non-streaming) -- used for compression summaries ----
export async function chat(messages) {
  return withRetry(async () => {
    const { provider, base, key, providerKey } = resolveProviderWithFailover();

    if (provider === 'anthropic') {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model:      state.activeModel,
          max_tokens: 4096,
          system:     extractSystem(messages),
          messages:   toAnthropicMessages(messages),
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        // Quota / auth errors → record for failover
        if (res.status === 429 || res.status === 401 || res.status === 403) recordProviderFailure(providerKey);
        throw mkHttpError(res.status, errText, res);
      }
      const data = await res.json();
      return { role: 'assistant', content: data.content?.find(b => b.type === 'text')?.text || '' };
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: state.activeModel, messages }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || res.status === 401 || res.status === 403) recordProviderFailure(providerKey);
      throw mkHttpError(res.status, errText, res);
    }
    const data = await res.json();
    return data.choices?.[0]?.message ?? { content: '' };
  });
}

// ---- Streaming generator ----
export async function* chatStream(messages, tools) {
  const { provider, base, key, providerKey } = resolveProviderWithFailover();
  try {
    if (provider === 'anthropic') {
      yield* claudeStream(messages, tools, base, key);
      return;
    }
    yield* openaiStream(messages, tools, base, key);
  } catch (err) {
    if (err.status === 429 || err.status === 401 || err.status === 403) recordProviderFailure(providerKey);
    throw err;
  }
}

// ---- OpenAI streaming ----
async function* openaiStream(messages, tools, base, key) {
  // Retry only the initial fetch; stream reading is in-flight and non-retryable
  const res = await withRetry(async () => {
    const body = { model: state.activeModel, messages, stream: true };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

    let r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      // 400 with tool-related error: fall back to no-tools (not a retryable condition)
      if (r.status === 400 && /tool|function/i.test(errText)) {
        const body2 = { model: state.activeModel, messages, stream: true };
        r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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
async function* claudeStream(messages, tools, base, key) {
  const anthropicTools = toAnthropicTools(tools);
  const body = {
    model:      state.activeModel,
    max_tokens: 8192,
    stream:     true,
    system:     extractSystem(messages),
    messages:   toAnthropicMessages(messages),
  };
  if (anthropicTools?.length) body.tools = anthropicTools;

  const res = await withRetry(async () => {
    const r = await fetch(`${base}/messages`, {
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

  // ev.index = content block index (counts text + tool blocks)
  // toolCallIndex = position among tool-only blocks (what core.mjs expects as tc.index)
  const toolBlocks = {};
  let toolCallIndex = -1;

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
            id:            ev.content_block.id,
            name:          ev.content_block.name,
            input_json:    '',
            toolCallIndex,
          };
        }
      }

      if (ev.type === 'content_block_delta') {
        const delta = ev.delta;
        if (delta?.type === 'text_delta') {
          yield { choices: [{ delta: { content: delta.text } }] };
        }
        if (delta?.type === 'input_json_delta' && toolBlocks[ev.index]) {
          toolBlocks[ev.index].input_json += delta.partial_json;
        }
      }

      if (ev.type === 'content_block_stop') {
        const block = toolBlocks[ev.index];
        if (block) {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index:    block.toolCallIndex,
                  id:       block.id,
                  type:     'function',
                  function: { name: block.name, arguments: block.input_json },
                }],
              },
            }],
          };
          delete toolBlocks[ev.index];
        }
      }

      if (ev.type === 'message_stop') return;
    }
  }

  // Flush any tool blocks that never received content_block_stop (truncated stream)
  for (const block of Object.values(toolBlocks)) {
    yield {
      choices: [{
        delta: {
          tool_calls: [{
            index:    block.toolCallIndex,
            id:       block.id,
            type:     'function',
            function: { name: block.name, arguments: block.input_json },
          }],
        },
      }],
    };
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
