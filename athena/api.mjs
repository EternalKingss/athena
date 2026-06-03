// api.mjs — LLM API calls (OpenAI-compatible + Anthropic Claude)
import {
  API_KEY, BASE, NVIDIA_KEY, NVIDIA_BASE,
  ANTHROPIC_KEY, ANTHROPIC_BASE, ANTHROPIC_VERSION,
  VOYAGE_KEY, CURATED_MODELS, state,
} from './config.mjs';

// ---- Provider detection ----
function resolveProvider() {
  const m = state.activeModel;
  if (m.startsWith('claude-'))
    return { provider: 'anthropic', base: ANTHROPIC_BASE, key: ANTHROPIC_KEY };
  const isNvidia = CURATED_MODELS.find(g => g.label === 'NVIDIA')?.models.includes(m);
  if (isNvidia && NVIDIA_KEY)
    return { provider: 'openai', base: NVIDIA_BASE, key: NVIDIA_KEY };
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
      await new Promise(r => setTimeout(r, wait));
      delay = Math.min(delay * 2, 32000);
    }
  }
}

// ---- Single-shot (non-streaming) — used for compression summaries ----
export async function chat(messages) {
  return withRetry(async () => {
    const { provider, base, key } = resolveProvider();

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
      if (!res.ok) throw mkHttpError(res.status, await res.text(), res);
      const data = await res.json();
      return { role: 'assistant', content: data.content?.find(b => b.type === 'text')?.text || '' };
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: state.activeModel, messages }),
    });
    if (!res.ok) throw mkHttpError(res.status, await res.text(), res);
    const data = await res.json();
    return data.choices?.[0]?.message ?? { content: '' };
  });
}

// ---- Streaming generator ----
export async function* chatStream(messages, tools) {
  const { provider, base, key } = resolveProvider();
  if (provider === 'anthropic') {
    yield* claudeStream(messages, tools, base, key);
    return;
  }
  yield* openaiStream(messages, tools, base, key);
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

// ---- Claude streaming — yields OpenAI-shaped chunks for core.mjs compatibility ----
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

// ---- Embedding generation — Voyage AI → NVIDIA NIM → OpenAI (Pillar 8) ----
export async function generateEmbedding(text) {
  // Voyage AI — best for code/technical content
  if (VOYAGE_KEY) {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOYAGE_KEY}` },
      body: JSON.stringify({ model: 'voyage-3', input: [text] }),
    });
    if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
  }

  // NVIDIA NIM
  if (NVIDIA_KEY) {
    const res = await fetch(`${NVIDIA_BASE}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NVIDIA_KEY}` },
      body: JSON.stringify({ model: 'nvidia/nv-embedqa-e5-v5', input: [text], input_type: 'query' }),
    });
    if (!res.ok) throw new Error(`NVIDIA Embedding API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
  }

  // OpenAI
  if (!API_KEY) throw new Error('No embedding provider configured. Add VOYAGE_API_KEY, NVIDIA_API_KEY, or OPENAI_API_KEY to config/.env.');
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}
