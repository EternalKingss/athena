// api.mjs -- LLM API calls (OpenAI-compatible + Anthropic Claude)
import {
  API_KEY, BASE,
  ANTHROPIC_KEY, ANTHROPIC_BASE, ANTHROPIC_VERSION,
  CURATED_MODELS, LOCAL_LLM_PORT, state, API_STALL_MS,
} from './config.mjs';
import { triageNetwork } from './net_triage.mjs';

// ---- Model-switch broadcast callback (set by ui.mjs) ----
let _onModelSwitch = null;
export function setModelSwitchCallback(fn) { _onModelSwitch = fn; }

// ---- Provider detection for a given model ----
function providerForModel(model) {
  if (model.startsWith('local-')) {
    // llama-server now requires the per-run key (it defaults to open + allow-all CORS).
    let key = 'local';
    try { key = globalThis.__athenaLocalKey || 'local'; } catch {}
    return { provider: 'local', base: 'http://127.0.0.1:' + LOCAL_LLM_PORT + '/v1', key };
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
function blockProvider(model) {
  // On credit/auth failure, block every model in the same provider group
  for (const g of CURATED_MODELS) {
    if ((g.models || []).includes(model)) {
      for (const m of g.models) {
        _modelFailures[m] = MODEL_FAIL_MAX;
        _modelResetAt[m]  = Date.now() + MODEL_RESET_MS;
        console.warn('[api:failover] Provider block: "' + m + '" blocked (credit/auth on "' + model + '")');
      }
      return;
    }
  }
  recordModelFailure(model); // unknown group -- fall back to per-model block
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
  // The local model is never a fallback for Claude (v3.4): it handles basic commands only
  // (task_router.mjs), never diagnosis or fixing. It stays in the list only when the user
  // explicitly switched to it with /model.
  if (!String(current).startsWith('local-')) return result.filter(m => !m.startsWith('local-'));
  return result;
}

// ---- Pick the best available model, update state, broadcast if changed ----
function pickModel(preferred) {
  // An explicit per-call model (housekeeping summaries, crystallization) is honoured
  // directly. Callers used to get this by assigning state.activeModel and restoring it
  // in a finally -- which races badly, because background agents run concurrently and
  // one agent's restore clobbers another's switch mid-request.
  if (preferred && !isModelBlocked(preferred)) {
    const p = providerForModel(preferred);
    if (p) return { ...p, model: preferred };
  }
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
  const prov = providerForModel(original) || { provider: 'anthropic', base: ANTHROPIC_BASE, key: ANTHROPIC_KEY };
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
      // A screenshot result carries its image separately (core.mjs splitScreenshot);
      // a tool_result block can hold text and image blocks together.
      const content = Array.isArray(m.images) && m.images.length
        ? [{ type: 'text', text: String(m.content) },
           ...m.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } }))]
        : String(m.content);
      userMessages.push({
        role: 'user',
        content: [{
          type:        'tool_result',
          tool_use_id: m.tool_call_id,
          content,
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

// OpenAI-compatible providers get the plain message shape: tool messages there are
// text-only, so a screenshot's `images` field is dropped (the text still says what it was).
function toOpenAiMessages(messages) {
  return messages.map(m => {
    if (!m || !m.images) return m;
    const { images, ...rest } = m;
    return rest;
  });
}

function extractSystem(messages) {
  return messages.find(m => m.role === 'system')?.content || '';
}

// System prompt as a cacheable block -- Athena's memory/instincts rarely change
// mid-session, so this cuts input cost ~90% on every turn after the first.
function toAnthropicSystem(messages) {
  const sys = extractSystem(messages);
  if (!sys) return undefined;
  return [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }];
}

// Mark the last content block of the conversation so the whole history
// prefix is reused from cache on the next turn.
function markCacheBreakpoint(msgs) {
  if (!msgs.length) return msgs;
  const last = msgs[msgs.length - 1];
  if (Array.isArray(last.content) && last.content.length) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  } else if (typeof last.content === 'string' && last.content) {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }
  return msgs;
}

// ---- Stall protection ----
// fetch() has no timeout of its own, and Node's defaults let a connection that accepted
// the request but never answers sit for five minutes per read -- multiplied across up to
// eight failover attempts. That is the "turn silently hangs, no error, no tool call"
// failure. Every provider call now has a deadline for the response headers and, when
// streaming, an idle deadline between chunks. Hitting either aborts the request with a
// `stalled` error, which chatStream()/chat() treat as "this model is not answering, try
// the next one" -- not as "the machine is offline". Only MAX_STALL_FAILOVERS models are
// tried after a stall: a provider that hangs usually hangs for every model it serves, and
// eight sequential stall windows would just be a slower hang.
const MAX_STALL_FAILOVERS = 2;
function stallMsFor(model) {
  return String(model || '').startsWith('local-') ? API_STALL_MS * 5 : API_STALL_MS;
}

function stallError(model, ms, phase) {
  const e = new Error('API stalled: "' + model + '" sent no ' + phase + ' for ' + Math.round(ms / 1000) + 's');
  e.stalled = true;
  return e;
}

// fetch() with an abort deadline that covers connecting and waiting for headers. The
// returned response carries the controller so the body reader can abort the same request.
async function timedFetch(url, init, model) {
  const ms  = stallMsFor(model);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(stallError(model, ms, 'response')), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    res._athenaAbort = ctl;
    return res;
  } catch (e) {
    if (ctl.signal.aborted && ctl.signal.reason && ctl.signal.reason.stalled) throw ctl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Non-streaming: one deadline for the whole exchange, headers and body together.
async function timedJson(url, init, model) {
  const ms  = stallMsFor(model) * 2;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(stallError(model, ms, 'complete response')), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    if (ctl.signal.aborted && ctl.signal.reason && ctl.signal.reason.stalled) throw ctl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// reader.read() with an idle deadline. The timer is always cleared, so a finished read
// never leaves a pending timeout holding the event loop.
async function readWithIdle(reader, res, model) {
  const ms = stallMsFor(model);
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = stallError(model, ms, 'stream data');
          // Reject BEFORE cancelling: cancel() settles the pending read() as { done: true }
          // synchronously, and if that wins the race the stall reads as a normal end of
          // stream -- a half-finished reply presented as complete.
          reject(err);
          try { res._athenaAbort && res._athenaAbort.abort(err); } catch {}
          reader.cancel(err).catch(() => {});
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs network triage at most once per chat()/chatStream() call, and only for a cloud
// model -- a local model being unreachable says nothing about the network. Returns the
// triage result, or null when triage does not apply.
async function tryNetworkTriage(base, model) {
  if (String(model).startsWith('local-')) return null;
  let host = '';
  try { host = new URL(base).hostname; } catch {}
  if (!host || host === '127.0.0.1' || host === 'localhost') return null;
  try { return await triageNetwork({ host }); }
  catch { return null; }
}

// Offline means one thing (v3.4): this machine has no working internet. When triage
// confirms that, trying the other cloud models is pointless and falling back to the local
// model is not wanted -- the only useful work is getting the connection back, which
// core.mjs reports. No failure is recorded against the cloud models either: the network
// was at fault, not them, and blocking them would keep Athena on a fallback after the
// connection returns.

// ---- HTTP helpers ----
const RETRYABLE = new Set([429, 502, 503, 504]);
// Quota/auth errors trigger model failover
const FAILOVER_TRIGGERS = new Set([429, 402, 401, 403]);
const CREDIT_TRIGGERS   = new Set([402, 401, 403]); // auth/credit = block whole provider

// A dead endpoint has no HTTP status, so the old catch fell through to `throw err` and
// aborted the whole failover chain. That is exactly what a registered-but-not-running
// local model looks like: one unreachable entry killed cloud failover for every model
// after it.
function isConnError(err) {
  if (err && err.status) return false;
  const m = String((err && err.message) || '');
  return (err instanceof TypeError) || /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(m);
}

// A local-model HTTP 400 whose body describes exceeding the context window is a
// distinct, recoverable case, not a generic failure. Tagging it lets core.mjs force
// a compression pass and retry once, instead of surfacing a raw HTTP dump and leaving
// the oversized messages array to fail identically on every message after it, until
// the process restarts and the in-memory array resets.
export function isLocalContextOverflow(err) {
  if (!err || err.status !== 400) return false;
  return /exceed|too many tokens|context.{0,20}(size|length|window)/i.test(String(err.message || ''));
}

// Running out of credits is not the same as being offline, but it is the moment the local
// model is supposed to earn its keep. The weights are on disk; nothing was starting them.
const _localStartTried = new Set();
export function resetLocalStartAttempt() { _localStartTried.clear(); }
async function ensureLocalUp(model) {
  if (_localStartTried.has(model)) return false;
  _localStartTried.add(model);
  try {
    const m = await import('./local_llm.mjs');
    const quiet = () => {};
    if (await m.isLocalLLMRunning()) {
      if (m.getLocalModelName() === model) return false;   // already the right weights
      return Boolean(await m.switchLocalModel(model, LOCAL_LLM_PORT, quiet));
    }
    await m.startLocalLLM(LOCAL_LLM_PORT, quiet, model);
    return await m.isLocalLLMRunning();
  } catch { return false; }
}

function mkHttpError(status, text, res) {
  const err = new Error('HTTP ' + status + ': ' + text);
  err.status = status;
  const ra = Number(res?.headers?.get('retry-after'));
  if (ra > 0) err.retryAfter = ra;
  return err;
}

// A local llama-server that was just told to load different weights (a model switch,
// or this file's own ensureLocalUp) answers requests with this specific 503 the instant
// it's listening -- well before the model is actually usable. local_llm.mjs's own
// waitForHealth budgets up to 90s for exactly this: a 30B model with GPU-layer auto-fit
// routinely takes longer than the generic 2s/4s backoff below, so a request landing in
// that window used to exhaust withRetry's normal budget and throw a raw 503 seconds
// before the model actually finished loading (visibly: 'Local LLM ready' would appear
// right after the error, in the same turn -- the model was fine, the retry just quit too soon).
function isLocalLoadingError(err) {
  return Boolean(err) && err.status === 503 && /loading model/i.test(String(err.message || ''));
}

async function withRetry(fn, maxAttempts = 3) {
  let delay = 2000;
  let attempt = 0;
  while (true) {
    attempt++;
    let err;
    try { return await fn(); }
    catch (e) { err = e; }
    const localLoading = isLocalLoadingError(err);
    const limit = localLoading ? 30 : maxAttempts; // ~90s at 3s steps, matching local_llm.mjs
    if (attempt >= limit || (!localLoading && !RETRYABLE.has(err.status))) throw err;
    const wait = localLoading ? 3000 : (err.retryAfter != null ? err.retryAfter * 1000 : delay);
    console.debug('[api] HTTP ' + err.status + ' -- retrying in ' + Math.round(wait / 1000) + 's' + (localLoading ? ' (local model still loading)' : ''));
    await new Promise(r => setTimeout(r, wait));
    if (!localLoading) delay = Math.min(delay * 2, 32000);
  }
}

// ---- Single-shot (non-streaming) ----
export async function chat(messages, opts = {}) {
  let modelAttempts = 0, connFailures = 0, stallFailures = 0, triaged = false;
  while (modelAttempts < 8) {
    const { provider, base, key, model } = pickModel(opts.model);
    try {
      return await withRetry(async () => {
        if (provider === 'anthropic') {
          const { res, text } = await timedJson(base + '/messages', {
            method: 'POST',
            headers: {
              'Content-Type':      'application/json',
              'x-api-key':         key,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              system:   toAnthropicSystem(messages),
              messages: markCacheBreakpoint(toAnthropicMessages(messages)),
            }),
          }, model);
          if (!res.ok) {
            // Failure accounting happens once, in the outer catch. Recording it here too
            // meant one rate-limited request counted ~4 times against MODEL_FAIL_MAX=2,
            // so a single 429 blocked the model for the full 15-minute window.
            throw mkHttpError(res.status, text, res);
          }
          const data = JSON.parse(text);
          return { role: 'assistant', content: data.content?.find(b => b.type === 'text')?.text || '' };
        }
        const { res, text } = await timedJson(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({ model, messages: toOpenAiMessages(messages) }),
        }, model);
        if (!res.ok) throw mkHttpError(res.status, text, res);
        const data = JSON.parse(text);
        return data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
      });
    } catch (err) {
      const conn = isConnError(err);
      if (conn && model.startsWith('local-') && await ensureLocalUp(model)) continue;  // started it; retry same model
      if (conn && !triaged) {
        triaged = true;
        const tri = await tryNetworkTriage(base, model);
        if (tri && tri.restored) continue;   // network fixed; retry same model
        if (tri && tri.networkDown) { connFailures++; modelAttempts++; break; }
      }
      if (err.stalled) {
        recordModelFailure(model);
        stallFailures++;
        modelAttempts++;
        if (stallFailures >= MAX_STALL_FAILOVERS) break;
        continue;
      }
      if (FAILOVER_TRIGGERS.has(err.status) || conn) {
        if (CREDIT_TRIGGERS.has(err.status)) blockProvider(model);
        else recordModelFailure(model);
        if (conn) connFailures++;
        modelAttempts++;
        continue;
      }
      if (model.startsWith('local-') && isLocalContextOverflow(err)) err.localContextExceeded = true;
      throw err;
    }
  }
  // If every attempt died on the wire, this is an offline machine, not a quota problem --
  // and core.mjs decides which of those to say by matching on the message.
  throw new Error(connFailures >= modelAttempts
    ? 'All models unreachable (fetch failed) -- no route to any provider.'
    : (stallFailures >= MAX_STALL_FAILOVERS || stallFailures >= modelAttempts)
      ? 'All models stalled -- every provider accepted the request and then stopped responding.'
      : 'All models exhausted -- check your API keys and quota.');
}

// ---- Streaming generator ----
export async function* chatStream(messages, tools, opts = {}) {
  let modelAttempts = 0, connFailures = 0, stallFailures = 0, triaged = false;
  while (modelAttempts < 8) {
    const { provider, base, key, model } = pickModel(opts.model);
    if (opts.strictModel && opts.model && model !== opts.model) {
      throw new Error('model "' + opts.model + '" is unavailable (strict -- no failover to "' + model + '")');
    }
    let yielded = false;
    try {
      const gen = provider === 'anthropic'
        ? claudeStream(messages, tools, base, key, model)
        : openaiStream(messages, tools, base, key, model);
      for await (const chunk of gen) { yielded = true; yield chunk; }
      return;
    } catch (err) {
      const conn = isConnError(err);
      if (conn && model.startsWith('local-') && await ensureLocalUp(model)) {
        console.warn('[api:failover] started local model "' + model + '" -- retrying');
        continue;
      }
      if (conn && !yielded && !triaged) {
        triaged = true;
        const tri = await tryNetworkTriage(base, model);
        if (tri && tri.restored) {
          console.warn('[api:failover] network restored -- retrying "' + model + '"');
          continue;
        }
        if (tri && tri.networkDown) { connFailures++; modelAttempts++; break; }
      }
      if (err.stalled) {
        recordModelFailure(model);
        // Half a reply is already on screen; replaying the turn on another model would
        // duplicate it. Surface the stall instead and let the user retry.
        if (yielded) throw err;
        stallFailures++;
        modelAttempts++;
        if (stallFailures >= MAX_STALL_FAILOVERS) break;
        console.warn('[api:failover] ' + err.message + ' -- trying next model');
        continue;
      }
      if (FAILOVER_TRIGGERS.has(err.status) || conn) {
        if (CREDIT_TRIGGERS.has(err.status)) blockProvider(model);
        else recordModelFailure(model);
        if (conn) connFailures++;
        modelAttempts++;
        console.warn('[api:failover] Stream error on "' + model + '" (' + (err.status || 'unreachable') + ') -- trying next model');
        continue;
      }
      if (model.startsWith('local-') && isLocalContextOverflow(err)) err.localContextExceeded = true;
      throw err;
    }
  }
  throw new Error(connFailures >= modelAttempts
    ? 'All models unreachable (fetch failed) -- no route to any provider.'
    : (stallFailures >= MAX_STALL_FAILOVERS || stallFailures >= modelAttempts)
      ? 'All models stalled -- every provider accepted the request and then stopped responding.'
      : 'All models exhausted for streaming.');
}

// ---- OpenAI streaming ----
async function* openaiStream(messages, tools, base, key, model) {
  const res = await withRetry(async () => {
    const body = { model, messages: toOpenAiMessages(messages), stream: true };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    let r = await timedFetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    }, model);
    if (!r.ok) {
      const errText = await r.text();
      if (r.status === 400 && /tool|function/i.test(errText)) {
        const body2 = { model, messages: toOpenAiMessages(messages), stream: true };
        r = await timedFetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body2),
        }, model);
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
    const { done, value } = await readWithIdle(reader, res, model);
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
    system:     toAnthropicSystem(messages),
    messages:   markCacheBreakpoint(toAnthropicMessages(messages)),
  };
  if (anthropicTools?.length) body.tools = anthropicTools;

  const res = await withRetry(async () => {
    const r = await timedFetch(base + '/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    }, model);
    if (!r.ok) throw mkHttpError(r.status, await r.text(), r);
    return r;
  });

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '';
  const toolBlocks   = {};
  let toolCallIndex  = -1;

  while (true) {
    const { done, value } = await readWithIdle(reader, res, model);
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
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Embedding API ' + res.status + ': ' + await res.text());
  const data = await res.json();
  return data.data[0].embedding;
}
