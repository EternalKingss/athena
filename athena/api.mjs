// api.mjs — LLM API calls (OpenAI-compatible + Anthropic Claude)
import {
  API_KEY, BASE, NVIDIA_KEY, NVIDIA_BASE,
  ANTHROPIC_KEY, ANTHROPIC_BASE, ANTHROPIC_VERSION,
  CURATED_MODELS, state,
} from './config.mjs';

// ---- Provider detection ----
export function resolveProvider() {
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
    if (m.role === 'system') continue; // handled separately
    if (m.role === 'tool') {
      // Claude expects tool results inside a user message as content blocks
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
      // Convert OpenAI tool_calls → Claude tool_use content blocks
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

// ---- Single-shot (non-streaming) — used for compression summaries ----
export async function chat(messages) {
  const { provider, base, key } = resolveProvider();

  if (provider === 'anthropic') {
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      state.activeModel,
        max_tokens: 4096,
        system:     extractSystem(messages),
        messages:   toAnthropicMessages(messages),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    return { role: 'assistant', content: text };
  }

  // OpenAI-compatible
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: state.activeModel, messages }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message ?? { content: '' };
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
  async function doFetch(withTools) {
    const body = { model: state.activeModel, messages, stream: true };
    if (withTools && tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    return fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  }

  let res = await doFetch(true);
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 400 || /tool|function/i.test(errText)) {
      res = await doFetch(false);
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    } else {
      throw new Error(`API ${res.status}: ${errText}`);
    }
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
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

  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  // Track tool use blocks being assembled
  const toolBlocks = {}; // index → {id, name, input_json}
  let blockIndex = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (line.startsWith('event: ')) continue; // event type line
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;

      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }

      if (ev.type === 'content_block_start') {
        blockIndex = ev.index;
        if (ev.content_block?.type === 'tool_use') {
          toolBlocks[blockIndex] = {
            id:         ev.content_block.id,
            name:       ev.content_block.name,
            input_json: '',
          };
        }
      }

      if (ev.type === 'content_block_delta') {
        const delta = ev.delta;
        if (delta?.type === 'text_delta') {
          // Yield OpenAI-shaped text token
          yield { choices: [{ delta: { content: delta.text } }] };
        }
        if (delta?.type === 'input_json_delta' && toolBlocks[ev.index]) {
          toolBlocks[ev.index].input_json += delta.partial_json;
        }
      }

      if (ev.type === 'content_block_stop') {
        const block = toolBlocks[ev.index];
        if (block) {
          // Yield an OpenAI-shaped tool call chunk
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index:    0,
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
}

// ---- Embedding generation (OpenAI only — Anthropic has no embeddings API) ----
export async function generateEmbedding(text) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY required for embeddings');
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding; // number[]
}
